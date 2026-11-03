import type { ConfigManager } from "../config/index"
import type { AuthorizedProjectBinding } from "../config/authorized-projects"
import type { AuthorizedProjectSetup, AuthorizedProjection } from "../taric/governance"
import type { TaricHostModule } from "../taric/host-module"
import type { ChallengeAttemptLogRecord, ChallengeInfoRecord, ChallengeSubmissionLogRecord } from "./store"
import type { ChallengeStatsRecord, SolverStatsRecord } from "./stats"
import { deriveCompositeProjectKey } from "../project/types"
import { createTaricHostModuleForProject } from "../taric/provider-factory"
import { TaricAuthorityScopeService } from "../taric/authority-scope-service"
import { TaricAuthorityCoverageService } from "../taric/authority-coverage-service"
import { TaricAuthorityReportService } from "../taric/authority-report-service"
import { AuthorizedPentestGovernance } from "../taric/governance"
import { TaricAuthorityWorkService } from "../taric/authority-work-service"
import { TaricAuthorityActionService } from "../taric/authority-action-service"
import { TaricArtifactService } from "../taric/artifact-service"
import { dirname, resolve } from "node:path"
import { getLocalTaricGatewayRuntime } from "../taric/local-gateway"
import { readGovernancePages } from "../taric/governance-query-reader"
import type { AuthorityRecoveryRun, RecoveryPremise } from "../taric/recovery-locator"
import { TaricOperationError } from "../taric/types"
import { hashChallengeAsset } from "./store"

export interface AuthorizedChallengeProjection {
    challenge: ChallengeInfoRecord
    /** Canonical setup reconstructed from ScopeRevision and manifest records. */
    setup?: AuthorizedProjectSetup
    attempts: ChallengeAttemptLogRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    stats: { stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }
    authority: AuthorizedProjection
}

