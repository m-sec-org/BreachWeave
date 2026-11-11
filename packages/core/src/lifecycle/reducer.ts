import type {
    Assignment,
    AssignmentState,
    CompletionFacts,
    Finalization,
    FinalizationState,
    ReviewJob,
    ReviewJobState,
    SolverRun,
    SolverRunState,
} from "./domain"

export class LifecycleTransitionError extends Error {
    readonly code = "LIFECYCLE_INVALID_TRANSITION"
    readonly entity: string
    readonly from: string
    readonly to: string

    constructor(entity: string, from: string, to: string) {
        super(`${entity} 不允许从 ${from} 转换为 ${to}`)
        this.name = "LifecycleTransitionError"
        this.entity = entity
        this.from = from
        this.to = to
    }
}

const solverRunTransitions: Record<SolverRunState, readonly SolverRunState[]> = {
    starting: ["running", "stopping", "crashed"],
    running: ["finalizing", "stopping", "crashed"],
    finalizing: ["stopping", "crashed"],
    stopping: ["stopped", "force_stopped", "crashed"],
    stopped: [],
    force_stopped: [],
    crashed: [],
}

const assignmentTransitions: Record<AssignmentState, readonly AssignmentState[]> = {
    assigned: ["executing", "cancelled", "deadline_expired", "manual_review"],
    executing: ["report_submitted", "awaiting_evidence", "awaiting_audit", "deadline_expired", "cancelled", "manual_review"],
    report_submitted: ["authority_commit_pending", "report_ingest_gap", "awaiting_evidence", "awaiting_audit", "manual_review"],
    authority_commit_pending: ["awaiting_evidence", "awaiting_audit", "report_ingest_gap", "manual_review"],
    report_ingest_gap: ["manual_review", "awaiting_evidence"],
    awaiting_evidence: ["awaiting_audit", "manual_review"],
    awaiting_audit: ["audit_running", "manual_review", "cancelled"],
    audit_running: ["awaiting_planner", "audit_retryable", "manual_review"],
    audit_retryable: ["audit_running", "manual_review"],
    awaiting_planner: ["continuing", "verified_complete", "verified_blocked", "blocked_handoff", "deadline_expired", "cancelled", "manual_review"],
    continuing: ["executing", "manual_review"],
    verified_complete: [],
    verified_blocked: [],
    blocked_handoff: [],
    deadline_expired: [],
    cancelled: [],
    manual_review: [],
}

const reviewJobTransitions: Record<ReviewJobState, readonly ReviewJobState[]> = {
    queued: ["leased", "stale", "manual_review"],
    leased: ["running", "queued", "retryable", "audit_retryable", "failed", "manual_review", "stale"],
    running: ["ready", "retryable", "audit_retryable", "failed", "manual_review", "stale"],
    ready: ["stale"],
    retryable: ["queued", "leased", "manual_review", "stale"],
    audit_retryable: ["queued", "leased", "manual_review", "stale"],
    failed: ["retryable", "manual_review", "stale"],
    manual_review: ["stale"],
    stale: [],
}

const finalizationTransitions: Record<FinalizationState, readonly FinalizationState[]> = {
    open: ["sealing_requested", "reopened"],
    sealing_requested: ["execution_sealed", "blocked", "retryable", "manual_review", "stale"],
    execution_sealed: ["source_set_frozen", "reopened", "stale"],
    source_set_frozen: ["aggregating", "reopened", "stale"],
    aggregating: ["draft_ready", "retryable", "blocked", "manual_review", "stale"],
    draft_ready: ["qa_running", "stale", "retryable", "blocked", "manual_review"],
    qa_running: ["ready_to_publish", "retryable", "blocked", "manual_review", "stale"],
    ready_to_publish: ["published", "stale", "retryable", "blocked", "manual_review"],
    published: ["reopened"],
    retryable: ["sealing_requested", "source_set_frozen", "aggregating", "qa_running", "ready_to_publish", "blocked", "manual_review", "stale"],
    blocked: ["sealing_requested", "reopened", "stale"],
    manual_review: ["sealing_requested", "reopened", "stale"],
    stale: ["reopened"],
    reopened: ["sealing_requested"],
}

function canTransition<T extends string>(table: Record<T, readonly T[]>, from: T, to: T): boolean {
    return from === to || table[from].includes(to)
}

function transition<T extends object, S extends string>(entity: string, value: T, table: Record<S, readonly S[]>, stateKey: string, to: S): T {
    const from = (value as Record<string, unknown>)[stateKey] as S
    if (!canTransition(table, from, to)) throw new LifecycleTransitionError(entity, from, to)
    if (from === to) return value
    const revision = (value as { revision?: number }).revision
    return { ...value, [stateKey]: to, ...(revision === undefined ? {} : { revision: revision + 1 }) } as T
}

export function transitionSolverRun(run: SolverRun, to: SolverRunState, now = new Date().toISOString()): SolverRun {
    const next = transition("SolverRun", run, solverRunTransitions, "status", to)
    if (next === run) return run
    if (to === "stopped" || to === "force_stopped" || to === "crashed") return { ...next, stoppedAt: now }
    return next
}

export function transitionAssignment(assignment: Assignment, to: AssignmentState, now = new Date().toISOString()): Assignment {
    const next = transition("Assignment", assignment, assignmentTransitions, "phase", to)
    if (next === assignment) return assignment
    return { ...next, updatedAt: now }
}

export function transitionReviewJob(reviewJob: ReviewJob, to: ReviewJobState): ReviewJob {
    return transition("ReviewJob", reviewJob, reviewJobTransitions, "status", to) as ReviewJob
}

export function transitionFinalization(finalization: Finalization, to: FinalizationState, now = new Date().toISOString()): Finalization {
    const next = transition("Finalization", finalization, finalizationTransitions, "status", to)
    if (next === finalization) return finalization
    return {
        ...next,
        ...(to === "execution_sealed" && finalization.sealedAt === undefined ? { sealedAt: now } : {}),
        ...(to === "published" && finalization.publishedAt === undefined ? { publishedAt: now } : {}),
    }
}

/** 四个完成事实必须由各自领域记录提供，不能从单一状态推导。 */
export function assertCompletionFactsIndependent(facts: CompletionFacts): CompletionFacts {
    for (const value of Object.values(facts)) {
        if (typeof value !== "boolean") throw new TypeError("完成事实必须是布尔值")
    }
    return { ...facts }
}

export const lifecycleTransitionTables = {
    solverRun: solverRunTransitions,
    assignment: assignmentTransitions,
    reviewJob: reviewJobTransitions,
    finalization: finalizationTransitions,
} as const
