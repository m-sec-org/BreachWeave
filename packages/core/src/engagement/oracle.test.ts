import { describe, expect, test } from "bun:test"
import { buildEngagementContext, computeEngagementComplete, countHypotheses, formatEngagementContext } from "./oracle"
import { DEFAULT_RUN_POLICY, type HypothesisBacklog, type HypothesisRecord, type RunState } from "../config/tools/pentest-workspace"

function makeRunState(overrides?: Partial<RunState>): RunState {
    return {
        current_phase: "TEST",
        completed_phases: ["SCOPE", "RECON", "HYPOTHESIZE"],
        cycle: 0,
        reentry_count: 0,
        active_hypothesis_id: null,
        goal_achieved: false,
        goal_output_id: null,
        goal_evidence_refs: [],
        goal_achieved_at: null,
        last_updated: "2026-07-17T00:00:00.000Z",
        transitions: [],
        ...overrides,
    }
}

function makeHypothesis(status: HypothesisRecord["status"], id: string): HypothesisRecord {
    return {
        id,
        statement: `hyp ${id}`,
        kind: "sqli",
        entry_point: "/api",
        priority: "medium",
        confidence: 0.5,
        why_plausible: "-",
        next_test: "-",
        origin_cycle: 0,
        status,
        attempt_count: 1,
        source_output_id: "-",
        source_artifact: "-",
        evidence_refs: [],
        last_result: "-",
        last_updated: "2026-07-17T00:00:00.000Z",
    }
}

function makeBacklog(statuses: HypothesisRecord["status"][]): HypothesisBacklog {
    return {
        hypotheses: statuses.map((status, i) => makeHypothesis(status, `h${i}`)),
        updated_at: "2026-07-17T00:00:00.000Z",
    }
}

describe("countHypotheses", () => {
    test("tallies by status", () => {
        const counts = countHypotheses(makeBacklog(["candidate", "candidate", "verified", "rejected", "inconclusive"]))
        expect(counts).toEqual({ total: 5, candidate: 2, verified: 1, rejected: 1, inconclusive: 1 })
    })
})

describe("computeEngagementComplete", () => {
    test("goal_achieved short-circuits everything", () => {
        const result = computeEngagementComplete({
            runState: makeRunState({ goal_achieved: true, goal_output_id: "out-1" }),
            backlog: makeBacklog(["candidate"]),
        })
        expect(result).toMatchObject({ complete: true, reason: "goal_achieved" })
    })

    test("in_progress while candidates remain and phases incomplete", () => {
        const result = computeEngagementComplete({
            runState: makeRunState({ current_phase: "TEST", completed_phases: ["SCOPE", "RECON", "HYPOTHESIZE"] }),
            backlog: makeBacklog(["candidate", "verified"]),
        })
        expect(result.complete).toBe(false)
        expect(result.reason).toBe("in_progress")
    })

    test("coverage_met when TEST+DOCUMENT done and no open candidates", () => {
        const result = computeEngagementComplete({
            runState: makeRunState({ current_phase: "REPORT", completed_phases: ["SCOPE", "RECON", "HYPOTHESIZE", "TEST", "DOCUMENT"] }),
            backlog: makeBacklog(["verified", "rejected", "inconclusive"]),
        })
        expect(result).toMatchObject({ complete: true, reason: "coverage_met" })
    })

    test("NOT coverage_met if a candidate is still open even after phases done", () => {
        const result = computeEngagementComplete({
            runState: makeRunState({ current_phase: "DOCUMENT", completed_phases: ["SCOPE", "RECON", "HYPOTHESIZE", "TEST", "DOCUMENT"] }),
            backlog: makeBacklog(["verified", "candidate"]),
        })
        expect(result.complete).toBe(false)
    })

    test("budget: tool-call cap exhausts regardless of coverage", () => {
        const result = computeEngagementComplete({
            runState: makeRunState(),
            backlog: makeBacklog(["candidate", "candidate"]),
            budget: { maxToolCalls: 100, toolCallsUsed: 100 },
        })
        expect(result).toMatchObject({ complete: true, reason: "budget_exhausted" })
    })

    test("budget: wall-clock cap exhausts", () => {
        const startedAt = 1_000_000
        const result = computeEngagementComplete({
            runState: makeRunState(),
            backlog: makeBacklog(["candidate"]),
            budget: { maxDurationMs: 60_000, startedAt },
            now: startedAt + 60_000,
        })
        expect(result).toMatchObject({ complete: true, reason: "budget_exhausted" })
    })

    test("budget: under cap stays in_progress", () => {
        const result = computeEngagementComplete({
            runState: makeRunState(),
            backlog: makeBacklog(["candidate"]),
            budget: { maxToolCalls: 100, toolCallsUsed: 10 },
        })
        expect(result.complete).toBe(false)
    })
})

describe("formatEngagementContext", () => {
    test("renders a neutral engagement-state block (no CTF flag/hint terms)", () => {
        const ctx = buildEngagementContext({
            engagementId: "eng-1",
            runState: makeRunState({ current_phase: "TEST", completed_phases: ["SCOPE", "RECON"] }),
            backlog: makeBacklog(["candidate", "verified"]),
            policy: { ...DEFAULT_RUN_POLICY, allowed_targets: ["api.corp.com"] },
        })
        const text = formatEngagementContext(ctx)
        expect(text).toContain("## Engagement State")
        expect(text).toContain("- id: eng-1")
        expect(text).toContain("- phase: TEST")
        expect(text).toContain("- allowed_targets: api.corp.com")
        expect(text).toContain("hypotheses: 2 total")
        expect(text).not.toContain("flag")
        expect(text).not.toContain("Challenge")
    })
})