export interface AuthorizedChallengeProjectionProvider {
    listBindings(): Promise<AuthorizedProjectBinding[]>
    read(challengeId: string): Promise<AuthorizedChallengeProjection | undefined>
    prepareLifecycle?(challengeId: string): Promise<AuthorizedChallengeProjection | undefined>
    recoverStartup?(challengeId: string): Promise<AuthorizedWorkRecoveryResult[]>
    prepareSolver?(challengeId: string, agentId: string): Promise<{ projection: AuthorizedChallengeProjection; run: AuthorityRecoveryRun }>
    renewWorkRun?(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string }): Promise<void>
    finishWorkRun?(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string }): Promise<void>
    failWorkRun?(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string }): Promise<void>
    executeAction?(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string; request: { url: string; method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"; headers?: Record<string, string>; body?: string; rationale: string } }): Promise<{ statusCode: number; outcome: string; bodyBase64?: string; diagnostic: string }>
    registerFromManifest(input: { challengeId: string; title: string; project: AuthorizedProjectBinding["project"] }): Promise<void>
    close?(): Promise<void>
}

export interface AuthorizedWorkRecoveryResult {
    workItemId: string
    resourceId: string
    status: "resumed" | "replan_required"
    reason?: string
    runId?: string
    generation?: number
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized projection record is unavailable")
    return value as Record<string, unknown>
}

function operationData(value: unknown): Record<string, unknown> {
    let current = value
    for (let depth = 0; depth < 3; depth += 1) {
        if (!current || typeof current !== "object" || Array.isArray(current)) break
        const object = current as Record<string, unknown>
        if (object.ok === false) throw new TaricOperationError("authority_operation_failed", "Taric projection operation failed")
        if (object.ok === true && object.data && typeof object.data === "object") current = object.data
        else if (object.data && typeof object.data === "object" && !Array.isArray(object.data)) current = object.data
        else return object
    }
    return record(current)
}

function workResource(authority: AuthorizedProjection, work: Record<string, unknown>): Record<string, unknown> | undefined {
    const refs = Array.isArray(work.resource_refs) ? work.resource_refs.filter((value): value is string => typeof value === "string") : []
    if (!refs.length) return
    const resources = refs.map((ref) => authority.resources.find((item) => item.id === ref) ?? authority.resources.find((item) => authority.resourceRevisions.some((revision) => revision.id === ref && revision.resource_ref === item.id)))
    if (resources.some((item) => !item) || new Set(resources.map((item) => item!.id)).size !== 1) return
    return resources[0]
}

function premiseForRun(binding: RecoveryPremise["binding"], challengeId: string, projection: AuthorizedChallengeProjection, run: Record<string, unknown>): RecoveryPremise {
    const scope = record(projection.authority.scope[0])
    const scopeRevision = record(projection.authority.scopeRevisions[0])
    const workItemId = String(run.work_item_ref ?? run.work_item_id ?? "")
    const workItem = projection.authority.work.find((item) => item.id === workItemId)
    if (!workItem) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun WorkItem binding is unavailable")
    const resource = workResource(projection.authority, workItem)
    if (!resource) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun Resource binding is unavailable")
    const resourceRevision = projection.authority.resourceRevisions.find((item) => item.resource_ref === resource.id && Number(item.revision) === Number(run.target_version))
    if (!resourceRevision) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun ResourceRevision is unavailable")
    const identity = record(resource.identity)
    if (typeof identity.origin !== "string" || typeof identity.path !== "string") throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun target identity is unavailable")
    const target = new URL(identity.path, identity.origin).toString()
    const policyDigest = String(scopeRevision.policy_digest ?? "")
    if (!/^sha256:[a-f0-9]{64}$/.test(policyDigest)) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun policy digest is unavailable")
    return {
        binding, challengeId, assetId: hashChallengeAsset(target), resourceId: String(resource.id), resourceRevisionId: String(resourceRevision.id),
        scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(scopeRevision.id), scopePolicyDigest: policyDigest,
        workItemId, workItemVersion: Number(workItem.version), targetVersion: Number(resourceRevision.revision),
    }
}

/** Project the product APIs from an authority snapshot, including explicit unavailable metrics. */
export function projectAuthorizedChallenge(binding: AuthorizedProjectBinding, authority: AuthorizedProjection): AuthorizedChallengeProjection {
    const projectId = deriveCompositeProjectKey(binding.project)
    const timestamp = String(authority.scope[0]?.created_at ?? authority.refreshedAt)
    const targets = authority.resources.map((resource) => {
        const identity = record(resource.identity)
        if (typeof identity.origin !== "string" || typeof identity.path !== "string") throw new TaricOperationError("incomplete_authority_snapshot", "Canonical Resource target is unavailable")
        return new URL(identity.path, identity.origin).toString()
    })
    const closed = authority.report?.closed === true
    const active = authority.work.some((item) => ["claimed", "running", "in_progress", "checkpointed"].includes(String(item.status)))
    const gaps = Array.isArray(authority.coverageGate.gaps) ? authority.coverageGate.gaps : []
    const unresolvedCoverageStatuses = new Set(["not_tested", "queued", "in_progress", "tested_no_observation", "blocked", "blocked_by_control", "inconclusive"])
    const resolvedCoverage = authority.coverage.filter((item) => !unresolvedCoverageStatuses.has(String(item.status))).length
    const challenge: ChallengeInfoRecord = {
        id: binding.challengeId, name: binding.title, title: binding.title, description: "Authorized project reconstructed from Taric.", difficulty: "authorized", level: 0, hint_viewed: false,
        project: binding.project, project_id: projectId, project_classification: "trusted", mode: "authorized_pentest", memory_mode: "taric_required",
        assets_url: targets, assets_ip: [], assets: { urls: targets.map((asset) => ({ asset, asset_hash: hashChallengeAsset(asset), scanned: false })), ips: [] },
        instance_status: closed ? "stopped" : active ? "running" : "stopped", planner_status: closed ? "stop" : active ? "running" : "stop", planner_enabled: !closed, entrypoint: targets,
        created_at: timestamp, updated_at: authority.refreshedAt, source: "taric:canonical_projection",
        authority_projection: { source: authority.source, read_seq: authority.readSeq, lifecycle_mode: authority.lifecycleMode, closed, can_close: authority.coverageGate.can_close === true, gaps, work_total: authority.work.length, coverage_total: authority.coverage.length, coverage_resolved: resolvedCoverage, evidence_refs: authority.evidence.map((item) => String(item.id)), report_refs: (authority.report?.reports ?? []).map((item) => String(item.id)), action_event_total: authority.actionAudit.length },
    }
    const submissions: ChallengeSubmissionLogRecord[] = (authority.report?.reports ?? []).map((item) => ({
        id: String(item.id), challenge_id: binding.challengeId, project_id: projectId, asset_hash: "authorized-report", asset: "authorized-engagement", report: JSON.stringify({ report_snapshot_ref: item.id, report_artifact_ref: item.report_artifact_ref, report_artifact_digest: item.report_artifact_digest, evidence_refs: item.evidence_refs }), created_at: String(item.committed_at ?? item.created_at ?? timestamp),
    }))
    const stats: ChallengeStatsRecord = { challenge_id: binding.challengeId, solver_count: 0, attempt_count: 0, submission_count: submissions.length, solver_active_duration_ms_total: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }, updated_at: authority.refreshedAt,
        authority: { read_seq: authority.readSeq, work_total: authority.work.length, work_completed: authority.work.filter((item) => item.status === "completed").length, coverage_total: authority.coverage.length, evidence_total: authority.evidence.length, action_event_total: authority.actionAudit.length, closed, unavailable_metrics: ["solver_count", "attempt_count", "report_duration_ms", "solver_active_duration_ms_total", "usage"] } }
    return { challenge, attempts: [], submissions, stats: { stats, solver_stats: [] }, authority }
}

