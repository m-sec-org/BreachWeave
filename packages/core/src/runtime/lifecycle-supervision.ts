/**
 * 运行时停止、物理副作用和 Supervisor 的确定性合同。
 *
 * 该模块只描述控制面行为，不直接依赖 Docker、Pi 或进程 API。真实运行时
 * 通过回调提供取消、通道关闭、进程观察和强制回收能力；因此同一套合同可
 * 由 Manager、Supervisor 和内存测试夹具复用。
 */

export type RuntimeEffectKind = "start" | "stop" | "force_stop" | "close_asset" | "close_challenge" | "reopen" | "publish"
export type RuntimeEffectStatus = "requested" | "applying" | "applied" | "failed" | "unknown"

export interface RuntimeIdentityInput {
    hostId: string
    bootId: string
    workerId: string
    containerId: string
    processStartIdentity: string
    processId?: number
}

export type RuntimeIdentity = Readonly<RuntimeIdentityInput>

export interface RuntimeEffectInput {
    effectId: string
    assignmentId: string
    runId: string
    kind: RuntimeEffectKind
    status?: RuntimeEffectStatus
    requestRevision: number
    idempotencyKey: string
    managerEpoch: number
    runGeneration: number
    leaseFencingToken: string
    identity: RuntimeIdentityInput
    stopPolicyRevision?: string
    stopDeadlineAt?: number
    errorCode?: string
    createdAt: number
    appliedAt?: number
}

export interface RuntimeEffect extends Omit<RuntimeEffectInput, "identity" | "status"> {
    readonly identity: RuntimeIdentity
    readonly status: RuntimeEffectStatus
}

export type PhysicalExitEvidence = "waitpid" | "container_exit" | "cgroup_empty" | "lease_expired" | "pid_reused" | "unmatched"

export interface PhysicalExitObservation {
    identity: RuntimeIdentityInput
    outcome: "running" | "exited" | "unknown"
    evidence: PhysicalExitEvidence
    observedAt: number
    processTreeExited: boolean
    channelsClosed: boolean
    ownedJobsReconciled: boolean
}

export interface MonotonicClock {
    now(): number
    waitUntil(deadlineAt: number): Promise<void>
}

export const SYSTEM_MONOTONIC_CLOCK: MonotonicClock = Object.freeze({
    now: () => performance.now(),
    waitUntil: async (deadlineAt: number) => {
        const remaining = Math.max(0, deadlineAt - performance.now())
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining))
    },
})

export interface StopPolicy {
    graceMs: number
    hardMs: number
}

export const DEFAULT_STOP_POLICY: Readonly<StopPolicy> = Object.freeze({ graceMs: 3_000, hardMs: 10_000 })

export interface StopRequest {
    effect: RuntimeEffect
    policy?: StopPolicy
}

export interface StopCallbacks {
    /** 由宿主在停止流程开始时关闭普通执行准入。 */
    closeAdmission(): Promise<unknown> | unknown
    /** 撤销本 run 的普通能力和订阅。 */
    revokeCapabilities(): Promise<unknown> | unknown
    /** 向 Pi/工具栈发出同步取消信号。 */
    cancel(): Promise<unknown> | unknown
    /** 允许复用现有 RuntimeManager 的停止入口。 */
    runtimeManagerStop?: (request: StopRequest) => Promise<unknown> | unknown
    /** 等待物理执行树结束，回调必须只观察，不重复产生停止副作用。 */
    waitForExit(deadlineAt: number): Promise<PhysicalExitObservation | undefined>
    /** 在硬 deadline 后执行有界强制回收。 */
    forceStop(deadlineAt: number): Promise<PhysicalExitObservation | undefined>
    /** 关闭执行通道，必须在 force stop 前完成。 */
    closeChannels(): Promise<unknown> | unknown
}

export type StopEventName =
    | "stop_requested"
    | "admission_closed"
    | "capabilities_revoked"
    | "cancel_requested"
    | "runtime_manager_stop_requested"
    | "stop_callback_failed"
    | "grace_deadline_reached"
    | "hard_deadline_reached"
    | "channels_closed"
    | "force_stop_requested"
    | "solver_stopped"
    | "solver_force_stopped"
    | "stop_unknown"

