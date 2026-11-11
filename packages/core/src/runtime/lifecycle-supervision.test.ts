import { describe, expect, test } from "bun:test"
import {
    createRuntimeEffect,
    DEFAULT_STOP_POLICY,
    StartupRecovery,
    StopCoordinator,
    Supervisor,
    SupervisorFencedError,
    SupervisorLockError,
    SupervisorResourceLimitError,
    reconcileRuntimeEffect,
    type MonotonicClock,
    type PhysicalExitObservation,
    type RuntimeIdentityInput,
} from "./lifecycle-supervision"

class FixtureClock implements MonotonicClock {
    current = 100

    now(): number {
        return this.current
    }

    async waitUntil(deadlineAt: number): Promise<void> {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
    }
}

function identity(overrides: Partial<RuntimeIdentityInput> = {}): RuntimeIdentityInput {
    return {
        hostId: "host-a",
        bootId: "boot-a",
        workerId: "worker-a",
        containerId: "container-a",
        processStartIdentity: "start-a",
        processId: 123,
        ...overrides,
    }
}

function effect(overrides: Partial<Parameters<typeof createRuntimeEffect>[0]> = {}) {
    return createRuntimeEffect({
        effectId: "effect-a",
        assignmentId: "assignment-a",
        runId: "run-a",
        kind: "stop",
        requestRevision: 1,
        idempotencyKey: "stop:run-a:1",
        managerEpoch: 4,
        runGeneration: 1,
        leaseFencingToken: "lease-a",
        identity: identity(),
        createdAt: 100,
        ...overrides,
    })
}

function exited(overrides: Partial<PhysicalExitObservation> = {}): PhysicalExitObservation {
    return {
        identity: identity(),
        outcome: "exited",
        evidence: "waitpid",
        observedAt: 120,
        processTreeExited: true,
        channelsClosed: true,
        ownedJobsReconciled: true,
        ...overrides,
    }
}

describe("RuntimeEffect 物理身份和对账", () => {
    test("不可变身份必须完全匹配，lease 过期不能证明物理退出", () => {
        const current = effect({ status: "applying" })
        const applied = reconcileRuntimeEffect(current, exited())
        expect(applied.status).toBe("applied")
        expect(Object.isFrozen(applied)).toBe(true)

        const reusedPid = reconcileRuntimeEffect(current, exited({ identity: identity({ processStartIdentity: "start-b" }), evidence: "pid_reused" }))
        expect(reusedPid.status).toBe("unknown")
        expect(reusedPid.errorCode).toBe("runtime_identity_mismatch")

        const leaseExpiry = reconcileRuntimeEffect(current, exited({ evidence: "lease_expired" }))
        expect(leaseExpiry.status).toBe("unknown")
        expect(leaseExpiry.errorCode).toBe("lease_expiry_not_exit")
    })

    test("缺少执行树、通道或 owned job 证据时保留 unknown", () => {
        const current = effect({ status: "applying" })
        const unresolved = reconcileRuntimeEffect(current, exited({ ownedJobsReconciled: false }))
        expect(unresolved.status).toBe("unknown")
        expect(unresolved.errorCode).toBe("physical_exit_unconfirmed")
    })
})

