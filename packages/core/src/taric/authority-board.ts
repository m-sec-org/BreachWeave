import type { TaricHostModule } from "./host-module"
import type { TaricAuthorityWorkService } from "./authority-work-service"
import type { GovernanceQueryDiagnostics, GovernanceQueryLimits, GovernanceQueryResult } from "./governance-query-reader"
import type { RecoveryPremise } from "./recovery-locator"
import { readGovernancePages } from "./governance-query-reader"
import { requireOpaqueHostId, requireTaricUuid } from "./host-identity"
import { TaricOperationError } from "./types"

export type AuthorityBoardRefreshReason = "startup" | "manual" | "notification" | "reconnect" | "scheduling"
export type AuthorityBoardStatus = "idle" | "refreshing" | "healthy" | "blocked" | "closed"

export interface AuthorityBoardRecord {
    id: string
    kind: string
    version?: number
    status?: string
    trustLevel?: "L1" | "L2"
    resourceId?: string
    resourceIds?: string[]
    revision?: number
    acceptanceCriteriaCount?: number
}

export interface AuthorityBoardSnapshot {
    format: "breachweave-authority-board/1"
    projectId: string
    engagementId: string
    status: AuthorityBoardStatus
    revision: number
    readSeq?: number
    refreshedAt?: string
    reason?: AuthorityBoardRefreshReason
    errorCode?: string
    connectionStale: boolean
    freshnessAllowsScheduling: boolean
    /** A fresh projection cannot grant authorization or bypass contract readiness. */
    launchAuthorized: false
    authorizationGate: "external_control_plane_contract_required"
    projectManifestBound: boolean
    completeness: {
        recordVersions: "same_watermark"
        visibility: "current_recall_visible_projection"
        workTrust: "host_L1_and_L2"
        contextTrust: "model_L2_only"
        coverageGate: "not_read_or_inferred"
        entireEngagementReconstructed: false
        budget: "aggregate_across_four_raw_query_surfaces"
    }
    records: { context: AuthorityBoardRecord[]; work: AuthorityBoardRecord[]; resources: AuthorityBoardRecord[]; revisions: AuthorityBoardRecord[] }
    queries?: { context: GovernanceQueryDiagnostics; work: GovernanceQueryDiagnostics; resources: GovernanceQueryDiagnostics; revisions: GovernanceQueryDiagnostics }
}

/** Trusted host membership inventory; never populate this from a request body. */
export interface AuthorityProjectManifest {
    resourceIds: readonly string[]
    workItemIds: readonly string[]
}

export interface AuthorityBoardOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "query">
    work: Pick<TaricAuthorityWorkService, "queryWork">
    limits?: Partial<GovernanceQueryLimits>
    contextBudget?: number
    projectManifest?: AuthorityProjectManifest
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Authority board query returned an invalid record")
    return value as Record<string, unknown>
}

function responseData(value: unknown): Record<string, unknown> {
    const response = record(value)
    return response.ok === true ? record(response.data) : response
}

function metadata(value: Record<string, unknown>): AuthorityBoardRecord {
    const id = requireTaricUuid(value.id, "board record id")
    if (typeof value.kind !== "string" || !/^[a-z_]{1,64}$/.test(value.kind)) throw new TaricOperationError("validation_error", "Authority board record kind is invalid")
    const output: AuthorityBoardRecord = { id, kind: value.kind }
    if (typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 0) output.version = value.version
    if (typeof value.status === "string" && /^[a-z_]{1,64}$/.test(value.status)) output.status = value.status
    if (value.trust_level === "L1" || value.trust_level === "L2") output.trustLevel = value.trust_level
    if (value.resource_ref !== undefined) output.resourceId = requireTaricUuid(value.resource_ref, "board resource reference")
    if (value.resource_refs !== undefined) {
        if (!Array.isArray(value.resource_refs) || value.resource_refs.length > 256) throw new TaricOperationError("validation_error", "Authority board Resource references are invalid")
        output.resourceIds = value.resource_refs.map((ref) => requireTaricUuid(ref, "board resource reference"))
    }
    if (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) output.revision = value.revision
    if (Array.isArray(value.acceptance_criteria)) output.acceptanceCriteriaCount = value.acceptance_criteria.length
    return output
}

