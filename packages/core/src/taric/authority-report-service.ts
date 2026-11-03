import type { TaricHostModule } from "./host-module"
import type { TaricAuthorityCoverageService } from "./authority-coverage-service"
import { readGovernancePages } from "./governance-query-reader"
import type { GovernanceQueryLimits } from "./governance-query-reader"
import { requireTaricUuid } from "./host-identity"
import { TaricOperationError } from "./types"

export interface AuthorityReportServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator">
    coverage: Pick<TaricAuthorityCoverageService, "snapshot">
    limits?: Partial<GovernanceQueryLimits>
}

export interface AuthorityReportSnapshotInput {
    /** Preserve this value when retrying an ambiguous commit. */
    expectedAuthoritySeq: number
    manifestId: string
    manifestDigest: string
    scopeRevisionId: string
    policyDigest: string
    resourceRevisionIds: readonly string[]
    artifactSessionId: string
    artifactRef: string
    idempotencyKey: string
}

export interface AuthorityCloseInput {
    reportSnapshotId: string
    expectedEngagementVersion: number
    expectedAuthoritySeq: number
    reason: string
    idempotencyKey: string
}

export interface AuthorityReopenInput {
    closeDecisionId: string
    expectedEngagementVersion: number
    expectedAuthoritySeq: number
    reason: string
    idempotencyKey: string
}

export interface AuthorityReportProjection {
    engagement: Record<string, unknown>
    reports: Record<string, unknown>[]
    decisions: Record<string, unknown>[]
    latestDecision?: Record<string, unknown>
    closed: boolean
    readSeq: number
    source: "canonical_taric_records"
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Report authority returned an invalid record")
    return value as Record<string, unknown>
}

function data(value: unknown): Record<string, unknown> {
    const response = record(value)
    if (response.ok === false) throw new TaricOperationError(String(record(response.error).code), "Report authority operation rejected")
    return response.ok === true ? record(response.data) : response
}

function digest(value: unknown): string {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TaricOperationError("validation_error", "Report binding requires a SHA-256 digest")
    return value
}

function text(value: string, field: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]|bearer\s+\S+|(?:password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]/i.test(value)) throw new TaricOperationError("validation_error", `Report ${field} is invalid`)
    return value
}

/** Report and close truth lives exclusively in immutable Taric records. */
export class TaricAuthorityReportService {
    private readonly limits: GovernanceQueryLimits

    constructor(private readonly options: AuthorityReportServiceOptions) {
        this.limits = { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }
        for (const key of ["maxPages", "maxRecords", "maxBytes"] as const) if (options.limits?.[key] !== undefined) {
            const value = options.limits[key]!
            if (!Number.isSafeInteger(value) || value < 1 || value > this.limits[key]) throw new TaricOperationError("validation_error", "Report query limits may only tighten aggregate bounds")
            this.limits[key] = value
        }
    }

