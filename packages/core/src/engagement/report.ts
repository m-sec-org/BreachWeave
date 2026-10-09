// Engagement report renderer + exporter (Slice 3).
//
// Turns findings.ndjson into (1) a human-readable Markdown report and (2) a
// SARIF 2.1.0 log for CI gating / ticketing. Pure render/build logic is SDK-free
// and time-injected (meta.generatedAt); only writeEngagementReport touches disk
// (Bun.file / Bun.write). Idempotent: report.md / report.sarif.json are overwritten.

import { join } from "path"
import { PENTEST_WORKSPACE_FILES } from "../config/tools/pentest-workspace"
import { deriveSeverity, parseFindingsNdjson, severityToSarifLevel, type ReportFinding, type SarifLevel, type Severity } from "./finding"

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"
const SARIF_TOOL_NAME = "BreachWeave"

const REPORT_MARKDOWN_FILE = "report.md"
const REPORT_SARIF_FILE = "report.sarif.json"

/** Severity ordering (most → least severe) for grouping and counts. */
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"]

export interface ReportMeta {
    engagementId: string
    /** Injected timestamp (ISO string) — pure functions never call `new Date()`. */
    generatedAt: string
    allowedTargets?: string[]
}

export interface WriteEngagementReportResult {
    markdownPath: string
    sarifPath: string
    count: number
}

// SARIF 2.1.0 minimal shape (only what we emit).
export interface SarifRule {
    id: string
    name: string
}

export interface SarifResult {
    ruleId: string
    level: SarifLevel
    message: { text: string }
    locations: Array<{
        physicalLocation: {
            artifactLocation: { uri: string }
            region?: { snippet: { text: string } }
        }
    }>
    properties: {
        confidence?: number
        status: string
        severity: Severity
        evidence_refs: string[]
        hypothesis_id: string
    }
}

export interface SarifLog {
    version: "2.1.0"
    $schema: string
    runs: Array<{
        tool: { driver: { name: string; rules: SarifRule[] } }
        results: SarifResult[]
    }>
}

function countBySeverity(findings: ReportFinding[]): Record<Severity, number> {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const finding of findings) {
        counts[deriveSeverity(finding)] += 1
    }
    return counts
}

function countByStatus(findings: ReportFinding[]): Record<ReportFinding["status"], number> {
    const counts: Record<ReportFinding["status"], number> = { candidate: 0, verified: 0, rejected: 0 }
    for (const finding of findings) {
        counts[finding.status] += 1
    }
    return counts
}

function renderExecutiveSummary(findings: ReportFinding[], meta: ReportMeta): string {
    const severityCounts = countBySeverity(findings)
    const statusCounts = countByStatus(findings)
    const lines = [
        "## Executive Summary",
        "",
        `- engagement: ${meta.engagementId}`,
        `- generated_at: ${meta.generatedAt}`,
        `- total_findings: ${findings.length}`,
    ]
    if (meta.allowedTargets && meta.allowedTargets.length > 0) {
        lines.push(`- allowed_targets: ${meta.allowedTargets.join(", ")}`)
    }
    lines.push("", "### By Severity", "", "| severity | count |", "| --- | --- |")
    for (const severity of SEVERITY_ORDER) {
        lines.push(`| ${severity} | ${severityCounts[severity]} |`)
    }
    lines.push("", "### By Status", "", "| status | count |", "| --- | --- |")
    for (const status of ["verified", "candidate", "rejected"] as const) {
        lines.push(`| ${status} | ${statusCounts[status]} |`)
    }
    return lines.join("\n")
}

function renderFindingDetail(finding: ReportFinding): string {
    const severity = deriveSeverity(finding)
    const lines = [
        `### ${finding.kind} — ${finding.entry_point}`,
        "",
        `- severity: ${severity}`,
        `- confidence: ${typeof finding.confidence === "number" ? finding.confidence : "-"}`,
        `- status: ${finding.status}`,
        `- target: ${finding.target}`,
        `- entry_point: ${finding.entry_point}`,
        `- hypothesis: ${finding.hypothesis}`,
        `- hypothesis_id: ${finding.hypothesis_id}`,
        `- source_agent: ${finding.source_agent}`,
        `- source_artifact: ${finding.source_artifact}`,
        `- evidence: ${finding.evidence || "-"}`,
    ]

    const evidenceRefs = finding.evidence_refs.length > 0 ? finding.evidence_refs.map((ref) => `  - ${ref}`).join("\n") : "  - none"
    lines.push("- evidence_refs:", evidenceRefs)

    if (finding.request) {
        lines.push("- request:", "```http", finding.request, "```")
    }
    if (finding.response) {
        lines.push("- response:", "```http", finding.response, "```")
    }
    lines.push(`- remediation: ${finding.remediation || "-"}`)
    if (finding.notes) {
        lines.push(`- notes: ${finding.notes}`)
    }
    lines.push(`- timestamp: ${finding.timestamp}`)
    return lines.join("\n")
}

