import { describe, expect, test } from "bun:test"
import { assertLifecycleWriteAuthority, checkLifecycleCompatibility, createDeterministicTaricLifecycleAdapter, rejectLegacyLifecycleWrite, WorkerHarness, LifecycleTelemetry } from "./index"

describe("Taric 生命周期兼容适配器", () => {
    test("生产 profile 对 tuple mismatch fail closed，test profile 返回诊断但可写", () => {
        expect(checkLifecycleCompatibility({ profile: "governed-production", adapter: "taric_authority", actual: { taricCommit: "old" } }).writable).toBe(false); expect(checkLifecycleCompatibility({ profile: "test", adapter: "fixture_gateway", actual: { taricCommit: "old" } }).writable).toBe(true)
    })
    test("操作边界校验 principal、幂等和 legacy write rejection", async () => {
        const adapter = createDeterministicTaricLifecycleAdapter(); const payload = { id: "report-1" }; const payloadHash = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex")}`; const accepted = await adapter.invoke({ operation: "lifecycle.report.commit", principal: "host", idempotencyKey: "op-1", payloadHash, payload }); expect(accepted.status).toBe("accepted"); expect((await adapter.invoke({ operation: "lifecycle.report.commit", principal: "host", idempotencyKey: "op-1", payloadHash, payload })).status).toBe("replayed"); expect((await adapter.invoke({ operation: "lifecycle.review.commit", principal: "model", idempotencyKey: "op-2", payloadHash, payload })).status).toBe("rejected"); expect(() => rejectLegacyLifecycleWrite("legacy.sidecar.write")).toThrow("legacy"); expect(() => assertLifecycleWriteAuthority("rpc.write")).toThrow()
    })
    test("WorkerHarness 与 telemetry 保持边界和指标分母", async () => {
        const adapter = createDeterministicTaricLifecycleAdapter(); const fence = { assignmentId: "a", runId: "r", generation: 1, epoch: 1, scopeRevision: 1, leaseToken: "l", terminalGate: false, budgetDigest: "budget", effectId: "effect" }; const harness = new WorkerHarness(adapter, fence); const payload = { prompt: "x" }; const payloadHash = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex")}`; expect((await harness.dispatch({ operation: "lifecycle.model.request", principal: "model", fence, payload, payloadHash, idempotencyKey: "model-1" })).status).toBe("accepted"); expect(() => harness.updateFence({ ...fence, generation: 2 })).not.toThrow(); await expect(harness.dispatch({ operation: "lifecycle.model.request", principal: "model", fence, payload, payloadHash, idempotencyKey: "model-2" })).rejects.toThrow("stale"); const telemetry = new LifecycleTelemetry(); telemetry.metric({ name: "review_retry_rate", value: 1, denominator: 2, profile: "test", dimensions: { queue: "review" } }); expect(telemetry.snapshot().metrics[0]?.denominator).toBe(2)
    })
})
