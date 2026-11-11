import type { Assignment, ReportRevision, SolverRun } from "../lifecycle/domain"
import type { AppendReportInput, AppendReportResult, LifecycleLedger, LifecycleOperationResult } from "../lifecycle/ledger"
import { createInMemoryLifecycleLedger } from "../lifecycle/ledger"
import { LifecycleFenceError, LifecycleOperationConflictError, operationPayloadHash, sha256Digest } from "../lifecycle/validation"
import { transitionSolverRun } from "../lifecycle/reducer"

export type LifecycleReportCode = "REPORT_ACCEPTED" | "PENDING_COMMIT"

export interface LifecycleAssignmentInput {
    assignmentId?: string
    runId?: string
    challengeId: string
    taskSnapshotHash: string
    scopeRevision: number
    managerEpoch: number
    runtimeId: string
    leaseToken: string
    leaseExpiresAt: string
}

export interface LifecycleReportInput {
    operationKey: string
    assignmentId: string
    runId: string
    generation: number
    managerEpoch: number
    scopeRevision: number
    leaseToken: string
    taskSnapshotHash: string
    reportId: string
    payload: unknown
    evidenceSnapshotHash?: string
}

export interface FinalBatchItem {
    kind: "final_report" | "tool_call" | "bash" | "read" | "mcp" | "nested_task" | "steer" | "follow_up"
}

export interface LifecycleStopRequest {
    assignment: Assignment
    run: SolverRun
    report?: ReportRevision
    reason: "final_report" | "pending_commit"
}

export interface ManagerLifecycleOptions {
    ledger?: LifecycleLedger
    stop?: (request: LifecycleStopRequest) => Promise<void> | void
    spool?: PendingCommitSpool
}

export interface LifecycleReportResult {
    code: LifecycleReportCode
    operationKey: string
    result?: AppendReportResult
    pendingId?: string
    diagnostics?: string
}

export interface LifecycleProjection {
    challengeId: string
    runtime: "running" | "stopping" | "stopped" | "unknown"
    assignmentPhase: string
    reportPhase: "none" | "incremental" | "final" | "pending_commit"
    reviewState: string
    finalizationState: "open" | "unknown"
    pendingDiagnostics: readonly string[]
}

export interface PendingCommitEntry {
    id: string
    operationKey: string
    payloadHash: string
    encryptedPayload: string
    createdAt: string
}

export interface PendingCommitSpool {
    put(input: { operationKey: string; payloadHash: string; payload: unknown }): Promise<PendingCommitEntry>
    list(): Promise<readonly PendingCommitEntry[]>
    read(id: string): Promise<unknown | undefined>
    remove?(id: string): Promise<void>
}

/** 有界内存加密 spool。生产适配器可用同一接口替换为加密文件或密钥服务。 */
export class EncryptedPendingCommitSpool implements PendingCommitSpool {
    private readonly entries = new Map<string, PendingCommitEntry>()
    private readonly keyPromise: Promise<CryptoKey>

    constructor(private readonly maxEntries = 128, key?: Uint8Array) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("spool 容量必须是正整数")
        const bytes = key ? new Uint8Array(key) : crypto.getRandomValues(new Uint8Array(32))
        if (bytes.byteLength !== 32) throw new RangeError("spool 密钥必须为 32 字节")
        this.keyPromise = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])
    }

    async put(input: { operationKey: string; payloadHash: string; payload: unknown }): Promise<PendingCommitEntry> {
        if (!input.operationKey.trim()) throw new TypeError("operationKey 不能为空")
        if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) throw new TypeError("payloadHash 无效")
        const existing = [...this.entries.values()].find((entry) => entry.operationKey === input.operationKey)
        if (existing) {
            if (existing.payloadHash !== input.payloadHash) throw new LifecycleOperationConflictError("pending operationKey 内容冲突")
            return existing
        }
        if (this.entries.size >= this.maxEntries) throw new Error("pending commit spool 已满")
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const plaintext = new TextEncoder().encode(JSON.stringify(input.payload))
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.keyPromise, plaintext))
        const encoded = `${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`
        const entry: PendingCommitEntry = { id: `pending:${crypto.randomUUID()}`, operationKey: input.operationKey, payloadHash: input.payloadHash, encryptedPayload: encoded, createdAt: new Date().toISOString() }
        this.entries.set(entry.id, entry)
        return entry
    }

    async list(): Promise<readonly PendingCommitEntry[]> {
        return [...this.entries.values()].map((entry) => ({ ...entry }))
    }

    async read(id: string): Promise<unknown | undefined> {
        const entry = this.entries.get(id)
        if (!entry) return undefined
        const [ivText, cipherText] = entry.encryptedPayload.split(".")
        if (!ivText || !cipherText) throw new Error("pending commit 密文损坏")
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(ivText, "base64url") }, await this.keyPromise, Buffer.from(cipherText, "base64url"))
        return JSON.parse(new TextDecoder().decode(plaintext))
    }

    async remove(id: string): Promise<void> {
        this.entries.delete(id)
    }
}

