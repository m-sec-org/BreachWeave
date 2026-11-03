import type { TaricHostModule } from "./host-module"
import type { AuthorityCheckpointContextSource, AuthorityRecoveryLocator, AuthorityRecoveryRun, RecoveryPremise } from "./recovery-locator"
import type { GovernanceQueryLimits, GovernanceQueryResult } from "./governance-query-reader"
import { createAuthorityRecoveryCheckpoint, parseAuthorityRecoveryRun, TaricRecoveryError, validateAuthorityRecoveryPacket } from "./recovery-locator"
import { deriveStableHostRequestIdentity, requireOpaqueHostId, requireTaricUuid } from "./host-identity"
import { readGovernancePages } from "./governance-query-reader"
import { TaricOperationError, TaricUnavailableError } from "./types"

export class TaricAuthorityClaimError extends TaricOperationError {
    readonly claimOutcome: "not_dispatched" | "rejected" | "indeterminate"

    constructor(outcome: "not_dispatched" | "rejected" | "indeterminate", code: string, message: string) {
        super(code, message)
        this.name = "TaricAuthorityClaimError"
        this.claimOutcome = outcome
    }
}

export interface AuthorityWorkServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
    /** Trusted policy inventory; the host principal must independently have Taric's admit grant. */
    policyDigest: string
}

export interface AuthorityWorkDefinition {
    challengeId: string
    assetId: string
    workKey: string
    scopeId: string
    targetVersion: number
    resourceIds: readonly string[]
    title: string
    acceptanceCriteria: readonly string[]
}

export interface AuthorityWorkCheckpointInput {
    premise: RecoveryPremise
    authorityRun: unknown
    piSessionId: string
    contextSnapshotId: string
    sourceReadSeq: number
    /** Hash-only provenance of the actual Core context page used by the host builder. */
    sourceContext: AuthorityCheckpointContextSource
    completedSteps: readonly string[]
    nextSteps: readonly string[]
    observationRefs: readonly string[]
    evidenceRefs: readonly string[]
    unresolvedWork: readonly string[]
}

export type AuthorityWorkRecovery = {
    status: "resumed"
    run: AuthorityRecoveryRun
    locator: AuthorityRecoveryLocator
    checkpoint: Record<string, unknown>
    readSeq: number
} | {
    status: "replan_required"
    reason: "missing_active_run" | "authority_premise_incomplete" | "lease_expired" | "lease_reclaimed"
    run?: AuthorityRecoveryRun
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", `Taric ${field} is not a record`)
    return value as Record<string, unknown>
}

function positiveInteger(value: number, field: string, minimum = 1): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TaricOperationError("validation_error", `${field} must be a bounded integer`)
    return value
}

function visibleText(value: string, field: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\0\r]/.test(value)) throw new TaricOperationError("validation_error", `${field} must be bounded visible text`)
    if (/(?:Bearer\s+\S+|(?:password|secret|api[_-]?key|access[_-]?token|cookie|authorization)\s*[=:]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(value)) throw new TaricOperationError("validation_error", `${field} contains a sensitive value`)
    return value
}

/**
 * Only canonical operations mutate lifecycle state. No process-local run map is
 * authoritative. WorkItem pages are bounded, but their live active_run join is
 * explicitly unpinned in the locked Taric contract; work.resume is the final
 * authority premise check. ScopeRevision and policy digest are checked against
 * the same canonical watermark before claim, renew, active/completed transitions,
 * checkpoint, or recovery. Failed/cancelled cleanup retains authority fencing.
 */
export class TaricAuthorityWorkService {
    constructor(private readonly options: AuthorityWorkServiceOptions) {
        if (!/^sha256:[a-f0-9]{64}$/.test(options.policyDigest)) throw new TaricOperationError("validation_error", "policyDigest must be SHA-256")
    }

