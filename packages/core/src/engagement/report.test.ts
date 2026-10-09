import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { ReportFinding } from "./finding"
import { renderReportMarkdown, toSarif, writeEngagementReport, type ReportMeta, type SarifLog } from "./report"

const created: string[] = []

async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "engagement-report-"))
    created.push(dir)
    return dir
}

afterEach(async () => {
    while (created.length > 0) {
        const dir = created.pop()!
        await rm(dir, { recursive: true, force: true })
    }
})

const META: ReportMeta = { engagementId: "eng-42", generatedAt: "2026-07-17T00:00:00.000Z", allowedTargets: ["api.corp.com"] }

function makeFinding(overrides?: Partial<ReportFinding>): ReportFinding {
    return {
        target: "https://api.corp.com",
        kind: "sqli",
        entry_point: "/login?user=",
        hypothesis: "time-based SQLi on user param",
        hypothesis_id: "hyp-1",
        status: "candidate",
        evidence: "10s delay on sleep(10)",
        evidence_refs: ["sub-agents/test-001.json"],
        source_agent: "targeted-pentest",
        source_artifact: "sub-agents/test-001.json",
        notes: "",
        timestamp: "2026-07-17T00:00:00.000Z",
        ...overrides,
    }
}

describe("renderReportMarkdown", () => {
    test("empty findings yields placeholder report", () => {
        const md = renderReportMarkdown([], META)
        expect(md).toContain("# Engagement Report: eng-42")
        expect(md).toContain("total_findings: 0")
        expect(md).toContain("No findings recorded")
    })

    test("includes executive summary with severity + status counts", () => {
        const md = renderReportMarkdown(
            [makeFinding({ status: "verified", severity: "critical" }), makeFinding({ hypothesis_id: "hyp-2", status: "candidate" })],
            META,
        )
        expect(md).toContain("## Executive Summary")
        expect(md).toContain("total_findings: 2")
        expect(md).toContain("| critical | 1 |")
        expect(md).toContain("| medium | 1 |")
        expect(md).toContain("| verified | 1 |")
        expect(md).toContain("| candidate | 1 |")
    })

    test("groups findings by severity and includes remediation/evidence/traceability", () => {
        const md = renderReportMarkdown(
            [
                makeFinding({ hypothesis_id: "hyp-crit", severity: "critical", remediation: "parameterize queries", evidence_refs: ["cap/req-1.txt"] }),
                makeFinding({ hypothesis_id: "hyp-low", kind: "info-leak", severity: "low" }),
            ],
            META,
        )
        expect(md).toContain("### Severity: critical (1)")
        expect(md).toContain("### Severity: low (1)")
        // remediation + evidence ref + hypothesis_id traceability present
        expect(md).toContain("remediation: parameterize queries")
        expect(md).toContain("cap/req-1.txt")
        expect(md).toContain("hypothesis_id: hyp-crit")
        // critical group appears before low group
        expect(md.indexOf("### Severity: critical")).toBeLessThan(md.indexOf("### Severity: low"))
    })

    test("renders request/response evidence when present", () => {
        const md = renderReportMarkdown([makeFinding({ request: "GET /x HTTP/1.1", response: "HTTP/1.1 500" })], META)
        expect(md).toContain("GET /x HTTP/1.1")
        expect(md).toContain("HTTP/1.1 500")
    })
})

