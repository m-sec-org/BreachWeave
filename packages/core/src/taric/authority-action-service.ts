import { isIP } from "node:net"
import type { TaricArtifactService } from "./artifact-service"
import { TaricEgressExecutor } from "./egress-executor"
import type { TaricEgressDecision, TaricEgressExecutorOptions, TaricEgressInput, TaricEgressResult } from "./egress-executor"
import type { TaricHostBinding } from "./types"
import { readGovernancePages } from "./governance-query-reader"
import type { GovernanceQueryLimits, GovernanceQueryResult } from "./governance-query-reader"
import type { TaricAuthorityScopeService } from "./authority-scope-service"
import { evaluateEgress } from "./governance"
import type { ScopeTarget } from "./governance"
import { TaricOperationError } from "./types"

export type TaricCanonicalActionOperation = "action.recommend" | "action.host-decision" | "action.host-result" | "action.reconcile"

export interface TaricAuthorityActionHost {
    getBinding(): TaricHostBinding
    invokeHost(operation: "work.resume" | "action.audit.query", input: Record<string, unknown>): Promise<unknown>
    /** Trusted host dispatch only. A model-facing surface must not expose these host writes. */
    invokeAction(operation: TaricCanonicalActionOperation, input: Record<string, unknown>): Promise<unknown>
}

export interface TaricAuthorityActionContext {
    engagementId: string
    workRunId: string
    attemptId: string
    generation: number
    ownerHost: string
    scopeId: string
    scopeVersion: number
    scopeRevisionId: string
    taskSessionId: string
    /** Optional agent identity for deployments whose WorkRun owner is host+agent. */
    ownerAgentId?: string
}

export interface TaricAuthorityActionOptions {
    host: TaricAuthorityActionHost
    policyDigest: string
    /** Explicit test-only override; the full agent lifecycle has not cut over to this client. */
    allowLocalFixtureExecution?: boolean
    allowAuthorizedTargetExecution?: boolean
    targetBaseUrl?: string
    artifactService?: Pick<TaricArtifactService, "consumeTargetAuth">
    scopeService?: Pick<TaricAuthorityScopeService, "resolve">
    network: Omit<TaricEgressExecutorOptions, "assertFence" | "onDecision" | "recordResult" | "artifactService" | "maxRedirects">
}