    async proposeWorkItem(input: AuthorityWorkDefinition): Promise<Record<string, unknown>> {
        requireTaricUuid(input.scopeId, "scopeId")
        positiveInteger(input.targetVersion, "targetVersion", 0)
        if (!input.resourceIds.length || input.resourceIds.length > 16) throw new TaricOperationError("validation_error", "WorkItem needs canonical Resource references")
        const resourceIds = input.resourceIds.map((id) => requireTaricUuid(id, "resourceId"))
        if (!input.acceptanceCriteria.length || input.acceptanceCriteria.length > 64) throw new TaricOperationError("validation_error", "WorkItem acceptance criteria are required")
        const identity = deriveStableHostRequestIdentity(this.options.host.getBinding(), { kind: "work_item", challengeId: input.challengeId, assetId: input.assetId, dimensions: [input.workKey, input.scopeId, String(input.targetVersion)] })
        return record(await this.options.host.submitProposal({ eventId: identity.clientRequestId, subjectType: "work_item", expectedVersion: 0, content: {
            kind: "work_item", title: visibleText(input.title, "title"), status: "queued", scope_ref: input.scopeId,
            target_version: input.targetVersion, resource_refs: resourceIds,
            acceptance_criteria: input.acceptanceCriteria.map((criterion) => visibleText(criterion, "acceptance criterion")),
        } }), "WorkItem proposal")
    }

    async admitWorkItem(proposalId: string): Promise<Record<string, unknown>> {
        const id = requireTaricUuid(proposalId, "proposalId")
        const admission = record(await this.options.host.invokeHost("admission.commit", {
            proposal_id: id, expected_version: 0, policy_digest: this.options.policyDigest, idempotency_key: `bw:work-admission:${id}`,
        }), "WorkItem admission")
        if (admission.ok === false) throw new TaricOperationError("conflict", "Taric did not admit the WorkItem proposal")
        const data = admission.data && typeof admission.data === "object" && !Array.isArray(admission.data) ? record(admission.data, "WorkItem admission data") : admission
        const item = record(data.record, "admitted WorkItem")
        this.assertWorkItem(item)
        return item
    }

    async provisionWorkItem(input: AuthorityWorkDefinition): Promise<Record<string, unknown>> {
        const proposal = await this.proposeWorkItem(input)
        return this.admitWorkItem(requireTaricUuid(proposal.id, "proposalId"))
    }

