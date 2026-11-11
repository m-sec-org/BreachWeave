/** 审查、Planner 决策与证据准入的纯内存实现。 */
import type { Assignment, SolverRun } from "../domain"
import { transitionAssignment, transitionSolverRun } from "../reducer"

export type LifecycleReviewVerdict = "verified" | "blocked" | "missing" | "unsupported" | "contradictory"
/** 直接导入 reporting/review 时使用的审查结论别名。 */
export type ReviewVerdict = LifecycleReviewVerdict
export type ReviewJobState = "queued" | "leased" | "running" | "ready" | "retryable" | "audit_retryable" | "failed" | "manual_review" | "stale"
export type PlannerAction = "continue" | "stop" | "retry_review" | "manual_review"

export interface ReviewBinding {
    assignmentId: string
    reportId: string
    reportRevision: number
    assignmentRevision: number
    generation: number
    scopeRevision: number
    historyWatermark: number
    evidenceSnapshotHash: string
}

export interface FrozenReviewPack extends ReviewBinding {
    id: string
    format: "frozen-review-pack/1"
    createdAt: string
    contentHash: string
    manifestHash: string
    redactionPolicy: string
    reviewerPrincipal: string
    acl: readonly string[]
    report: Readonly<Record<string, unknown>>
    evidence: readonly ReviewEvidenceRef[]
    history: readonly ReviewHistoryExcerpt[]
    omissions: readonly string[]
    immutable: true
}

export interface ReviewEvidenceRef {
    id: string
    contentHash: string
    kind: string
    admittedRevision?: number
    redacted: boolean
}

export interface ReviewHistoryExcerpt {
    id: string
    contentHash: string
    text: string
    watermark: number
    redacted: boolean
}

export interface ReviewChecklistItem {
    id: string
    claimId?: string
    requiredEvidence: readonly string[]
    targetRef?: string
    scriptRef?: string
}

export interface ReviewItemResult {
    itemId: string
    verdict: LifecycleReviewVerdict
    evidenceRefs: readonly string[]
    concerns: readonly string[]
}

export interface ReviewResult extends ReviewBinding {
    jobId: string
    packHash: string
    reviewerPrincipal: string
    items: readonly ReviewItemResult[]
    verdict: LifecycleReviewVerdict
    completedAt: string
}

export interface ReviewJob {
    id: string
    binding: ReviewBinding
    pack: FrozenReviewPack
    state: ReviewJobState
    attempt: number
    maxAttempts: number
    leaseToken?: string
    leaseExpiresAt?: number
    current: boolean
    result?: ReviewResult
    lastError?: string
}

export interface PlannerDecision {
    id: string
    action: PlannerAction
    binding: ReviewBinding
    reviewJobId: string
    reviewVerdict: LifecycleReviewVerdict
    reason: string
    createdAt: string
}

export interface ContinuationLineage {
    assignment: Assignment
    previousRun: SolverRun
    nextRun: SolverRun
    decision: PlannerDecision
}

/** Planner continue 只创建新 generation；旧 run 永远保持 terminal。 */
export function continueAssignment(input: {
    decision: PlannerDecision
    assignment: Assignment
    previousRun: SolverRun
    leaseToken: string
    leaseExpiresAt: string
    runtimeId: string
    managerEpoch: number
}): ContinuationLineage {
    if (input.decision.action !== "continue") throw new ReviewContractError("invalid_decision", "只有 continue 决策可以创建新 run")
    if (input.decision.binding.assignmentId !== input.assignment.assignmentId || input.decision.binding.generation !== input.previousRun.generation || input.decision.binding.assignmentRevision !== input.assignment.revision || input.decision.binding.scopeRevision !== input.assignment.scopeRevision) throw new ReviewContractError("stale_decision", "Planner 决策与当前 assignment/run 不匹配")
    if (!["stopped", "force_stopped", "crashed"].includes(input.previousRun.status)) throw new ReviewContractError("run_not_terminal", "旧 run 必须先进入 terminal 状态")
    if (input.managerEpoch !== input.assignment.managerEpoch) throw new ReviewContractError("stale_decision", "Manager epoch 已过期")
    const now = new Date().toISOString()
    const nextRun: SolverRun = {
        ...input.previousRun,
        runId: `run:${crypto.randomUUID()}`,
        generation: input.previousRun.generation + 1,
        status: "starting",
        revision: 1,
        managerEpoch: input.managerEpoch,
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
        runtimeId: input.runtimeId,
        startedAt: now,
        stoppedAt: undefined,
        stopReason: undefined,
    }
    const continuing = transitionAssignment(input.assignment, "continuing", now)
    const assignment = transitionAssignment({ ...continuing, activeRunId: nextRun.runId }, "executing", now)
    return { assignment, previousRun: input.previousRun, nextRun: transitionSolverRun(nextRun, "running", now), decision: structuredClone(input.decision) }
}