describe("toSarif", () => {
    test("emits SARIF 2.1.0 with one result per finding", () => {
        const sarif = toSarif([makeFinding({ hypothesis_id: "hyp-1" }), makeFinding({ hypothesis_id: "hyp-2", kind: "xss" })], META)
        expect(sarif.version).toBe("2.1.0")
        expect(sarif.$schema).toContain("sarif")
        expect(sarif.runs[0]!.tool.driver.name).toBe("BreachWeave")
        expect(sarif.runs[0]!.results).toHaveLength(2)
    })

    test("maps level correctly by severity", () => {
        const sarif = toSarif(
            [
                makeFinding({ hypothesis_id: "a", severity: "critical" }),
                makeFinding({ hypothesis_id: "b", kind: "xss", severity: "medium" }),
                makeFinding({ hypothesis_id: "c", kind: "info-leak", severity: "info" }),
            ],
            META,
        )
        expect(sarif.runs[0]!.results[0]!.level).toBe("error")
        expect(sarif.runs[0]!.results[1]!.level).toBe("warning")
        expect(sarif.runs[0]!.results[2]!.level).toBe("note")
    })

    test("uses status fallback level when severity absent", () => {
        const sarif = toSarif([makeFinding({ status: "verified" })], META)
        // verified -> high -> error
        expect(sarif.runs[0]!.results[0]!.level).toBe("error")
    })

    test("ruleId = kind and rules are deduplicated by kind", () => {
        const sarif = toSarif(
            [makeFinding({ hypothesis_id: "a", kind: "sqli" }), makeFinding({ hypothesis_id: "b", kind: "sqli" }), makeFinding({ hypothesis_id: "c", kind: "xss" })],
            META,
        )
        expect(sarif.runs[0]!.results.map((r) => r.ruleId)).toEqual(["sqli", "sqli", "xss"])
        expect(sarif.runs[0]!.tool.driver.rules.map((rule) => rule.id)).toEqual(["sqli", "xss"])
    })

    test("carries confidence/status/severity/evidence_refs/hypothesis_id in properties", () => {
        const sarif = toSarif([makeFinding({ confidence: 0.8, status: "verified", severity: "high", hypothesis_id: "hyp-9", evidence_refs: ["cap/1.txt"] })], META)
        const props = sarif.runs[0]!.results[0]!.properties
        expect(props.confidence).toBe(0.8)
        expect(props.status).toBe("verified")
        expect(props.severity).toBe("high")
        expect(props.hypothesis_id).toBe("hyp-9")
        expect(props.evidence_refs).toEqual(["cap/1.txt"])
    })

    test("puts target in location uri and entry_point in region snippet", () => {
        const sarif = toSarif([makeFinding()], META)
        const loc = sarif.runs[0]!.results[0]!.locations[0]!.physicalLocation
        expect(loc.artifactLocation.uri).toBe("https://api.corp.com")
        expect(loc.region?.snippet.text).toBe("/login?user=")
    })
})

describe("writeEngagementReport", () => {
    test("writes report.md + report.sarif.json with correct count; SARIF round-trips", async () => {
        const dir = await makeTmpDir()
        const a = makeFinding({ hypothesis_id: "hyp-1", severity: "critical" })
        const b = makeFinding({ hypothesis_id: "hyp-2", kind: "xss", status: "verified" })
        // include a blank + malformed line to confirm parse tolerance
        const ndjson = ["", JSON.stringify(a), "not-json", JSON.stringify(b), ""].join("\n")
        await Bun.write(join(dir, "findings.ndjson"), ndjson)

        const result = await writeEngagementReport(dir, META)
        expect(result.count).toBe(2)
        expect(result.markdownPath).toBe(join(dir, "report.md"))
        expect(result.sarifPath).toBe(join(dir, "report.sarif.json"))

        const md = await Bun.file(result.markdownPath).text()
        expect(md).toContain("# Engagement Report: eng-42")
        expect(md).toContain("total_findings: 2")

        const sarifText = await Bun.file(result.sarifPath).text()
        const sarif = JSON.parse(sarifText) as SarifLog
        expect(sarif.version).toBe("2.1.0")
        expect(sarif.runs[0]!.results).toHaveLength(2)
        expect(sarif.runs[0]!.tool.driver.name).toBe("BreachWeave")
    })

    test("empty/missing findings.ndjson yields placeholder report and count 0", async () => {
        const dir = await makeTmpDir()
        const result = await writeEngagementReport(dir, META)
        expect(result.count).toBe(0)
        const md = await Bun.file(result.markdownPath).text()
        expect(md).toContain("No findings recorded")
        const sarif = JSON.parse(await Bun.file(result.sarifPath).text()) as SarifLog
        expect(sarif.runs[0]!.results).toHaveLength(0)
    })

    test("idempotent: re-running overwrites report files", async () => {
        const dir = await makeTmpDir()
        await Bun.write(join(dir, "findings.ndjson"), `${JSON.stringify(makeFinding())}\n`)
        await writeEngagementReport(dir, META)
        const second = await writeEngagementReport(dir, META)
        expect(second.count).toBe(1)
        const md = await Bun.file(second.markdownPath).text()
        expect(md).toContain("total_findings: 1")
    })
})