export interface StopEvent {
    name: StopEventName
    effectId: string
    at: number
    errorCode?: string
}

export interface StopResult {
    effect: RuntimeEffect
    events: readonly StopEvent[]
    releasedSlot: boolean
}

export class RuntimeIdentityError extends Error {
    readonly code = "runtime_identity_mismatch"

    constructor(message = "物理运行时身份不匹配") {
        super(message)
        this.name = "RuntimeIdentityError"
    }
}

export class SupervisorFencedError extends Error {
    readonly code = "manager_epoch_fenced"

    constructor(message = "Manager epoch 已被 Supervisor 隔离") {
        super(message)
        this.name = "SupervisorFencedError"
    }
}

export class SupervisorLockError extends Error {
    readonly code = "manager_lock_held"

    constructor(message = "已有活跃 Manager 持有 Supervisor 锁") {
        super(message)
        this.name = "SupervisorLockError"
    }
}

export class SupervisorResourceLimitError extends Error {
    readonly code = "child_resource_limit"

    constructor(message = "子进程资源超过 Supervisor 上限") {
        super(message)
        this.name = "SupervisorResourceLimitError"
    }
}

function nonEmpty(value: string, field: string): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\0\r\n]/.test(value)) throw new TypeError(`${field} 必须是有界文本`)
    return value
}

function positiveInteger(value: number, field: string, allowZero = false): number {
    if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new TypeError(`${field} 必须是有界整数`)
    return value
}

function finiteNumber(value: number, field: string): number {
    if (!Number.isFinite(value)) throw new TypeError(`${field} 必须是有限数值`)
    return value
}

export function createRuntimeIdentity(input: RuntimeIdentityInput): RuntimeIdentity {
    const identity: RuntimeIdentityInput = {
        hostId: nonEmpty(input.hostId, "hostId"),
        bootId: nonEmpty(input.bootId, "bootId"),
        workerId: nonEmpty(input.workerId, "workerId"),
        containerId: nonEmpty(input.containerId, "containerId"),
        processStartIdentity: nonEmpty(input.processStartIdentity, "processStartIdentity"),
        ...(input.processId === undefined ? {} : { processId: positiveInteger(input.processId, "processId") }),
    }
    return Object.freeze(identity)
}

export function sameRuntimeIdentity(left: RuntimeIdentityInput, right: RuntimeIdentityInput): boolean {
    return left.hostId === right.hostId
        && left.bootId === right.bootId
        && left.workerId === right.workerId
        && left.containerId === right.containerId
        && left.processStartIdentity === right.processStartIdentity
        && left.processId === right.processId
}

export function createRuntimeEffect(input: RuntimeEffectInput): RuntimeEffect {
    const status = input.status ?? "requested"
    const effect: RuntimeEffect = {
        effectId: nonEmpty(input.effectId, "effectId"),
        assignmentId: nonEmpty(input.assignmentId, "assignmentId"),
        runId: nonEmpty(input.runId, "runId"),
        kind: input.kind,
        status,
        requestRevision: positiveInteger(input.requestRevision, "requestRevision", true),
        idempotencyKey: nonEmpty(input.idempotencyKey, "idempotencyKey"),
        managerEpoch: positiveInteger(input.managerEpoch, "managerEpoch"),
        runGeneration: positiveInteger(input.runGeneration, "runGeneration", true),
        leaseFencingToken: nonEmpty(input.leaseFencingToken, "leaseFencingToken"),
        identity: createRuntimeIdentity(input.identity),
        ...(input.stopPolicyRevision === undefined ? {} : { stopPolicyRevision: nonEmpty(input.stopPolicyRevision, "stopPolicyRevision") }),
        ...(input.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: finiteNumber(input.stopDeadlineAt, "stopDeadlineAt") }),
        ...(input.errorCode === undefined ? {} : { errorCode: nonEmpty(input.errorCode, "errorCode") }),
        createdAt: finiteNumber(input.createdAt, "createdAt"),
        ...(input.appliedAt === undefined ? {} : { appliedAt: finiteNumber(input.appliedAt, "appliedAt") }),
    }
    return Object.freeze(effect)
}

