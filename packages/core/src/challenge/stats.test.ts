import { describe, expect, test } from "bun:test"
import type { ChallengeInfoRecord, ChallengeSubmissionLogRecord } from "./store"
import { hashChallengeAsset } from "./store"
import { buildChallengeStatsOverview } from "./stats"

function createChallenge(id: string, scanned: boolean[]): ChallengeInfoRecord {
    return {
        id,
        name: id,
        title: id,
        difficulty: "easy",
        description: "",
        level: 1,
        hint_viewed: false,
        instance_status: "stopped",
        entrypoint: null,
        assets_url: scanned.map((_, index) => `https://${id}-${index}.example`),
        assets_ip: [],
        assets: {
            urls: scanned.map((item, index) => {
                const asset = `https://${id}-${index}.example`
                return { asset, asset_hash: hashChallengeAsset(asset), scanned: item }
            }),
            ips: [],
        },
        planner_enabled: true,
        planner_status: "stop",
        created_at: "2026-04-12T00:00:00.000Z",
        updated_at: "2026-04-12T00:00:00.000Z",
        source: "test",
    }
}

function createSubmission(input: {
    id: string
    challengeId: string
    solverId: string
    promptName: string
    modelName: string
    asset: string
}): ChallengeSubmissionLogRecord {
    return {
        id: input.id,
        challenge_id: input.challengeId,
        solver_id: input.solverId,
        prompt_name: input.promptName,
        model_name: input.modelName,
        asset_hash: hashChallengeAsset(input.asset),
        asset: input.asset,
        report: `report for ${input.asset}`,
        created_at: "2026-04-12T00:00:00.000Z",
    }
}

describe("buildChallengeStatsOverview asset-based buckets", () => {
    test("overview completion uses asset progress", () => {
        const challengeA = createChallenge("challenge-a", [true, false])
        const challengeB = createChallenge("challenge-b", [true])

        const overview = buildChallengeStatsOverview([
            { challenge: challengeA, stats: createStats("challenge-a", 1), solver_stats: [], submissions: [] },
            { challenge: challengeB, stats: createStats("challenge-b", 1), solver_stats: [], submissions: [] },
        ])

        expect(overview.assets_total).toBe(3)
        expect(overview.assets_scanned).toBe(2)
        expect(overview.assets_pending).toBe(1)
        expect(overview.asset_completion_rate).toBeCloseTo(2 / 3)
        expect(overview.challenges_completed).toBe(1)
    })

    test("buckets count reports and covered assets by model and prompt", () => {
        const challenge = createChallenge("challenge-a", [true, true, false])
        const submissions = [
            createSubmission({
                id: "1",
                challengeId: challenge.id,
                solverId: "solver-1",
                promptName: "prompt-a",
                modelName: "provider/model-a",
                asset: "https://challenge-a-0.example",
            }),
            createSubmission({
                id: "2",
                challengeId: challenge.id,
                solverId: "solver-1",
                promptName: "prompt-a",
                modelName: "provider/model-a",
                asset: "https://challenge-a-0.example",
            }),
            createSubmission({
                id: "3",
                challengeId: challenge.id,
                solverId: "solver-2",
                promptName: "prompt-a",
                modelName: "provider/model-a",
                asset: "https://challenge-a-1.example",
            }),
        ]

        const overview = buildChallengeStatsOverview([
            {
                challenge,
                stats: createStats(challenge.id, submissions.length),
                solver_stats: [
                    createSolverStat("solver-1", challenge.id, "prompt-a", "provider/model-a"),
                    createSolverStat("solver-2", challenge.id, "prompt-a", "provider/model-a"),
                ],
                submissions,
            },
        ])

        const modelBucket = overview.models[0]
        const promptBucket = overview.prompts[0]

        expect(modelBucket?.assets_total).toBe(3)
        expect(modelBucket?.assets_scanned).toBe(2)
        expect(modelBucket?.assets_covered).toBe(2)
        expect(modelBucket?.submission_count).toBe(3)
        expect(promptBucket?.assets_covered).toBe(2)
    })

    test("authorized project totals come from canonical governance metrics and stay separate", () => {
        const challenge = {
            ...createChallenge("authorized-a", [false]),
            mode: "authorized_pentest" as const,
            authority_projection: {
                source: "canonical_taric_records" as const,
                read_seq: 42,
                lifecycle_mode: "taric_projection" as const,
                closed: true,
                can_close: true,
                gaps: [],
                work_total: 3,
                coverage_total: 5,
                coverage_resolved: 5,
                evidence_refs: ["evidence-a", "evidence-b"],
                report_refs: ["report-a"],
                action_event_total: 4,
            },
        }
        const stats = {
            ...createStats(challenge.id, 1),
            authority: { read_seq: 42, work_total: 3, work_completed: 2, coverage_total: 5, evidence_total: 2, action_event_total: 4, closed: true, unavailable_metrics: ["usage"] },
        }
        const overview = buildChallengeStatsOverview([{ challenge, stats, solver_stats: [], submissions: [createSubmission({ id: "report-a", challengeId: challenge.id, solverId: "solver-a", promptName: "authorized", modelName: "unknown", asset: "https://authorized-a.example" })] }])

        expect(overview.challenges_total).toBe(0)
        expect(overview.authorized_governance).toMatchObject({ projects: 1, work_total: 3, work_completed: 2, coverage_total: 5, evidence_total: 2, action_event_total: 4, reports_total: 1, closed: 1, gaps_total: 0 })
        expect(overview.authorized_governance.unavailable_metrics).toContain("usage")
    })
})

function createStats(challengeId: string, submissionCount: number) {
    return {
        challenge_id: challengeId,
        solver_count: 1,
        attempt_count: 1,
        submission_count: submissionCount,
        solver_active_duration_ms_total: 0,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 },
        updated_at: "2026-04-12T00:00:00.000Z",
    }
}

function createSolverStat(solverId: string, challengeId: string, promptName: string, modelName: string) {
    return {
        solver_id: solverId,
        challenge_id: challengeId,
        prompt_name: promptName,
        model_name: modelName,
        duration_ms: 0,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 },
    }
}