describe("StopCoordinator", () => {
    test("优雅停止按固定顺序关闭准入并在确认物理退出后释放 slot", async () => {
        const clock = new FixtureClock()
        const coordinator = new StopCoordinator({ clock, policy: { graceMs: 10, hardMs: 30 } })
        const calls: string[] = []
        const result = await coordinator.request({ effect: effect() }, {
            closeAdmission: () => { calls.push("admission") },
            revokeCapabilities: () => { calls.push("revoke") },
            cancel: () => { calls.push("cancel") },
            runtimeManagerStop: () => { calls.push("runtime") },
            waitForExit: async () => exited({ observedAt: clock.now() }),
            closeChannels: () => { calls.push("channels") },
            forceStop: async () => { throw new Error("不应强制停止") },
        })
        expect(calls).toEqual(["admission", "revoke", "cancel", "runtime", "channels"])
        expect(result.effect.status).toBe("applied")
        expect(result.releasedSlot).toBe(true)
        expect(result.events.map((item) => item.name)).toEqual([
            "stop_requested", "admission_closed", "capabilities_revoked", "cancel_requested",
            "runtime_manager_stop_requested", "channels_closed", "solver_stopped",
        ])
    })

    test("超过 grace 后 force stop，无法确认物理退出则保留 slot 和 unknown", async () => {
        const clock = new FixtureClock()
        const coordinator = new StopCoordinator({ clock, policy: DEFAULT_STOP_POLICY })
        const calls: string[] = []
        const result = await coordinator.request({ effect: effect() }, {
            closeAdmission: () => { calls.push("admission") },
            revokeCapabilities: () => { calls.push("revoke") },
            cancel: () => { calls.push("cancel") },
            waitForExit: async () => undefined,
            closeChannels: () => { calls.push("channels") },
            forceStop: async () => exited({ outcome: "unknown", evidence: "unmatched", processTreeExited: false, ownedJobsReconciled: false }),
        })
        expect(calls).toEqual(["admission", "revoke", "cancel", "channels"])
        expect(result.effect.status).toBe("unknown")
        expect(result.releasedSlot).toBe(false)
        expect(result.events.map((item) => item.name)).toEqual([
            "stop_requested", "admission_closed", "capabilities_revoked", "cancel_requested",
            "grace_deadline_reached", "hard_deadline_reached", "channels_closed", "force_stop_requested", "stop_unknown",
        ])
    })

    test("相同 effect 并发请求共享一个 stop promise，避免重复副作用", async () => {
        const coordinator = new StopCoordinator({ clock: new FixtureClock(), policy: { graceMs: 1, hardMs: 2 } })
        let cancelCount = 0
        const callbacks = {
            closeAdmission() {}, revokeCapabilities() {}, cancel() { cancelCount += 1 },
            waitForExit: async () => exited(), closeChannels() {}, forceStop: async () => exited(),
        }
        const first = coordinator.request({ effect: effect() }, callbacks)
        const second = coordinator.request({ effect: effect() }, callbacks)
        expect(first).toBe(second)
        await first
        expect(cancelCount).toBe(1)
    })

    test("force callback 卡住时仍在独立截止时间内返回 unknown", async () => {
        const coordinator = new StopCoordinator({ clock: new FixtureClock(), policy: { graceMs: 1, hardMs: 2 } })
        const result = await coordinator.request({ effect: effect() }, {
            closeAdmission() {}, revokeCapabilities() {}, cancel() {},
            waitForExit: async () => undefined,
            closeChannels() {},
            forceStop: () => new Promise<PhysicalExitObservation>(() => {}),
        })
        expect(result.effect.status).toBe("unknown")
        expect(result.events.at(-1)?.name).toBe("stop_unknown")
    })
})