function withEffect(effect: RuntimeEffect, changes: Partial<RuntimeEffectInput> & { identity?: RuntimeIdentityInput }): RuntimeEffect {
    return createRuntimeEffect({
        ...effect,
        ...changes,
        identity: changes.identity ?? effect.identity,
    })
}

const PHYSICAL_EXIT_EVIDENCE = new Set<PhysicalExitEvidence>(["waitpid", "container_exit", "cgroup_empty"])

export function reconcileRuntimeEffect(effect: RuntimeEffect, observation: PhysicalExitObservation): RuntimeEffect {
    const observedIdentity = createRuntimeIdentity(observation.identity)
    if (!sameRuntimeIdentity(effect.identity, observedIdentity)) return withEffect(effect, { status: "unknown", errorCode: "runtime_identity_mismatch" })
    if (observation.evidence === "lease_expired") return withEffect(effect, { status: "unknown", errorCode: "lease_expiry_not_exit" })
    if (observation.evidence === "pid_reused" || observation.evidence === "unmatched") return withEffect(effect, { status: "unknown", errorCode: "physical_identity_unproven" })
    if (observation.outcome === "exited" && PHYSICAL_EXIT_EVIDENCE.has(observation.evidence) && observation.processTreeExited && observation.channelsClosed && observation.ownedJobsReconciled) {
        return withEffect(effect, { status: "applied", appliedAt: observation.observedAt, errorCode: undefined })
    }
    if (observation.outcome === "running") return withEffect(effect, { status: "applying", errorCode: undefined })
    return withEffect(effect, { status: "unknown", errorCode: "physical_exit_unconfirmed" })
}

export function assertRuntimeIdentity(effect: RuntimeEffect, identity: RuntimeIdentityInput): void {
    if (!sameRuntimeIdentity(effect.identity, createRuntimeIdentity(identity))) throw new RuntimeIdentityError()
}

function validateStopPolicy(policy: StopPolicy): StopPolicy {
    positiveInteger(policy.graceMs, "graceMs", true)
    positiveInteger(policy.hardMs, "hardMs")
    if (policy.hardMs < policy.graceMs) throw new RangeError("hardMs 必须不小于 graceMs")
    return { graceMs: policy.graceMs, hardMs: policy.hardMs }
}

function event(name: StopEventName, effectId: string, at: number, errorCode?: string): StopEvent {
    return Object.freeze({ name, effectId, at, ...(errorCode === undefined ? {} : { errorCode }) })
}

export class StopCoordinator {
    private readonly inFlight = new Map<string, Promise<StopResult>>()
    private readonly clock: MonotonicClock
    private readonly defaultPolicy: StopPolicy

    constructor(options: { clock?: MonotonicClock; policy?: StopPolicy } = {}) {
        this.clock = options.clock ?? SYSTEM_MONOTONIC_CLOCK
        this.defaultPolicy = validateStopPolicy(options.policy ?? DEFAULT_STOP_POLICY)
    }

    request(request: StopRequest, callbacks: StopCallbacks): Promise<StopResult> {
        const existing = this.inFlight.get(request.effect.effectId)
        if (existing) return existing
        const run = this.run(request, callbacks)
        this.inFlight.set(request.effect.effectId, run)
        void run.finally(() => this.inFlight.delete(request.effect.effectId)).catch(() => {})
        return run
    }

    private async callBounded<T>(operation: () => Promise<T> | T, deadlineAt: number): Promise<{ value?: T; timedOut: boolean; error?: unknown }> {
        if (this.clock.now() >= deadlineAt) return { timedOut: true }
        const operationPromise = Promise.resolve().then(operation)
        const timer = this.clock.waitUntil(deadlineAt).then(() => { throw new Error("deadline") })
        try {
            const value = await Promise.race([operationPromise, timer])
            return { value, timedOut: false }
        } catch (error) {
            if (error instanceof Error && error.message === "deadline") return { timedOut: true }
            return { timedOut: false, error }
        }
    }

