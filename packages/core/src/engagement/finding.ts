// Engagement finding: SDK-free shared types + ndjson parsing (Slice 3).
//
// Elevates the plain FindingRecord (document-finding.ts) into an enterprise-grade
// ReportFinding carrying severity / confidence / remediation / request-response
// evidence. Kept free of any `@mariozechner/*` import so the report layer and its
// tests run without the SDK installed. Pure over its inputs (no I/O, no `new Date`).

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export type FindingStatus = "candidate" | "verified" | "rejected"

/** SARIF result level (2.1.0). */
export type SarifLevel = "error" | "warning" | "note"

/**
 * A documented finding as persisted in findings.ndjson.
 *
 * The base fields mirror the existing FindingRecord (document-finding.ts). The
 * optional fields are the Slice 3 additions; older ndjson lines that lack them
 * still parse and fall back through `deriveSeverity`.
 */
export interface ReportFinding {
    target: string
    kind: string
    entry_point: string
    hypothesis: string
    hypothesis_id: string
    status: FindingStatus
    evidence: string
    evidence_refs: string[]
    source_agent: string
    source_artifact: string
    notes: string
    timestamp: string
    // Slice 3 optional enrichment (backward compatible).
    severity?: Severity
    /** Confidence in [0, 1]. */
    confidence?: number
    remediation?: string
    /** Raw HTTP request evidence (optional; evidence_refs may point at a capture file instead). */
    request?: string
    /** Raw HTTP response evidence (optional). */
    response?: string
}

/**
 * Parse findings.ndjson content into ReportFinding[].
 *
 * One JSON object per line; blank lines and malformed lines are tolerated (dropped).
 */
export function parseFindingsNdjson(content: string): ReportFinding[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            try {
                return JSON.parse(line) as ReportFinding
            } catch {
                return undefined
            }
        })
        .filter((record): record is ReportFinding => Boolean(record))
}

/**
 * Derive an effective severity for a finding.
 *
 * If an explicit `severity` is present, use it. Otherwise fall back by status:
 * verified → "high", candidate → "medium", rejected → "info".
 */
export function deriveSeverity(f: ReportFinding): Severity {
    if (f.severity) return f.severity
    if (f.status === "verified") return "high"
    if (f.status === "candidate") return "medium"
    return "info"
}

/** Map a severity to a SARIF 2.1.0 result level. */
export function severityToSarifLevel(s: Severity): SarifLevel {
    if (s === "critical" || s === "high") return "error"
    if (s === "medium") return "warning"
    return "note"
}
