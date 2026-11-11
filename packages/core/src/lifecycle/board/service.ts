/** 有界策略板、发现候选、历史索引和上下文快照。 */

export type BoardItemClass = "candidate" | "fact" | "failure_boundary" | "constraint" | "blocker"
export type BoardVisibility = "assignment_private" | "challenge_shared"
export type BoardJobState = "queued" | "leased" | "running" | "completed" | "retryable" | "stale" | "failed"

export interface BoardItem {
    id: string
    class: BoardItemClass
    text: string
    sourceRefs: readonly string[]
    conditions: readonly string[]
    visibility: BoardVisibility
    confidence: number
    lineage?: string
    supersedes?: string
}

export interface StrategyBoardRevision {
    id: string
    scopeId: string
    assignmentId?: string
    revision: number
    generation: number
    leaseToken?: string
    assignmentRevision: number
    processedWatermark: number
    eventRange: { from: number; to: number }
    items: readonly BoardItem[]
    contentHash: string
    committedAt: string
}

export interface BoardPatch {
    scopeId: string
    assignmentId?: string
    baseRevision: number
    generation: number
    assignmentRevision: number
    leaseToken: string
    eventRange: { from: number; to: number }
    processedWatermark: number
    operationKey: string
    mode: "PATCH" | "NO_CHANGE"
    items?: readonly BoardItem[]
    sourceRefs?: readonly string[]
    tokenBudget?: number
    entryBudget?: number
    maxItemLength?: number
    principal?: string
    acl?: readonly string[]
    lifecycleMutation?: string
}

export interface BoardJob {
    id: string
    scopeId: string
    assignmentId?: string
    state: BoardJobState
    attempt: number
    maxAttempts: number
    leaseToken?: string
    leaseExpiresAt?: number
    eventRange: { from: number; to: number }
    baseRevision: number
    staleReason?: string
}

export interface DiscoveryCandidate {
    id: string
    scopeId: string
    sourceRefs: readonly string[]
    status: "pending" | "assigned" | "covered" | "excluded" | "deferred"
    dispositionReason?: string
    createdAt: string
    watermark: number
}

export interface ArtifactManifest {
    id: string
    kind: "event" | "branch" | "attachment" | "tool_output"
    contentHash: string
    parentIds: readonly string[]
    sourceAddress: string
    redacted: boolean
    omittedReason?: string
    available: boolean
    createdAt: string
}

export interface HistorySnapshot {
    historyWatermark: number
    indexWatermark: number
    artifacts: readonly ArtifactManifest[]
    incomplete: boolean
    gaps: readonly string[]
}

export interface ContextRevision {
    id: string
    scopeId: string
    parentIds: readonly string[]
    sourceWatermark: number
    archiveWatermark: number
    contentHash: string
    mandatoryRefs: readonly string[]
    itemRefs: readonly string[]
    status: "prepared" | "committed" | "stale" | "blocked"
    reason?: string
    createdAt: string
}

export class BoardContractError extends Error {
    readonly code: string
    constructor(code: string, message: string) { super(message); this.name = "BoardContractError"; this.code = code }
}