    private async run(request: StopRequest, callbacks: StopCallbacks): Promise<StopResult> {
        if (request.effect.kind !== "stop" && request.effect.kind !== "force_stop") throw new TypeError("StopCoordinator 只接受 stop effect")
        const policy = validateStopPolicy(request.policy ?? this.defaultPolicy)
        const startedAt = this.clock.now()
        const graceDeadlineAt = startedAt + policy.graceMs
        const hardDeadlineAt = startedAt + policy.hardMs
        let effect = withEffect(request.effect, { status: "applying", stopDeadlineAt: hardDeadlineAt, errorCode: undefined })
        const events: StopEvent[] = [event("stop_requested", effect.effectId, startedAt)]
        const emit = (name: StopEventName, errorCode?: string) => events.push(event(name, effect.effectId, this.clock.now(), errorCode))
        const boundedStep = async (name: string, operation: () => unknown | Promise<unknown>) => {
            const result = await this.callBounded(operation, hardDeadlineAt)
            if (result.error) emit("stop_callback_failed", `${name}:${result.error instanceof Error ? result.error.message : String(result.error)}`)
            if (result.timedOut) emit("stop_callback_failed", `${name}:deadline`)
            return !result.error && !result.timedOut
        }

        if (await boundedStep("closeAdmission", callbacks.closeAdmission)) emit("admission_closed")
        if (await boundedStep("revokeCapabilities", callbacks.revokeCapabilities)) emit("capabilities_revoked")
        if (await boundedStep("cancel", callbacks.cancel)) emit("cancel_requested")
        if (callbacks.runtimeManagerStop) {
            if (await boundedStep("runtimeManagerStop", () => callbacks.runtimeManagerStop?.(request))) emit("runtime_manager_stop_requested")
        }

        const graceful = await this.callBounded(() => callbacks.waitForExit(graceDeadlineAt), graceDeadlineAt)
        if (graceful.value && isConfirmedPhysicalExit(graceful.value, effect.identity)) {
            if (await boundedStep("closeChannels", callbacks.closeChannels)) emit("channels_closed")
            emit("solver_stopped")
            effect = withEffect(effect, { status: "applied", appliedAt: graceful.value.observedAt, errorCode: undefined })
            return Object.freeze({ effect, events: Object.freeze(events), releasedSlot: true })
        }
        if (this.clock.now() < graceDeadlineAt) await this.clock.waitUntil(graceDeadlineAt)
        emit("grace_deadline_reached")

        const hardWait = await this.callBounded(() => callbacks.waitForExit(hardDeadlineAt), hardDeadlineAt)
        if (hardWait.value && isConfirmedPhysicalExit(hardWait.value, effect.identity)) {
            if (await boundedStep("closeChannels", callbacks.closeChannels)) emit("channels_closed")
            emit("solver_stopped")
            effect = withEffect(effect, { status: "applied", appliedAt: hardWait.value.observedAt, errorCode: undefined })
            return Object.freeze({ effect, events: Object.freeze(events), releasedSlot: true })
        }
        if (this.clock.now() < hardDeadlineAt) await this.clock.waitUntil(hardDeadlineAt)
        emit("hard_deadline_reached")
        if (await boundedStep("closeChannels", callbacks.closeChannels)) emit("channels_closed")
        emit("force_stop_requested")
        const forceStopDeadlineAt = hardDeadlineAt + Math.max(1, policy.graceMs)
        const forcedAttempt = await this.callBounded(() => callbacks.forceStop(hardDeadlineAt), forceStopDeadlineAt)
        const forced = forcedAttempt.value
        const forceError = forcedAttempt.error ?? (forcedAttempt.timedOut ? new Error("force_stop_deadline") : undefined)
        if (isConfirmedPhysicalExit(forced, effect.identity)) {
            emit("solver_force_stopped")
            effect = withEffect(effect, { status: "applied", kind: "force_stop", appliedAt: forced.observedAt, errorCode: undefined })
            return Object.freeze({ effect, events: Object.freeze(events), releasedSlot: true })
        }
        emit("stop_unknown", forceError instanceof Error ? forceError.message : "physical_exit_unconfirmed")
        effect = withEffect(effect, { status: "unknown", kind: "force_stop", errorCode: "stop_unknown" })
        return Object.freeze({ effect, events: Object.freeze(events), releasedSlot: false })
    }
}

