import { describe, expect, test } from "bun:test"
import { deriveSeverity, parseFindingsNdjson, severityToSarifLevel, type ReportFinding } from "./finding"

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

describe("parseFindingsNdjson", () => {
    test("parses multiple lines", () => {
        const a = makeFinding({ hypothesis_id: "hyp-1" })
        const b = makeFinding({ hypothesis_id: "hyp-2", kind: "xss" })
        const content = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`
        const parsed = parseFindingsNdjson(content)
        expect(parsed).toHaveLength(2)
        expect(parsed[0]!.hypothesis_id).toBe("hyp-1")
        expect(parsed[1]!.kind).toBe("xss")
    })

    test("tolerates blank lines and skips malformed lines", () => {
        const good = makeFinding()
        const content = ["", "   ", "{ not json", JSON.stringify(good), "also-not-json", ""].join("\n")
        const parsed = parseFindingsNdjson(content)
        expect(parsed).toHaveLength(1)
        expect(parsed[0]!.hypothesis_id).toBe("hyp-1")
    })

    test("returns empty array for empty content", () => {
        expect(parseFindingsNdjson("")).toEqual([])
        expect(parseFindingsNdjson("\n\n  \n")).toEqual([])
    })

    test("round-trips optional Slice 3 fields", () => {
        const f = makeFinding({ severity: "critical", confidence: 0.9, remediation: "parameterize queries", request: "GET /x", response: "500" })
        const parsed = parseFindingsNdjson(`${JSON.stringify(f)}\n`)
        expect(parsed[0]!.severity).toBe("critical")
        expect(parsed[0]!.confidence).toBe(0.9)
        expect(parsed[0]!.remediation).toBe("parameterize queries")
        expect(parsed[0]!.request).toBe("GET /x")
        expect(parsed[0]!.response).toBe("500")
    })
})

describe("deriveSeverity", () => {
    test("uses explicit severity when present", () => {
        expect(deriveSeverity(makeFinding({ severity: "low", status: "verified" }))).toBe("low")
        expect(deriveSeverity(makeFinding({ severity: "critical", status: "rejected" }))).toBe("critical")
    })

    test("falls back by status when severity absent", () => {
        expect(deriveSeverity(makeFinding({ status: "verified" }))).toBe("high")
        expect(deriveSeverity(makeFinding({ status: "candidate" }))).toBe("medium")
        expect(deriveSeverity(makeFinding({ status: "rejected" }))).toBe("info")
    })
})

describe("severityToSarifLevel", () => {
    test("maps severity to SARIF level", () => {
        expect(severityToSarifLevel("critical")).toBe("error")
        expect(severityToSarifLevel("high")).toBe("error")
        expect(severityToSarifLevel("medium")).toBe("warning")
        expect(severityToSarifLevel("low")).toBe("note")
        expect(severityToSarifLevel("info")).toBe("note")
    })
})