function complete(result: GovernanceQueryResult<Record<string, unknown>>, expectedReadSeq?: number): void {
    if (result.diagnostics.status !== "complete" || !result.diagnostics.snapshotPinned || result.diagnostics.hasMore || result.nextCursor !== undefined || (expectedReadSeq !== undefined && result.readSeq !== expectedReadSeq)) throw new TaricOperationError("incomplete_authority_snapshot", "Authority board requires complete queries at one watermark")
}

function projectionDiagnostics(value: GovernanceQueryDiagnostics): GovernanceQueryDiagnostics {
    const { lastCursor: _lastCursor, nextCursor: _nextCursor, ...safe } = value
    return safe
}

/**
 * Notifications invalidate freshness; only full pinned authority reads replace
 * the board. No local file, notification payload or cached task list supplies
 * Work truth. The visible set is subject to Core's current recall filtering and
 * is never represented as the entire Engagement or as a Coverage gate result.
 */
export class TaricAuthorityBoard {
    private readonly limits: GovernanceQueryLimits
    private snapshotValue: AuthorityBoardSnapshot
    private refreshPromise: Promise<AuthorityBoardSnapshot> | undefined
    private refreshAgain = false
    private nextReason: AuthorityBoardRefreshReason = "startup"
    private connectionEpoch = 0
    private closed = false
    private manifest: { resources: Set<string>; work: Set<string> } | undefined
    private manifestEpoch = 0

    constructor(private readonly options: AuthorityBoardOptions) {
        const binding = options.host.getBinding()
        requireOpaqueHostId(binding.projectId, "projectId")
        requireTaricUuid(binding.engagementId, "engagementId")
        this.limits = { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }
        for (const key of ["maxPages", "maxRecords", "maxBytes"] as const) {
            const value = options.limits?.[key]
            if (value === undefined) continue
            if (!Number.isSafeInteger(value) || value < 1 || value > this.limits[key]) throw new TaricOperationError("validation_error", "Board limits may only tighten the default aggregate bounds")
            this.limits[key] = value
        }
        if (options.projectManifest) this.manifest = this.parseManifest(options.projectManifest)
        const budget = options.contextBudget ?? 50_000
        if (!Number.isSafeInteger(budget) || budget < 256 || budget > 50_000) throw new TaricOperationError("validation_error", "Authority board context budget is invalid")
        this.snapshotValue = {
            format: "breachweave-authority-board/1", projectId: binding.projectId, engagementId: binding.engagementId, status: "idle", revision: 0,
            connectionStale: false, freshnessAllowsScheduling: false, launchAuthorized: false, authorizationGate: "external_control_plane_contract_required", projectManifestBound: this.manifest !== undefined,
            completeness: { recordVersions: "same_watermark", visibility: "current_recall_visible_projection", workTrust: "host_L1_and_L2", contextTrust: "model_L2_only", coverageGate: "not_read_or_inferred", entireEngagementReconstructed: false, budget: "aggregate_across_four_raw_query_surfaces" },
            records: { context: [], work: [], resources: [], revisions: [] },
        }
    }

    snapshot(): AuthorityBoardSnapshot { return structuredClone(this.snapshotValue) }

    updateProjectManifest(manifest: AuthorityProjectManifest): void {
        if (this.closed) throw new TaricOperationError("authority_board_closed", "Authority board is closed")
        this.manifest = this.parseManifest(manifest)
        this.manifestEpoch += 1
        // Never retain metadata that is no longer in the current project inventory.
        this.snapshotValue = { ...this.snapshotValue, status: "blocked", projectManifestBound: true, freshnessAllowsScheduling: false, records: { context: [], work: [], resources: [], revisions: [] }, queries: undefined, errorCode: "project_manifest_changed" }
    }

