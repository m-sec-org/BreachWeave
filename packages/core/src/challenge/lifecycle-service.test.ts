import { describe, expect, test } from "bun:test"
import { createManagerLifecycleService, EncryptedPendingCommitSpool } from "./lifecycle-service"
import { createInMemoryLifecycleLedger } from "../lifecycle/ledger"

const HASH = "a".repeat(64)

function service() {
    const stops: string[] = []
    const lifecycle = createManagerLifecycleService({ stop: ({ run }) => { stops.push(run.runId) } })
    const created = lifecycle.createAssignment({ challengeId: "challenge-1", taskSnapshotHash: HASH, scopeRevision: 1, managerEpoch: 1, runtimeId: "runtime-1", leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    return { lifecycle, created, stops }
}

function report(overrides: Record<string, unknown> = {}) {
    return {
        operationKey: "op-1", assignmentId: "assignment", runId: "run", generation: 1, managerEpoch: 1,
        scopeRevision: 1, leaseToken: "lease-1", taskSnapshotHash: HASH, reportId: "report-1", payload: { text: "报告" },
        ...overrides,
    }
}

describe("Manager 生命周期报告入口", () => {
    test("增量报告保持运行，最终报告创建审核和停止 effect", async () => {
        const { lifecycle, created, stops } = service()
        const input = report({ assignmentId: created.assignment.assignmentId, runId: created.run.runId })
        const progress = await lifecycle.submitProgress(input)
        expect(progress.code).toBe("REPORT_ACCEPTED")
        expect(lifecycle.ledger.getSolverRun(created.run.runId)?.status).toBe("running")
        const final = await lifecycle.submitFinal({ ...input, operationKey: "op-2", reportId: "report-2", evidenceSnapshotHash: HASH })
        expect(final.code).toBe("REPORT_ACCEPTED")
        expect(final.result?.reviewJob?.status).toBe("queued")
        expect(final.result?.stopEffect?.status).toBe("requested")
        expect(stops).toEqual([created.run.runId])
    })

    test("混合最终批次在任何外部效果前拒绝", async () => {
        const { lifecycle, created, stops } = service()
        await expect(lifecycle.submitFinal({ ...report({ assignmentId: created.assignment.assignmentId, runId: created.run.runId }) }, [{ kind: "final_report" }, { kind: "bash" }])).rejects.toThrow()
        expect(stops).toHaveLength(0)
        expect(lifecycle.ledger.listOutbox()).toHaveLength(0)
    })

    test("权威提交失败进入加密 spool 并可重试对账", async () => {
        const spool = new EncryptedPendingCommitSpool(2)
        const stops: string[] = []
        const ledger = createInMemoryLifecycleLedger()
        const accepted = ledger.acceptFinalReport.bind(ledger)
        let unavailable = true
        ledger.acceptFinalReport = async (input) => {
            if (unavailable) throw new Error("authority offline")
            return accepted(input)
        }
        const pendingLifecycle = createManagerLifecycleService({ ledger, spool, stop: ({ run }) => { stops.push(run.runId) } })
        const created = pendingLifecycle.createAssignment({ challengeId: "challenge-1", taskSnapshotHash: HASH, scopeRevision: 1, managerEpoch: 1, runtimeId: "runtime-1", leaseToken: "lease-1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
        const input = report({ assignmentId: created.assignment.assignmentId, runId: created.run.runId })
        const pending = await pendingLifecycle.submitFinal({ ...input, evidenceSnapshotHash: HASH })
        expect(pending.code).toBe("PENDING_COMMIT")
        expect((await spool.list()).length).toBe(1)
        expect(stops).toHaveLength(1)
        expect(ledger.listOutbox()).toHaveLength(0)
        unavailable = false
        const reconciled = await pendingLifecycle.reconcilePending()
        expect(reconciled[0]?.code).toBe("REPORT_ACCEPTED")
        expect(ledger.listOutbox()).toHaveLength(1)
    })
})
