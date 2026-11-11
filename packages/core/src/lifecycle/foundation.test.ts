import { describe, expect, test } from "bun:test"
import { Value } from "typebox/value"
import {
    AssignmentSchema,
    BudgetTree,
    FatalLatch,
    InMemoryLifecycleLedger,
    RoleResourceManifestSchema,
    ToolGateway,
    assertCompletionFactsIndependent,
    createRoleResourceManifest,
    normalizeRequest,
    parseStrict,
    transitionAssignment,
    transitionFinalization,
    transitionReviewJob,
    transitionSolverRun,
    validateRoleResourceManifest,
} from "./index"

const digest = "a".repeat(64)
const date = "2026-11-07T00:00:00.000Z"

function assignment() {
    return {
        assignmentId: "assignment-1",
        challengeId: "challenge-1",
        taskSnapshotHash: digest,
        lineageId: "lineage-1",
        phase: "executing" as const,
        revision: 1,
        scopeRevision: 1,
        managerEpoch: 1,
        activeRunId: "run-1",
        currentReportVersion: 0,
        createdAt: date,
        updatedAt: date,
    }
}

function run() {
    return {
        runId: "run-1",
        assignmentId: "assignment-1",
        generation: 1,
        status: "running" as const,
        revision: 1,
        managerEpoch: 1,
        scopeRevision: 1,
        leaseToken: "lease-1",
        leaseExpiresAt: date,
        runtimeId: "runtime-1",
        startedAt: date,
    }
}

