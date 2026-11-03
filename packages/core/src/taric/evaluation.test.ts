import { describe, expect, test } from "bun:test"
import { buildTaricEvaluationReport, validateTaricBenchmarkManifest, type TaricBenchmarkManifest, type TaricEvaluationMetrics } from "./evaluation"

const manifest: TaricBenchmarkManifest = {
    format: "breachweave-taric-benchmark/1",
    targetRevision: "dvwa-1",
    challengeRevision: "challenge-1",
    model: "model-a",
    promptDigest: "sha256:prompt",
    toolImage: "tool:1",
    timeBudgetSeconds: 600,
    tokenBudget: 10_000,
    concurrency: 1,
}

const metrics: TaricEvaluationMetrics = {
    attempted: 1, accepted: 1, deferred: 0, rejectedValidation: 0, rejectedAuthorization: 0, failedPermanent: 0, indeterminate: 0,
    queryComplete: 1, queryPartial: 0, queryFailed: 0, evidenceLinked: 1, evidenceTraceable: 1, duplicateWork: 0,
    recoverySucceeded: 0, recoveryAttempted: 0, candidateReused: 0, candidatesAdmitted: 0, admissionLatencyMs: [], taskOutcomes: [1], costUnits: [1],
}

describe("Taric controlled evaluation", () => {
    test("rejects incomplete benchmark controls", () => {
        expect(() => validateTaricBenchmarkManifest({ ...manifest, promptDigest: "" })).toThrow("promptDigest")
    })

    test("marks a single run as a non-causal case study", () => {
        const report = buildTaricEvaluationReport({
            manifest,
            runs: [{ manifest, mode: "taric_best_effort", runId: "run-1", startedAt: "2026-10-28T00:00:00.000Z", status: "passed" }],
            metrics,
        })
        expect(report.evidenceClass).toBe("case_study")
        expect(report.causalClaimAllowed).toBe(false)
        expect(report.limitations[0]).toContain("case study")
    })

    test("requires matching controls before allowing paired claims", () => {
        const report = buildTaricEvaluationReport({
            manifest,
            runs: [
                { manifest, mode: "legacy_local", runId: "legacy-1", startedAt: "2026-10-28T00:00:00.000Z", status: "passed" },
                { manifest, mode: "taric_best_effort", runId: "taric-1", startedAt: "2026-10-28T00:01:00.000Z", status: "passed" },
                { manifest, mode: "legacy_local", runId: "legacy-2", startedAt: "2026-10-28T00:02:00.000Z", status: "passed" },
                { manifest, mode: "taric_best_effort", runId: "taric-2", startedAt: "2026-10-28T00:03:00.000Z", status: "passed" },
            ],
            metrics,
        })
        expect(report.evidenceClass).toBe("paired_evaluation")
        expect(report.causalClaimAllowed).toBe(true)
    })

    test("failed or excluded runs disable causal claims", () => {
        const report = buildTaricEvaluationReport({
            manifest,
            runs: [
                { manifest, mode: "legacy_local", runId: "legacy-1", startedAt: "2026-10-28T00:00:00.000Z", status: "passed" },
                { manifest, mode: "taric_best_effort", runId: "taric-1", startedAt: "2026-10-28T00:01:00.000Z", status: "failed", failureCategory: "authority_unavailable" },
            ],
            metrics,
        })
        expect(report.causalClaimAllowed).toBe(false)
        expect(report.failedRuns).toBe(1)
    })
})