    async commitSnapshot(input: AuthorityReportSnapshotInput): Promise<Record<string, unknown>> {
        requireTaricUuid(input.manifestId, "manifestId")
        requireTaricUuid(input.scopeRevisionId, "scopeRevisionId")
        digest(input.manifestDigest); digest(input.policyDigest)
        if (!Array.isArray(input.resourceRevisionIds) || !input.resourceRevisionIds.length || input.resourceRevisionIds.length > 1024 || new Set(input.resourceRevisionIds).size !== input.resourceRevisionIds.length) throw new TaricOperationError("validation_error", "Report ResourceRevision references must be non-empty and unique")
        input.resourceRevisionIds.forEach((id) => requireTaricUuid(id, "resourceRevisionId"))
        text(input.artifactSessionId, "Artifact session"); text(input.artifactRef, "Artifact reference"); text(input.idempotencyKey, "idempotency key")
        if (!Number.isSafeInteger(input.expectedAuthoritySeq) || input.expectedAuthoritySeq < 0) throw new TaricOperationError("validation_error", "Report commit requires an explicit authority watermark")
        const coverage = await this.options.coverage.snapshot({ manifestId: input.manifestId, manifestDigest: input.manifestDigest, readSeq: input.expectedAuthoritySeq })
        const gate = coverage.gate
        if (coverage.diagnostics.status !== "complete" || !coverage.diagnostics.completeDomain || coverage.diagnostics.hasMore || coverage.metadata.scope_revision_ref !== input.scopeRevisionId || coverage.metadata.policy_digest !== input.policyDigest || gate.can_close !== true) throw new TaricOperationError("coverage_incomplete", "Report requires complete passing Coverage at the requested ScopeRevision")
        const snapshot = data(await this.options.host.invokeHost("report.snapshot.commit", {
            expected_authority_seq: coverage.readSeq, manifest_ref: input.manifestId, manifest_digest: input.manifestDigest,
            scope_revision_ref: input.scopeRevisionId, resource_revision_refs: [...input.resourceRevisionIds].sort(),
            coverage_read_seq: coverage.readSeq, coverage_snapshot_digest: digest(coverage.snapshotDigest),
            report_artifact_session_id: input.artifactSessionId, report_artifact_ref: input.artifactRef, idempotency_key: input.idempotencyKey,
        }))
        this.assertCanonical(snapshot, "report_snapshot")
        if (snapshot.manifest_ref !== input.manifestId || snapshot.manifest_digest !== input.manifestDigest || snapshot.scope_revision_ref !== input.scopeRevisionId || snapshot.policy_digest !== input.policyDigest || snapshot.coverage_read_seq !== coverage.readSeq || snapshot.authority_read_seq !== coverage.readSeq || snapshot.coverage_snapshot_digest !== coverage.snapshotDigest || snapshot.report_artifact_session_id !== input.artifactSessionId || snapshot.report_artifact_ref !== input.artifactRef || snapshot.coverage_can_close !== true || snapshot.coverage_complete_domain !== true || JSON.stringify(snapshot.resource_revision_refs) !== JSON.stringify([...input.resourceRevisionIds].sort())) throw new TaricOperationError("conflict", "Committed ReportSnapshot binding differs from its request")
        for (const key of ["snapshot_digest", "evidence_snapshot_hash", "report_artifact_digest", "coverage_gate_digest"]) digest(snapshot[key])
        return snapshot
    }

    async close(input: AuthorityCloseInput): Promise<Record<string, unknown>> {
        requireTaricUuid(input.reportSnapshotId, "reportSnapshotId")
        this.validateDecision(input)
        const decision = data(await this.options.host.invokeOperator("engagement.close", { expected_engagement_version: input.expectedEngagementVersion, expected_authority_seq: input.expectedAuthoritySeq, report_snapshot_ref: input.reportSnapshotId, reason: input.reason, idempotency_key: input.idempotencyKey }))
        this.assertCanonical(decision, "close_decision")
        this.assertDecisionAcknowledgement(decision, input, "completed")
        if (decision.decision !== "closed" || decision.report_snapshot_ref !== input.reportSnapshotId) throw new TaricOperationError("conflict", "Canonical close decision does not match its request")
        return decision
    }

    async reopen(input: AuthorityReopenInput): Promise<Record<string, unknown>> {
        requireTaricUuid(input.closeDecisionId, "closeDecisionId")
        this.validateDecision(input)
        const decision = data(await this.options.host.invokeOperator("engagement.reopen", { expected_engagement_version: input.expectedEngagementVersion, expected_authority_seq: input.expectedAuthoritySeq, close_decision_ref: input.closeDecisionId, reason: input.reason, idempotency_key: input.idempotencyKey }))
        this.assertCanonical(decision, "close_decision")
        this.assertDecisionAcknowledgement(decision, input, "active")
        if (decision.decision !== "reopened" || decision.supersedes !== input.closeDecisionId) throw new TaricOperationError("conflict", "Canonical reopen decision does not match its request")
        return decision
    }