describe("生命周期基础合同", () => {
    test("严格 schema 拒绝缺失绑定、强制转换和额外字段", () => {
        expect(Value.Check(AssignmentSchema, { ...assignment(), revision: "1" })).toBe(false)
        expect(Value.Check(AssignmentSchema, { ...assignment(), managerEpoch: undefined })).toBe(false)
        expect(Value.Check(AssignmentSchema, { ...assignment(), callerSuppliedIdentity: "bad" })).toBe(false)
        expect(() => parseStrict(AssignmentSchema, { ...assignment(), revision: "1" })).toThrow()
    })

    test("状态 reducer 拒绝非法回退并保持四个完成事实独立", () => {
        expect(transitionSolverRun(run(), "finalizing").status).toBe("finalizing")
        expect(transitionAssignment(assignment(), "awaiting_audit").phase).toBe("awaiting_audit")
        expect(() => transitionSolverRun({ ...run(), status: "stopped" }, "running")).toThrow()
        expect(() => transitionReviewJob({ reviewJobId: "r", assignmentId: "a", reportId: "p", reportVersion: 1, generation: 1, status: "ready", attempt: 0, managerEpoch: 1, scopeRevision: 1, createdAt: date }, "running")).toThrow()
        expect(transitionFinalization({ finalizationId: "f", challengeId: "c", finalizationGeneration: 1, status: "open", revision: 1, scopeRevision: 1, taskManifestRevision: 1, expectedEngagementRevision: 1, watermarks: { authorityReadSeq: 0, executionReadSeq: 0, artifactCatalogWatermark: 0, artifactIndexWatermark: 0, historyWatermark: 0 }, sourceWatermark: 0, createdAt: date }, "sealing_requested").status).toBe("sealing_requested")
        expect(assertCompletionFactsIndependent({ reportCoverageComplete: true, runPhysicallyStopped: false, assignmentAccepted: false, engagementClosed: true })).toEqual({ reportCoverageComplete: true, runPhysicallyStopped: false, assignmentAccepted: false, engagementClosed: true })
    })

    test("Ledger 对 final 报告、ReviewJob、stop effect 做原子幂等", async () => {
        const ledger = new InMemoryLifecycleLedger()
        ledger.putAssignment(assignment())
        ledger.putSolverRun(run())
        const input = { operationKey: "op-1", assignmentId: "assignment-1", runId: "run-1", generation: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", taskSnapshotHash: digest, reportId: "report-1", payloadHash: digest, submissionKind: "final" as const, evidenceSnapshotHash: digest }
        const first = await ledger.acceptFinalReport(input)
        const replay = await ledger.acceptFinalReport(input)
        expect(first.status).toBe("applied")
        expect(replay.status).toBe("replayed")
        expect(ledger.getCurrentReviewJob("assignment-1", 1)?.reviewJobId).toBe("review:report-1")
        expect(ledger.listOutbox()).toHaveLength(1)
        await expect(ledger.acceptFinalReport({ ...input, payloadHash: "b".repeat(64) })).rejects.toThrow()
        expect(ledger.getReport("report-1")?.payloadHash).toBe(digest)
    })

    test("增量报告推进不可变版本但不创建审核或停止效果", async () => {
        const ledger = new InMemoryLifecycleLedger()
        ledger.putAssignment(assignment())
        ledger.putSolverRun(run())
        const result = await ledger.appendReport({ operationKey: "op-progress", assignmentId: "assignment-1", runId: "run-1", generation: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", taskSnapshotHash: digest, reportId: "report-progress", payloadHash: digest, submissionKind: "incremental" })
        expect(result.result.report.reportVersion).toBe(1)
        expect(result.result.assignment.currentReportVersion).toBe(1)
        expect(result.result.reviewJob).toBeUndefined()
        expect(result.result.stopEffect).toBeUndefined()
        expect(ledger.getSolverRun("run-1")?.status).toBe("running")
    })

    test("预算树向父节点累计，Gateway 在 dispatch 边界拒绝陈旧或隐藏调度", async () => {
        const budgets = new BudgetTree()
        budgets.addNode("root", { tokens: 10, timeMs: 10, cost: 10, concurrency: 1, outputBytes: 100, retries: 0 })
        budgets.addNode("child", { tokens: 10, timeMs: 10, cost: 10, concurrency: 1, outputBytes: 100, retries: 0 }, "root")
        budgets.reserve("child", { tokens: 4, concurrency: 1 })
        expect(budgets.usage("root").tokens).toBe(4)
        expect(() => budgets.reserve("child", { tokens: 7 })).toThrow()
        const gateway = new ToolGateway({ runId: "run-1", runGeneration: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", policyDigest: digest, manifestDigest: digest, gateRevision: 1, terminalGateOpen: true, fatalLatched: false, budgetNodeId: "child" }, budgets)
        await expect(gateway.dispatch({ requestId: "req", toolCallId: "tool", operation: "read", normalizedArguments: {}, fence: { runId: "run-1", runGeneration: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", policyDigest: digest, manifestDigest: digest }, budget: {} , nested: true }, async () => ({ status: "succeeded", executionIdentity: "x" }))).rejects.toThrow()
        gateway.updateState({ runId: "run-1", runGeneration: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", policyDigest: digest, manifestDigest: digest, gateRevision: 2, terminalGateOpen: false, fatalLatched: false, budgetNodeId: "child" })
        await expect(gateway.dispatch({ requestId: "req", toolCallId: "tool-2", operation: "read", normalizedArguments: {}, fence: { runId: "run-1", runGeneration: 1, managerEpoch: 1, scopeRevision: 1, leaseToken: "lease-1", policyDigest: digest, manifestDigest: digest }, budget: {} }, async () => ({ status: "succeeded", executionIdentity: "x" }))).rejects.toThrow()
    })

    test("RoleResourceManifest 校验内容 hash，FatalLatch 只阻断普通执行", () => {
        const manifest = createRoleResourceManifest({ manifestId: "manifest-1", role: "solver", revision: 1, promptSkillArtifactRefs: ["prompt-1"], toolSchemaBindings: [], resourceContentHashes: [digest], toolImplementationDigests: [digest], mcpBindings: [], scopePolicyRef: "scope-1", modelPolicyRef: "model-1", budgetPolicyRef: "budget-1", approvedBy: "host" })
        expect(validateRoleResourceManifest(manifest).manifestId).toBe("manifest-1")
        expect(Value.Check(RoleResourceManifestSchema, { ...manifest, contentDigest: "b".repeat(64) })).toBe(true)
        expect(() => validateRoleResourceManifest({ ...manifest, contentDigest: "b".repeat(64) })).toThrow()
        const latch = new FatalLatch()
        latch.latch("PERSISTENCE", "提交失败")
        expect(latch.isLatched).toBe(true)
        expect(latch.allowTerminalIntake()).toBe(true)
        expect(() => latch.assertOrdinaryExecutionAllowed()).toThrow()
    })

    test("模型请求不能覆盖宿主身份", () => {
        expect(() => normalizeRequest({ requestId: "r", operation: "read", arguments: {}, runId: "attacker" }, { operation: "read" })).toThrow()
        expect(normalizeRequest({ requestId: "r", operation: "read", arguments: { path: "x" } }, { operation: "read" }).requestId).toBe("r")
    })
})