function isConfirmedPhysicalExit(observation: PhysicalExitObservation | undefined, identity: RuntimeIdentityInput): observation is PhysicalExitObservation {
    return !!observation
        && sameRuntimeIdentity(observation.identity, identity)
        && observation.outcome === "exited"
        && PHYSICAL_EXIT_EVIDENCE.has(observation.evidence)
        && observation.processTreeExited
        && observation.channelsClosed
        && observation.ownedJobsReconciled
}

export interface ManagerLease {
    readonly instanceId: string
    readonly epoch: number
}

export type SupervisorSchedulingState = "blocked_reconciling" | "ready" | "backoff" | "circuit_open"

export interface SupervisorState {
    readonly managerInstanceId?: string
    readonly managerEpoch: number
    readonly lastHeartbeatAt?: number
    readonly ledgerRevision?: number
    readonly reconciledAt?: number
    readonly activeChildCount: number
    readonly scheduling: SupervisorSchedulingState
    readonly consecutiveFailures: number
    readonly nextStartAt?: number
}

export interface SupervisorEvent {
    readonly name: "manager_epoch_changed" | "heartbeat_recorded" | "manager_fenced" | "orphan_discovered" | "orphan_reaped" | "orphan_unknown" | "manager_backoff" | "manager_circuit_open" | "reconciliation_complete"
    readonly at: number
    readonly epoch: number
    readonly childId?: string
    readonly errorCode?: string
}

export interface SupervisorChild {
    childId: string
    identity: RuntimeIdentityInput
    managerInstanceId?: string
    managerEpoch?: number
    ledgerOwner?: string
    deadlineAt?: number
    resourceUsage?: {
        cpuMs: number
        memoryBytes: number
    }
}

export interface SupervisorResourceLimits {
    maxActiveChildren?: number
    maxCpuMs?: number
    maxMemoryBytes?: number
}

export interface OrphanCleanupResult {
    identity: RuntimeIdentityInput
    outcome: "exited" | "unknown"
    evidence: PhysicalExitEvidence
    observedAt: number
    processTreeExited: boolean
    channelsClosed: boolean
    ownedJobsReconciled: boolean
}

export class Supervisor {
    private readonly clock: MonotonicClock
    private readonly heartbeatTimeoutMs: number
    private readonly maxConsecutiveFailures: number
    private readonly baseBackoffMs: number
    private readonly maxBackoffMs: number
    private readonly resourceLimits: SupervisorResourceLimits
    private state: SupervisorState
    private readonly events: SupervisorEvent[] = []

    constructor(options: {
        clock?: MonotonicClock
        heartbeatTimeoutMs?: number
        maxConsecutiveFailures?: number
        baseBackoffMs?: number
        maxBackoffMs?: number
        resourceLimits?: SupervisorResourceLimits
        initial?: Partial<SupervisorState>
    } = {}) {
        this.clock = options.clock ?? SYSTEM_MONOTONIC_CLOCK
        this.heartbeatTimeoutMs = positiveInteger(options.heartbeatTimeoutMs ?? 30_000, "heartbeatTimeoutMs")
        this.maxConsecutiveFailures = positiveInteger(options.maxConsecutiveFailures ?? 3, "maxConsecutiveFailures")
        this.baseBackoffMs = positiveInteger(options.baseBackoffMs ?? 1_000, "baseBackoffMs")
        this.maxBackoffMs = positiveInteger(options.maxBackoffMs ?? 30_000, "maxBackoffMs")
        this.resourceLimits = { ...options.resourceLimits }
        if (this.resourceLimits.maxActiveChildren !== undefined) positiveInteger(this.resourceLimits.maxActiveChildren, "maxActiveChildren", true)
        if (this.resourceLimits.maxCpuMs !== undefined) positiveInteger(this.resourceLimits.maxCpuMs, "maxCpuMs", true)
        if (this.resourceLimits.maxMemoryBytes !== undefined) positiveInteger(this.resourceLimits.maxMemoryBytes, "maxMemoryBytes", true)
        this.state = freezeSupervisorState({
            managerEpoch: options.initial?.managerEpoch ?? 0,
            managerInstanceId: options.initial?.managerInstanceId,
            lastHeartbeatAt: options.initial?.lastHeartbeatAt,
            ledgerRevision: options.initial?.ledgerRevision,
            reconciledAt: options.initial?.reconciledAt,
            activeChildCount: options.initial?.activeChildCount ?? 0,
            scheduling: options.initial?.scheduling ?? "blocked_reconciling",
            consecutiveFailures: options.initial?.consecutiveFailures ?? 0,
            nextStartAt: options.initial?.nextStartAt,
        })
    }