    assertProjectPremise(premise: RecoveryPremise): void {
        const binding = this.options.host.getBinding()
        if (!this.manifest || Object.keys(binding).some((key) => binding[key as keyof typeof binding] !== premise.binding[key as keyof typeof binding]) || !this.manifest.resources.has(premise.resourceId) || !this.manifest.work.has(premise.workItemId)) throw new TaricOperationError("authorization_error", "Work premise is outside the trusted project manifest")
        const item = this.snapshotValue.records.work.find((entry) => entry.id === premise.workItemId)
        const revision = this.snapshotValue.records.revisions.find((entry) => entry.id === premise.resourceRevisionId)
        if (!item?.resourceIds?.includes(premise.resourceId) || revision?.resourceId !== premise.resourceId) throw new TaricOperationError("authorization_error", "Work premise does not match the project authority projection")
    }

    initialize(): Promise<AuthorityBoardSnapshot> { return this.refresh("startup") }
    manualRefresh(): Promise<AuthorityBoardSnapshot> { return this.refresh("manual") }
    notify(): Promise<AuthorityBoardSnapshot> { return this.refresh("notification") }
    reconnect(): Promise<AuthorityBoardSnapshot> { return this.refresh("reconnect") }

    markConnectionStale(reason: "disconnect" | "slow_consumer" | "token_revoked" | "invalid_cursor" = "disconnect"): void {
        if (this.closed) return
        this.connectionEpoch += 1
        this.snapshotValue = { ...this.snapshotValue, status: "blocked", connectionStale: true, freshnessAllowsScheduling: false, errorCode: reason }
    }

    /** Always refetch, even if the current view looks fresh or no signal arrived. */
    async refreshForScheduling(): Promise<AuthorityBoardSnapshot> {
        const snapshot = await this.refresh("scheduling")
        if (!snapshot.freshnessAllowsScheduling || snapshot.status !== "healthy" || snapshot.connectionStale) throw new TaricOperationError("authority_board_stale", "Authority board cannot schedule from an incomplete or stale projection")
        return snapshot
    }

    async refresh(reason: AuthorityBoardRefreshReason): Promise<AuthorityBoardSnapshot> {
        if (this.closed) throw new TaricOperationError("authority_board_closed", "Authority board is closed")
        this.nextReason = reason
        this.snapshotValue = { ...this.snapshotValue, status: "refreshing", freshnessAllowsScheduling: false }
        if (this.refreshPromise) { this.refreshAgain = true; return this.refreshPromise }
        this.refreshPromise = this.drain()
        return this.refreshPromise
    }

    close(): void {
        this.closed = true
        this.refreshAgain = false
        this.snapshotValue = { ...this.snapshotValue, status: "closed", freshnessAllowsScheduling: false }
    }

    private async drain(): Promise<AuthorityBoardSnapshot> {
        try {
            do {
                this.refreshAgain = false
                const reason = this.nextReason
                const epoch = this.connectionEpoch
                const manifestEpoch = this.manifestEpoch
                const pending = await this.readCompleteSnapshot()
                if (this.closed) return this.snapshot()
                if (manifestEpoch !== this.manifestEpoch) throw new TaricOperationError("project_manifest_changed", "Project manifest changed during authority refresh")
                if (this.snapshotValue.readSeq !== undefined && pending.readSeq < this.snapshotValue.readSeq) throw new TaricOperationError("stale_version", "Authority board watermark moved backwards")
                const connectionStale = this.snapshotValue.connectionStale && !(reason === "reconnect" && epoch === this.connectionEpoch)
                const healthy = !connectionStale && epoch === this.connectionEpoch && !this.refreshAgain
                // Publish all four complete surfaces together; failed reads keep
                // the previous projection intact and only change readiness.
                this.snapshotValue = {
                    ...this.snapshotValue, ...pending, reason, revision: this.snapshotValue.revision + 1, refreshedAt: new Date().toISOString(),
                    status: this.refreshAgain ? "refreshing" : healthy ? "healthy" : "blocked", connectionStale, freshnessAllowsScheduling: healthy, errorCode: connectionStale ? "connection_stale" : undefined,
                }
            } while (this.refreshAgain)
            return this.snapshot()
        } catch (error) {
            const code = error instanceof TaricOperationError ? error.code : "authority_query_failed"
            this.snapshotValue = { ...this.snapshotValue, status: this.closed ? "closed" : "blocked", freshnessAllowsScheduling: false, errorCode: /^[A-Za-z0-9_:-]{1,128}$/.test(code) ? code : "authority_query_failed" }
            throw error
        } finally { this.refreshPromise = undefined }
    }