function requireText(value: string, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} 不能为空`)
    return value.trim()
}

function requirePositive(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} 必须为正整数`)
    return value
}

function now(): string {
    return new Date().toISOString()
}

export function validateFinalBatch(batch: readonly FinalBatchItem[]): void {
    if (!Array.isArray(batch) || batch.length !== 1 || batch[0]?.kind !== "final_report") {
        throw new Error("final report 必须是只包含一个 final_report 的完整批次")
    }
}

export class ManagerLifecycleService {
    readonly ledger: LifecycleLedger
    readonly spool: PendingCommitSpool
    private readonly terminalGates = new Set<string>()
    private readonly assignmentChallenges = new Map<string, string>()
    private readonly stop?: (request: LifecycleStopRequest) => Promise<void> | void

    constructor(options: ManagerLifecycleOptions = {}) {
        this.ledger = options.ledger ?? createInMemoryLifecycleLedger()
        this.spool = options.spool ?? new EncryptedPendingCommitSpool()
        this.stop = options.stop
    }

    createAssignment(input: LifecycleAssignmentInput): { assignment: Assignment; run: SolverRun } {
        const challengeId = requireText(input.challengeId, "challengeId")
        const assignmentId = input.assignmentId?.trim() || `assignment:${crypto.randomUUID()}`
        const runId = input.runId?.trim() || `run:${crypto.randomUUID()}`
        const taskSnapshotHash = requireText(input.taskSnapshotHash, "taskSnapshotHash")
        if (!/^[a-f0-9]{64}$/.test(taskSnapshotHash)) throw new TypeError("taskSnapshotHash 必须为 SHA-256 摘要")
        const scopeRevision = requirePositive(input.scopeRevision, "scopeRevision")
        const managerEpoch = requirePositive(input.managerEpoch, "managerEpoch")
        const createdAt = now()
        const assignment: Assignment = {
            assignmentId, challengeId, taskSnapshotHash, lineageId: assignmentId, phase: "executing", revision: 1,
            scopeRevision, managerEpoch, activeRunId: runId, currentReportVersion: 0, createdAt, updatedAt: createdAt,
        }
        const run: SolverRun = {
            runId, assignmentId, generation: 1, status: "starting", revision: 1, managerEpoch, scopeRevision,
            leaseToken: requireText(input.leaseToken, "leaseToken"), leaseExpiresAt: requireText(input.leaseExpiresAt, "leaseExpiresAt"),
            runtimeId: requireText(input.runtimeId, "runtimeId"), startedAt: createdAt,
        }
        this.ledger.putAssignment(assignment)
        this.ledger.putSolverRun(run)
        const activeRun = transitionSolverRun(run, "running")
        this.ledger.updateSolverRun(activeRun, run.revision)
        this.assignmentChallenges.set(assignmentId, challengeId)
        return { assignment, run: activeRun }
    }

    async projection(challengeId: string): Promise<LifecycleProjection> {
        const assignments = [...this.assignmentChallenges.entries()]
            .filter(([, value]) => value === challengeId)
            .map(([assignmentId]) => this.ledger.getAssignment(assignmentId))
            .filter((value): value is Assignment => value !== undefined)
        const assignment = assignments.at(-1)
        const run = assignment?.activeRunId ? this.ledger.getSolverRun(assignment.activeRunId) : undefined
        const reports = assignment ? this.ledger.listOutbox().filter((entry) => typeof entry.payload === "object" && entry.payload !== null && (entry.payload as { assignmentId?: unknown }).assignmentId === assignment.assignmentId) : []
        const pendingEntries = await this.spool.list()
        const pending: PendingCommitEntry[] = []
        for (const entry of pendingEntries) {
            const payload = await this.spool.read(entry.id)
            const assignmentId = payload && typeof payload === "object" ? (payload as { assignmentId?: unknown }).assignmentId : undefined
            if (typeof assignmentId === "string" && this.assignmentChallenges.get(assignmentId) === challengeId) pending.push(entry)
        }
        return {
            challengeId,
            runtime: run?.status === "running" ? "running" : run?.status === "stopping" ? "stopping" : run?.status === "stopped" || run?.status === "force_stopped" || run?.status === "crashed" ? "stopped" : "unknown",
            assignmentPhase: assignment?.phase ?? "unknown",
            reportPhase: pending.length > 0 ? "pending_commit" : reports.some((entry) => entry.operation.endsWith("accept_final_report")) ? "final" : reports.length > 0 ? "incremental" : "none",
            reviewState: assignment?.currentReportVersion ? (this.ledger.getCurrentReviewJob(assignment.assignmentId, assignment.currentReportVersion)?.status ?? "queued") : "none",
            finalizationState: "unknown",
            pendingDiagnostics: pending.map((entry) => entry.operationKey),
        }
    }