    snapshot(): SupervisorState {
        return this.state
    }

    eventLog(): readonly SupervisorEvent[] {
        return Object.freeze([...this.events])
    }

    acquireManager(instanceId: string): ManagerLease {
        nonEmpty(instanceId, "instanceId")
        const now = this.clock.now()
        const active = this.state.managerInstanceId !== undefined && this.state.lastHeartbeatAt !== undefined && now - this.state.lastHeartbeatAt < this.heartbeatTimeoutMs
        if (active) {
            this.events.push(Object.freeze({ name: "manager_fenced", at: now, epoch: this.state.managerEpoch, errorCode: "manager_lock_held" }))
            throw new SupervisorLockError()
        }
        const epoch = this.state.managerEpoch + 1
        this.state = freezeSupervisorState({
            ...this.state,
            managerInstanceId: instanceId,
            managerEpoch: epoch,
            lastHeartbeatAt: now,
            ledgerRevision: undefined,
            reconciledAt: undefined,
            activeChildCount: 0,
            scheduling: this.state.scheduling === "circuit_open" ? "circuit_open" : "blocked_reconciling",
        })
        this.events.push(Object.freeze({ name: "manager_epoch_changed", at: now, epoch }))
        return Object.freeze({ instanceId, epoch })
    }

    assertLease(lease: ManagerLease): void {
        if (this.state.managerInstanceId !== lease.instanceId || this.state.managerEpoch !== lease.epoch) throw new SupervisorFencedError()
    }

    heartbeat(lease: ManagerLease, ledgerRevision: number, activeChildCount: number): SupervisorState {
        this.assertLease(lease)
        positiveInteger(ledgerRevision, "ledgerRevision", true)
        positiveInteger(activeChildCount, "activeChildCount", true)
        const now = this.clock.now()
        this.state = freezeSupervisorState({ ...this.state, lastHeartbeatAt: now, ledgerRevision, activeChildCount })
        this.events.push(Object.freeze({ name: "heartbeat_recorded", at: now, epoch: lease.epoch }))
        return this.state
    }

    completeReconciliation(lease: ManagerLease, ledgerRevision: number): SupervisorState {
        this.assertLease(lease)
        positiveInteger(ledgerRevision, "ledgerRevision", true)
        const now = this.clock.now()
        const scheduling = this.state.scheduling === "circuit_open" ? "circuit_open" : "ready"
        this.state = freezeSupervisorState({ ...this.state, ledgerRevision, reconciledAt: now, scheduling })
        this.events.push(Object.freeze({ name: "reconciliation_complete", at: now, epoch: lease.epoch }))
        return this.state
    }

    canSchedule(lease: ManagerLease): boolean {
        try { this.assertLease(lease) } catch { return false }
        const now = this.clock.now()
        return this.state.scheduling === "ready" && (this.state.nextStartAt === undefined || now >= this.state.nextStartAt)
    }

