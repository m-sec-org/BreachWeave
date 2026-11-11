/** Seal、来源冻结、报告 IR、QA 和发布效果。 */

import type { EvidenceAdmission, ReviewResult } from "./review"
import { ReviewContractError } from "./review"

export type FinalizationState = "open" | "sealing_requested" | "execution_sealed" | "source_set_frozen" | "aggregating" | "draft_ready" | "qa_running" | "ready_to_publish" | "published" | "retryable" | "blocked" | "manual_review" | "stale" | "reopened"
export type ClaimRelation = "duplicate" | "root_cause" | "distinct" | "uncertain" | "disputed"

export interface SealBlocker { code: string; detail: string; count?: number }
export interface SealIntent { id: string; scopeId: string; taskManifestRevision: number; generation: number; operationKey: string; requestedAt?: string }

export interface Finalization {
    id: string
    scopeId: string
    taskManifestRevision: number
    generation: number
    state: FinalizationState
    revision: number
    sealIntentId?: string
    sourceManifestId?: string
    sourceManifestHash?: string
    qaId?: string
    publishEffectId?: string
    closeEffectId?: string
    blockers: readonly SealBlocker[]
    phase: "seal" | "source" | "aggregate" | "ir" | "render" | "qa" | "publish" | "close"
}

export interface SourceInput {
    id: string
    assignmentId: string
    reportRevision: number
    valid: boolean
    stale?: boolean
    excludedReason?: string
    evidenceAdmissionIds: readonly string[]
    evidenceSnapshotHash: string
    historyWatermark: number
    coverage: "tested" | "not_tested" | "blocked" | "unsupported"
}

export interface SourceManifest {
    id: string
    scopeId: string
    generation: number
    taskManifestRevision: number
    createdAt: string
    contentHash: string
    historyWatermark: number
    evidenceRevision: number
    inputs: readonly SourceInput[]
    included: readonly string[]
    excluded: readonly { id: string; reason: string }[]
    unresolved: readonly { id: string; reason: string }[]
    counts: { total: number; included: number; excluded: number; unresolved: number; incomplete: number }
}

export interface AtomicClaim {
    id: string
    asset: string
    endpoint?: string
    vulnerabilityClass: string
    parameter?: string
    authenticationContext?: string
    securityLevel?: string
    preconditions: readonly string[]
    severity: string
    confidence: number
    evidenceRefs: readonly string[]
    sourceIds: readonly string[]
    text: string
    disputed?: boolean
}

export interface ClaimRelationRecord { id: string; leftClaimId: string; rightClaimId: string; relation: ClaimRelation; rule: string; createdAt: string }
export type ClaimRelationInput = Omit<ClaimRelationRecord, "createdAt"> & { createdAt?: string }

export interface ReportIR {
    id: string
    sourceManifestId: string
    sourceManifestHash: string
    version: number
    scope: Readonly<Record<string, unknown>>
    coverage: { tested: readonly string[]; notTested: readonly string[]; blocked: readonly string[]; unsupported: readonly string[] }
    findings: readonly AtomicClaim[]
    relations: readonly ClaimRelationRecord[]
    rootCauses: readonly { id: string; claimIds: readonly string[]; text: string }[]
    disputes: readonly string[]
    limitations: readonly string[]
    remediation: readonly string[]
    provenance: Readonly<Record<string, readonly string[]>>
    contentHash: string
}

export interface RenderedReport { id: string; irId: string; artifactHash: string; text: string; sentenceSources: Readonly<Record<string, readonly string[]>> }
export interface QaIssue { code: string; detail: string; sourceIds?: readonly string[] }
export interface FinalQa { id: string; irId: string; artifactHash: string; passed: boolean; issues: readonly QaIssue[]; checkedAt: string }
export interface PublishEffect { id: string; finalizationId: string; artifactHash: string; status: "not_configured" | "pending" | "published" | "unknown" | "failed"; result?: unknown }