export interface EvidenceAdmission {
    id: string
    assignmentId: string
    reviewJobId: string
    reviewRevision: number
    evidenceSnapshotHash: string
    findingId: string
    evidenceRefs: readonly string[]
    contentHash: string
    admittedAt: string
    status: "admitted" | "rejected"
}

export class ReviewContractError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
        super(message)
        this.name = "ReviewContractError"
        this.code = code
    }
}

function text(value: unknown, field: string, max = 2048): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ReviewContractError("validation_error", `${field} 无效`)
    return value.trim()
}

function positive(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ReviewContractError("validation_error", `${field} 必须是非负整数`)
    return Number(value)
}

function digest(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new ReviewContractError("validation_error", `${field} 必须是 SHA-256 摘要`)
    return value
}

function hash(value: unknown): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function redact(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === "string") {
        let output = value
        for (const secret of secrets.filter(Boolean)) output = output.replaceAll(secret, "[REDACTED]")
        return output.replace(/(?:bearer\s+)[^\s]+/gi, "Bearer [REDACTED]").replace(/((?:password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^,;\s]+/gi, "$1[REDACTED]")
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]))
    return value
}

function binding(input: ReviewBinding): ReviewBinding {
    return {
        assignmentId: text(input.assignmentId, "assignmentId"), reportId: text(input.reportId, "reportId"), reportRevision: positive(input.reportRevision, "reportRevision"),
        assignmentRevision: positive(input.assignmentRevision, "assignmentRevision"), generation: positive(input.generation, "generation"), scopeRevision: positive(input.scopeRevision, "scopeRevision"),
        historyWatermark: positive(input.historyWatermark, "historyWatermark"), evidenceSnapshotHash: digest(input.evidenceSnapshotHash, "evidenceSnapshotHash"),
    }
}

export function assembleFrozenReviewPack(input: {
    id: string
    binding: ReviewBinding
    report: Record<string, unknown>
    evidence: readonly ReviewEvidenceRef[]
    history?: readonly ReviewHistoryExcerpt[]
    reviewerPrincipal: string
    acl: readonly string[]
    redactionPolicy?: string
    secrets?: readonly string[]
    createdAt?: string
}): FrozenReviewPack {
    const fixedBinding = binding(input.binding)
    const id = text(input.id, "pack id")
    const reviewerPrincipal = text(input.reviewerPrincipal, "reviewerPrincipal")
    const acl = [...new Set(input.acl.map((item) => text(item, "acl principal")))]
    if (!acl.includes(reviewerPrincipal)) throw new ReviewContractError("authorization_error", "Reviewer 不在 FrozenReviewPack ACL 中")
    const evidence = input.evidence.map((item) => {
        const ref = { ...item, id: text(item.id, "evidence id"), contentHash: digest(item.contentHash, "evidence contentHash"), kind: text(item.kind, "evidence kind"), redacted: item.redacted === true }
        if (item.admittedRevision !== undefined) positive(item.admittedRevision, "admittedRevision")
        return Object.freeze(ref)
    })
    const history = (input.history ?? []).map((item) => Object.freeze({ id: text(item.id, "history id"), contentHash: digest(item.contentHash, "history contentHash"), text: text(item.text, "history text", 16_384), watermark: positive(item.watermark, "history watermark"), redacted: item.redacted === true }))
    const report = redact(input.report, input.secrets ?? []) as Record<string, unknown>
    const manifest = { format: "frozen-review-pack/1", binding: fixedBinding, evidence, history, redactionPolicy: input.redactionPolicy ?? "host-default" }
    const manifestHash = hash(manifest)
    const contentHash = hash({ manifestHash, report })
    return Object.freeze({ ...fixedBinding, id, format: "frozen-review-pack/1", createdAt: input.createdAt ?? new Date().toISOString(), contentHash, manifestHash, redactionPolicy: input.redactionPolicy ?? "host-default", reviewerPrincipal, acl, report: Object.freeze(report), evidence, history, omissions: [], immutable: true as const })
}