export interface TaricAuthorityActionOutcome {
    actionId: string
    canonicalStatus: "denied" | "executed" | "failed" | "unknown"
    execution: TaricEgressResult
    diagnostic: ReturnType<TaricAuthorityActionService["diagnostic"]>
    responseBodyBase64?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^sha256:[a-f0-9]{64}$/
const PREMISES = ["engagement", "work_item", "scope", "checkpoint", "attempt", "source_sequence", "lease", "context_manifest", "host_authorization_refs"] as const

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Action authority response is invalid")
    return value as Record<string, unknown>
}
function uuid(value: string): string { if (!UUID.test(value)) throw new TaricOperationError("validation_error", "Action identity must be a Taric UUID"); return value }
function digest(value: unknown): string { return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}` }
function visible(value: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\0]/.test(value) || /bearer\s+\S+|(?:password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(value)) throw new TaricOperationError("validation_error", "Action recommendation contains invalid or sensitive text")
    return value
}
function loopback(address: string): boolean { return isIP(address) === 4 ? address.startsWith("127.") : address === "::1" }

/**
 * Canonical ActionIntent writes + an actual single-hop HTTP client, restricted to
 * explicit loopback fixtures. ScopeRevision, structured socket provenance and
 * historical audit are canonical; this client does not govern arbitrary tools.
 */
export class TaricAuthorityActionService {
    private readonly activeRuns = new Set<string>()

    constructor(private readonly options: TaricAuthorityActionOptions) {
        if (!SHA256.test(options.policyDigest)) throw new TaricOperationError("validation_error", "Action policy digest must be SHA-256")
    }

    diagnostic() {
        return {
            status: this.options.allowLocalFixtureExecution === true ? "local_fixture_only" as const : "blocked" as const,
            fullControlPlane: "blocked" as const,
            scopeMapping: "immutable_scope_revision" as const,
            actionAuditQuery: "canonical_pinned_history" as const,
            networkProvenance: "observed_connected_socket" as const,
            redirects: "separate_recommendation_required" as const,
            runtimeFirewall: false,
            productionEvidence: false,
            limitations: ["Socket provenance is observed by this host and durably recorded by Taric; it is not independent external attestation.", "Response bodies are private in-memory inputs unless separately captured as Evidence Artifacts.", "This explicit loopback fixture bridge does not authorize project launch or arbitrary shell/socket traffic."],
        }
    }

    async execute(input: { request: TaricEgressInput; rationale: string; uncertainty?: string; includeResponseBody?: boolean }, trustedContext: TaricAuthorityActionContext): Promise<TaricAuthorityActionOutcome> {
        this.requireExecutionProfile()
        const context = this.context(trustedContext)
        if (this.activeRuns.has(context.workRunId)) throw new TaricOperationError("conflict", "An Action execution is already active for this WorkRun")
        this.activeRuns.add(context.workRunId)
        try {
            await this.assertFence(context)
            if (!this.options.scopeService) throw new TaricOperationError("action_scope_unavailable", "Action execution requires canonical ScopeRevision resolution")
            const scope = await this.options.scopeService.resolve({ scopeId: context.scopeId, scopeVersion: context.scopeVersion, scopeRevisionId: context.scopeRevisionId, policyDigest: this.options.policyDigest })
            const rationale = visible(input.rationale)
            const uncertainty = input.uncertainty === undefined ? undefined : visible(input.uncertainty)
            const request = { ...input.request, ...(input.request.headers ? { headers: { ...input.request.headers } } : {}), ...(input.request.targetAuth ? { targetAuth: { ...input.request.targetAuth } } : {}) }
            let url: URL
            try { url = new URL(request.url) } catch { throw new TaricOperationError("validation_error", "Action target URL is invalid") }
            if (!this.isWithinTarget(url)) throw new TaricOperationError("authorization_error", "Action target does not match the active WorkItem Resource")
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.href.length > 8192 || [...url.searchParams.keys()].some((key) => /password|passwd|secret|credential|token|cookie|authorization|api[_-]?key|session[_-]?id/i.test(key)) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method ?? "GET")) throw new TaricOperationError("validation_error", "Action target URL or method contains unsupported or sensitive fields")
            this.assertSafeMetadata(rationale)
            this.assertSafeMetadata(uncertainty)
            this.assertSafeMetadata(url.toString())
            for (const value of url.searchParams.values()) this.assertSafeMetadata(value)
            try { this.assertSafeMetadata(decodeURIComponent(url.pathname)) } catch (error) { if (error instanceof TaricOperationError) throw error; throw new TaricOperationError("validation_error", "Action target URL encoding is invalid") }
            if (request.targetAuth && request.targetAuth.sessionId !== context.taskSessionId) throw new TaricOperationError("authorization_error", "Action target credential session does not match the active task session")
            const recommendation = record(await this.options.host.invokeAction("action.recommend", {
                work_run_id: context.workRunId, generation: context.generation, target: url.toString(), method: request.method ?? "GET", rationale,
                ...(uncertainty === undefined ? {} : { uncertainty }), scope: context.scopeId,
                scope_revision_ref: context.scopeRevisionId, policy_digest: this.options.policyDigest,
                constraints: [`Host policy ${this.options.policyDigest}`, `Canonical ScopeRevision ${context.scopeRevisionId}.`, "One HTTP request; redirects require a separate canonical recommendation."],
                limitations: this.diagnostic().limitations,
            }))
            const actionId = uuid(String(recommendation.recommendation_id))
            if (recommendation.target !== url.toString() || recommendation.method !== (request.method ?? "GET")) throw new TaricOperationError("conflict", "Canonical action recommendation does not match its request")
            let canonicalStatus: "recommended" | "authorized" | "denied" | "executed" | "failed" | "unknown" = "recommended"
            let decisionRef: string | undefined
            let responseBodyBase64: string | undefined
            const executor = new TaricEgressExecutor({
                ...this.options.network, maxRedirects: 0, artifactService: this.options.artifactService,
                consumeResponse: async (response) => {
                    if (input.includeResponseBody === true) responseBodyBase64 = Buffer.from(response.bytes.slice(0, 48 * 1024)).toString("base64")
                    await this.options.network.consumeResponse?.(response)
                },
                evaluateEgress: async (egress, runContext) => {
                    const addresses = egress.resolvedAddresses ?? []
                    if (!addresses.length || (this.options.allowLocalFixtureExecution === true && addresses.some((address) => !loopback(address)))) return { allowed: false, reason: "local fixture execution is restricted to loopback targets", normalizedUrls: [] }
                    const target = new URL(egress.url)
                    if (!this.isWithinTarget(target)) return { allowed: false, reason: "request is outside the active WorkItem Resource", normalizedUrls: [] }
                    const ports = scope.policy.ports
                    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80))
                    if (!scope.policy.methods.includes(request.method ?? "GET") || !ports.some((range) => range.from <= port && port <= range.to) || addresses.length > scope.policy.dns.max_addresses || (scope.policy.dns.reject_private_addresses && addresses.some((address) => loopback(address) || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)))) return { allowed: false, reason: "canonical ScopeRevision method, port or DNS constraint denied", normalizedUrls: [] }
                    const convert = (value: string): ScopeTarget => value.includes("://") ? { host: new URL(value).hostname.replace(/^\[|\]$/g, "") } : value.includes("/") ? { cidr: value } : { host: value.replace(/^\[|\]$/g, "") }
                    const canonical = evaluateEgress({ allowedTargets: scope.policy.allowed_targets.map(convert), deniedTargets: scope.policy.excluded_targets.map(convert), allowedProtocols: scope.policy.protocols }, { startsAt: scope.policy.valid_from, endsAt: scope.policy.valid_until }, egress)
                    if (!canonical.allowed) return canonical
                    // URL scopes additionally retain their origin/path boundary.
                    const urlTargets = scope.policy.allowed_targets.filter((value) => value.includes("://"))
                    const plainTargetAllowsHost = scope.policy.allowed_targets.some((value) => !value.includes("://") && evaluateEgress({ allowedTargets: [convert(value)] }, { startsAt: scope.policy.valid_from, endsAt: scope.policy.valid_until }, { ...egress, resolvedAddresses: [] }).allowed)
                    if (!plainTargetAllowsHost && !urlTargets.some((value) => { const allowed = new URL(value); return allowed.origin === target.origin && (!allowed.search || allowed.search === target.search) && (allowed.pathname === "/" || target.pathname === allowed.pathname || target.pathname.startsWith(`${allowed.pathname.replace(/\/$/, "")}/`)) })) return { allowed: false, reason: "canonical ScopeRevision URL boundary denied", normalizedUrls: [] }
                    return this.options.network.evaluateEgress(egress, runContext)
                },
                assertFence: async () => { await this.assertFence(context, actionId) },
                onDecision: async (decision: TaricEgressDecision) => {
                    await this.assertFence(context, actionId)
                    if (canonicalStatus !== "recommended") throw new TaricOperationError("conflict", "A canonical Action host decision cannot be replayed or rebound")
                    decisionRef = `bw-action-decision:${digest({ format: "breachweave-action-network-decision/1", scopeId: context.scopeId, scopeVersion: context.scopeVersion, policyDigest: this.options.policyDigest, method: decision.method, urlDigest: digest(decision.url), resolvedAddresses: decision.resolvedAddresses, pinnedAddress: decision.pinnedAddress, allowed: decision.allowed, generation: context.generation, attemptId: context.attemptId })}`
                    const status = decision.allowed ? "authorized" : "denied"
                    const authority = record(await this.options.host.invokeAction("action.host-decision", { work_run_id: context.workRunId, generation: context.generation, action_id: actionId, mode: "authorized_autonomous", status, host_decision_ref: decisionRef, scope_revision_ref: context.scopeRevisionId, policy_digest: this.options.policyDigest }))
                    this.assertActionWrite(authority, context, actionId, status)
                    canonicalStatus = status
                    return { decisionRef }
                },
                recordResult: async (result) => {
                    await this.assertFence(context, actionId)
                    if (canonicalStatus === "denied") return
                    if (canonicalStatus === "recommended") {
                        decisionRef = `bw-action-preflight:${digest({ actionId, context, failureCode: result.failureCode })}`
                        const denied = record(await this.options.host.invokeAction("action.host-decision", { work_run_id: context.workRunId, generation: context.generation, action_id: actionId, mode: "authorized_autonomous", status: "denied", host_decision_ref: decisionRef, scope_revision_ref: context.scopeRevisionId, policy_digest: this.options.policyDigest }))
                        this.assertActionWrite(denied, context, actionId, "denied")
                        canonicalStatus = "denied"
                        return
                    }
                    const status = result.outcome === "executed" ? "executed" : result.hopCount === 0 ? "failed" : "unknown"
                    const receipt = `bw-action-result:${digest({ format: "breachweave-action-host-receipt/1", actionId, scopeId: context.scopeId, scopeVersion: context.scopeVersion, policyDigest: this.options.policyDigest, result })}`
                    const authority = record(await this.options.host.invokeAction("action.host-result", { work_run_id: context.workRunId, generation: context.generation, action_id: actionId, mode: "authorized_autonomous", status, host_decision_ref: decisionRef, result_ref: receipt, scope_revision_ref: context.scopeRevisionId, policy_digest: this.options.policyDigest, ...(result.networkProvenance ? { network_provenance: result.networkProvenance } : {}) }))
                    this.assertActionWrite(authority, context, actionId, status)
                    canonicalStatus = status
                },
            })
            const execution = await executor.execute(request, { engagementId: context.engagementId, actionId, workRunId: context.workRunId, attemptId: context.attemptId, generation: context.generation, ownerHost: context.ownerHost, scopeRevision: context.scopeVersion })
            if (!["denied", "executed", "failed", "unknown"].includes(String(canonicalStatus))) throw new TaricOperationError("conflict", "Canonical Action result was not durably acknowledged")
            return { actionId, canonicalStatus: canonicalStatus as TaricAuthorityActionOutcome["canonicalStatus"], execution, diagnostic: this.diagnostic(), ...(responseBodyBase64 ? { responseBodyBase64 } : {}) }
        } finally { this.activeRuns.delete(context.workRunId) }
    }

    /** Complete append-only history, pinned across pages and safe to rebuild after restart. */
    async queryAudit(input: { actionId?: string; workRunId?: string; attemptId?: string; generation?: number; status?: string; readSeq?: number; pageSize?: number; limits?: Partial<GovernanceQueryLimits> } = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        const binding = this.options.host.getBinding()
        const filters: Record<string, unknown> = {}
        for (const [field, value] of [["action_id", input.actionId], ["work_run_id", input.workRunId], ["attempt_id", input.attemptId]] as const) if (value !== undefined) filters[field] = uuid(value)
        if (input.generation !== undefined) {
            if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new TaricOperationError("validation_error", "Action audit generation must be positive")
            filters.generation = input.generation
        }
        if (input.status !== undefined) {
            if (!["recommended", "authorized", "denied", "executed", "failed", "unknown", "late_result_quarantine"].includes(input.status)) throw new TaricOperationError("validation_error", "Action audit status is invalid")
            filters.status = input.status
        }
        const pageSize = input.pageSize ?? 50
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new TaricOperationError("validation_error", "Action audit page size is invalid")
        const limits = { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }
        for (const field of ["maxPages", "maxRecords", "maxBytes"] as const) if (input.limits?.[field] !== undefined) {
            const value = input.limits[field]!
            if (!Number.isSafeInteger(value) || value < 1 || value > limits[field]) throw new TaricOperationError("validation_error", "Action audit limits may only tighten aggregate bounds")
            limits[field] = value
        }
        const result = await readGovernancePages({
            kind: "action", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters, pageSize, readSeq: input.readSeq }, limits,
            snapshotPinned: true, pageKey: "events", readSeqInput: "read_seq", query: (request) => this.options.host.invokeHost("action.audit.query", request),
            parseRecord: (value) => {
                const event = record(value)
                uuid(String(event.event_id)); uuid(String(event.action_id))
                if (event.engagement_id !== binding.engagementId || !Number.isSafeInteger(event.commit_seq) || Number(event.commit_seq) < 1) throw new TaricOperationError("authorization_error", "Action audit event binding is invalid")
                return { ...event, id: String(event.event_id) } as Record<string, unknown>
            },
            compareRecords: (left, right) => Number(left.commit_seq) - Number(right.commit_seq),
        })
        result.diagnostics.visibility = "complete"
        result.diagnostics.completeDomain = result.diagnostics.status === "complete"
        return result
    }

    /** Only an explicit trusted reconciliation call can resolve a persisted unknown action. It never sends traffic. */
    async reconcileUnknown(input: { actionId: string; status: "executed" | "failed"; hostReceiptDigest: string }, trustedContext: TaricAuthorityActionContext): Promise<{ actionId: string; status: "executed" | "failed" }> {
        this.requireExecutionProfile()
        const context = this.context(trustedContext)
        const actionId = uuid(input.actionId)
        if (!["executed", "failed"].includes(input.status) || !SHA256.test(input.hostReceiptDigest)) throw new TaricOperationError("validation_error", "Action reconciliation requires an explicit resolved status and host receipt digest")
        const packet = await this.assertFence(context, actionId, true)
        if (!(packet.pending_actions as Array<Record<string, unknown>>).some((item) => item.action_id === actionId && item.status === "unknown")) throw new TaricOperationError("conflict", "No matching unknown Action requires reconciliation")
        const result = record(await this.options.host.invokeAction("action.reconcile", { work_run_id: context.workRunId, generation: context.generation, action_id: actionId, status: input.status, result_ref: `bw-action-reconcile:${input.hostReceiptDigest}` }))
        this.assertActionWrite(result, context, actionId, input.status)
        return { actionId, status: input.status }
    }

    private requireExecutionProfile(): void {
        if (this.options.allowLocalFixtureExecution !== true && this.options.allowAuthorizedTargetExecution !== true) throw new TaricOperationError("action_contract_blocked", "Action execution requires an integrated governed host lifecycle or explicit local fixture")
    }

    private context(input: TaricAuthorityActionContext): TaricAuthorityActionContext {
        const binding = this.options.host.getBinding()
        for (const value of [input.engagementId, input.workRunId, input.attemptId, input.scopeId, input.scopeRevisionId]) uuid(value)
        if (input.engagementId !== binding.engagementId || input.ownerHost !== binding.hostPrincipalId || !input.taskSessionId || input.taskSessionId.length > 256 || !Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.scopeVersion) || input.scopeVersion < 1) throw new TaricOperationError("authorization_error", "Action context does not match the trusted host binding")
        if (input.ownerAgentId !== undefined && (!input.ownerAgentId || input.ownerAgentId.length > 256 || /[\r\n\0]/.test(input.ownerAgentId))) throw new TaricOperationError("authorization_error", "Action owner agent identity is invalid")
        for (const value of Object.values(input)) if (typeof value === "string") this.assertSafeMetadata(value)
        return Object.freeze({ engagementId: input.engagementId, workRunId: input.workRunId, attemptId: input.attemptId, generation: input.generation, ownerHost: input.ownerHost, scopeId: input.scopeId, scopeVersion: input.scopeVersion, scopeRevisionId: input.scopeRevisionId, taskSessionId: input.taskSessionId, ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }) })
    }

    private async assertFence(context: TaricAuthorityActionContext, activeActionId?: string, allowUnknown = false): Promise<Record<string, unknown>> {
        // `work.resume` is host-authenticated by the transport; host_id is not
        // a request field. Supplying the expected generation prevents a stale
        // action callback from being rebound to a newer lease.
        const packet = record(await this.options.host.invokeHost("work.resume", { work_run_id: context.workRunId, generation: context.generation }))
        const run = record(packet.run)
        const owner = record(run.owner)
        const checks = record(packet.premise_checks)
        const checkpoint = record(packet.checkpoint)
        if (run.scope_revision_ref !== context.scopeRevisionId || run.policy_digest !== this.options.policyDigest || checkpoint.scope_revision_ref !== context.scopeRevisionId || checkpoint.policy_digest !== this.options.policyDigest) throw new TaricOperationError("stale_version", "Action immutable ScopeRevision or policy digest is stale")
        if (run.run_id !== context.workRunId || run.engagement_id !== context.engagementId || run.attempt_ref !== context.attemptId || run.generation !== context.generation || owner.host_id !== context.ownerHost || (context.ownerAgentId !== undefined && owner.agent_id !== context.ownerAgentId) || run.scope_ref !== context.scopeId || run.scope_version !== context.scopeVersion || run.task_session_ref !== context.taskSessionId || packet.task_session_ref !== context.taskSessionId || checkpoint.scope_ref !== context.scopeId || checkpoint.scope_version !== context.scopeVersion || !Number.isFinite(Date.parse(String(run.lease_expires_at))) || Date.parse(String(run.lease_expires_at)) <= Date.now() || ["completed", "failed", "cancelled", "lost"].includes(String(run.status)) || PREMISES.some((key) => checks[key] !== true)) throw new TaricOperationError("stale_version", "Action WorkRun, Attempt, Scope or checkpoint premise is not current")
        if (!Array.isArray(packet.pending_actions)) throw new TaricOperationError("validation_error", "Action pending state is incomplete")
        const pending = packet.pending_actions.map(record)
        if (pending.some((item) => item.action_id !== activeActionId || item.generation !== context.generation || item.run_id !== context.workRunId || (item.status !== "authorized" && !(allowUnknown && item.status === "unknown")))) throw new TaricOperationError("action_reconciliation_required", "Pending authorized or unknown Actions must be reconciled before new execution")
        if (checks.action_results !== true && pending.length === 0) throw new TaricOperationError("action_reconciliation_required", "Action result premise is incomplete")
        return { ...packet, pending_actions: pending }
    }

    private assertActionWrite(value: Record<string, unknown>, context: TaricAuthorityActionContext, actionId: string, status: string): void {
        const owner = record(value.owner)
        if (value.action_id !== actionId || value.run_id !== context.workRunId || value.engagement_id !== context.engagementId || value.generation !== context.generation || value.status !== status || value.host_id !== context.ownerHost || owner.host_id !== context.ownerHost || (context.ownerAgentId !== undefined && (value.agent_id !== context.ownerAgentId || owner.agent_id !== context.ownerAgentId)) || value.scope_revision_ref !== context.scopeRevisionId || value.policy_digest !== this.options.policyDigest) throw new TaricOperationError("conflict", "Canonical Action acknowledgement does not match the trusted run")
    }

    private assertSafeMetadata(value: string | undefined): void {
        if (value !== undefined && this.options.network.configurationSecrets?.some((secret) => secret.length > 0 && value.includes(secret))) throw new TaricOperationError("validation_error", "Trusted configuration secrets cannot enter canonical Action metadata")
    }

    private isWithinTarget(target: URL): boolean {
        const base = this.options.targetBaseUrl
        if (!base) return true
        let allowed: URL
        try { allowed = new URL(base) } catch { return false }
        const path = allowed.pathname.replace(/\/$/, "") || "/"
        return target.origin === allowed.origin && (path === "/" || target.pathname === path || target.pathname.startsWith(`${path}/`))
    }
}