/** Discovery is trusted configuration; every project state read is a fresh authority query. */
export function createAuthorizedChallengeProjectionProvider(config: ConfigManager, createHost = createTaricHostModuleForProject): AuthorizedChallengeProjectionProvider {
    const hosts = new Map<string, Promise<TaricHostModule>>()
    async function hostFor(binding: AuthorizedProjectBinding, hostSessionId?: string): Promise<TaricHostModule> {
        const projectId = deriveCompositeProjectKey(binding.project)
        const cacheKey = hostSessionId ? `${projectId}:${hostSessionId}` : projectId
        let pending = hosts.get(cacheKey)
        if (!pending) {
            pending = (async () => {
                const host = await createHost(config, binding.project, projectId, { hostSessionId })
                const health = await host.initialize()
                if (health.status !== "healthy") {
                    await host.close()
                    throw new TaricOperationError("taric_unavailable", "Authorized projection requires a healthy Taric authority")
                }
                return host
            })()
            hosts.set(cacheKey, pending)
            void pending.catch(() => hosts.delete(cacheKey))
        }
        return pending
    }
    return {
        listBindings: () => config.listAuthorizedProjectBindings(),
        async registerFromManifest(input) {
            const projectId = deriveCompositeProjectKey(input.project)
            const host = await createHost(config, input.project, projectId)
            try {
                const health = await host.initialize()
                if (health.status !== "healthy") throw new TaricOperationError("taric_unavailable", "Authorized project registration requires a healthy Taric authority")
                const binding = host.getBinding()
                const manifests = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind: "coverage_manifest", include_candidates: true }, pageSize: 50 }, limits: { maxPages: 20, maxRecords: 500, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => host.invokeHost("resource.query", request) })
                const manifest = manifests.records.find((item) => item.id === input.project.coverage_manifest_id)
                if (manifests.diagnostics.status !== "complete" || manifests.diagnostics.hasMore || !manifest || !Array.isArray(manifest.expected_cells) || !manifest.expected_cells.length || typeof manifest.scope_revision_ref !== "string") throw new TaricOperationError("incomplete_authority_snapshot", "Authorized project manifest is not canonical and complete")
                const scopeHistory = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind: "scope", include_candidates: true }, pageSize: 50, readSeq: manifests.readSeq }, limits: { maxPages: 20, maxRecords: 500, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => host.invokeHost("resource.query", request), parseRecord: (value) => record(value) })
                const scopes = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind: "scope_revision", include_candidates: true }, pageSize: 50, readSeq: manifests.readSeq }, limits: { maxPages: 20, maxRecords: 500, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => host.invokeHost("resource.query", request) })
                const revision = scopes.records.find((item) => item.id === manifest.scope_revision_ref && item.kind === "scope_revision" && item.trust_level !== "L0")
                const scope = scopeHistory.records.find((item) => item.id === revision?.scope_ref && item.kind === "scope" && item.trust_level !== "L0")
                if (scopeHistory.diagnostics.status !== "complete" || scopes.diagnostics.status !== "complete" || scopeHistory.readSeq !== manifests.readSeq || scopes.readSeq !== manifests.readSeq || !scope || !revision || scope.current_revision_ref !== revision.id || revision.approval_status !== "approved" || Number(revision.revision) !== input.project.scope_revision) throw new TaricOperationError("stale_scope", "Authorized project ScopeRevision does not match its canonical manifest")
                await config.saveAuthorizedProjectBinding({ challengeId: input.challengeId, title: input.title, project: input.project, scopeId: String(scope.id) })
            } finally { await host.close() }
        },
        async read(challengeId) {
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === challengeId)
            if (!binding) return
            const host = await hostFor(binding)
            const scope = await new TaricAuthorityScopeService({ host }).resolve({ scopeId: binding.scopeId })
            if (scope.revision !== binding.project.scope_revision) throw new TaricOperationError("stale_scope", "Authorized project discovery requires the current canonical ScopeRevision")
            const query = await readGovernancePages({ kind: "resource", binding: { principalId: host.getBinding().hostPrincipalId, engagementId: host.getBinding().engagementId, filters: { kind: "coverage_manifest", include_candidates: true }, pageSize: 50, readSeq: scope.readSeq }, limits: { maxPages: 20, maxRecords: 500, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (input) => host.invokeHost("resource.query", input) })
            const manifest = query.records.find((item) => item.id === binding.project.coverage_manifest_id)
            if (query.diagnostics.status !== "complete" || query.diagnostics.hasMore || !manifest || manifest.scope_revision_ref !== scope.scopeRevisionId || !Array.isArray(manifest.expected_cells) || !manifest.expected_cells.length) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized project manifest cannot be reconstructed")
            const dimensions = manifest.expected_cells.map(record)
            const manifestItems = [...new Set(dimensions.map((item) => String(item.resource_ref)))].map((resourceId) => ({ resourceId, revision: 1, testCategories: [...new Set(dimensions.filter((item) => item.resource_ref === resourceId).map((item) => String(item.test_category)))] }))
            // Projection rebuilds never recover raw credential bindings. Keep a
            // typed opaque placeholder so the governance setup remains valid;
            // it is metadata only and cannot be used to read an Artifact.
            const setup: AuthorizedProjectSetup = { project: binding.project, scope: { allowedTargets: scope.policy.allowed_targets.map((target) => target.includes("://") ? { host: new URL(target).hostname } : target.includes("/") ? { cidr: target } : { host: target }) }, testWindow: { startsAt: scope.policy.valid_from, endsAt: scope.policy.valid_until }, manifest: manifestItems, secretReferences: ["secret:projection-unavailable"], retentionDays: 30, policyDigest: scope.policyDigest }
            const coverage = new TaricAuthorityCoverageService({ host })
            const governance = new AuthorizedPentestGovernance({ host, setup, artifactRoot: config.dir, artifactKey: new Uint8Array(32), reportService: new TaricAuthorityReportService({ host, coverage }) })
            // The first rebuild is the migration read. It is compared against
            // the canonical rebuild before the lifecycle is marked cut over;
            // no local challenge/session snapshot is accepted as a fallback.
            const migrationProjection = await governance.rebuildProjection()
            const reconciliation = await governance.cutoverToTaricProjection(migrationProjection as unknown as Record<string, unknown>)
            const canonicalRevisionByResource = new Map(reconciliation.projection.resourceRevisions.map((item) => [String(item.resource_ref), Number(item.revision)]))
            const canonicalSetup = {
                ...setup,
                manifest: setup.manifest.map((item) => ({ ...item, revision: canonicalRevisionByResource.get(item.resourceId) ?? item.revision })),
            }
            return { ...projectAuthorizedChallenge(binding, reconciliation.projection), setup: canonicalSetup }
        },
        async prepareLifecycle(challengeId) {
            return this.read(challengeId)
        },
        async recoverStartup(challengeId) {
            const projection = await this.read(challengeId)
            if (!projection) return []
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === challengeId)
            if (!binding) return []
            const host = await hostFor(binding)
            const scope = record(projection.authority.scope[0])
            const scopeRevision = record(projection.authority.scopeRevisions[0])
            const policyDigest = String(scopeRevision.policy_digest ?? "")
            const work = new TaricAuthorityWorkService({ host, policyDigest })
            const activeWork = projection.authority.work.filter((item) => item.active_run || ["claimed", "in_progress", "checkpointed", "blocked"].includes(String(item.status)))
            const results: AuthorizedWorkRecoveryResult[] = []
            for (const item of activeWork) {
                const resource = workResource(projection.authority, item)
                if (!resource) {
                    results.push({ workItemId: String(item.id), resourceId: "", status: "replan_required", reason: "work_item_resource_binding_ambiguous" })
                    continue
                }
                const resourceId = String(resource.id)
                const resourceRevision = projection.authority.resourceRevisions.find((value) => value.resource_ref === resourceId && Number(value.revision) === Number(item.target_version))
                if (!resourceRevision || !resource) {
                    results.push({ workItemId: String(item.id), resourceId, status: "replan_required", reason: "resource_revision_incomplete" })
                    continue
                }
                const identity = record(resource.identity)
                if (typeof identity.origin !== "string" || typeof identity.path !== "string") {
                    results.push({ workItemId: String(item.id), resourceId, status: "replan_required", reason: "resource_target_incomplete" })
                    continue
                }
                const target = new URL(identity.path, identity.origin).toString()
                const premise: RecoveryPremise = {
                    binding: host.getBinding(), challengeId, assetId: hashChallengeAsset(target), resourceId, resourceRevisionId: String(resourceRevision.id),
                    scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(scopeRevision.id), scopePolicyDigest: policyDigest,
                    workItemId: String(item.id), workItemVersion: Number(item.version), targetVersion: Number(resourceRevision.revision),
                }
                const recovered = await work.recoverActive(premise, { agentId: `bw-recovery-${process.pid}-${crypto.randomUUID().slice(0, 8)}`, ttlMs: 60_000 })
                results.push(recovered.status === "resumed"
                    ? { workItemId: String(item.id), resourceId, status: "resumed", runId: recovered.run.runId, generation: recovered.run.generation }
                    : { workItemId: String(item.id), resourceId, status: "replan_required", reason: recovered.reason, ...(recovered.run ? { runId: recovered.run.runId, generation: recovered.run.generation } : {}) })
            }
            return results
        },
        async prepareSolver(challengeId, agentId) {
            const projection = await this.read(challengeId)
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === challengeId)
            if (!projection || !binding) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized Solver requires a complete Taric projection")
            if (projection.authority.report?.closed) throw new TaricOperationError("engagement_closed", "Authorized Solver cannot start in a closed Engagement")
            const host = await hostFor(binding)
            const scope = record(projection.authority.scope[0])
            const scopeRevision = record(projection.authority.scopeRevisions[0])
            const policyDigest = String(scopeRevision.policy_digest ?? "")
            const queued = projection.authority.work
                .filter((item) => item.status === "queued" && item.scope_ref === scope.id)
                .sort((left, right) => String(left.id).localeCompare(String(right.id)))
            for (const item of queued) {
                const resource = workResource(projection.authority, item)
                if (!resource) continue
                const resourceRevision = projection.authority.resourceRevisions.find((value) => value.resource_ref === resource.id && Number(value.revision) === Number(item.target_version))
                if (!resourceRevision) continue
                const identity = record(resource.identity)
                if (typeof identity.origin !== "string" || typeof identity.path !== "string") continue
                const target = new URL(identity.path, identity.origin).toString()
                const premise: RecoveryPremise = {
                    binding: host.getBinding(), challengeId, assetId: hashChallengeAsset(target), resourceId: String(resource.id), resourceRevisionId: String(resourceRevision.id),
                    scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(scopeRevision.id), scopePolicyDigest: policyDigest,
                    workItemId: String(item.id), workItemVersion: Number(item.version), targetVersion: Number(resourceRevision.revision),
                }
                const context = operationData(await host.invokeHost("context.query", { work_item_id: premise.workItemId, budget: 50_000, include_candidates: true, read_seq: projection.authority.readSeq }))
                const contextReadSeq = Number(context.read_seq)
                if (
                    contextReadSeq !== projection.authority.readSeq ||
                    typeof context.context_snapshot_id !== "string" ||
                    !Array.isArray(context.items) ||
                    context.cursor !== undefined ||
                    context.has_more === true ||
                    context.truncated_count !== 0 ||
                    context.omitted_count !== 0 ||
                    context.omitted_count_complete !== true ||
                    context.omitted_as_unexamined !== false
                ) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized Solver context snapshot is incomplete")
                const taskSessionId = `bw-task-${crypto.randomUUID()}`
                const sessionHost = await hostFor(binding, taskSessionId)
                const settings = (await config.getHostSettings()).taric
                const local = getLocalTaricGatewayRuntime()
                const authorityPath = settings?.authorityPath ?? (local?.hostPrincipalId === sessionHost.getBinding().hostPrincipalId ? local.dbPath : undefined)
                const contentRoot = settings?.contentRoot ?? process.env.TARIC_CONTENT_ROOT ?? (authorityPath ? resolve(dirname(authorityPath), "content") : undefined)
                if (!contentRoot) throw new TaricOperationError("authorized_solver_transport_unavailable", "Authorized Solver requires a trusted local Taric content root")
                await new TaricArtifactService({ host: sessionHost }).bindSession({ sessionId: taskSessionId, root: resolve(contentRoot, taskSessionId), mode: "host-session" })
                const work = new TaricAuthorityWorkService({ host: sessionHost, policyDigest })
                // The model transport itself is host-mediated and may wait for
                // several minutes. Keep the initial lease longer than the
                // bounded bridge request; action execution renews it again
                // before every governed target request.
                const claimed = await work.claim({ premise, agentId, taskSessionId, ttlMs: 15 * 60_000 })
                let activeRun = claimed
                let recovered: Awaited<ReturnType<TaricAuthorityWorkService["checkpoint"]>>
                try {
                    activeRun = await work.transition(premise, claimed, "running", `bw-start-${crypto.randomUUID()}`)
                    const contextSnapshotId = Bun.randomUUIDv7()
                    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(context)).digest("hex")}`
                    recovered = await work.checkpoint({
                        premise, authorityRun: activeRun, piSessionId: agentId, contextSnapshotId, sourceReadSeq: contextReadSeq,
                        sourceContext: { snapshotId: context.context_snapshot_id, readSeq: contextReadSeq, contentDigest: digest },
                        completedSteps: [], nextSteps: ["Inspect the authorized Resource using challenge_authorized_http."], observationRefs: [], evidenceRefs: [], unresolvedWork: [],
                    })
                    activeRun = await work.transition(premise, activeRun, "running", `bw-checkpoint-ready-${crypto.randomUUID()}`)
                } catch (error) {
                    await work.transition(premise, activeRun, "failed", `bw-start-failed-${crypto.randomUUID()}`).catch(() => {})
                    throw error
                }
                const preparedProjection = {
                    ...projection,
                    authority: {
                        ...projection.authority,
                        context: context.items.map((item) => record(item)),
                    },
                }
                return { projection: preparedProjection, run: recovered.run }
            }
            throw new TaricOperationError("work_item_unavailable", "No admitted queued WorkItem is available for an authorized Solver")
        },
        async renewWorkRun(input) {
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === input.challengeId)
            const projection = await this.read(input.challengeId)
            if (!binding || !projection) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun projection is unavailable")
            const host = await hostFor(binding)
            const packet = operationData(await host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation }))
            const run = record(packet.run)
            const owner = record(run.owner)
            if (run.run_id !== input.workRunId || run.generation !== input.generation || run.status !== "running" || owner.agent_id !== input.agentId) throw new TaricOperationError("stale_version", "Authorized Solver WorkRun lease is no longer current")
            const premise = premiseForRun(host.getBinding(), input.challengeId, projection, run)
            if (premise.resourceId !== input.resourceId) throw new TaricOperationError("authorization_error", "Authorized Solver lease resource does not match its WorkItem")
            const sessionHost = await hostFor(binding, String(run.task_session_ref))
            await new TaricAuthorityWorkService({ host: sessionHost, policyDigest: premise.scopePolicyDigest }).renew(premise, run, 60_000)
        },
        async finishWorkRun(input) {
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === input.challengeId)
            const projection = await this.read(input.challengeId)
            if (!binding || !projection) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun projection is unavailable")
            const host = await hostFor(binding)
            const packet = operationData(await host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation }))
            const run = record(packet.run)
            const owner = record(run.owner)
            if (run.run_id !== input.workRunId || run.generation !== input.generation || run.status !== "running" || owner.agent_id !== input.agentId) throw new TaricOperationError("stale_version", "Authorized Solver WorkRun is no longer current")
            const premise = premiseForRun(host.getBinding(), input.challengeId, projection, run)
            if (premise.resourceId !== input.resourceId) throw new TaricOperationError("authorization_error", "Authorized Solver completion resource does not match its WorkItem")
            const sessionHost = await hostFor(binding, String(run.task_session_ref))
            await new TaricAuthorityWorkService({ host: sessionHost, policyDigest: premise.scopePolicyDigest }).transition(premise, run, "completed", `bw-complete-${crypto.randomUUID()}`)
        },
        async failWorkRun(input) {
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === input.challengeId)
            const projection = await this.read(input.challengeId)
            if (!binding || !projection) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkRun projection is unavailable")
            const host = await hostFor(binding)
            const packet = operationData(await host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation }))
            const run = record(packet.run)
            const owner = record(run.owner)
            if (run.run_id !== input.workRunId || run.generation !== input.generation || owner.agent_id !== input.agentId || !["running", "checkpointed", "blocked"].includes(String(run.status))) throw new TaricOperationError("stale_version", "Authorized Solver WorkRun is no longer current")
            const premise = premiseForRun(host.getBinding(), input.challengeId, projection, run)
            if (premise.resourceId !== input.resourceId) throw new TaricOperationError("authorization_error", "Authorized Solver failure resource does not match its WorkItem")
            const sessionHost = await hostFor(binding, String(run.task_session_ref))
            await new TaricAuthorityWorkService({ host: sessionHost, policyDigest: premise.scopePolicyDigest }).transition(premise, run, "failed", `bw-failed-${crypto.randomUUID()}`)
        },
        async executeAction(input) {
            const binding = (await config.listAuthorizedProjectBindings()).find((item) => item.challengeId === input.challengeId)
            if (!binding) throw new TaricOperationError("authorization_error", "Authorized Solver binding is unavailable")
            const host = await hostFor(binding)
            const policyDigest = String((await this.read(input.challengeId))?.authority.scopeRevisions[0]?.policy_digest ?? "")
            if (!/^sha256:[a-f0-9]{64}$/.test(policyDigest)) throw new TaricOperationError("incomplete_authority_snapshot", "Authorized Solver policy digest is unavailable")
            const packet = operationData(await host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation }))
            const run = record(packet.run)
            const owner = record(run.owner)
            const projection = await this.read(input.challengeId)
            const checkpoint = record(packet.checkpoint)
            const workItem = projection?.authority.work.find((item) => item.id === run.work_item_ref)
            const resource = projection?.authority.resources.find((item) => item.id === input.resourceId)
            const workResourceRefs = Array.isArray(workItem?.resource_refs) ? workItem.resource_refs.filter((value): value is string => typeof value === "string") : []
            const bindsResource = Boolean(resource && workResourceRefs.some((ref) => ref === resource.id || projection?.authority.resourceRevisions.some((revision) => revision.id === ref && revision.resource_ref === resource.id)))
            if (run.run_id !== input.workRunId || run.generation !== input.generation || owner.agent_id !== input.agentId || run.status !== "running" || run.task_session_ref !== packet.task_session_ref || checkpoint.work_item_ref !== run.work_item_ref || !workItem || !bindsResource) throw new TaricOperationError("stale_version", "Authorized Solver WorkRun fence is no longer current")
            const identity = resource ? record(resource.identity) : undefined
            if (!identity || typeof identity.origin !== "string" || typeof identity.path !== "string") throw new TaricOperationError("incomplete_authority_snapshot", "Authorized WorkItem Resource identity is unavailable")
            const targetBaseUrl = new URL(identity.path, identity.origin).toString()
            const sessionHost = await hostFor(binding, String(run.task_session_ref))
            const service = new TaricAuthorityActionService({
                host: sessionHost,
                policyDigest,
                allowAuthorizedTargetExecution: true,
                targetBaseUrl,
                scopeService: new TaricAuthorityScopeService({ host: sessionHost }),
                network: { evaluateEgress: () => ({ allowed: true, reason: "canonical ScopeRevision policy is enforced by the action service", normalizedUrls: [] }), maxResponseBytes: 1024 * 1024 },
            })
            const { rationale, ...request } = input.request
            const result = await service.execute({ request, rationale, includeResponseBody: true }, {
                engagementId: host.getBinding().engagementId,
                workRunId: input.workRunId,
                attemptId: String(run.attempt_ref),
                generation: input.generation,
                ownerHost: host.getBinding().hostPrincipalId,
                ownerAgentId: input.agentId,
                scopeId: String(run.scope_ref),
                scopeVersion: Number(run.scope_version),
                scopeRevisionId: String(run.scope_revision_ref),
                taskSessionId: String(run.task_session_ref),
            })
            return { statusCode: result.execution.statusCode ?? 0, outcome: result.canonicalStatus, ...(result.responseBodyBase64 ? { bodyBase64: result.responseBodyBase64 } : {}), diagnostic: result.execution.failureCode ?? "canonical_action_audit_recorded" }
        },
        async close() { for (const host of hosts.values()) await (await host).close(); hosts.clear() },
    }
}