export class FinalizationContractError extends Error {
    readonly code: string
    readonly blockers?: readonly SealBlocker[]
    constructor(code: string, message: string, blockers?: readonly SealBlocker[]) { super(message); this.name = "FinalizationContractError"; this.code = code; this.blockers = blockers }
}
function text(value: unknown, field: string, max = 4096): string { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new FinalizationContractError("validation_error", `${field} 无效`); return value.trim() }
function integer(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new FinalizationContractError("validation_error", `${field} 必须是非负整数`); return Number(value) }
function digest(value: unknown, field: string): string { if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new FinalizationContractError("validation_error", `${field} 必须是 SHA-256 摘要`); return value }
function hash(value: unknown): string { return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}` }

export class FinalizationService {
    private readonly records = new Map<string, Finalization>()
    private readonly manifests = new Map<string, SourceManifest>()
    private readonly irs = new Map<string, ReportIR>()
    private readonly rendered = new Map<string, RenderedReport>()
    private readonly qa = new Map<string, FinalQa>()
    private readonly effects = new Map<string, PublishEffect>()
    private readonly operations = new Map<string, unknown>()
    create(input: { id: string; scopeId: string; taskManifestRevision: number; generation?: number }): Finalization { const record: Finalization = { id: text(input.id, "finalization id"), scopeId: text(input.scopeId, "scopeId"), taskManifestRevision: integer(input.taskManifestRevision, "taskManifestRevision"), generation: input.generation ?? 0, state: "open", revision: 0, blockers: [], phase: "seal" }; this.records.set(record.id, record); return structuredClone(record) }
    get(id: string): Finalization { const record = this.records.get(id); if (!record) throw new FinalizationContractError("not_found", "Finalization 不存在"); return structuredClone(record) }
    requestSeal(id: string, intent: SealIntent, inventory: { unresolvedAssignments?: number; activeEffects?: number; unknownEffects?: number; pendingCandidates?: number; incompleteExecution?: number; missingWatermarks?: number; launchEffects?: number }): Finalization {
        const record = this.require(id); if (record.state !== "open" && record.state !== "blocked" && record.state !== "retryable" && record.state !== "reopened") throw new FinalizationContractError("invalid_state", "Finalization 当前不可 seal")
        if (intent.scopeId !== record.scopeId || intent.taskManifestRevision !== record.taskManifestRevision || intent.generation !== record.generation) throw new FinalizationContractError("stale_intent", "seal intent 绑定已过期")
        const blockers: SealBlocker[] = []; for (const [code, count] of Object.entries({ unresolved_assignments: inventory.unresolvedAssignments ?? 0, active_effects: inventory.activeEffects ?? 0, unknown_effects: inventory.unknownEffects ?? 0, pending_candidates: inventory.pendingCandidates ?? 0, incomplete_execution: inventory.incompleteExecution ?? 0, missing_watermarks: inventory.missingWatermarks ?? 0, launch_effects: inventory.launchEffects ?? 0 })) if (count > 0) blockers.push({ code, count, detail: `${code} 尚未清理` })
        record.revision += 1; record.sealIntentId = text(intent.id, "seal intent id"); record.state = blockers.length > 0 ? "blocked" : "execution_sealed"; record.phase = "seal"; record.blockers = blockers
        if (blockers.length > 0) throw new FinalizationContractError("seal_blocked", "Finalization seal 被阻断", blockers)
        return structuredClone(record)
    }
    freezeSources(id: string, inputs: readonly SourceInput[], historyWatermark: number, evidenceRevision: number): SourceManifest {
        const record = this.require(id); if (record.state !== "execution_sealed" && record.state !== "source_set_frozen") throw new FinalizationContractError("invalid_state", "必须先 execution_sealed 才能冻结来源")
        const normalized = inputs.map((input) => ({ ...input, reportRevision: integer(input.reportRevision, "reportRevision"), historyWatermark: integer(input.historyWatermark, "historyWatermark"), evidenceAdmissionIds: [...input.evidenceAdmissionIds], evidenceSnapshotHash: digest(input.evidenceSnapshotHash, "evidenceSnapshotHash") }))
        const included = normalized.filter((input) => input.valid && !input.stale && input.coverage === "tested").map((input) => input.id); const excluded = normalized.filter((input) => !included.includes(input.id) && input.excludedReason).map((input) => ({ id: input.id, reason: input.excludedReason! })); const unresolved = normalized.filter((input) => !included.includes(input.id) && !excluded.some((item) => item.id === input.id)).map((input) => ({ id: input.id, reason: input.stale ? "stale_source" : input.coverage !== "tested" ? input.coverage : "invalid_source" }))
        const manifestBase = { id: `source:${id}:${record.revision + 1}`, scopeId: record.scopeId, generation: record.generation, taskManifestRevision: record.taskManifestRevision, historyWatermark: integer(historyWatermark, "historyWatermark"), evidenceRevision: integer(evidenceRevision, "evidenceRevision"), inputs: normalized, included, excluded, unresolved }
        const manifest: SourceManifest = { ...manifestBase, createdAt: new Date().toISOString(), contentHash: hash(manifestBase), counts: { total: normalized.length, included: included.length, excluded: excluded.length, unresolved: unresolved.length, incomplete: normalized.filter((input) => input.coverage === "blocked" || input.coverage === "unsupported").length } }
        this.manifests.set(manifest.id, manifest); record.sourceManifestId = manifest.id; record.sourceManifestHash = manifest.contentHash; record.state = "source_set_frozen"; record.phase = "source"; record.revision += 1; return structuredClone(manifest)
    }
    aggregate(id: string, claims: readonly AtomicClaim[], relations: readonly ClaimRelationInput[] = []): ReportIR {
        const record = this.require(id); const manifest = record.sourceManifestId ? this.manifests.get(record.sourceManifestId) : undefined; if (!manifest || manifest.contentHash !== record.sourceManifestHash) throw new FinalizationContractError("stale_source", "SourceManifest 不存在或已漂移")
        if (record.state !== "source_set_frozen" && record.state !== "aggregating" && record.state !== "draft_ready") throw new FinalizationContractError("invalid_state", "Finalization 当前不可聚合")
        record.state = "aggregating"; record.phase = "aggregate"; const findings = claims.map((claim) => { const normalized = { ...claim, id: text(claim.id, "claim id"), asset: text(claim.asset, "asset"), vulnerabilityClass: text(claim.vulnerabilityClass, "vulnerabilityClass"), severity: text(claim.severity, "severity"), confidence: Number(claim.confidence), evidenceRefs: [...new Set(claim.evidenceRefs)], sourceIds: [...new Set(claim.sourceIds)], preconditions: [...claim.preconditions], text: text(claim.text, "claim text") }; if (!Number.isFinite(normalized.confidence) || normalized.confidence < 0 || normalized.confidence > 1) throw new FinalizationContractError("validation_error", "claim confidence 无效"); if (normalized.sourceIds.some((source) => !manifest.inputs.some((input) => input.id === source))) throw new FinalizationContractError("provenance_error", "claim 引用了未知来源"); return normalized })
        const claimIds = new Set(findings.map((claim) => claim.id)); const normalizedRelations = relations.map((relation) => { if (!claimIds.has(relation.leftClaimId) || !claimIds.has(relation.rightClaimId)) throw new FinalizationContractError("provenance_error", "claim relationship 引用了未知 claim"); return { ...relation, createdAt: relation.createdAt || new Date().toISOString() } }); const disputes = normalizedRelations.filter((relation) => relation.relation === "disputed" || relation.relation === "uncertain").map((relation) => relation.id); const rootCauses = normalizedRelations.filter((relation) => relation.relation === "root_cause").map((relation) => ({ id: relation.id, claimIds: [relation.leftClaimId, relation.rightClaimId], text: relation.rule })); const coverage = { tested: manifest.inputs.filter((input) => input.coverage === "tested").map((input) => input.id), notTested: manifest.inputs.filter((input) => input.coverage === "not_tested").map((input) => input.id), blocked: manifest.inputs.filter((input) => input.coverage === "blocked").map((input) => input.id), unsupported: manifest.inputs.filter((input) => input.coverage === "unsupported").map((input) => input.id) }; const provenance = Object.fromEntries(findings.map((finding) => [finding.id, finding.sourceIds])); const irBase = { sourceManifestId: manifest.id, sourceManifestHash: manifest.contentHash, scope: { scopeId: record.scopeId, generation: record.generation }, coverage, findings, relations: normalizedRelations, rootCauses, disputes, limitations: [...manifest.unresolved.map((item) => `${item.id}: ${item.reason}`)], remediation: [], provenance }
        const ir: ReportIR = { id: `ir:${id}:${record.revision + 1}`, ...irBase, version: 1, contentHash: hash(irBase) }; this.irs.set(ir.id, ir); record.state = "draft_ready"; record.phase = "ir"; record.revision += 1; return structuredClone(ir)
    }
    render(id: string, irId: string): RenderedReport { const record = this.require(id); const ir = this.irs.get(irId); if (!ir || record.sourceManifestHash !== ir.sourceManifestHash) throw new FinalizationContractError("stale_source", "Report IR 来源已过期"); const sentenceSources: Record<string, readonly string[]> = {}; const lines = [`报告范围: ${String(ir.scope.scopeId)}`, `已测试覆盖: ${ir.coverage.tested.length} 项`, `未测试: ${ir.coverage.notTested.length} 项`, `阻塞: ${ir.coverage.blocked.length} 项`, `不支持: ${ir.coverage.unsupported.length} 项`]; for (const finding of ir.findings) { const sentenceId = `finding:${finding.id}`; lines.push(`${finding.severity}: ${finding.text}`); sentenceSources[sentenceId] = finding.sourceIds } if (ir.findings.length === 0) lines.push("在已测试范围与条件内未确认发现。"); if (ir.limitations.length > 0) lines.push(`限制: ${ir.limitations.join("; ")}`); const output: RenderedReport = { id: `render:${ir.id}`, irId, artifactHash: hash(lines), text: lines.join("\n"), sentenceSources }; this.rendered.set(output.id, output); record.state = "qa_running"; record.phase = "render"; return structuredClone(output) }
    qaCheck(id: string, irId: string, renderId: string): FinalQa { const record = this.require(id); const ir = this.irs.get(irId); const rendered = this.rendered.get(renderId); const issues: QaIssue[] = []; if (!ir || !rendered || rendered.irId !== irId) issues.push({ code: "missing_artifact", detail: "IR 或渲染产物不存在" }); else { if (rendered.artifactHash !== hash(rendered.text.split("\n"))) issues.push({ code: "artifact_hash_mismatch", detail: "渲染产物摘要不匹配" }); if (ir.findings.some((finding) => finding.sourceIds.length === 0)) issues.push({ code: "provenance_missing", detail: "发现缺少来源" }); if (ir.findings.some((finding) => finding.evidenceRefs.length === 0)) issues.push({ code: "evidence_missing", detail: "发现缺少证据" }); if (ir.disputes.length > 0 && !rendered.text.includes("限制")) issues.push({ code: "dispute_visibility", detail: "争议未在报告中披露" }) } const result: FinalQa = { id: `qa:${irId}`, irId, artifactHash: rendered?.artifactHash ?? "", passed: issues.length === 0, issues, checkedAt: new Date().toISOString() }; this.qa.set(result.id, result); record.qaId = result.id; record.state = result.passed ? "ready_to_publish" : "retryable"; record.phase = "qa"; return structuredClone(result) }
    publish(id: string, artifactHash: string, adapter?: (effect: PublishEffect) => Promise<unknown>): PublishEffect { const record = this.require(id); const qa = record.qaId ? this.qa.get(record.qaId) : undefined; if (record.state !== "ready_to_publish" || !qa?.passed || qa.artifactHash !== artifactHash) throw new FinalizationContractError("qa_required", "只有 QA 通过的当前产物才能发布"); const effectId = `publish:${id}:${artifactHash}`; const existing = this.effects.get(effectId); if (existing) return structuredClone(existing); const effect: PublishEffect = { id: effectId, finalizationId: id, artifactHash, status: adapter ? "pending" : "not_configured" }; this.effects.set(effectId, effect); record.publishEffectId = effectId; record.phase = "publish"; if (!adapter) { record.state = "ready_to_publish"; return structuredClone(effect) } void adapter(effect).then((result) => { effect.status = "published"; effect.result = result; record.state = "published" }).catch(() => { effect.status = "unknown"; record.state = "retryable" }); return structuredClone(effect) }
    close(id: string, adapter?: (effect: PublishEffect) => Promise<unknown>): PublishEffect { const record = this.require(id); if (record.state !== "published" && record.state !== "ready_to_publish") throw new FinalizationContractError("invalid_state", "Finalization 当前不可关闭"); const effectId = `close:${id}:${record.generation}`; const existing = this.effects.get(effectId); if (existing) return structuredClone(existing); const effect: PublishEffect = { id: effectId, finalizationId: id, artifactHash: record.sourceManifestHash ?? "", status: adapter ? "pending" : "not_configured" }; this.effects.set(effectId, effect); record.closeEffectId = effectId; record.phase = "close"; if (adapter) void adapter(effect).then((result) => { effect.status = "published"; effect.result = result }).catch(() => { effect.status = "unknown" }); return structuredClone(effect) }
    reopen(id: string, scopeRevision: number): Finalization { const record = this.require(id); if (!["execution_sealed", "source_set_frozen", "draft_ready", "qa_running", "ready_to_publish", "published", "blocked", "retryable"].includes(record.state)) throw new FinalizationContractError("invalid_state", "Finalization 当前不可 reopen"); record.generation += 1; record.taskManifestRevision = integer(scopeRevision, "scopeRevision"); record.state = "reopened"; record.revision += 1; record.sourceManifestId = undefined; record.sourceManifestHash = undefined; record.qaId = undefined; record.publishEffectId = undefined; record.closeEffectId = undefined; record.phase = "seal"; return structuredClone(record) }
    resume(id: string): Finalization { const record = this.require(id); if (record.state === "stale") throw new FinalizationContractError("stale_source", "Finalization 依赖的来源已失效"); return structuredClone(record) }
    private require(id: string): Finalization { const record = this.records.get(text(id, "finalization id")); if (!record) throw new FinalizationContractError("not_found", "Finalization 不存在"); return record }
}

export function validateEvidenceBoundFinding(input: { claim: AtomicClaim; admissions: readonly EvidenceAdmission[]; review?: ReviewResult }): void { const admissions = input.admissions.filter((admission) => admission.findingId === input.claim.id && admission.status === "admitted"); if (admissions.length === 0) throw new ReviewContractError("evidence_required", "finding 必须绑定独立 EvidenceAdmission"); const review = input.review; if (review && admissions.some((admission) => admission.reviewJobId !== review.jobId || admission.reviewRevision !== review.reportRevision)) throw new ReviewContractError("stale_review", "EvidenceAdmission 与当前审查版本不匹配") }