    async submitProgress(input: LifecycleReportInput): Promise<LifecycleReportResult> {
        return this.append(input, "incremental")
    }

    isTerminalGated(runId: string): boolean {
        return this.terminalGates.has(runId)
    }

    async submitFinal(input: LifecycleReportInput, batch: readonly FinalBatchItem[] = [{ kind: "final_report" }]): Promise<LifecycleReportResult> {
        validateFinalBatch(batch)
        const assignment = this.ledger.getAssignment(input.assignmentId)
        const run = this.ledger.getSolverRun(input.runId)
        if (!assignment || !run) throw new Error("assignment/run 不存在")
        const previous = this.ledger.getOutbox(input.operationKey)
        if (previous?.result) return { code: "REPORT_ACCEPTED", operationKey: input.operationKey, result: previous.result as AppendReportResult }
        const pending = (await this.spool.list()).some((entry) => entry.operationKey === input.operationKey)
        if (this.terminalGates.has(run.runId) && !pending) throw new Error("run 的终态准入门已关闭")
        this.terminalGates.add(run.runId)
        return this.append(input, "final", assignment, run)
    }

    async reconcilePending(): Promise<readonly LifecycleReportResult[]> {
        const results: LifecycleReportResult[] = []
        for (const entry of await this.spool.list()) {
            const payload = await this.spool.read(entry.id)
            if (!payload || typeof payload !== "object") continue
            const input = payload as AppendReportInput
            try {
                const result = await this.ledger.acceptFinalReport(input)
                results.push({ code: "REPORT_ACCEPTED", operationKey: result.operationKey, result: result.result })
                await this.spool.remove?.(entry.id)
            } catch (error) {
                results.push({ code: "PENDING_COMMIT", operationKey: entry.operationKey, pendingId: entry.id, diagnostics: error instanceof Error ? error.message : String(error) })
            }
        }
        return results
    }

    private async append(input: LifecycleReportInput, kind: "incremental" | "final", knownAssignment?: Assignment, knownRun?: SolverRun): Promise<LifecycleReportResult> {
        const payloadHash = operationPayloadHash(input.payload)
        const request: AppendReportInput = {
            operationKey: requireText(input.operationKey, "operationKey"), assignmentId: requireText(input.assignmentId, "assignmentId"),
            runId: requireText(input.runId, "runId"), generation: requirePositive(input.generation, "generation"), managerEpoch: requirePositive(input.managerEpoch, "managerEpoch"),
            scopeRevision: requirePositive(input.scopeRevision, "scopeRevision"), leaseToken: requireText(input.leaseToken, "leaseToken"), taskSnapshotHash: requireText(input.taskSnapshotHash, "taskSnapshotHash"),
            reportId: requireText(input.reportId, "reportId"), payloadHash, submissionKind: kind, ...(input.evidenceSnapshotHash ? { evidenceSnapshotHash: input.evidenceSnapshotHash } : {}),
        }
        try {
            const result = kind === "final" ? await this.ledger.acceptFinalReport(request) : await this.ledger.appendReport(request)
            if (kind === "final" && result.result.report && (this.stop !== undefined)) {
                const assignment = knownAssignment ?? this.ledger.getAssignment(request.assignmentId)
                const run = knownRun ?? this.ledger.getSolverRun(request.runId)
                if (assignment && run) {
                    try {
                        await this.stop({ assignment, run, report: result.result.report, reason: "final_report" })
                    } catch (error) {
                        return { code: "REPORT_ACCEPTED", operationKey: result.operationKey, result: result.result, diagnostics: error instanceof Error ? error.message : String(error) }
                    }
                }
            }
            return { code: "REPORT_ACCEPTED", operationKey: result.operationKey, result: result.result }
        } catch (error) {
            if (kind !== "final") throw error
            if (error instanceof LifecycleFenceError || error instanceof LifecycleOperationConflictError) {
                this.terminalGates.delete(input.runId)
                throw error
            }
            const pending = await this.spool.put({ operationKey: request.operationKey, payloadHash: operationPayloadHash(request), payload: request })
            const assignment = knownAssignment ?? this.ledger.getAssignment(request.assignmentId)
            const run = knownRun ?? this.ledger.getSolverRun(request.runId)
            if (assignment && run && this.stop) await this.stop({ assignment, run, reason: "pending_commit" })
            return { code: "PENDING_COMMIT", operationKey: request.operationKey, pendingId: pending.id, diagnostics: error instanceof Error ? error.message : String(error) }
        }
    }
}

export function createManagerLifecycleService(options: ManagerLifecycleOptions = {}): ManagerLifecycleService {
    return new ManagerLifecycleService(options)
}

export function lifecyclePayloadHash(payload: unknown): string {
    return sha256Digest(payload)
}
