import { describe, expect, test } from "bun:test"
import { archiveLifecycleEvaluation, createLifecycleEvaluationEvidence, readLifecycleEvaluation } from "./evaluation"

describe("生命周期评估证据", () => {
    test("以 profile、后端、限制和 durable state 归档并可重读", async () => {
        const path = `/tmp/lifecycle-evaluation-${crypto.randomUUID()}.json`
        const evidence = createLifecycleEvaluationEvidence({
            profile: "test",
            backend: "in_memory",
            scenario: "final-report-stop-review-recovery",
            status: "reconciled",
            operations: ["lifecycle.report.commit", "lifecycle.stop.reconcile"],
            durableState: { report: "accepted", stop: "unknown", review: "queued" },
            limitations: ["未执行真实 Taric gateway 与容器冷恢复"],
        })
        await archiveLifecycleEvaluation(path, evidence)
        const restored = await readLifecycleEvaluation(path)
        expect(restored.profile).toBe("test")
        expect(restored.status).toBe("reconciled")
        expect(restored.limitations).toHaveLength(1)
    })
})