    /** No session map or report file is consulted; every reconstruction starts with Taric. */
    async reconstruct(readSeq?: number): Promise<AuthorityReportProjection> {
        const binding = this.options.host.getBinding()
        const spent = { maxPages: 0, maxRecords: 0, maxBytes: 0 }
        const readKind = async (kind: string, readSeq?: number) => {
            const limits = { maxPages: this.limits.maxPages - spent.maxPages, maxRecords: this.limits.maxRecords - spent.maxRecords, maxBytes: this.limits.maxBytes - spent.maxBytes }
            if (Object.values(limits).some((value) => value < 1)) throw new TaricOperationError("incomplete_authority_snapshot", "Report reconstruction query budget exhausted")
            const result = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind, include_candidates: true }, pageSize: 50, readSeq }, limits, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("resource.query", request), parseRecord: (value) => { const item = record(value); this.assertCanonical(item, kind); return item } })
            spent.maxPages += result.diagnostics.pages; spent.maxRecords += result.diagnostics.records; spent.maxBytes += result.diagnostics.bytes
            if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore || result.nextCursor) throw new TaricOperationError("incomplete_authority_snapshot", "Report reconstruction requires exhausted pinned queries")
            return result
        }
        const engagementPage = await readKind("engagement", readSeq)
        const engagement = engagementPage.records.find((entry) => entry.id === binding.engagementId)
        if (!engagement) throw new TaricOperationError("incomplete_authority_snapshot", "Canonical Engagement is absent from the report projection")
        const reports = (await readKind("report_snapshot", engagementPage.readSeq)).records
        const decisions = (await readKind("close_decision", engagementPage.readSeq)).records.sort((left, right) => Number(left.commit_seq) - Number(right.commit_seq))
        let previousDecision: Record<string, unknown> | undefined
        for (const decision of decisions) {
            const snapshot = reports.find((entry) => entry.id === decision.report_snapshot_ref)
            if (!snapshot || snapshot.scope_revision_ref !== decision.scope_revision_ref || snapshot.policy_digest !== decision.policy_digest || snapshot.evidence_snapshot_hash !== decision.evidence_snapshot_hash || snapshot.coverage_snapshot_digest !== decision.coverage_snapshot_digest || snapshot.coverage_read_seq !== decision.snapshot_read_seq || !Array.isArray(snapshot.resource_revision_refs) || !Array.isArray(decision.resource_revision_refs) || JSON.stringify([...snapshot.resource_revision_refs].sort()) !== JSON.stringify([...decision.resource_revision_refs].sort())) throw new TaricOperationError("incomplete_authority_snapshot", "Canonical close decision has an unresolved ReportSnapshot binding")
            if (!["closed", "reopened"].includes(String(decision.decision)) || (decision.decision === "reopened" && (previousDecision?.decision !== "closed" || decision.supersedes !== previousDecision.id)) || (decision.decision === "closed" && previousDecision?.decision === "closed")) throw new TaricOperationError("incomplete_authority_snapshot", "Canonical close and reopen decision history is inconsistent")
            previousDecision = decision
        }
        const latestDecision = decisions.at(-1)
        const closed = engagement.status === "completed"
        if ((closed && latestDecision?.decision !== "closed") || (!closed && latestDecision?.decision === "closed")) throw new TaricOperationError("incomplete_authority_snapshot", "Engagement status differs from its latest canonical close decision")
        return { engagement, reports, decisions, ...(latestDecision ? { latestDecision } : {}), closed, readSeq: engagementPage.readSeq, source: "canonical_taric_records" }
    }

    private validateDecision(input: { expectedEngagementVersion: number; expectedAuthoritySeq: number; reason: string; idempotencyKey: string }): void {
        if (!Number.isSafeInteger(input.expectedEngagementVersion) || input.expectedEngagementVersion < 1 || !Number.isSafeInteger(input.expectedAuthoritySeq) || input.expectedAuthoritySeq < 0) throw new TaricOperationError("validation_error", "Close decision requires explicit Engagement version and authority watermark")
        text(input.reason, "decision reason"); text(input.idempotencyKey, "idempotency key")
    }

    private assertCanonical(value: Record<string, unknown>, kind: string): void {
        requireTaricUuid(value.id, `${kind}Id`)
        if (value.kind !== kind || value.engagement_id !== this.options.host.getBinding().engagementId || !["L1", "L2"].includes(String(value.trust_level))) throw new TaricOperationError("authorization_error", "Report authority record is outside the trusted Engagement")
    }

    private assertDecisionAcknowledgement(decision: Record<string, unknown>, input: { expectedEngagementVersion: number; expectedAuthoritySeq: number }, status: "active" | "completed"): void {
        const engagement = record(decision.engagement)
        this.assertCanonical(engagement, "engagement")
        if (engagement.id !== this.options.host.getBinding().engagementId || engagement.version !== input.expectedEngagementVersion + 1 || engagement.status !== status || decision.expected_authority_seq !== input.expectedAuthoritySeq) throw new TaricOperationError("conflict", "Canonical close decision acknowledgement changed its Engagement or compare-and-set premise")
    }
}
