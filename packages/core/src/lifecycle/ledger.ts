import type { Assignment, ReviewJob, ReportRevision, RuntimeEffect, SolverRun } from "./domain"
import { LifecycleFenceError, LifecycleOperationConflictError, LifecycleValidationError, ensureOperationKey, operationPayloadHash, validateLifecycleFence, validateReportIdentity } from "./validation"
import { transitionAssignment, transitionSolverRun } from "./reducer"

export type LifecycleOutboxStatus = "pending" | "dispatched" | "reconciled" | "conflict" | "unknown" | "failed"

export interface LifecycleOutboxRecord<T = unknown> {
    outboxId: string
    operationKey: string
    operation: string
    payloadHash: string
    payload: T
    status: LifecycleOutboxStatus
    result?: unknown
    createdAt: string
    updatedAt: string
}

export interface LifecycleOperationResult<T> {
    status: "applied" | "replayed"
    operationKey: string
    result: T
}

export interface AppendReportInput {
    operationKey: string
    assignmentId: string
    runId: string
    generation: number
    managerEpoch: number
    scopeRevision: number
    leaseToken: string
    taskSnapshotHash: string
    reportId: string
    payloadHash: string
    submissionKind: "incremental" | "final"
    evidenceSnapshotHash?: string
    createdAt?: string
}

export interface AppendReportResult {
    report: ReportRevision
    assignment: Assignment
    reviewJob?: ReviewJob
    stopEffect?: RuntimeEffect
}

export interface LifecycleLedger {
    getAssignment(assignmentId: string): Assignment | undefined
    getSolverRun(runId: string): SolverRun | undefined
    getReport(reportId: string): ReportRevision | undefined
    getReviewJob(reviewJobId: string): ReviewJob | undefined
    getCurrentReviewJob(assignmentId: string, reportVersion: number): ReviewJob | undefined
    getRuntimeEffect(effectId: string): RuntimeEffect | undefined
    getOutbox(operationKey: string): LifecycleOutboxRecord | undefined
    listOutbox(): readonly LifecycleOutboxRecord[]
    putAssignment(assignment: Assignment): void
    putSolverRun(run: SolverRun): void
    updateAssignment(assignment: Assignment, expectedRevision: number): void
    updateSolverRun(run: SolverRun, expectedRevision: number): void
    appendReport(input: AppendReportInput): Promise<LifecycleOperationResult<AppendReportResult>>
    acceptFinalReport(input: AppendReportInput): Promise<LifecycleOperationResult<AppendReportResult>>
}

function now(): string {
    return new Date().toISOString()
}

function clone<T>(value: T): T {
    return structuredClone(value)
}

function operationHash(input: AppendReportInput): string {
    return operationPayloadHash({
        assignmentId: input.assignmentId,
        runId: input.runId,
        generation: input.generation,
        managerEpoch: input.managerEpoch,
        scopeRevision: input.scopeRevision,
        leaseToken: input.leaseToken,
        taskSnapshotHash: input.taskSnapshotHash,
        reportId: input.reportId,
        payloadHash: input.payloadHash,
        submissionKind: input.submissionKind,
        evidenceSnapshotHash: input.evidenceSnapshotHash ?? null,
    })
}

function ensureSame<T>(current: T | undefined, expected: T, label: string): void {
    if (current === undefined) return
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new LifecycleOperationConflictError(`${label} 已存在且内容冲突`)
}

/** 确定性内存 Ledger，作为测试和本地 profile 的权威实现。 */
export class InMemoryLifecycleLedger implements LifecycleLedger {
    private readonly assignments = new Map<string, Assignment>()
    private readonly runs = new Map<string, SolverRun>()
    private readonly reports = new Map<string, ReportRevision>()
    private readonly reportsByAssignment = new Map<string, ReportRevision[]>()
    private readonly reviewJobs = new Map<string, ReviewJob>()
    private readonly effects = new Map<string, RuntimeEffect>()
    private readonly outbox = new Map<string, LifecycleOutboxRecord>()