    async queryWork(resourceIds: readonly string[] = [], includeActiveRuns = false, readSeq?: number, limits: Partial<GovernanceQueryLimits> = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        const binding = this.options.host.getBinding()
        const refs = resourceIds.map((id) => requireTaricUuid(id, "resourceId"))
        if (refs.length > 16) throw new TaricOperationError("validation_error", "too many Resource filters")
        if (includeActiveRuns && readSeq !== undefined) throw new TaricRecoveryError("active WorkRun summaries are not snapshot-pinned", "replan_required")
        const bounded = { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }
        for (const key of ["maxPages", "maxRecords", "maxBytes"] as const) {
            const value = limits[key]
            if (value === undefined) continue
            if (!Number.isSafeInteger(value) || value < 1 || value > bounded[key]) throw new TaricOperationError("validation_error", "Work query limits may only tighten the default bounds")
            bounded[key] = value
        }
        const result = await readGovernancePages({
            kind: "work", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: includeActiveRuns ? { include_active_runs: true, ...(refs.length ? { resource_refs: refs } : {}) } : { kind: "work_item", include_candidates: true }, pageSize: 50, ...(readSeq === undefined ? {} : { readSeq }) },
            limits: bounded, snapshotPinned: !includeActiveRuns,
            pageKey: includeActiveRuns ? "items" : "records", ...(includeActiveRuns ? {} : { readSeqInput: "as_of" as const }),
            query: (request) => this.options.host.invokeHost(includeActiveRuns ? "work.query" : "resource.query", request),
            parseRecord: (value) => { const item = record(value, "WorkItem"); this.assertWorkItem(item); return item },
        })
        const diagnostics = { ...result.diagnostics, visibility: includeActiveRuns ? "complete" as const : "recall_filtered" as const, completeDomain: includeActiveRuns && !result.diagnostics.hasMore && ["complete", "unpinned"].includes(result.diagnostics.status) }
        return { ...result, diagnostics, records: includeActiveRuns || refs.length === 0 ? result.records : result.records.filter((item) => Array.isArray(item.resource_refs) && item.resource_refs.some((ref) => typeof ref === "string" && refs.includes(ref))) }
    }

    async claim(input: { premise: RecoveryPremise; agentId: string; taskSessionId: string; ttlMs?: number }): Promise<Record<string, unknown>> {
        try {
            this.assertPremiseBinding(input.premise)
            await this.assertCanonicalPremise(input.premise)
            requireOpaqueHostId(input.agentId, "agentId")
            requireOpaqueHostId(input.taskSessionId, "taskSessionId")
            if (input.ttlMs !== undefined) positiveInteger(input.ttlMs, "ttlMs")
            const query = await this.queryWork([input.premise.resourceId])
            if (query.diagnostics.hasMore || query.diagnostics.status === "failed" || query.diagnostics.status === "truncated") throw new TaricRecoveryError("WorkItem authority query is incomplete", "replan_required")
            const item = query.records.find((entry) => entry.id === input.premise.workItemId)
            if (!item || item.version !== input.premise.workItemVersion || item.scope_ref !== input.premise.scopeId || item.target_version !== input.premise.targetVersion) throw new TaricRecoveryError("admitted WorkItem premise is stale or unavailable", "replan_required")
        } catch (error) { throw new TaricAuthorityClaimError("not_dispatched", error instanceof TaricOperationError ? error.code : "claim_not_dispatched", "Work claim preflight failed before dispatch") }
        let reply: unknown
        try { reply = await this.options.host.invokeHost("work.claim", {
            work_item_id: input.premise.workItemId, host_id: this.options.host.getBinding().hostPrincipalId, agent_id: input.agentId,
            task_session_ref: input.taskSessionId, ...(input.ttlMs === undefined ? {} : { ttl_ms: positiveInteger(input.ttlMs, "ttlMs") }),
        }) } catch (error) {
            const rejected = error instanceof TaricOperationError && ["validation_error", "authorization_error", "stale_version", "conflict", "unsupported_schema_version", "idempotency_conflict"].includes(error.code)
            const outcome = rejected ? "rejected" : error instanceof TaricUnavailableError && error.dispatchState === "pre_dispatch" ? "not_dispatched" : "indeterminate"
            throw new TaricAuthorityClaimError(outcome, error instanceof TaricOperationError ? error.code : "claim_indeterminate", "Work claim requires its recorded dispatch disposition")
        }
        try {
            const run = record(reply, "claimed WorkRun")
            const parsed = parseAuthorityRecoveryRun(run, input.premise)
            if (parsed.taskSessionId !== input.taskSessionId || parsed.owner.agent_id !== input.agentId) throw new TaricRecoveryError("claimed WorkRun transport binding differs from the trusted host")
            return run
        } catch { throw new TaricAuthorityClaimError("indeterminate", "claim_indeterminate", "Work claim reply is invalid; authority reconciliation is required") }
    }

    async renew(premise: RecoveryPremise, authorityRun: unknown, ttlMs?: number): Promise<Record<string, unknown>> {
        this.assertPremiseBinding(premise)
        const run = parseAuthorityRecoveryRun(authorityRun, premise)
        await this.assertCanonicalPremise(premise)
        const renewed = record(await this.options.host.invokeHost("work.renew", { work_run_id: run.runId, generation: run.generation, ...(ttlMs === undefined ? {} : { ttl_ms: positiveInteger(ttlMs, "ttlMs") }) }), "renewed WorkRun")
        const current = parseAuthorityRecoveryRun(renewed, premise)
        this.assertSameGeneration(run, current, "renewed WorkRun")
        return renewed
    }

    async transition(premise: RecoveryPremise, authorityRun: unknown, status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled", requestId: string): Promise<Record<string, unknown>> {
        this.assertPremiseBinding(premise)
        const run = parseAuthorityRecoveryRun(authorityRun, premise)
        if (status !== "failed" && status !== "cancelled") await this.assertCanonicalPremise(premise)
        requireOpaqueHostId(requestId, "requestId")
        const transitioned = record(await this.options.host.invokeHost("work.transition", { work_run_id: run.runId, generation: run.generation, status, idempotency_key: requestId }), "transitioned WorkRun")
        const owner = record(transitioned.owner, "transitioned WorkRun owner")
        if (transitioned.run_id !== run.runId || transitioned.engagement_id !== run.engagementId || transitioned.attempt_ref !== run.attemptId || transitioned.generation !== run.generation || transitioned.status !== status || owner.host_id !== run.owner.host_id || owner.agent_id !== run.owner.agent_id || transitioned.task_session_ref !== run.taskSessionId) {
            throw new TaricRecoveryError("transition acknowledgement does not match the active WorkRun generation", "replan_required")
        }
        return transitioned
    }

    async checkpoint(input: AuthorityWorkCheckpointInput): Promise<Extract<AuthorityWorkRecovery, { status: "resumed" }>> {
        this.assertPremiseBinding(input.premise)
        await this.assertCanonicalPremise(input.premise)
        const checkpoint = createAuthorityRecoveryCheckpoint({ ...input, builderVersion: "breachweave-authority-work-1" })
        const run = parseAuthorityRecoveryRun(input.authorityRun, input.premise)
        await this.options.host.invokeHost("checkpoint.commit", { work_run_id: run.runId, generation: run.generation, checkpoint })
        const packet = await this.options.host.invokeHost("work.resume", { work_run_id: run.runId, generation: run.generation })
        const recovered = validateAuthorityRecoveryPacket(packet, input.premise)
        this.assertSameGeneration(run, recovered.run, "checkpoint recovery")
        this.assertCheckpointBuilder(recovered.checkpoint)
        return { status: "resumed", ...recovered }
    }

    async recover(premise: RecoveryPremise, workRunId: string, reclaim?: { agentId: string; ttlMs?: number }): Promise<AuthorityWorkRecovery> {
        this.assertPremiseBinding(premise)
        let canonicalReadSeq: number
        try {
            canonicalReadSeq = await this.assertCanonicalPremise(premise)
        } catch (error) {
            // A bounded authority read can be incomplete without being a
            // stale identity. Startup must not launch from a partial snapshot;
            // callers receive an explicit replan result so they can block the
            // worker and reconnect the cursor.
            if ((error instanceof TaricRecoveryError && /incomplete|cursor|query/i.test(error.message)) || (error instanceof TaricOperationError && ["invalid_cursor", "conflict", "minimum_budget_required"].includes(error.code))) return { status: "replan_required", reason: "authority_premise_incomplete" }
            throw error
        }
        const expectedRunId = requireTaricUuid(workRunId, "workRunId")
        let packet: unknown
        try {
            // work.resume is the final authority check. The pinned identity
            // reads above only establish the recovery premise and never grant
            // permission to continue a worker.
            packet = await this.options.host.invokeHost("work.resume", { work_run_id: expectedRunId })
        } catch (error) {
            if ((error instanceof TaricRecoveryError && /incomplete|cursor|query/i.test(error.message)) || (error instanceof TaricOperationError && ["invalid_cursor", "conflict", "minimum_budget_required"].includes(error.code))) return { status: "replan_required", reason: "authority_premise_incomplete" }
            throw error
        }
        try {
            const recovered = validateAuthorityRecoveryPacket(packet, premise, Date.now(), true)
            if (recovered.run.runId !== expectedRunId) throw new TaricRecoveryError("work.resume returned a different WorkRun than the recovery locator", "replan_required")
            this.assertCheckpointBuilder(recovered.checkpoint)
            if (recovered.readSeq < canonicalReadSeq) throw new TaricRecoveryError("work.resume watermark predates the canonical recovery premise", "replan_required")
            if (Date.parse(recovered.run.leaseExpiresAt) <= Date.now()) return reclaim ? this.reclaim(premise, recovered.run.runId, reclaim.agentId, reclaim.ttlMs, recovered.run.generation) : { status: "replan_required", reason: "lease_expired", run: recovered.run }
            return { status: "resumed", ...recovered }
        } catch (error) {
            if (!(error instanceof TaricRecoveryError)) throw error
            return { status: "replan_required", reason: "authority_premise_incomplete" }
        }
    }

    /** Discover an active run with canonical Work pages; no local run map is read. */
    async recoverActive(premise: RecoveryPremise, reclaim?: { agentId: string; ttlMs?: number }): Promise<AuthorityWorkRecovery> {
        this.assertPremiseBinding(premise)
        let query: GovernanceQueryResult<Record<string, unknown>>
        try { query = await this.queryWork([premise.resourceId], true) } catch (error) {
            if (error instanceof TaricOperationError && ["invalid_cursor", "conflict", "minimum_budget_required"].includes(error.code)) return { status: "replan_required", reason: "authority_premise_incomplete" }
            throw error
        }
        if (query.diagnostics.hasMore || query.diagnostics.status === "truncated" || query.diagnostics.status === "failed") return { status: "replan_required", reason: "authority_premise_incomplete" }
        const item = query.records.find((entry) => entry.id === premise.workItemId)
        if (!item?.active_run) return { status: "replan_required", reason: "missing_active_run" }
        const active = record(item.active_run, "active WorkRun")
        return this.recover(premise, requireTaricUuid(active.run_id, "workRunId"), reclaim)
    }

    /** A new generation is never silently resumed from an old checkpoint. */
    async reclaim(premise: RecoveryPremise, workRunId: string, agentId: string, ttlMs?: number, previousGeneration?: number): Promise<AuthorityWorkRecovery> {
        this.assertPremiseBinding(premise)
        await this.assertCanonicalPremise(premise)
        const previousRunId = requireTaricUuid(workRunId, "workRunId")
        const ownerAgentId = requireOpaqueHostId(agentId, "agentId")
        if (previousGeneration !== undefined) positiveInteger(previousGeneration, "previousGeneration")
        const run = await this.options.host.invokeHost("work.reclaim", { work_run_id: previousRunId, agent_id: ownerAgentId, ...(ttlMs === undefined ? {} : { ttl_ms: positiveInteger(ttlMs, "ttlMs") }) })
        const reclaimed = parseAuthorityRecoveryRun(run, premise)
        if (reclaimed.runId !== previousRunId || reclaimed.owner.agent_id !== ownerAgentId || (previousGeneration !== undefined && reclaimed.generation <= previousGeneration)) throw new TaricRecoveryError("reclaim acknowledgement does not advance the WorkRun generation", "replan_required")
        return { status: "replan_required", reason: "lease_reclaimed", run: reclaimed }
    }

    private assertPremiseBinding(premise: RecoveryPremise): void {
        const binding = this.options.host.getBinding()
        if (Object.keys(binding).some((key) => binding[key as keyof typeof binding] !== premise.binding[key as keyof typeof binding])) throw new TaricRecoveryError("recovery premise is outside the trusted host binding")
    }

    private async assertCanonicalPremise(premise: RecoveryPremise): Promise<number> {
        const binding = this.options.host.getBinding()
        let readSeq: number | undefined
        const resolved = new Map<string, Record<string, unknown>>()
        for (const [kind, id] of [["scope", premise.scopeId], ["scope_revision", premise.scopeRevisionId], ["resource", premise.resourceId], ["resource_revision", premise.resourceRevisionId], ["work_item", premise.workItemId]] as const) {
            requireTaricUuid(id, kind)
            const result = await readGovernancePages({
                kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind, include_candidates: true }, pageSize: 50, ...(readSeq === undefined ? {} : { readSeq }) },
                limits: { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, readSeqInput: "as_of", pageKey: "records",
                query: (request) => this.options.host.invokeHost("resource.query", request),
            })
            if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore) throw new TaricRecoveryError("canonical recovery premises are incomplete", "replan_required")
            readSeq ??= result.readSeq
            const canonical = result.records.find((entry) => entry.id === id)
            if (!canonical || canonical.kind !== kind || canonical.engagement_id !== binding.engagementId || !["L1", "L2"].includes(String(canonical.trust_level)) || ["stale", "retracted", "superseded", "archived", "expired"].includes(String(canonical.status))) throw new TaricRecoveryError("canonical recovery identity is unavailable", "replan_required")
            resolved.set(kind, canonical)
        }
        const scope = resolved.get("scope")!
        const revision = resolved.get("scope_revision")!
        const resource = resolved.get("resource")!
        const resourceRevision = resolved.get("resource_revision")!
        const workItem = resolved.get("work_item")!
        const policy = record(revision.policy, "ScopeRevision policy")
        const now = Date.now()
        if (scope.version !== premise.scopeVersion || scope.current_revision_ref !== premise.scopeRevisionId || scope.policy_digest !== premise.scopePolicyDigest || scope.revision_state !== "approved" || revision.scope_ref !== premise.scopeId || revision.policy_digest !== premise.scopePolicyDigest || revision.approval_status !== "approved" || !Number.isFinite(Date.parse(String(policy.valid_from))) || !Number.isFinite(Date.parse(String(policy.valid_until))) || now < Date.parse(String(policy.valid_from)) || now >= Date.parse(String(policy.valid_until)) || resourceRevision.resource_ref !== premise.resourceId || resourceRevision.revision !== premise.targetVersion || resource.revision !== premise.targetVersion || workItem.version !== premise.workItemVersion || workItem.scope_ref !== premise.scopeId || workItem.target_version !== premise.targetVersion || !Array.isArray(workItem.resource_refs) || !workItem.resource_refs.includes(premise.resourceId)) throw new TaricRecoveryError("canonical WorkItem, ScopeRevision or ResourceRevision premise changed", "replan_required")
        return readSeq!
    }

    private assertCheckpointBuilder(checkpoint: Record<string, unknown>): void {
        const context = record(checkpoint.context_manifest, "checkpoint ContextManifest")
        const adapter = record(context.adapter_manifest, "checkpoint adapter manifest")
        if (context.builder_version !== "breachweave-authority-work-1" || !adapter.breachweave_context) throw new TaricRecoveryError("checkpoint host builder provenance is incomplete", "replan_required")
    }

    private assertSameGeneration(expected: AuthorityRecoveryRun, actual: AuthorityRecoveryRun, field: string): void {
        if (actual.runId !== expected.runId || actual.attemptId !== expected.attemptId || actual.generation !== expected.generation || actual.engagementId !== expected.engagementId || actual.owner.host_id !== expected.owner.host_id || actual.owner.agent_id !== expected.owner.agent_id || actual.taskSessionId !== expected.taskSessionId) {
            throw new TaricRecoveryError(`${field} acknowledgement does not match the active WorkRun generation`, "replan_required")
        }
    }

    private assertWorkItem(item: Record<string, unknown>): void {
        if (item.kind !== "work_item" || item.engagement_id !== this.options.host.getBinding().engagementId || !["L1", "L2"].includes(String(item.trust_level))) throw new TaricOperationError("authorization_error", "WorkItem is not canonical in the trusted Engagement")
        requireTaricUuid(item.id, "workItemId")
        positiveInteger(Number(item.version), "workItemVersion")
    }
}