/**
 * Render a human-readable Markdown engagement report.
 *
 * ① Executive Summary (severity + status count tables)
 * ② Findings grouped by severity (most → least severe), each with confidence /
 *    status / target / entry_point / evidence / evidence_refs / remediation /
 *    hypothesis_id traceability. Empty input yields a placeholder report.
 */
export function renderReportMarkdown(findings: ReportFinding[], meta: ReportMeta): string {
    const header = `# Engagement Report: ${meta.engagementId}`

    if (findings.length === 0) {
        return [header, "", "## Executive Summary", "", `- generated_at: ${meta.generatedAt}`, "- total_findings: 0", "", "_No findings recorded for this engagement._", ""].join("\n")
    }

    const sections = [header, "", renderExecutiveSummary(findings, meta), "", "## Findings"]

    for (const severity of SEVERITY_ORDER) {
        const group = findings.filter((finding) => deriveSeverity(finding) === severity)
        if (group.length === 0) continue
        sections.push("", `### Severity: ${severity} (${group.length})`)
        for (const finding of group) {
            sections.push("", renderFindingDetail(finding))
        }
    }

    return `${sections.join("\n")}\n`
}

function buildSarifRules(findings: ReportFinding[]): SarifRule[] {
    const seen = new Set<string>()
    const rules: SarifRule[] = []
    for (const finding of findings) {
        if (seen.has(finding.kind)) continue
        seen.add(finding.kind)
        rules.push({ id: finding.kind, name: finding.kind })
    }
    return rules
}

function buildSarifResult(finding: ReportFinding): SarifResult {
    const severity = deriveSeverity(finding)
    const result: SarifResult = {
        ruleId: finding.kind,
        level: severityToSarifLevel(severity),
        message: { text: finding.hypothesis || finding.kind },
        locations: [
            {
                physicalLocation: {
                    artifactLocation: { uri: finding.target },
                    ...(finding.entry_point ? { region: { snippet: { text: finding.entry_point } } } : {}),
                },
            },
        ],
        properties: {
            status: finding.status,
            severity,
            evidence_refs: finding.evidence_refs,
            hypothesis_id: finding.hypothesis_id,
        },
    }
    if (typeof finding.confidence === "number") {
        result.properties.confidence = finding.confidence
    }
    return result
}

/**
 * Build a SARIF 2.1.0 log from findings.
 *
 * One result per finding (ruleId=kind, level=severityToSarifLevel(severity),
 * message=hypothesis, location.uri=target, entry_point in region snippet,
 * properties carry confidence/status/severity/evidence_refs/hypothesis_id).
 * Rules are deduplicated by kind.
 */
export function toSarif(findings: ReportFinding[], _meta: ReportMeta): SarifLog {
    return {
        version: "2.1.0",
        $schema: SARIF_SCHEMA,
        runs: [
            {
                tool: { driver: { name: SARIF_TOOL_NAME, rules: buildSarifRules(findings) } },
                results: findings.map((finding) => buildSarifResult(finding)),
            },
        ],
    }
}

/**
 * Read findings.ndjson from a workspace and write report.md + report.sarif.json.
 * Idempotent (overwrites). Time is taken from meta.generatedAt.
 */
export async function writeEngagementReport(cwd: string, meta: ReportMeta): Promise<WriteEngagementReportResult> {
    const ndjsonPath = join(cwd, PENTEST_WORKSPACE_FILES.findingsNdjson)
    const content = await Bun.file(ndjsonPath).text().catch(() => "")
    const findings = parseFindingsNdjson(content)

    const markdownPath = join(cwd, REPORT_MARKDOWN_FILE)
    const sarifPath = join(cwd, REPORT_SARIF_FILE)

    await Bun.write(markdownPath, renderReportMarkdown(findings, meta))
    await Bun.write(sarifPath, `${JSON.stringify(toSarif(findings, meta), null, 2)}\n`)

    return { markdownPath, sarifPath, count: findings.length }
}
