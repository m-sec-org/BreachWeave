import * as Value from "typebox/value"
import { type TSchema } from "typebox"
import { AssignmentSchema, type Assignment, ReportRevisionSchema, type ReportRevision, SolverRunSchema, type SolverRun } from "./domain"

export class LifecycleValidationError extends Error {
    readonly code = "LIFECYCLE_VALIDATION_FAILED"
    constructor(message: string) {
        super(message)
        this.name = "LifecycleValidationError"
    }
}

export class LifecycleFenceError extends Error {
    readonly code = "LIFECYCLE_STALE_FENCE"
    readonly field: string
    constructor(field: string, expected: unknown, received: unknown) {
        super(`生命周期校验失败：${field} 已过期（期望 ${String(expected)}，收到 ${String(received)}）`)
        this.name = "LifecycleFenceError"
        this.field = field
    }
}

export class LifecycleOperationConflictError extends Error {
    readonly code = "LIFECYCLE_OPERATION_CONFLICT"
    constructor(message: string) {
        super(message)
        this.name = "LifecycleOperationConflictError"
    }
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue)
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]))
    }
    return value
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(stableValue(value))
}

export function sha256Digest(value: unknown): string {
    return new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")
}

export function isSchemaValue<T extends TSchema>(schema: T, value: unknown): value is import("typebox").Static<T> {
    return Value.Check(schema, value)
}

/** 严格校验输入；不做类型强制转换，也不复制未知字段。 */
export function parseStrict<T extends TSchema>(schema: T, value: unknown, label = "输入"): import("typebox").Static<T> {
    if (!Value.Check(schema, value)) throw new LifecycleValidationError(`${label} 不符合严格 schema`)
    return structuredClone(value) as import("typebox").Static<T>
}

export interface HostBoundIdentity {
    assignmentId: string
    runId?: string
    generation: number
    managerEpoch: number
    scopeRevision: number
    leaseToken?: string
}

const IDENTITY_FIELDS = ["assignmentId", "runId", "generation", "managerEpoch", "scopeRevision", "leaseToken"] as const

/** 模型不得传入或覆盖宿主绑定身份；存在字段时必须与宿主一致。 */
export function assertHostBoundIdentity(input: unknown, bound: HostBoundIdentity): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new LifecycleValidationError("请求必须是对象")
    const record = input as Record<string, unknown>
    for (const field of IDENTITY_FIELDS) {
        const expected = bound[field]
        const received = record[field]
        if (received !== undefined && received !== expected) throw new LifecycleValidationError(`请求不得覆盖宿主绑定字段 ${field}`)
    }
}

export interface LifecycleFence {
    assignmentRevision: number
    generation: number
    managerEpoch: number
    scopeRevision: number
    leaseToken?: string
    operationKey: string
}

export interface CurrentLifecycleFence {
    assignmentRevision: number
    generation: number
    managerEpoch: number
    scopeRevision: number
    leaseToken?: string
}

export function validateLifecycleFence(request: LifecycleFence, current: CurrentLifecycleFence): void {
    for (const field of ["assignmentRevision", "generation", "managerEpoch", "scopeRevision"] as const) {
        const expected = current[field]
        const received = request[field]
        if (received !== expected) throw new LifecycleFenceError(field, expected, received)
    }
    if (current.leaseToken !== undefined && request.leaseToken !== current.leaseToken) throw new LifecycleFenceError("leaseToken", current.leaseToken, request.leaseToken)
    if (!request.operationKey.trim()) throw new LifecycleValidationError("operationKey 不能为空")
}

export function validateRevision(expected: number, received: number, field = "revision"): void {
    if (!Number.isSafeInteger(received) || received !== expected) throw new LifecycleFenceError(field, expected, received)
}

export function validateGeneration(expected: number, received: number): void {
    validateRevision(expected, received, "generation")
}

export function validateManagerEpoch(expected: number, received: number): void {
    validateRevision(expected, received, "managerEpoch")
}

export function validateScopeRevision(expected: number, received: number): void {
    validateRevision(expected, received, "scopeRevision")
}

export function validateLease(expected: string, received: string): void {
    if (received !== expected) throw new LifecycleFenceError("leaseToken", expected, received)
}

export function validateReportIdentity(report: ReportRevision, assignment: Assignment, run: SolverRun): void {
    if (report.assignmentId !== assignment.assignmentId) throw new LifecycleFenceError("assignmentId", assignment.assignmentId, report.assignmentId)
    if (report.runId !== run.runId) throw new LifecycleFenceError("runId", run.runId, report.runId)
    if (report.generation !== run.generation) throw new LifecycleFenceError("generation", run.generation, report.generation)
    if (report.managerEpoch !== run.managerEpoch) throw new LifecycleFenceError("managerEpoch", run.managerEpoch, report.managerEpoch)
    if (report.scopeRevision !== run.scopeRevision) throw new LifecycleFenceError("scopeRevision", run.scopeRevision, report.scopeRevision)
    if (report.taskSnapshotHash !== assignment.taskSnapshotHash) throw new LifecycleFenceError("taskSnapshotHash", assignment.taskSnapshotHash, report.taskSnapshotHash)
}

export function operationPayloadHash(payload: unknown): string {
    return sha256Digest(payload)
}

export function ensureOperationKey(operationKey: unknown): string {
    if (typeof operationKey !== "string" || !operationKey.trim()) throw new LifecycleValidationError("operationKey 必须是非空字符串")
    return operationKey.trim()
}

export function parseAssignment(value: unknown): Assignment {
    return parseStrict(AssignmentSchema, value, "Assignment")
}

export function parseReportRevision(value: unknown): ReportRevision {
    return parseStrict(ReportRevisionSchema, value, "ReportRevision")
}

export function parseSolverRun(value: unknown): SolverRun {
    return parseStrict(SolverRunSchema, value, "SolverRun")
}
