import { describe, expect, test } from "bun:test"
import { buildChallengeAttackTimeline } from "./attack-timeline"

describe("challenge attack timeline", () => {
    test("submission events include asset report in the visible summary", async () => {
        const snapshot = await buildChallengeAttackTimeline({
            challengeId: "mock-Level7",
            attempts: [],
            submissions: [
                {
                    id: "submission-kp-01",
                    challenge_id: "mock-Level7",
                    solver_id: "solver-1",
                    prompt_name: "360-内网协同突破",
                    model_name: "test-model",
                    asset_hash: "7c2af83f18b3b5284b0b4ab2fbd804ea",
                    asset: "http://www.example.com",
                    report: "Langflow 1.8.1 暴露在 Web 入口，RCE 后确认容器为特权运行。",
                    created_at: "2026-06-19T00:00:00.000Z",
                },
            ],
            memory: [],
            ideas: [],
            solverStats: [],
        })

        const submissionEvent = snapshot.events.find((event) => event.kind === "report_submitted")
        expect(submissionEvent?.summary).toContain("http://www.example.com")
        expect(submissionEvent?.summary).toContain("Langflow 1.8.1")
        expect(submissionEvent?.summary).toContain("RCE")
    })
})