    getAssignment(assignmentId: string): Assignment | undefined { return clone(this.assignments.get(assignmentId)) }
    getSolverRun(runId: string): SolverRun | undefined { return clone(this.runs.get(runId)) }
    getReport(reportId: string): ReportRevision | undefined { return clone(this.reports.get(reportId)) }
    getReviewJob(reviewJobId: string): ReviewJob | undefined { return clone(this.reviewJobs.get(reviewJobId)) }
    getCurrentReviewJob(assignmentId: string, reportVersion: number): ReviewJob | undefined {
        const result = [...this.reviewJobs.values()].find((job) => job.assignmentId === assignmentId && job.reportVersion === reportVersion && job.status !== "stale")
        return clone(result)
    }
    getRuntimeEffect(effectId: string): RuntimeEffect | undefined { return clone(this.effects.get(effectId)) }
    getOutbox(operationKey: string): LifecycleOutboxRecord | undefined { return clone(this.outbox.get(operationKey)) }
    listOutbox(): readonly LifecycleOutboxRecord[] { return clone([...this.outbox.values()]) }

    putAssignment(assignment: Assignment): void {
        const current = this.assignments.get(assignment.assignmentId)
        ensureSame(current, assignment, "Assignment")
        this.assignments.set(assignment.assignmentId, clone(assignment))
    }

    putSolverRun(run: SolverRun): void {
        const current = this.runs.get(run.runId)
        ensureSame(current, run, "SolverRun")
        this.runs.set(run.runId, clone(run))
    }

    updateAssignment(assignment: Assignment, expectedRevision: number): void {
        const current = this.assignments.get(assignment.assignmentId)
        if (!current) throw new LifecycleFenceError("assignmentId", "存在", assignment.assignmentId)
        if (current.revision !== expectedRevision) throw new LifecycleFenceError("assignmentRevision", expectedRevision, current.revision)
        if (assignment.revision !== expectedRevision + 1) throw new LifecycleValidationError("Assignment revision 必须单调递增")
        this.assignments.set(assignment.assignmentId, clone(assignment))
    }

    updateSolverRun(run: SolverRun, expectedRevision: number): void {
        const current = this.runs.get(run.runId)
        if (!current) throw new LifecycleFenceError("runId", "存在", run.runId)
        if (current.revision !== expectedRevision) throw new LifecycleFenceError("runRevision", expectedRevision, current.revision)
        if (run.revision !== expectedRevision + 1) throw new LifecycleValidationError("SolverRun revision 必须单调递增")
        this.runs.set(run.runId, clone(run))
    }

    appendReport(input: AppendReportInput): Promise<LifecycleOperationResult<AppendReportResult>> {
        return this.commitReport(input, input.submissionKind === "final")
    }

    acceptFinalReport(input: AppendReportInput): Promise<LifecycleOperationResult<AppendReportResult>> {
        if (input.submissionKind !== "final") throw new LifecycleOperationConflictError("acceptFinalReport 只接受 final 报告")
        return this.commitReport(input, true)
    }