export function verifyFrozenReviewPack(pack: FrozenReviewPack): void {
    const manifest = { format: pack.format, binding: binding(pack), evidence: pack.evidence, history: pack.history, redactionPolicy: pack.redactionPolicy }
    if (hash(manifest) !== pack.manifestHash || hash({ manifestHash: pack.manifestHash, report: pack.report }) !== pack.contentHash) throw new ReviewContractError("pack_tampered", "FrozenReviewPack 内容摘要不匹配")
    if (!pack.acl.includes(pack.reviewerPrincipal)) throw new ReviewContractError("authorization_error", "FrozenReviewPack ACL 缺少 Reviewer")
}

export function runMechanicalReview(input: { pack: FrozenReviewPack; checklist: readonly ReviewChecklistItem[]; reviewerPrincipal: string }): readonly ReviewItemResult[] {
    verifyFrozenReviewPack(input.pack)
    if (!input.pack.acl.includes(input.reviewerPrincipal) || input.reviewerPrincipal !== input.pack.reviewerPrincipal) throw new ReviewContractError("authorization_error", "Reviewer principal 无权读取此审查包")
    const report = input.pack.report
    return input.checklist.map((item) => {
        const evidenceIds = new Set(input.pack.evidence.map((entry) => entry.id))
        const refs = item.requiredEvidence.filter((ref) => evidenceIds.has(ref))
        const concerns: string[] = []
        let verdict: LifecycleReviewVerdict = "verified"
        if (!item.id.trim()) { verdict = "missing"; concerns.push("checklist item 缺少标识") }
        else if (item.requiredEvidence.some((ref) => !evidenceIds.has(ref))) { verdict = "missing"; concerns.push("缺少要求的证据引用") }
        else if (item.claimId && !Array.isArray(report.findings) && !Array.isArray(report.claims)) { verdict = "unsupported"; concerns.push("报告未提供可检查的 claim/finding 列表") }
        else if (!item.targetRef) { verdict = "blocked"; concerns.push("缺少目标绑定") }
        else if (!item.scriptRef && item.claimId) { verdict = "unsupported"; concerns.push("缺少可复现脚本引用") }
        return Object.freeze({ itemId: text(item.id, "checklist item"), verdict, evidenceRefs: refs, concerns })
    })
}

export function summarizeReviewVerdict(items: readonly ReviewItemResult[]): LifecycleReviewVerdict {
    if (items.length === 0) return "missing"
    if (items.some((item) => item.verdict === "contradictory")) return "contradictory"
    if (items.some((item) => item.verdict === "missing")) return "missing"
    if (items.some((item) => item.verdict === "unsupported")) return "unsupported"
    if (items.some((item) => item.verdict === "blocked")) return "blocked"
    return "verified"
}