describe("Supervisor epoch、心跳和恢复", () => {
    test("单活跃 Manager、epoch fencing 和 reconciliation 前禁止调度", () => {
        const clock = new FixtureClock()
        const supervisor = new Supervisor({ clock, heartbeatTimeoutMs: 50 })
        const first = supervisor.acquireManager("manager-a")
        expect(() => supervisor.acquireManager("manager-b")).toThrow(SupervisorLockError)
        expect(supervisor.canSchedule(first)).toBe(false)
        supervisor.completeReconciliation(first, 10)
        expect(supervisor.canSchedule(first)).toBe(true)
        expect(() => supervisor.heartbeat({ instanceId: "manager-a", epoch: first.epoch - 1 }, 11, 0)).toThrow(SupervisorFencedError)
    })

    test("心跳过期允许新 epoch 接管，并保留旧 epoch 不可写", () => {
        const clock = new FixtureClock()
        const supervisor = new Supervisor({ clock, heartbeatTimeoutMs: 10 })
        const first = supervisor.acquireManager("manager-a")
        clock.current = 111
        const second = supervisor.acquireManager("manager-b")
        expect(second.epoch).toBe(first.epoch + 1)
        expect(() => supervisor.completeReconciliation(first, 1)).toThrow(SupervisorFencedError)
    })

    test("连续启动失败使用退避并最终熔断", () => {
        const supervisor = new Supervisor({ maxConsecutiveFailures: 2, baseBackoffMs: 5, maxBackoffMs: 20 })
        expect(supervisor.recordManagerFailure().scheduling).toBe("backoff")
        expect(supervisor.recordManagerFailure().scheduling).toBe("circuit_open")
        expect(supervisor.canSchedule({ instanceId: "none", epoch: 0 })).toBe(false)
    })

    test("注册子进程时执行数量、CPU 和内存上限", () => {
        const supervisor = new Supervisor({ resourceLimits: { maxActiveChildren: 1, maxCpuMs: 10, maxMemoryBytes: 100 } })
        const lease = supervisor.acquireManager("manager-a")
        supervisor.completeReconciliation(lease, 1)
        const child = { childId: "child-a", identity: identity(), managerInstanceId: "manager-a", managerEpoch: lease.epoch, ledgerOwner: "manager-a", resourceUsage: { cpuMs: 10, memoryBytes: 100 } }
        supervisor.registerChild(lease, child)
        expect(() => supervisor.registerChild(lease, { ...child, childId: "child-b" })).toThrow(SupervisorResourceLimitError)
    })
})

describe("StartupRecovery 固定顺序与幂等 key", () => {
    test("先获取新 epoch，再对账 stop、补 review、恢复 worker、隔离 stale decision、最后开放调度", async () => {
        const supervisor = new Supervisor({ clock: new FixtureClock() })
        const calls: string[] = []
        const adapter = {
            async replayLedger() {
                calls.push("ledger")
                return {
                    ledgerRevision: 20,
                    acceptedFinals: [{ assignmentId: "a", reportId: "r", reportVersion: 1, runId: "run", stopEffect: effect({ effectId: "stop-1", status: "requested" }) }],
                    reviewJobs: [{ reviewJobId: "review-1", assignmentId: "a", reportId: "r", reportVersion: 1, status: "retryable" as const }],
                    plannerDecisions: [{ decisionId: "decision-live", assignmentId: "a", reportVersion: 1, stale: false }, { decisionId: "decision-old", assignmentId: "a", reportVersion: 0, stale: true }],
                }
            },
            async reconcileStop(_effect: unknown, key: string) { calls.push(`stop:${key}`) },
            async ensureReviewJob(_input: unknown, key: string) { calls.push(`review:${key}`) },
            async resumeReview(_job: unknown, key: string) { calls.push(`resume-review:${key}`) },
            async resumePlanner(_decision: unknown, key: string) { calls.push(`planner:${key}`) },
            async quarantineDecision(_decision: unknown, key: string) { calls.push(`quarantine:${key}`) },
        }
        const result = await new StartupRecovery(supervisor).run("manager-a", adapter)
        expect(result.steps).toEqual(["new_epoch", "ledger_replayed", "accepted_final_stop_reconciled", "review_jobs_backfilled", "reviewer_planner_resumed", "stale_decisions_quarantined", "scheduling_enabled"])
        expect(calls).toEqual([
            "ledger", "stop:recovery:stop:stop-1", "resume-review:recovery:review-resume:review-1",
            "planner:recovery:planner:decision-live", "quarantine:recovery:quarantine:decision-old",
        ])
        expect(supervisor.snapshot().scheduling).toBe("ready")
        expect(result.backfilledReviewJobs).toBe(0)
    })
})
