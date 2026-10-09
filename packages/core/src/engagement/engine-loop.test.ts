// SDK-free integration test for the single-agent engagement loop (Slice 5a).
//
// Proves the engine can actually complete its loop using only the SDK-free
// building blocks the tools wrap: bootstrapEngagement + transitionToPhase (the
// forward driver the engagement_transition_phase tool calls) + readEngagementCompletion
// (the coverage oracle) + writeEngagementReport (the generate_engagement_report tool).
// The SDK is NOT installed here, so this test must not import any tool file.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { bootstrapEngagement } from "./bootstrap"
import type { ReportFinding } from "./finding"
import { readEngagementCompletion } from "./oracle"
import type { TestPolicy } from "./policy"
import { writeEngagementReport } from "./report"
import { PENTEST_PHASES, isForwardPhaseTransition, readRunState, transitionToPhase, type PentestPhase } from "../config/tools/pentest-workspace"

const created: string[] = []

async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "engagement-engine-loop-"))
    created.push(dir)
    return dir
}

afterEach(async () => {
    while (created.length > 0) {
        const dir = created.pop()!
        await rm(dir, { recursive: true, force: true })
    }
})

function makePolicy(overrides?: Partial<TestPolicy>): TestPolicy {
    return {
        vulnClasses: ["sqli", "idor"],
        depth: "standard",
        redLine: "poc-safe",
        ...overrides,
    }
}

function makeFinding(overrides?: Partial<ReportFinding>): ReportFinding {
    return {
        target: "https://api.corp.com",
        kind: "sqli",
        entry_point: "GET /users?id=",
        hypothesis: "id parameter is injectable",
        hypothesis_id: "H-1",
        status: "verified",
        evidence: "boolean-based SQLi confirmed via version() disclosure",
        evidence_refs: ["sub-agents/test-001.md"],
        source_agent: "targeted-pentest",
        source_artifact: "sub-agents/test-001.json",
        notes: "",
        timestamp: "2026-07-17T00:00:00.000Z",
        severity: "high",
        confidence: 0.9,
        ...overrides,
    }
}

/** Drive the phase state machine SCOPE→…→REPORT the way engagement_transition_phase would. */
async function advanceToReport(dir: string): Promise<void> {
    const forwardPhases: PentestPhase[] = ["RECON", "HYPOTHESIZE", "TEST", "DOCUMENT", "REPORT"]
    for (const phase of forwardPhases) {
        await transitionToPhase(dir, phase, `advance to ${phase}`)
    }
}

describe("engagement engine loop (single-agent, SDK-free)", () => {
    test("bootstrap → step to REPORT → coverage oracle reaches coverage_met", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-loop",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: ["https://api.corp.com/"],
            policy: makePolicy(),
        })

        // Freshly bootstrapped: phase=SCOPE, oracle in_progress.
        const before = await readEngagementCompletion(dir)
        expect(before.complete).toBe(false)
        expect(before.reason).toBe("in_progress")

        await advanceToReport(dir)

        const state = await readRunState(dir)
        expect(state.current_phase).toBe("REPORT")
        // Forward transition marks all phases before target as completed.
        expect(state.completed_phases).toContain("TEST")
        expect(state.completed_phases).toContain("DOCUMENT")

        // No open candidate hypotheses (backlog is empty) + TEST+DOCUMENT done → coverage_met.
        const completion = await readEngagementCompletion(dir)
        expect(completion.complete).toBe(true)
        expect(completion.reason).toBe("coverage_met")
    })

    test("writeEngagementReport produces report.md + report.sarif.json with a sane count", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-loop",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy(),
        })
        await advanceToReport(dir)

        // Document one finding (raw ndjson line, matching document_finding's persistence).
        const finding = makeFinding()
        await Bun.write(join(dir, "findings.ndjson"), `${JSON.stringify(finding)}\n`)

        const result = await writeEngagementReport(dir, {
            engagementId: "eng-loop",
            generatedAt: "2026-07-17T12:00:00.000Z",
        })

        expect(result.count).toBe(1)
        expect(await Bun.file(result.markdownPath).exists()).toBe(true)
        expect(await Bun.file(result.sarifPath).exists()).toBe(true)

        const markdown = await Bun.file(result.markdownPath).text()
        expect(markdown).toContain("Engagement Report: eng-loop")
        expect(markdown).toContain("sqli")

        const sarif = await Bun.file(result.sarifPath).json()
        expect(sarif.version).toBe("2.1.0")
        expect(sarif.runs[0].results.length).toBe(1)
    })

    test("an open candidate keeps the oracle in_progress even at REPORT", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-loop",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy(),
        })
        await advanceToReport(dir)

        // A still-open candidate hypothesis blocks coverage.
        await Bun.write(
            join(dir, "state/hypothesis-backlog.json"),
            JSON.stringify({
                hypotheses: [
                    {
                        id: "H-open",
                        statement: "untested",
                        kind: "idor",
                        entry_point: "GET /orders/{id}",
                        priority: "high",
                        confidence: 0.5,
                        why_plausible: "sequential ids",
                        next_test: "swap id",
                        origin_cycle: 0,
                        status: "candidate",
                        attempt_count: 0,
                        source_output_id: "recon-001",
                        source_artifact: "sub-agents/recon-001.json",
                        evidence_refs: [],
                        last_result: "",
                        last_updated: "2026-07-17T00:00:00.000Z",
                    },
                ],
                updated_at: "2026-07-17T00:00:00.000Z",
            }),
        )

        const completion = await readEngagementCompletion(dir)
        expect(completion.complete).toBe(false)
        expect(completion.reason).toBe("in_progress")
    })
})

describe("isForwardPhaseTransition", () => {
    test("forward transitions are allowed", () => {
        expect(isForwardPhaseTransition("SCOPE", "RECON")).toBe(true)
        expect(isForwardPhaseTransition("TEST", "DOCUMENT")).toBe(true)
        expect(isForwardPhaseTransition("SCOPE", "REPORT")).toBe(true)
    })

    test("in-place transitions are allowed", () => {
        for (const phase of PENTEST_PHASES) {
            expect(isForwardPhaseTransition(phase, phase)).toBe(true)
        }
    })

    test("backward transitions are rejected (reentry is ingest's job)", () => {
        expect(isForwardPhaseTransition("RECON", "SCOPE")).toBe(false)
        expect(isForwardPhaseTransition("DOCUMENT", "TEST")).toBe(false)
        expect(isForwardPhaseTransition("REPORT", "SCOPE")).toBe(false)
    })
})