    private async commitReport(input: AppendReportInput, final: boolean): Promise<LifecycleOperationResult<AppendReportResult>> {
        const operationKey = ensureOperationKey(input.operationKey)
        const payloadHash = operationHash(input)
        const existingOperation = this.outbox.get(operationKey)
        if (existingOperation) {
            if (existingOperation.payloadHash !== payloadHash) throw new LifecycleOperationConflictError("operationKey 已被不同 payload 占用")
            if (existingOperation.result === undefined) throw new LifecycleOperationConflictError("operationKey 已存在但结果尚未可重放")
            return { status: "replayed", operationKey, result: clone(existingOperation.result as AppendReportResult) }
        }

        const assignment = this.assignments.get(input.assignmentId)
        const run = this.runs.get(input.runId)
        if (!assignment) throw new LifecycleFenceError("assignmentId", "存在", input.assignmentId)
        if (!run) throw new LifecycleFenceError("runId", "存在", input.runId)
        validateLifecycleFence({
            assignmentRevision: assignment.revision,
            generation: input.generation,
            managerEpoch: input.managerEpoch,
            scopeRevision: input.scopeRevision,
            leaseToken: input.leaseToken,
            operationKey,
        }, {
            assignmentRevision: assignment.revision,
            generation: run.generation,
            managerEpoch: run.managerEpoch,
            scopeRevision: run.scopeRevision,
            leaseToken: run.leaseToken,
        })
        if (run.status !== "running" && !(final && run.status === "finalizing")) throw new LifecycleOperationConflictError(`run 当前状态 ${run.status} 不可提交报告`)
        const version = assignment.currentReportVersion + 1
        const report: ReportRevision = {
            reportId: input.reportId,
            assignmentId: input.assignmentId,
            runId: input.runId,
            generation: input.generation,
            reportVersion: version,
            submissionKind: input.submissionKind,
            payloadHash: input.payloadHash,
            taskSnapshotHash: input.taskSnapshotHash,
            scopeRevision: input.scopeRevision,
            managerEpoch: input.managerEpoch,
            operationKey,
            ...(input.evidenceSnapshotHash ? { evidenceSnapshotHash: input.evidenceSnapshotHash } : {}),
            createdAt: input.createdAt ?? now(),
        }
        validateReportIdentity(report, assignment, run)
        const existingReport = this.reports.get(report.reportId)
        if (existingReport) {
            if (existingReport.payloadHash !== report.payloadHash) throw new LifecycleOperationConflictError("reportId 已被不同 payload 占用")
            throw new LifecycleOperationConflictError("reportId 已存在但 operationKey 不同")
        }

        const nextAssignment = {
            ...transitionAssignment(assignment, final ? (input.evidenceSnapshotHash ? "awaiting_audit" : "awaiting_evidence") : "report_submitted"),
            currentReportVersion: version,
        }
        const reviewJob: ReviewJob | undefined = final ? {
            reviewJobId: `review:${report.reportId}`,
            assignmentId: report.assignmentId,
            reportId: report.reportId,
            reportVersion: report.reportVersion,
            generation: report.generation,
            status: "queued" as const,
            attempt: 0,
            managerEpoch: report.managerEpoch,
            scopeRevision: report.scopeRevision,
            ...(report.evidenceSnapshotHash ? { evidenceSnapshotHash: report.evidenceSnapshotHash } : {}),
            createdAt: report.createdAt,
        } : undefined
        const stopEffect: RuntimeEffect | undefined = final ? {
            effectId: `stop:${report.runId}:${report.generation}`,
            assignmentId: report.assignmentId,
            runId: report.runId,
            generation: report.generation,
            managerEpoch: report.managerEpoch,
            scopeRevision: report.scopeRevision,
            leaseToken: run.leaseToken,
            kind: "stop",
            status: "requested" as const,
            requestRevision: assignment.revision,
            idempotencyKey: `stop:${report.reportId}`,
            createdAt: report.createdAt,
        } : undefined
        const result: AppendReportResult = { report, assignment: nextAssignment, ...(reviewJob ? { reviewJob } : {}), ...(stopEffect ? { stopEffect } : {}) }
        const outboxRecord: LifecycleOutboxRecord = {
            outboxId: `outbox:${operationKey}`,
            operationKey,
            operation: final ? "lifecycle.accept_final_report" : "lifecycle.append_report",
            payloadHash,
            payload: clone(input),
            status: "reconciled",
            result: clone(result),
            createdAt: report.createdAt,
            updatedAt: report.createdAt,
        }
        this.reports.set(report.reportId, clone(report))
        this.reportsByAssignment.set(report.assignmentId, [...(this.reportsByAssignment.get(report.assignmentId) ?? []), clone(report)])
        this.assignments.set(assignment.assignmentId, clone(nextAssignment))
        if (reviewJob) this.reviewJobs.set(reviewJob.reviewJobId, clone(reviewJob))
        if (stopEffect) {
            this.effects.set(stopEffect.effectId, clone(stopEffect))
            this.runs.set(run.runId, transitionSolverRun(run, "stopping"))
        }
        else this.runs.set(run.runId, clone(run))
        this.outbox.set(operationKey, outboxRecord)
        return { status: "applied", operationKey, result: clone(result) }
    }
}

export function createInMemoryLifecycleLedger(): InMemoryLifecycleLedger {
    return new InMemoryLifecycleLedger()
}