    registerChild(lease: ManagerLease, child: SupervisorChild): void {
        this.assertLease(lease)
        if (!this.canSchedule(lease)) throw new SupervisorFencedError("reconciliation 尚未完成，不能接纳子进程")
        nonEmpty(child.childId, "childId")
        const usage = child.resourceUsage
        if (this.resourceLimits.maxActiveChildren !== undefined && this.state.activeChildCount >= this.resourceLimits.maxActiveChildren) throw new SupervisorResourceLimitError("活跃子进程数超过上限")
        if (usage && this.resourceLimits.maxCpuMs !== undefined && usage.cpuMs > this.resourceLimits.maxCpuMs) throw new SupervisorResourceLimitError("子进程 CPU 预算超过上限")
        if (usage && this.resourceLimits.maxMemoryBytes !== undefined && usage.memoryBytes > this.resourceLimits.maxMemoryBytes) throw new SupervisorResourceLimitError("子进程内存预算超过上限")
        this.state = freezeSupervisorState({ ...this.state, activeChildCount: this.state.activeChildCount + 1 })
    }

    releaseChild(lease: ManagerLease): void {
        this.assertLease(lease)
        this.state = freezeSupervisorState({ ...this.state, activeChildCount: Math.max(0, this.state.activeChildCount - 1) })
    }

    discoverOrphans(lease: ManagerLease, children: readonly SupervisorChild[]): readonly SupervisorChild[] {
        this.assertLease(lease)
        const orphans = children.filter((child) => child.managerInstanceId !== lease.instanceId || child.managerEpoch !== lease.epoch || child.ledgerOwner !== lease.instanceId)
        for (const child of orphans) this.events.push(Object.freeze({ name: "orphan_discovered", at: this.clock.now(), epoch: lease.epoch, childId: child.childId }))
        return Object.freeze([...orphans])
    }

    async reapOrphan(lease: ManagerLease, child: SupervisorChild, cleanup: (child: SupervisorChild, deadlineAt: number) => Promise<OrphanCleanupResult>): Promise<OrphanCleanupResult> {
        this.assertLease(lease)
        const deadlineAt = this.clock.now() + this.maxBackoffMs
        const result = await cleanup(child, deadlineAt)
        const confirmed = result.outcome === "exited" && sameRuntimeIdentity(child.identity, result.identity) && result.processTreeExited && result.channelsClosed && result.ownedJobsReconciled
        this.events.push(Object.freeze({ name: confirmed ? "orphan_reaped" : "orphan_unknown", at: this.clock.now(), epoch: lease.epoch, childId: child.childId, ...(confirmed ? {} : { errorCode: "orphan_identity_or_exit_unconfirmed" }) }))
        return result
    }

    recordManagerFailure(errorCode = "manager_start_failed"): SupervisorState {
        const failures = this.state.consecutiveFailures + 1
        const now = this.clock.now()
        if (failures >= this.maxConsecutiveFailures) {
            this.state = freezeSupervisorState({ ...this.state, consecutiveFailures: failures, scheduling: "circuit_open", nextStartAt: undefined })
            this.events.push(Object.freeze({ name: "manager_circuit_open", at: now, epoch: this.state.managerEpoch, errorCode }))
            return this.state
        }
        const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (failures - 1))
        this.state = freezeSupervisorState({ ...this.state, consecutiveFailures: failures, scheduling: "backoff", nextStartAt: now + delay })
        this.events.push(Object.freeze({ name: "manager_backoff", at: now, epoch: this.state.managerEpoch, errorCode }))
        return this.state
    }

    recordManagerHealthy(): SupervisorState {
        this.state = freezeSupervisorState({ ...this.state, consecutiveFailures: 0, nextStartAt: undefined, scheduling: this.state.reconciledAt === undefined ? "blocked_reconciling" : "ready" })
        return this.state
    }
}

function freezeSupervisorState(state: SupervisorState): SupervisorState {
    return Object.freeze({ ...state })
}

export interface AcceptedFinalRecovery {
    assignmentId: string
    reportId: string
    reportVersion: number
    runId: string
    stopEffect: RuntimeEffect
}

export interface RecoveryReviewJob {
    reviewJobId: string
    assignmentId: string
    reportId: string
    reportVersion: number
    status: "queued" | "leased" | "running" | "retryable" | "audit_retryable" | "ready" | "stale"
}