    private async readCompleteSnapshot(): Promise<{ readSeq: number; records: AuthorityBoardSnapshot["records"]; queries: NonNullable<AuthorityBoardSnapshot["queries"]> }> {
        const binding = this.options.host.getBinding()
        if (binding.projectId !== this.snapshotValue.projectId || binding.engagementId !== this.snapshotValue.engagementId) throw new TaricOperationError("authorization_error", "Authority board host binding changed")
        const manifest = this.manifest
        if (!manifest) throw new TaricOperationError("project_manifest_required", "Authority board requires a trusted non-empty project manifest")
        const spent = { maxPages: 0, maxRecords: 0, maxBytes: 0 }
        const remaining = (): GovernanceQueryLimits => {
            const limits = { maxPages: this.limits.maxPages - spent.maxPages, maxRecords: this.limits.maxRecords - spent.maxRecords, maxBytes: this.limits.maxBytes - spent.maxBytes }
            if (Object.values(limits).some((value) => value < 1)) throw new TaricOperationError("authority_board_budget_exceeded", "Authority board aggregate query budget is exhausted")
            return limits
        }
        const consume = (result: GovernanceQueryResult<Record<string, unknown>>, readSeq?: number): void => {
            complete(result, readSeq)
            spent.maxPages += result.diagnostics.pages
            spent.maxRecords += result.diagnostics.records
            spent.maxBytes += result.diagnostics.bytes
            if (spent.maxPages > this.limits.maxPages || spent.maxRecords > this.limits.maxRecords || spent.maxBytes > this.limits.maxBytes) throw new TaricOperationError("authority_board_budget_exceeded", "Authority board aggregate query budget was exceeded")
        }
        let contextSnapshotId: string | undefined
        const context = await readGovernancePages({
            kind: "context", binding: { principalId: binding.modelPrincipalId, engagementId: binding.engagementId, filters: { include_candidates: false }, pageSize: this.options.contextBudget ?? 50_000 },
            limits: remaining(), snapshotPinned: true, pageKey: "items", cursorKey: "cursor", pageSizeInput: "budget", readSeqInput: "read_seq",
            query: async (request) => {
                const page = responseData(await this.options.host.query("context.query", request))
                const id = requireOpaqueHostId(page.context_snapshot_id, "Context snapshot id")
                if (contextSnapshotId !== undefined && id !== contextSnapshotId) throw new TaricOperationError("invalid_cursor", "Context snapshot changed between pages")
                contextSnapshotId = id
                if (page.truncated_count !== 0 || (page.cursor === undefined && (page.omitted_count !== 0 || page.omitted_count_complete !== true || page.omitted_as_unexamined !== false))) throw new TaricOperationError("context_truncated", "Context projection is incomplete")
                return page
            },
        })
        consume(context)
        context.diagnostics = { ...context.diagnostics, visibility: "recall_filtered", completeDomain: false }
        const readSeq = context.readSeq
        const work = await this.options.work.queryWork([], false, readSeq, remaining())
        consume(work, readSeq)
        const readResources = async (kind: "resource" | "resource_revision") => {
            const result = await readGovernancePages({
                kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind, include_candidates: true }, pageSize: 50, readSeq },
                limits: remaining(), snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("resource.query", request),
                parseRecord: (value) => {
                    const item = record(value)
                    if (item.kind !== kind || !["L1", "L2"].includes(String(item.trust_level))) throw new TaricOperationError("authorization_error", "Authority board Resource query is not canonical")
                    return item
                },
            })
            consume(result, readSeq)
            result.diagnostics = { ...result.diagnostics, visibility: "recall_filtered", completeDomain: false }
            return result
        }
        const resources = await readResources("resource")
        const revisions = await readResources("resource_revision")
        const projectResources = resources.records.filter((entry) => manifest.resources.has(String(entry.id)))
        const projectWork = work.records.filter((entry) => manifest.work.has(String(entry.id)))
        if (projectResources.length !== manifest.resources.size || projectWork.length !== manifest.work.size) throw new TaricOperationError("project_manifest_unresolved", "Project membership is not completely visible in the authority snapshot")
        const projectRevisions = revisions.records.filter((entry) => typeof entry.resource_ref === "string" && manifest.resources.has(entry.resource_ref))
        const revisionIds = new Set(projectRevisions.map((entry) => String(entry.id)))
        for (const item of projectWork) {
            if (!Array.isArray(item.resource_refs) || item.resource_refs.length === 0 || item.resource_refs.some((ref) => typeof ref !== "string" || !manifest.resources.has(ref) && !revisionIds.has(ref)) || (item.depends_on !== undefined && (!Array.isArray(item.depends_on) || item.depends_on.some((ref) => typeof ref !== "string" || !manifest.work.has(ref))))) throw new TaricOperationError("authorization_error", "Project Work references cross the trusted manifest boundary")
        }
        const scopedContext = context.records.filter((entry) => this.contextBelongsToProject(entry, manifest, revisionIds))
        return {
            readSeq,
            records: { context: scopedContext.map(metadata), work: projectWork.map(metadata), resources: projectResources.map(metadata), revisions: projectRevisions.map(metadata) },
            queries: { context: projectionDiagnostics(context.diagnostics), work: projectionDiagnostics(work.diagnostics), resources: projectionDiagnostics(resources.diagnostics), revisions: projectionDiagnostics(revisions.diagnostics) },
        }
    }

    private parseManifest(value: AuthorityProjectManifest): { resources: Set<string>; work: Set<string> } {
        const parse = (ids: readonly string[], field: string): Set<string> => {
            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1024) throw new TaricOperationError("project_manifest_required", "Project manifest membership must be non-empty and bounded")
            const parsed = ids.map((id) => requireTaricUuid(id, field))
            if (new Set(parsed).size !== parsed.length) throw new TaricOperationError("validation_error", "Project manifest membership contains duplicate identities")
            return new Set(parsed)
        }
        return { resources: parse(value.resourceIds, "manifest resourceId"), work: parse(value.workItemIds, "manifest workItemId") }
    }

    private contextBelongsToProject(value: Record<string, unknown>, manifest: { resources: Set<string>; work: Set<string> }, revisions: Set<string>): boolean {
        const membership = value.kind === "resource" ? manifest.resources : value.kind === "resource_revision" ? revisions : value.kind === "work_item" ? manifest.work : undefined
        if (membership && !membership.has(String(value.id))) return false
        let anchored = membership !== undefined
        for (const [fields, allowed] of [
            [["resource_ref", "target_resource_ref", "resource_refs", "tested_resource_refs", "protected_resource_refs"], manifest.resources],
            [["resource_revision_ref", "resource_revision_refs", "protected_resource_revision_refs"], revisions],
            [["work_item_ref", "work_item_id"], manifest.work],
        ] as const) for (const field of fields) {
            const raw = value[field]
            if (raw === undefined) continue
            const refs = Array.isArray(raw) ? raw : [raw]
            if (refs.length === 0) continue
            if (refs.some((ref) => typeof ref !== "string" || !allowed.has(ref))) return false
            anchored = true
        }
        return anchored
    }
}
