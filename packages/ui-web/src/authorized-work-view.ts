export interface AuthorizedWorkItemView {
    id: string
    status: string
    resourceRefs: string[]
    updatedAt?: string
}

export interface AuthorizedCoverageCellView {
    id: string
    resourceRef: string
    resourceRevisionRef: string
    category: string
    status: string
    evidenceRefs: string[]
    limitations: string[]
}

export interface AuthorizedReportIndexView {
    id: string
    artifactRef: string
    artifactDigest: string
    evidenceRefs: string[]
    committedAt?: string
}

const WORK_STATUSES = new Set(["queued", "claimed", "in_progress", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"])

/** Expose only lifecycle metadata from the canonical Work projection. */
export function projectAuthorizedWorkItems(records: Record<string, unknown>[]): AuthorizedWorkItemView[] {
    return records.flatMap((record) => {
        if (record.kind !== "work_item" || !["L1", "L2"].includes(String(record.trust_level))) return []
        if (typeof record.id !== "string" || !record.id.trim() || !WORK_STATUSES.has(String(record.status))) return []

        const resourceRefs = Array.isArray(record.resource_refs)
            ? record.resource_refs.filter((value): value is string => typeof value === "string")
            : []

        return [{
            id: record.id,
            status: String(record.status),
            resourceRefs,
            ...(typeof record.updated_at === "string" ? { updatedAt: record.updated_at } : {}),
        }]
    })
}

export function projectAuthorizedCoverage(records: Record<string, unknown>[]): AuthorizedCoverageCellView[] {
    return records.flatMap((record) => {
        if (record.kind !== "coverage" || !["L1", "L2"].includes(String(record.trust_level))) return []
        if (typeof record.id !== "string" || typeof record.resource_ref !== "string" || typeof record.resource_revision_ref !== "string" || typeof record.test_category !== "string" || typeof record.status !== "string") return []
        return [{
            id: record.id,
            resourceRef: record.resource_ref,
            resourceRevisionRef: record.resource_revision_ref,
            category: record.test_category,
            status: record.status,
            evidenceRefs: Array.isArray(record.evidence_refs) ? record.evidence_refs.filter((value): value is string => typeof value === "string") : [],
            limitations: Array.isArray(record.limitations) ? record.limitations.filter((value): value is string => typeof value === "string") : [],
        }]
    })
}

export function projectAuthorizedReports(records: Record<string, unknown>[]): AuthorizedReportIndexView[] {
    return records.flatMap((record) => {
        if (record.kind !== "report_snapshot" || !["L1", "L2"].includes(String(record.trust_level))) return []
        if (typeof record.id !== "string" || typeof record.report_artifact_ref !== "string" || typeof record.report_artifact_digest !== "string") return []
        return [{
            id: record.id,
            artifactRef: record.report_artifact_ref,
            artifactDigest: record.report_artifact_digest,
            evidenceRefs: Array.isArray(record.evidence_refs) ? record.evidence_refs.filter((value): value is string => typeof value === "string") : [],
            ...(typeof record.committed_at === "string" ? { committedAt: record.committed_at } : {}),
        }]
    })
}