export interface RecoveryPlannerDecision {
    decisionId: string
    assignmentId: string
    reportVersion: number
    stale: boolean
}

export interface RecoverySnapshot {
    ledgerRevision: number
    acceptedFinals: readonly AcceptedFinalRecovery[]
    reviewJobs: readonly RecoveryReviewJob[]
    plannerDecisions: readonly RecoveryPlannerDecision[]
}

export interface RecoveryAdapter {
    replayLedger(): Promise<RecoverySnapshot>
    reconcileStop(effect: RuntimeEffect, idempotencyKey: string): Promise<void>
    ensureReviewJob(input: AcceptedFinalRecovery, idempotencyKey: string): Promise<void>
    resumeReview(job: RecoveryReviewJob, idempotencyKey: string): Promise<void>
    resumePlanner(decision: RecoveryPlannerDecision, idempotencyKey: string): Promise<void>
    quarantineDecision(decision: RecoveryPlannerDecision, idempotencyKey: string): Promise<void>
}

export type RecoveryStep = "new_epoch" | "ledger_replayed" | "accepted_final_stop_reconciled" | "review_jobs_backfilled" | "reviewer_planner_resumed" | "stale_decisions_quarantined" | "scheduling_enabled"

export interface RecoveryResult {
    lease: ManagerLease
    steps: readonly RecoveryStep[]
    reconciledStopEffects: number
    backfilledReviewJobs: number
    resumedReviews: number
    resumedPlanners: number
    quarantinedDecisions: number
}

export class StartupRecovery {
    constructor(private readonly supervisor: Supervisor) {}

    async run(instanceId: string, adapter: RecoveryAdapter): Promise<RecoveryResult> {
        const lease = this.supervisor.acquireManager(instanceId)
        const steps: RecoveryStep[] = ["new_epoch"]
        const snapshot = await adapter.replayLedger()
        steps.push("ledger_replayed")
        let reconciledStopEffects = 0
        for (const accepted of snapshot.acceptedFinals) {
            if (accepted.stopEffect.status === "applied") continue
            await adapter.reconcileStop(accepted.stopEffect, `recovery:stop:${accepted.stopEffect.effectId}`)
            reconciledStopEffects += 1
        }
        steps.push("accepted_final_stop_reconciled")
        let backfilledReviewJobs = 0
        const existingReviewKeys = new Set(snapshot.reviewJobs.map((job) => `${job.assignmentId}:${job.reportId}:${job.reportVersion}`))
        for (const accepted of snapshot.acceptedFinals) {
            const key = `${accepted.assignmentId}:${accepted.reportId}:${accepted.reportVersion}`
            if (existingReviewKeys.has(key)) continue
            await adapter.ensureReviewJob(accepted, `recovery:review:${key}`)
            existingReviewKeys.add(key)
            backfilledReviewJobs += 1
        }
        steps.push("review_jobs_backfilled")
        let resumedReviews = 0
        for (const job of snapshot.reviewJobs) {
            if (job.status === "ready" || job.status === "stale") continue
            await adapter.resumeReview(job, `recovery:review-resume:${job.reviewJobId}`)
            resumedReviews += 1
        }
        let resumedPlanners = 0
        for (const decision of snapshot.plannerDecisions) {
            if (decision.stale) continue
            await adapter.resumePlanner(decision, `recovery:planner:${decision.decisionId}`)
            resumedPlanners += 1
        }
        steps.push("reviewer_planner_resumed")
        let quarantinedDecisions = 0
        for (const decision of snapshot.plannerDecisions) {
            if (!decision.stale) continue
            await adapter.quarantineDecision(decision, `recovery:quarantine:${decision.decisionId}`)
            quarantinedDecisions += 1
        }
        steps.push("stale_decisions_quarantined")
        this.supervisor.completeReconciliation(lease, snapshot.ledgerRevision)
        steps.push("scheduling_enabled")
        return Object.freeze({ lease, steps: Object.freeze(steps), reconciledStopEffects, backfilledReviewJobs, resumedReviews, resumedPlanners, quarantinedDecisions })
    }
}