export class ReviewJobStore {
    private readonly jobs = new Map<string, ReviewJob>()
    private readonly currentByReport = new Map<string, string>()
    create(input: { id: string; pack: FrozenReviewPack; maxAttempts?: number }): ReviewJob {
        verifyFrozenReviewPack(input.pack)
        const key = `${input.pack.assignmentId}:${input.pack.reportId}`
        const previous = this.currentByReport.get(key)
        if (previous) {
            const existing = this.jobs.get(previous)!
            if (existing.pack.contentHash === input.pack.contentHash) return structuredClone(existing)
            existing.current = false; existing.state = "stale"
        }
        const job: ReviewJob = { id: text(input.id, "job id"), binding: binding(input.pack), pack: input.pack, state: "queued", attempt: 0, maxAttempts: input.maxAttempts ?? 3, current: true }
        if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1) throw new ReviewContractError("validation_error", "maxAttempts 无效")
        this.jobs.set(job.id, job); this.currentByReport.set(key, job.id)
        return structuredClone(job)
    }
    get(id: string): ReviewJob | undefined { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined }
    lease(id: string, principal: string, now = Date.now(), ttlMs = 30_000): ReviewJob {
        const job = this.requireCurrent(id); if (job.state !== "queued" && job.state !== "retryable" && job.state !== "audit_retryable") throw new ReviewContractError("invalid_state", "ReviewJob 当前不可租约")
        if (principal !== job.pack.reviewerPrincipal || !job.pack.acl.includes(principal)) throw new ReviewContractError("authorization_error", "Reviewer principal 不匹配")
        job.attempt += 1; if (job.attempt > job.maxAttempts) { job.state = "manual_review"; throw new ReviewContractError("manual_review", "ReviewJob 已超过重试预算") }
        job.state = "leased"; job.leaseToken = hash(`${id}:${principal}:${job.attempt}:${now}`); job.leaseExpiresAt = now + ttlMs
        return structuredClone(job)
    }
    start(id: string, leaseToken: string, now = Date.now()): ReviewJob { const job = this.requireLease(id, leaseToken, now); job.state = "running"; return structuredClone(job) }
    complete(id: string, leaseToken: string, items: readonly ReviewItemResult[], now = Date.now()): ReviewJob {
        const job = this.requireLease(id, leaseToken, now); const normalized = items.map((item) => { if (!["verified", "blocked", "missing", "unsupported", "contradictory"].includes(item.verdict)) throw new ReviewContractError("validation_error", "Review verdict 无效"); return { itemId: text(item.itemId, "itemId"), verdict: item.verdict, evidenceRefs: [...item.evidenceRefs], concerns: [...item.concerns] } })
        job.result = { ...binding(job.binding), jobId: job.id, packHash: job.pack.contentHash, reviewerPrincipal: job.pack.reviewerPrincipal, items: normalized, verdict: summarizeReviewVerdict(normalized), completedAt: new Date(now).toISOString() }
        job.state = "ready"; return structuredClone(job)
    }
    expire(now = Date.now()): ReviewJob[] { const expired: ReviewJob[] = []; for (const job of this.jobs.values()) if (job.current && (job.state === "leased" || job.state === "running") && (job.leaseExpiresAt ?? Infinity) <= now) { job.state = job.attempt >= job.maxAttempts ? "manual_review" : "retryable"; job.lastError = "lease_expired"; expired.push(structuredClone(job)) } return expired }
    invalidate(bindingInput: Partial<ReviewBinding>): void { for (const job of this.jobs.values()) if (job.current && Object.entries(bindingInput).some(([key, value]) => value !== undefined && (job.binding as unknown as Record<string, unknown>)[key] !== value)) { job.current = false; job.state = "stale" } }
    private requireCurrent(id: string): ReviewJob { const job = this.jobs.get(id); if (!job || !job.current) throw new ReviewContractError("stale_review", "ReviewJob 不存在或已失效"); return job }
    private requireLease(id: string, token: string, now: number): ReviewJob { const job = this.requireCurrent(id); if ((job.state !== "leased" && job.state !== "running") || job.leaseToken !== token || (job.leaseExpiresAt ?? 0) <= now) throw new ReviewContractError("lease_fenced", "ReviewJob 租约失效"); return job }
}