function text(value: unknown, field: string, max = 2048): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new BoardContractError("validation_error", `${field} 无效`)
    return value.trim()
}
function nonNegative(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BoardContractError("validation_error", `${field} 必须是非负整数`); return Number(value) }
function hash(value: unknown): string { return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}` }

function validateItem(item: BoardItem, scope: string): BoardItem {
    if (!item || !["candidate", "fact", "failure_boundary", "constraint", "blocker"].includes(item.class)) throw new BoardContractError("validation_error", "Board item class 无效")
    const id = text(item.id, "item id"); const itemScope = item.sourceRefs.length > 0
    if (!itemScope) throw new BoardContractError("validation_error", "Board item 必须带 sourceRefs")
    const confidence = Number(item.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new BoardContractError("validation_error", "Board confidence 必须在 0 到 1 之间")
    if (item.visibility === "assignment_private" && !scope) throw new BoardContractError("authorization_error", "私有 Board item 缺少 assignment scope")
    return Object.freeze({ id, class: item.class, text: text(item.text, "item text", 4096), sourceRefs: [...new Set(item.sourceRefs.map((ref) => text(ref, "source ref")))], conditions: item.conditions.map((condition) => text(condition, "condition")), visibility: item.visibility, confidence, ...(item.lineage ? { lineage: text(item.lineage, "lineage") } : {}), ...(item.supersedes ? { supersedes: text(item.supersedes, "supersedes") } : {}) })
}

export class BoardService {
    private readonly boards = new Map<string, StrategyBoardRevision>()
    private readonly operations = new Map<string, { hash: string; result: StrategyBoardRevision }>()
    private readonly jobs = new Map<string, BoardJob>()
    constructor(private readonly limits: { maxEntries?: number; maxTokens?: number; maxItemLength?: number } = {}) {}
    snapshot(scopeId: string, assignmentId?: string): StrategyBoardRevision {
        const key = this.key(scopeId, assignmentId); return structuredClone(this.boards.get(key) ?? { id: `board:${key}`, scopeId, ...(assignmentId ? { assignmentId } : {}), revision: 0, generation: 0, assignmentRevision: 0, processedWatermark: 0, eventRange: { from: 0, to: 0 }, items: [], contentHash: hash([]), committedAt: new Date(0).toISOString() })
    }
    patch(input: BoardPatch): StrategyBoardRevision {
        const scopeId = text(input.scopeId, "scopeId"); const key = this.key(scopeId, input.assignmentId); const current = this.snapshot(scopeId, input.assignmentId)
        if (!text(input.leaseToken, "leaseToken") || !text(input.operationKey, "operationKey")) throw new BoardContractError("validation_error", "Board patch 缺少租约或操作键")
        const payloadHash = hash({ ...input, items: input.items ?? [] }); const previous = this.operations.get(input.operationKey)
        if (previous) { if (previous.hash !== payloadHash) throw new BoardContractError("idempotency_conflict", "Board operationKey 复用但 payload 不同"); return structuredClone(previous.result) }
        if (input.baseRevision !== current.revision) throw new BoardContractError("cas_conflict", "Board base revision 已过期")
        if (current.revision > 0 && input.leaseToken !== current.leaseToken) throw new BoardContractError("lease_fenced", "Board lease token 已过期")
        if (input.principal && input.acl && !input.acl.includes(input.principal)) throw new BoardContractError("authorization_error", "Board principal 不在 ACL 中")
        if (input.lifecycleMutation || (input as unknown as Record<string, unknown>).assignmentManifest || (input as unknown as Record<string, unknown>).coverage || (input as unknown as Record<string, unknown>).evidenceAdmission) throw new BoardContractError("authorization_error", "Board patch 不能修改生命周期事实")
        if (input.generation < current.generation || input.assignmentRevision < current.assignmentRevision) throw new BoardContractError("stale_generation", "Board generation 或 assignment revision 已过期")
        const from = nonNegative(input.eventRange.from, "eventRange.from"); const to = nonNegative(input.eventRange.to, "eventRange.to"); const watermark = nonNegative(input.processedWatermark, "processedWatermark")
        if (to < from || watermark < to) throw new BoardContractError("validation_error", "Board event range/watermark 无效")
        if (!input.assignmentId && (input.items ?? []).some((item) => item.visibility === "assignment_private")) throw new BoardContractError("authorization_error", "共享 Board 不得写入 assignment_private item")
        const items = input.mode === "NO_CHANGE" ? [...current.items] : (input.items ?? []).map((item) => validateItem(item, input.assignmentId ?? ""))
        const entryBudget = input.entryBudget ?? this.limits.maxEntries ?? 256; const maxLength = input.maxItemLength ?? this.limits.maxItemLength ?? 4096
        const tokenBudget = input.tokenBudget ?? this.limits.maxTokens ?? 20_000
        if (items.length > entryBudget || items.some((item) => item.text.length > maxLength) || JSON.stringify(items).length > tokenBudget * 4) throw new BoardContractError("budget_exceeded", "Board patch 超出预算")
        const result: StrategyBoardRevision = Object.freeze({ id: `board:${scopeId}:${input.assignmentId ?? "shared"}:${current.revision + 1}`, scopeId, ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}), revision: current.revision + 1, generation: input.generation, leaseToken: input.leaseToken, assignmentRevision: input.assignmentRevision, processedWatermark: watermark, eventRange: { from, to }, items, contentHash: hash(items), committedAt: new Date().toISOString() })
        this.boards.set(key, result); this.operations.set(input.operationKey, { hash: payloadHash, result }); return structuredClone(result)
    }
    enqueueJob(input: Omit<BoardJob, "state" | "attempt"> & { maxAttempts?: number }): BoardJob {
        if (this.jobs.has(input.id)) return structuredClone(this.jobs.get(input.id)!)
        const job: BoardJob = { ...input, state: "queued", attempt: 0, maxAttempts: input.maxAttempts ?? 3 }; this.jobs.set(job.id, job); return structuredClone(job)
    }
    leaseJob(id: string, now = Date.now(), ttlMs = 30_000): BoardJob { const job = this.requireJob(id); if (!["queued", "retryable"].includes(job.state)) throw new BoardContractError("invalid_state", "BoardJob 当前不可租约"); job.attempt += 1; if (job.attempt > job.maxAttempts) { job.state = "failed"; throw new BoardContractError("retry_exhausted", "BoardJob 重试耗尽") }; job.state = "leased"; job.leaseToken = hash(`${id}:${job.attempt}:${now}`); job.leaseExpiresAt = now + ttlMs; return structuredClone(job) }
    startJob(id: string, token: string, now = Date.now()): BoardJob { const job = this.requireLease(id, token, now); job.state = "running"; return structuredClone(job) }
    finishJob(id: string, token: string, now = Date.now()): BoardJob { const job = this.requireLease(id, token, now); job.state = "completed"; return structuredClone(job) }
    expireJobs(now = Date.now()): BoardJob[] { const output: BoardJob[] = []; for (const job of this.jobs.values()) if (["leased", "running"].includes(job.state) && (job.leaseExpiresAt ?? Infinity) <= now) { job.state = job.attempt >= job.maxAttempts ? "failed" : "retryable"; job.staleReason = "lease_expired"; output.push(structuredClone(job)) } return output }
    suppressAfterSeal(): void { for (const job of this.jobs.values()) if (["queued", "leased", "running"].includes(job.state)) { job.state = "stale"; job.staleReason = "execution_sealed" } }
    deliver(scopeId: string, assignmentId: string | undefined, input: { generation: number; leaseToken: string; terminal: boolean; principal: string; acl: readonly string[] }): StrategyBoardRevision | undefined {
        if (input.terminal || !input.acl.includes(input.principal)) return undefined
        const current = this.snapshot(scopeId, assignmentId)
        if (current.revision === 0 || current.generation !== input.generation || current.leaseToken !== input.leaseToken) return undefined
        return current
    }
    private key(scopeId: string, assignmentId?: string): string { return `${scopeId}:${assignmentId ?? "shared"}` }
    private requireJob(id: string): BoardJob { const job = this.jobs.get(text(id, "job id")); if (!job) throw new BoardContractError("not_found", "BoardJob 不存在"); return job }
    private requireLease(id: string, token: string, now: number): BoardJob { const job = this.requireJob(id); if (!["leased", "running"].includes(job.state) || job.leaseToken !== token || (job.leaseExpiresAt ?? 0) <= now) throw new BoardContractError("lease_fenced", "BoardJob 租约失效"); return job }
}

export class DiscoveryStore {
    private readonly values = new Map<string, DiscoveryCandidate>()
    register(input: Omit<DiscoveryCandidate, "status" | "createdAt">): DiscoveryCandidate { if (this.values.has(input.id)) return structuredClone(this.values.get(input.id)!); const candidate: DiscoveryCandidate = { ...input, status: "pending", createdAt: new Date().toISOString() }; this.values.set(candidate.id, candidate); return structuredClone(candidate) }
    dispose(id: string, status: Exclude<DiscoveryCandidate["status"], "pending">, reason: string): DiscoveryCandidate { const candidate = this.values.get(id); if (!candidate) throw new BoardContractError("not_found", "Discovery candidate 不存在"); if (!text(reason, "disposition reason")) throw new BoardContractError("validation_error", "Discovery disposition 必须带原因"); candidate.status = status; candidate.dispositionReason = reason; return structuredClone(candidate) }
    pending(scopeId?: string): DiscoveryCandidate[] { return [...this.values.values()].filter((candidate) => candidate.status === "pending" && (!scopeId || candidate.scopeId === scopeId)).map((candidate) => structuredClone(candidate)) }
    assertSealable(scopeId: string): void { const pending = this.pending(scopeId); if (pending.length > 0) throw new BoardContractError("candidate_intake_pending", `存在 ${pending.length} 个未处置 discovery candidate`) }
}

export class HistoryIngestor {
    private readonly artifacts = new Map<string, ArtifactManifest>()
    private historyWatermark = 0
    private indexWatermark = 0
    ingest(input: Omit<ArtifactManifest, "createdAt" | "available"> & { available?: boolean }): ArtifactManifest { if (this.artifacts.has(input.id)) return structuredClone(this.artifacts.get(input.id)!); const artifact: ArtifactManifest = { ...input, createdAt: new Date().toISOString(), available: input.available ?? true }; this.artifacts.set(artifact.id, artifact); this.historyWatermark = Math.max(this.historyWatermark, Number(input.sourceAddress.match(/(?:seq|watermark)[:=](\d+)/)?.[1] ?? 0)); return structuredClone(artifact) }
    markIndexed(watermark: number): void { this.indexWatermark = Math.max(this.indexWatermark, nonNegative(watermark, "indexWatermark")) }
    snapshot(): HistorySnapshot { const gaps = this.indexWatermark < this.historyWatermark ? [`index_watermark:${this.indexWatermark}<history_watermark:${this.historyWatermark}`] : []; return { historyWatermark: this.historyWatermark, indexWatermark: this.indexWatermark, artifacts: [...this.artifacts.values()].map((item) => structuredClone(item)), incomplete: gaps.length > 0 || [...this.artifacts.values()].some((item) => !item.available && !item.omittedReason), gaps } }
}

export class ContextRevisionStore {
    private readonly values = new Map<string, ContextRevision>()
    prepare(input: { id: string; scopeId: string; parentIds: readonly string[]; sourceWatermark: number; archiveWatermark: number; mandatoryRefs: readonly string[]; itemRefs: readonly string[]; budget: number; history: HistorySnapshot }): ContextRevision {
        const mandatoryRefs = [...new Set(input.mandatoryRefs.map((ref) => text(ref, "mandatory ref")))]; const itemRefs = [...new Set(input.itemRefs.map((ref) => text(ref, "context ref")))]
        if (JSON.stringify({ mandatoryRefs, itemRefs }).length > input.budget) { const revision: ContextRevision = { id: text(input.id, "context revision id"), scopeId: text(input.scopeId, "scopeId"), parentIds: [...input.parentIds], sourceWatermark: input.sourceWatermark, archiveWatermark: input.archiveWatermark, contentHash: hash({ mandatoryRefs, itemRefs }), mandatoryRefs, itemRefs, status: "blocked", reason: "context_budget_exceeded", createdAt: new Date().toISOString() }; this.values.set(revision.id, revision); return structuredClone(revision) }
        if (input.history.incomplete || input.history.historyWatermark < input.sourceWatermark) { const revision: ContextRevision = { id: text(input.id, "context revision id"), scopeId: text(input.scopeId, "scopeId"), parentIds: [...input.parentIds], sourceWatermark: input.sourceWatermark, archiveWatermark: input.archiveWatermark, contentHash: hash({ mandatoryRefs, itemRefs }), mandatoryRefs, itemRefs, status: "blocked", reason: "history_gap", createdAt: new Date().toISOString() }; this.values.set(revision.id, revision); return structuredClone(revision) }
        const revision: ContextRevision = { id: text(input.id, "context revision id"), scopeId: text(input.scopeId, "scopeId"), parentIds: [...input.parentIds], sourceWatermark: nonNegative(input.sourceWatermark, "sourceWatermark"), archiveWatermark: nonNegative(input.archiveWatermark, "archiveWatermark"), contentHash: hash({ mandatoryRefs, itemRefs, sourceWatermark: input.sourceWatermark }), mandatoryRefs, itemRefs, status: "prepared", createdAt: new Date().toISOString() }; this.values.set(revision.id, revision); return structuredClone(revision)
    }
    commit(id: string, expectedHash: string, history: HistorySnapshot): ContextRevision { const revision = this.require(id); if (revision.contentHash !== expectedHash) throw new BoardContractError("stale_context", "ContextRevision hash 已过期"); if (history.incomplete || history.historyWatermark < revision.sourceWatermark) throw new BoardContractError("history_gap", "ContextRevision 依赖的 history 尚未完整归档"); if (revision.status !== "prepared") throw new BoardContractError("invalid_state", "ContextRevision 当前不可提交"); revision.status = "committed"; return structuredClone(revision) }
    reconcile(id: string, committed: boolean): ContextRevision { const revision = this.require(id); if (committed) revision.status = "committed"; else if (revision.status === "prepared") revision.status = "stale"; return structuredClone(revision) }
    private require(id: string): ContextRevision { const revision = this.values.get(id); if (!revision) throw new BoardContractError("not_found", "ContextRevision 不存在"); return revision }
}