/** Manager 可接入的审查服务门面，内部仍保持 Reviewer 只读。 */
export class ReviewService {
    readonly jobs: ReviewJobStore
    constructor(jobs = new ReviewJobStore()) { this.jobs = jobs }
    assemble(input: Parameters<typeof assembleFrozenReviewPack>[0]): FrozenReviewPack { return assembleFrozenReviewPack(input) }
    createJob(input: { id: string; pack: FrozenReviewPack; maxAttempts?: number }): ReviewJob { return this.jobs.create(input) }
    mechanical(input: { pack: FrozenReviewPack; checklist: readonly ReviewChecklistItem[]; reviewerPrincipal: string }): readonly ReviewItemResult[] { return runMechanicalReview(input) }
    lease(id: string, principal: string, now?: number, ttlMs?: number): ReviewJob { return this.jobs.lease(id, principal, now, ttlMs) }
    get(id: string): ReviewJob | undefined { return this.jobs.get(id) }
    start(id: string, token: string, now?: number): ReviewJob { return this.jobs.start(id, token, now) }
    complete(id: string, token: string, items: readonly ReviewItemResult[], now?: number): ReviewJob { return this.jobs.complete(id, token, items, now) }
    expire(now?: number): ReviewJob[] { return this.jobs.expire(now) }
    invalidate(bindingInput: Partial<ReviewBinding>): void { this.jobs.invalidate(bindingInput) }
}

export function validatePlannerDecision(input: Omit<PlannerDecision, "createdAt"> & { createdAt?: string }, current: { binding: ReviewBinding; reviewJobId: string; verdict: LifecycleReviewVerdict; state: ReviewJobState }): PlannerDecision {
    const expected = binding(current.binding)
    if (input.reviewJobId !== current.reviewJobId || current.state !== "ready") throw new ReviewContractError("decision_needed", "Planner 只能消费当前 ready ReviewJob")
    if (JSON.stringify(binding(input.binding)) !== JSON.stringify(expected) || input.reviewVerdict !== current.verdict) throw new ReviewContractError("stale_decision", "Planner 决策绑定已过期")
    if (input.action === "stop" && !["verified", "blocked"].includes(input.reviewVerdict)) throw new ReviewContractError("evidence_required", "stop 必须有当前证据支持的审查结果")
    if (input.action === "continue" && input.reviewVerdict === "verified") throw new ReviewContractError("invalid_decision", "verified 审查不能继续执行")
    return { ...input, reason: text(input.reason, "reason"), createdAt: input.createdAt ?? new Date().toISOString() }
}

export function validateEvidenceBoundFinding(input: { findingId: string; evidenceRefs: readonly string[]; admissions: readonly EvidenceAdmission[]; review?: ReviewResult }): void {
    const admissions = input.admissions.filter((admission) => admission.findingId === input.findingId && admission.status === "admitted")
    if (admissions.length === 0 || input.evidenceRefs.some((ref) => !admissions.some((admission) => admission.evidenceRefs.includes(ref)))) throw new ReviewContractError("evidence_required", "Finding 必须绑定独立 EvidenceAdmission")
    const review = input.review
    if (review && admissions.some((admission) => admission.reviewJobId !== review.jobId || admission.reviewRevision !== review.reportRevision)) throw new ReviewContractError("stale_review", "EvidenceAdmission 与当前审查版本不匹配")
}

export function admitEvidence(input: { id: string; assignmentId: string; review: ReviewResult; findingId: string; evidenceRefs: readonly string[]; contentHash: string }): EvidenceAdmission {
    if (input.review.assignmentId !== input.assignmentId || input.review.verdict !== "verified") throw new ReviewContractError("evidence_required", "只有当前 verified 审查才能准入证据")
    if (input.evidenceRefs.length === 0 || input.review.items.every((item) => item.evidenceRefs.every((ref) => !input.evidenceRefs.includes(ref)))) throw new ReviewContractError("evidence_required", "证据必须被 ReviewResult 明确引用")
    const contentHash = digest(input.contentHash, "contentHash")
    return { id: text(input.id, "admission id"), assignmentId: text(input.assignmentId, "assignmentId"), reviewJobId: input.review.jobId, reviewRevision: input.review.reportRevision, evidenceSnapshotHash: input.review.evidenceSnapshotHash, findingId: text(input.findingId, "findingId"), evidenceRefs: [...new Set(input.evidenceRefs.map((ref) => text(ref, "evidenceRef")))], contentHash, admittedAt: new Date().toISOString(), status: "admitted" }
}
