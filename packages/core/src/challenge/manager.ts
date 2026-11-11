import { ChallengeApiClient } from "./api-client"
import type { ChallengeApiChallenge, ChallengeApiHintData, ChallengeApiListData, ChallengeApiStartData } from "./api-client"
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent"
import type { ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { ConfigManager, HostSettings } from "../config/index"
import { appendFile, chmod, mkdir } from "fs/promises"
import { join } from "path"
import { CHALLENGE_ENV_CHALLENGE_ID, CHALLENGE_ENV_PROJECT_ID } from "./env"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    listChallengeAttemptLogs,
    listChallengeSubmissionLogs,
    type ChallengeAssetsRecord,
    type ChallengeInfoRecord,
    type ChallengeRecord,
    type ChallengeAttemptLogRecord,
    type ChallengeSubmissionLogRecord,
    type ChallengeTestResult,
    computeChallengeCompleted,
    ensureChallengeStoreBaseDir,
    listChallengeRecords,
    readChallengeRecord,
    resolveChallengeDir,
    resolveArchiveChallengeDir,
    saveChallengeRecord,
    normalizeChallengeRecord,
    createChallengeRecord,
    type CreateChallengeInput,
    hashChallengeAsset,
    getChallengeDisplayName,
    archiveChallengeRecord,
} from "./store"
import type { ChallengeStatsOverviewBucket, ChallengeStatsRecord, SolverStatsRecord } from "./stats"
import { buildChallengeStatsOverview, refreshChallengeStats } from "./stats"
import {
    type AddIdeaResult,
    type AddIdeaInput,
    type AddMemoryInput,
    type IdeaRecord,
    type IdeaStatus,
    type MemoryKind,
    type MemoryEntry,
    type UpdateIdeaInput,
} from "./memory"
import type { ChallengeMemoryProvider, ChallengeMemoryScope } from "./memory-provider"
import type { TaricMemoryProviderFactory } from "../taric"
import { FileChallengeMemoryProvider } from "./memory-provider"
import { deriveCompositeProjectKey } from "../project/types"
import type { Project } from "../project/types"
import { archiveLegacyUnclassified, dryRunLegacyMigration } from "../project/migration"
import type { LegacyArchiveResult, LegacyMigrationReport } from "../project/migration"
import { CaptureDtoError, TaricUnavailableError } from "../taric"
import type { TaricHealth, TaricHostObservationInput } from "../taric"
import { createLocalTaricEngagement, getLocalTaricGatewayRuntime } from "../taric/local-gateway"
import { assertTaricControlPlaneContract } from "../taric/control-plane-contract"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import { solverSessionDir } from "../runtime/types"
import { seedSolverBoardSnapshot } from "../solver/board-store"
import { Type } from "typebox"
import { CHALLENGE_PLANNER_PROMPT_NAME } from "../config/prompts/index"
import type { AuthorizedChallengeProjection, AuthorizedChallengeProjectionProvider, AuthorizedWorkRecoveryResult } from "./authorized-projection"
import type { AuthorizedProjectBinding } from "../config/authorized-projects"
import type { SolverAssignmentReview, SolverReviewRecord } from "./solver-review"
import { listSolverReviews, saveSolverReview } from "./solver-review"
import { createManagerLifecycleService, type LifecycleReportInput, type ManagerLifecycleService } from "./lifecycle-service"

export type { IdeaStatus, MemoryKind, MemoryEntry, AddMemoryInput, IdeaRecord, AddIdeaInput, AddIdeaResult, UpdateIdeaInput } from "./memory"

const DEFAULT_PLANNER_PROMPT_NAME = CHALLENGE_PLANNER_PROMPT_NAME
const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_STALE_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_PLANNER_DECISION_TIMEOUT_MS = 300_000
/** Grace before the host accepts a fully reported assignment whose Observer review never lands. */
const SOLVER_REVIEW_RELEASE_GRACE_MS = 10 * 60_000
/** A running container this daemon cannot talk to is reaped after this launch window. */
const UNMANAGED_SOLVER_REAP_AFTER_MS = 2 * 60_000
const DEFAULT_MAX_SOLVERS = 7
const MAX_ACTIVE_CHALLENGES = 3
const NOISY_ERROR_THROTTLE_WINDOW_MS = 60_000
const NOISY_ERROR_SIGNATURE_LIMIT = 200
const SOLVER_MEMORY_LIMIT = 10
const SOLVER_IDEA_LIMIT = 8
const SOLVER_HANDOFF_MAX_CHARS = 900
const SOLVER_MEMORY_CONTENT_MAX_CHARS = 220
const SOLVER_IDEA_CONTENT_MAX_CHARS = 120
const SOLVER_RESULT_MAX_CHARS = 180
const CHALLENGE_STATE_PLACEHOLDER = "{{CHALLENGE_STATE}}"
const AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER = "{{AVAILABLE_SOLVER_PROMPTS}}"
const USER_STRATEGY_PLACEHOLDER = "{{USER_STRATEGY}}"
const PREVIOUS_PLANNER_ROUND_PLACEHOLDER = "{{PREVIOUS_PLANNER_ROUND}}"
const EMPTY_ASSETS: ChallengeAssetsRecord = { urls: [], ips: [] }

export interface ChallengeListResult {
    remote: ChallengeApiListData
    local: ChallengeInfoRecord[]
    summary: {
        remote: number
        local: number
        solved: number
        platform_solved: number
        reports_completed: number
        total: number
    }
}

export interface ChallengeActionResult<T> {
    remote: T
    challenge?: ChallengeInfoRecord
    is_completed: boolean
}

export interface ChallengeSubmissionMeta {
    solverId?: string
    promptName?: string
    modelName?: string
}

export interface ChallengeReportResult {
    submission: ChallengeSubmissionLogRecord
    challenge: ChallengeInfoRecord
    assets_total: number
    assets_scanned: number
    assets_pending: number
    assets_completed: boolean
    solver_task_completed: boolean
}

export interface ChallengeMemoryHealth {
    status: "healthy" | "degraded" | "blocked" | "unknown"
    mode: ChallengeInfoRecord["memory_mode"]
    provider: "legacy_local" | "taric"
    reason?: string
    checkedAt?: string
}

export type AuthorizedPlannerSolverOperation = "planner" | "solver"

export interface AuthorizedStartupRecovery {
    challengeId: string
    status: "complete" | "blocked"
    results: AuthorizedWorkRecoveryResult[]
    reason?: string
}

const CAPTURE_SENSITIVE_KEY = /(flag|token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i
const CAPTURE_FLAG_PATTERN = /flag\{[^}]*\}|(?:^|\s)(?:sk|ak|pk|token|key)[_-]?[A-Za-z0-9._-]{12,}/gi
const TARIC_RESOURCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sanitizeCaptureValue(value: unknown, key?: string, depth = 0): unknown {
    if (depth > 6) return "[redacted-depth]"
    if (key && CAPTURE_SENSITIVE_KEY.test(key)) return "[redacted-sensitive-field]"
    if (typeof value === "string") return value.replace(CAPTURE_FLAG_PATTERN, "[redacted-secret]").slice(0, 32_000)
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeCaptureValue(item, undefined, depth + 1))
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([entryKey, entryValue]) => [entryKey, sanitizeCaptureValue(entryValue, entryKey, depth + 1)]))
    }
    return value
}

function captureEventId(prefix: string, value: unknown): string {
    let serialized: string
    try {
        serialized = JSON.stringify(value)
    } catch {
        serialized = JSON.stringify({ unserializable: true })
    }
    const digest = new Bun.CryptoHasher("sha256").update(serialized ?? "null").digest("hex").slice(0, 48)
    return `${prefix}:${digest}`
}

function captureResourceRef(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const resourceRef = (value as { resource_ref?: unknown }).resource_ref
    return typeof resourceRef === "string" && TARIC_RESOURCE_UUID.test(resourceRef.trim()) ? resourceRef.trim() : undefined
}

interface LaunchSolverOptions {
    plannerHandoff?: string
    entrypoints?: PlannerAssetEntrypoint[]
    testItems?: string[]
}

interface PlannerAssetEntrypoint {
    asset_hash: string
    asset: string
}

type ChallengePlannerStatus = NonNullable<ChallengeInfoRecord["planner_status"]>

interface PlannerRunOptions {
    challengeId?: string
    preferredPromptName?: string
}

interface PlannerTextAction {
    toolName: "planner_start_challenge" | "planner_launch_solver" | "planner_complete_asset" | "planner_decide_solver"
    args: Record<string, unknown>
}

/**
 * Some OpenAI-compatible planner endpoints return tool-shaped XML as text
 * instead of a native tool call. Keep the fallback deliberately narrow: only
 * supported scheduling actions are accepted and their arguments are validated by
 * the normal planner tool implementations below.
 */
export function parsePlannerTextActions(text: string): PlannerTextAction[] {
    const actions: PlannerTextAction[] = []
    const blocks = /<(planner_(?:start_challenge|launch_challenge|launch_solver|complete_asset|decide_solver))>\s*([\s\S]*?)\s*<\/\1>/g
    for (const match of text.matchAll(blocks)) {
        const rawTag = match[1]
        const rawPayload = match[2]?.trim()
        if (!rawTag || !rawPayload) continue
        const payload = rawPayload.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
        let value: unknown
        try {
            value = JSON.parse(payload)
        } catch {
            continue
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue
        const toolName = rawTag === "planner_launch_solver" || rawTag === "planner_complete_asset" || rawTag === "planner_decide_solver" ? rawTag : "planner_start_challenge"
        actions.push({ toolName, args: { ...(value as Record<string, unknown>) } })
    }
    return actions
}

export function resolvePlannerSolverPromptName(value: unknown, availableNames: string[], preferredName?: string): string {
    const requested = typeof value === "string" ? value.trim() : ""
    if (availableNames.includes(requested)) return requested
    if (preferredName && availableNames.includes(preferredName.trim())) return preferredName.trim()
    if (availableNames.length === 1) return availableNames[0]!
    throw new Error(`invalid solver promptName ${requested || "(missing)"}; available prompts: ${availableNames.join(", ") || "none"}`)
}

function projectModelContext(items: Record<string, unknown>[]): Record<string, unknown>[] {
    return items.map((item) => Object.fromEntries(
        ["id", "kind", "title", "summary", "content", "statement", "status", "goal", "goals", "acceptance", "acceptance_criteria", "risk_budget", "limitations", "next_steps", "completed_steps", "unresolved_work", "resource_ref", "resource_refs", "evidence_refs", "subject_refs", "observation_refs", "work_item_ref", "scope_revision_ref", "created_at"]
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]),
    ))
}

export interface PlannerRunResult {
    message: string
    stopReason: string
    launchedSolvers: SolverInstance[]
}

function extractErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
        const message = error.message.trim()
        return message || error.name
    }
    if (error === undefined) return
    return String(error)
}

function isNoisyChallengeApiError(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false
    const text = errorMessage.toLowerCase()
    return (
        text.includes("challenge api get /challenges") ||
        text.includes("unable to connect") ||
        text.includes("typo in the url or port") ||
        text.includes("timeout after")
    )
}

interface PlannerSnapshotChallenge {
    id: string
    name: string
    title: string
    description: string
    instanceStatus: string
    assets: ChallengeAssetsRecord
    availableAssets: ChallengeAssetsRecord
    activeAssetClaims: Array<{ solverId: string; assetHashes: string[]; testItems: string[]; unknown: boolean; wildcardTests: boolean }>
    urlTargetCount: number
    ipTargetCount: number
    scannedTargetCount: number
    pendingTargetCount: number
    plannerPrompt?: string | null
    entrypoint: string[] | null
    attemptCount: number
    reportCount: number
    sharedMemory: MemoryEntry[]
    sharedIdeas: IdeaRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    solverReviews?: SolverReviewRecord[]
    untouched: boolean
    stale: boolean
    idleInstance: boolean
    activeSolverCount: number
    activeSolverIds: string[]
    activeForMinutes?: number
    minutesSinceLastAttempt?: number
    minutesSinceLastReport?: number
    authority?: {
        readSeq: number
        closed: boolean
        canClose: boolean
        gaps: string[]
        work: Array<{ id: string; status: string; resourceRefs: string[] }>
        evidenceRefs: string[]
        context: Record<string, unknown>[]
        reportRefs: string[]
    }
}

interface PlannerSnapshot {
    generatedAt: string
    constraints: {
        maxActiveChallenges: number
        maxSolvers: number
        activeChallenges: number
        activeSolvers: number
        staleTimeoutMs: number
    }
    activeSolvers: Array<{
        id: string
        challengeId?: string
        promptName: string
        status: string
        activeForMinutes: number
        timeoutStatus: "normal" | "stale"
    }>
    availableSolverPrompts: Array<{
        name: string
        description?: string
        modelPrefId?: string
        modelLabel?: string
        promptPerformance?: ChallengeStatsOverviewBucket
    }>
    challenges: PlannerSnapshotChallenge[]
}

interface PreviousPlannerRoundRecord {
    generated_at: string
    snapshot_digest: string
    actions: string[]
    summary: string
}

function requireText(value: unknown, fieldName: string): string {
    if (typeof value !== "string") throw new Error(`${fieldName} is required`)
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function requirePlannerAssetEntrypoints(value: unknown, fieldName: string): PlannerAssetEntrypoint[] {
    if (!Array.isArray(value)) throw new Error(`${fieldName} is required`)
    const entries = value.map((item) => {
        if (typeof item !== "object" || item === null) throw new Error(`${fieldName} is required`)
        const entry = item as { asset_hash?: unknown; asset?: unknown }
        return {
            asset_hash: requireText(entry.asset_hash, `${fieldName}.asset_hash`),
            asset: requireText(entry.asset, `${fieldName}.asset`),
        }
    })
    const unique = new Map(entries.map((entry) => [entry.asset_hash, entry]))
    if (unique.size === 0) throw new Error(`${fieldName} is required`)
    return [...unique.values()]
}

function collectPlannerChallengeEntryPoints(challenge: PlannerSnapshotChallenge): Map<string, string> {
    return new Map([...challenge.availableAssets.urls, ...challenge.availableAssets.ips].map((item) => [item.asset_hash, item.asset]))
}

const SOLVER_ENTRYPOINT_PATTERN = /^\s*-\s*\[([0-9a-f]{32})\]\s+.+$/gim
const SOLVER_TEST_SECTION_PATTERN = /^本次测试项:\s*\r?\n([\s\S]*?)(?:\r?\n\r?\n|当前 Memory 摘要:)/m

function extractSolverAssetHashes(task: unknown): Set<string> {
    const hashes = new Set<string>()
    if (typeof task !== "string") return hashes
    for (const match of task.matchAll(SOLVER_ENTRYPOINT_PATTERN)) {
        const hash = match[1]?.toLowerCase()
        if (hash) hashes.add(hash)
    }
    return hashes
}

function normalizeTestItems(value?: string[]): string[] | undefined {
    if (!value) return
    const unique = [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))]
    return unique.length > 0 ? unique : undefined
}

function extractSolverTestItems(task: unknown): Set<string> {
    if (typeof task !== "string") return new Set()
    const section = task.match(SOLVER_TEST_SECTION_PATTERN)?.[1]
    if (!section) return new Set()
    return new Set(section.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "").trim()).filter((item) => item.length > 0))
}

interface SolverAssignment {
    assetHashes?: Set<string>
    testItems?: Set<string>
}

function solverAssignmentsOverlap(left: SolverAssignment, right: SolverAssignment): boolean {
    const assetOverlap = left.assetHashes === undefined || right.assetHashes === undefined
        ? true
        : [...left.assetHashes].some((hash) => right.assetHashes?.has(hash))
    if (!assetOverlap) return false
    if (left.testItems === undefined || right.testItems === undefined) return true
    return [...left.testItems].some((item) => right.testItems?.has(item))
}

function solverAssignmentFromTask(task: unknown): SolverAssignment {
    const assetHashes = extractSolverAssetHashes(task)
    const testItems = extractSolverTestItems(task)
    return {
        assetHashes: assetHashes.size > 0 ? assetHashes : undefined,
        testItems: testItems.size > 0 ? testItems : undefined,
    }
}

function latestSolverAssetReport(submissions: ChallengeSubmissionLogRecord[], solverId: string, assetHash: string): ChallengeSubmissionLogRecord | undefined {
    return submissions.filter((item) => item.solver_id === solverId && item.asset_hash === assetHash)
        .reduce<ChallengeSubmissionLogRecord | undefined>((latest, item) => !latest || item.created_at >= latest.created_at ? item : latest, undefined)
}

function completedAssetTestItems(submissions: ChallengeSubmissionLogRecord[], assetHash: string): Set<string> {
    const latestBySolver = new Map<string, ChallengeSubmissionLogRecord>()
    for (const report of submissions) {
        if (report.asset_hash !== assetHash) continue
        const key = report.solver_id ?? report.id
        const previous = latestBySolver.get(key)
        if (!previous || report.created_at >= previous.created_at) latestBySolver.set(key, report)
    }
    return new Set([...latestBySolver.values()].flatMap((report) => report.test_results?.filter((result) => result.status === "completed").map((result) => result.test_item) ?? []))
}

function hasReportedAssignment(report: ChallengeSubmissionLogRecord | undefined, testItems: Set<string>, requireCompleted: boolean): boolean {
    if (!report) return false
    if (testItems.size === 0) return true
    return [...testItems].every((item) => report.test_results?.some((result) => result.test_item === item && (!requireCompleted || result.status === "completed")))
}

function sameSubmissionIds(left: string[], right: string[]): boolean {
    const sortedRight = [...right].sort()
    return left.length === right.length && [...left].sort().every((id, index) => id === sortedRight[index])
}

function isClaimingSolver(solver: SolverInstance): boolean {
    return solver.status === "starting" || solver.status === "running" || solver.status === "stopping"
}

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)))
}

function resolvePlannerTickIntervalMs(value?: number): number {
    return clampInt(value ?? DEFAULT_TICK_INTERVAL_MS, 5_000, 10 * 60 * 1000)
}

function resolvePlannerDecisionTimeoutMs(value?: number): number {
    return clampInt(value ?? DEFAULT_PLANNER_DECISION_TIMEOUT_MS, 60_000, 10 * 60 * 1000)
}

function sanitizePlannerRoundScope(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "challenge"
}

function parseTimestamp(value?: string): number | undefined {
    if (!value) return
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function formatMinutesFromTimestamp(value?: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return
    const diffMs = Date.now() - value
    if (!Number.isFinite(diffMs) || diffMs < 0) return 0
    return Math.floor(diffMs / 60000)
}

function isActiveSolver(solver: SolverInstance): boolean {
    return solver.status === "starting" || solver.status === "running"
}

function isActiveChallengeInstance(challenge: ChallengeInfoRecord): boolean {
    return challenge.instance_status === "running" || challenge.instance_status === "pending"
}

function escapeMarkdownTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map((row) => `| ${row.map((cell) => escapeMarkdownTableCell(cell)).join(" | ")} |`)
    return [header, separator, ...body].join("\n")
}

function clipTaskText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function summarizeBroadcastRefs(refs: string[]): string | undefined {
    const items = refs
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 3)
        .map((item) => clipTaskText(item, 80))
    if (items.length === 0) return
    return items.join(" | ")
}

function formatChallengeMemoryBroadcastMessage(action: "added" | "updated" | "deleted", entry: MemoryEntry): string {
    const actionText = action === "added" ? "新增" : action === "updated" ? "更新" : "删除"
    const refsSummary = summarizeBroadcastRefs(entry.refs)

    return [
        `协作同步：Challenge Memory 已${actionText}。`,
        `- kind: ${entry.kind}`,
        `- source: ${clipTaskText(entry.source, 120)}`,
        `- content: ${clipTaskText(entry.content, 220)}`,
        refsSummary ? `- refs: ${refsSummary}` : undefined,
        action === "deleted" ? "- 这条 challenge memory 已被移除，不要继续把它当成当前背景事实。" : "- 这是 challenge 级背景更新；如它影响当前路线，再自行吸收并调整。",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

function formatChallengeIdeaBroadcastMessage(action: "added" | "updated" | "deleted", idea: IdeaRecord): string {
    const actionText = action === "added" ? "新增" : action === "updated" ? "更新" : "删除"

    return [
        `协作同步：Challenge Idea 已${actionText}。`,
        `- status: ${idea.status}`,
        `- content: ${clipTaskText(idea.content, 200)}`,
        idea.result.trim() ? `- result: ${clipTaskText(idea.result, 180)}` : undefined,
        action === "deleted" ? "- 这条 challenge idea 已被移除，不要继续把它当成当前推荐路线。" : "- 这是 challenge 级背景更新；把它当作参考假设，不要直接当作结论。",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

function sortByUpdatedAtDesc<T extends { updated_at?: string }>(items: T[]): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
            const timestampDiff = (parseTimestamp(right.item.updated_at) ?? 0) - (parseTimestamp(left.item.updated_at) ?? 0)
            if (timestampDiff !== 0) return timestampDiff
            return right.index - left.index
        })
        .map((entry) => entry.item)
}

function selectRecentItems<T extends { updated_at?: string }>(items: T[], limit: number): T[] {
    return sortByUpdatedAtDesc(items).slice(0, limit)
}

/** Degraded Observer review derived from the solver's own submitted reports. */
function buildFallbackAssignmentReview(task: string, submissions: ChallengeSubmissionLogRecord[]): SolverAssignmentReview {
    const checklist: SolverAssignmentReview["checklist"] = []
    const seen = new Set<string>()
    const remainingWork: string[] = []
    const hasAssignedTests = extractSolverTestItems(task).size > 0
    for (const submission of submissions) {
        const results = submission.test_results ?? []
        if (results.length === 0) {
            const item = "全量测试"
            const key = `${submission.asset_hash}\n${item}`
            if (!seen.has(key)) {
                seen.add(key)
                checklist.push({ asset_hash: submission.asset_hash, test_item: item, verdict: "verified", evidence: clipTaskText(submission.report, SOLVER_MEMORY_CONTENT_MAX_CHARS * 2) })
            }
            continue
        }
        for (const result of results) {
            const key = `${submission.asset_hash}\n${result.test_item}`
            if (seen.has(key)) continue
            seen.add(key)
            const blocked = result.status === "blocked"
            checklist.push({
                asset_hash: submission.asset_hash,
                test_item: result.test_item,
                verdict: blocked ? "blocked" : "verified",
                evidence: clipTaskText(result.evidence, SOLVER_MEMORY_CONTENT_MAX_CHARS * 2),
            })
            if (blocked) remainingWork.push(`${submission.asset} ${result.test_item}`)
        }
    }
    return {
        summary: "Observer 独立审查在宽限期内未完成（多次超时/失败），宿主按 solver 自报结果生成降级审查以释放该分工。",
        checklist,
        concerns: ["降级审查：未经 Observer 独立证据核验，逐项结论直接来自 solver 自报的 test_results；如需强证据请安排复核。"],
        remaining_work: hasAssignedTests ? remainingWork : [],
        suggested_decision: "stop",
    }
}

function formatSolverMemorySection(items: MemoryEntry[]): string {
    if (items.length === 0) return "无"
    const selected = selectRecentItems(items, SOLVER_MEMORY_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Kind", "Trust", "Content", "Refs", "Source", "Updated"],
        selected.map((item) => [
            item.id,
            item.kind,
            item.trustState ?? "local",
            clipTaskText(item.content, SOLVER_MEMORY_CONTENT_MAX_CHARS),
            item.refs.length > 0 ? clipTaskText(item.refs.join(", "), SOLVER_IDEA_CONTENT_MAX_CHARS) : "-",
            item.source,
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\n注: 初始上下文仅展示最近 ${selected.length}/${items.length} 条 memory；需要全量记录时再调用 memory_list。`
}

function formatSolverIdeasSection(items: IdeaRecord[]): string {
    if (items.length === 0) return "无"
    const selected = selectRecentItems(items, SOLVER_IDEA_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Status", "Trust", "Idea", "Result", "Updated"],
        selected.map((item) => [
            item.id,
            item.status,
            item.trustState ?? "local",
            clipTaskText(item.content, SOLVER_IDEA_CONTENT_MAX_CHARS),
            item.result ? clipTaskText(item.result, SOLVER_RESULT_MAX_CHARS) : "-",
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\n注: 初始上下文仅展示最近 ${selected.length}/${items.length} 条 idea；需要全量策略板时再调用 idea_list 或 idea_search。`
}

function formatSolverSubmissionsSection(items: ChallengeSubmissionLogRecord[]): string {
    if (items.length === 0) return "无"
    const sorted = [...items].sort((a, b) => (parseTimestamp(b.created_at) ?? 0) - (parseTimestamp(a.created_at) ?? 0))
    return formatMarkdownTable(
        ["Asset", "Report"],
        sorted.map((item) => [item.asset, clipTaskText(item.report, SOLVER_MEMORY_CONTENT_MAX_CHARS)]),
    )
}

/** Compact pending-review rendering: keep decision-relevant signal, drop bulky evidence JSON. */
function formatSolverReviewMarkdown(review: SolverReviewRecord): string {
    return [
        `- reviewId: ${review.id} (solver ${review.solver_id}, suggested: ${review.review.suggested_decision}${review.decision ? `, decided: ${review.decision.action}` : ", 待决"})`,
        `  summary: ${clipTaskText(review.review.summary, 200)}`,
        ...review.review.checklist.map((item) => `  - ${item.asset_hash.slice(0, 8)} ${item.test_item}: ${item.verdict} (evidence: ${clipTaskText(item.evidence, 160)})`),
        review.review.concerns.length > 0 ? `  concerns: ${review.review.concerns.map((item) => clipTaskText(item, 120)).join("；")}` : undefined,
        review.review.remaining_work.length > 0 ? `  remaining_work: ${review.review.remaining_work.map((item) => clipTaskText(item, 120)).join("；")}` : undefined,
    ]
        .filter((line): line is string => typeof line === "string")
        .join("\n")
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function writePlannerTextChunk(chunk: string): void {
    const text = chunk.replace(/\r/g, "")
    if (!text) return
    process.stdout.write(text)
}

const CHALLENGE_LOG_SCOPE_ICONS: Record<string, string> = {
    planner: "🧠",
    "planner-tool": "🧠🛠",
    solver: "🤖",
    "sync-loop": "🔄",
    start: "🚀",
    stop: "🛑",
    submit: "📝",
    hint: "💡",
    finish: "✅",
}

function formatChallengeLogScope(scope: string): string {
    const parts = scope.split(":").filter(Boolean)
    if (parts.length === 0) return "🎯"
    if (parts[0] === "challenge") parts.shift()
    if (parts.length === 0) return "🎯"
    return CHALLENGE_LOG_SCOPE_ICONS[parts.join(":")] ?? CHALLENGE_LOG_SCOPE_ICONS[parts[0]] ?? "🎯"
}

function formatPromptPerformance(bucket?: ChallengeStatsOverviewBucket): string {
    if (!bucket) return "-"
    return `${bucket.assets_scanned}/${bucket.assets_total}`
}

function formatAvailableSolverPromptsMarkdown(snapshot: PlannerSnapshot): string {
    const availablePromptRows = snapshot.availableSolverPrompts.map((prompt) => [
        prompt.name,
        prompt.modelLabel ?? "-",
        formatPromptPerformance(prompt.promptPerformance),
        prompt.description?.replaceAll("\n", " ") || "-",
    ])

    const table = availablePromptRows.length > 0 ? formatMarkdownTable(["Prompt", "Configured Model", "Asset Coverage", "Description"], availablePromptRows) : "No solver prompts available."

    const details = snapshot.availableSolverPrompts.flatMap((prompt) => [
        `### ${prompt.name}`,
        `- Description: ${prompt.description?.trim() || "-"}`,
        `- Configured model: ${prompt.modelLabel ?? "-"}`,
        `- Model pref id: ${prompt.modelPrefId ?? "-"}`,
        `- Prompt performance: ${formatPromptPerformance(prompt.promptPerformance)}`,
        "",
    ])

    return [table, "", "## Solver Prompt Details", ...details].join("\n")
}

function formatPlannerSnapshotMarkdown(snapshot: PlannerSnapshot): string {
    const challengeRows = snapshot.challenges.map((challenge) => [
        challenge.id,
        challenge.name.replaceAll("\n", " "),
        challenge.instanceStatus,
        String(challenge.activeSolverCount),
        String(challenge.urlTargetCount),
        String(challenge.ipTargetCount),
        String(challenge.scannedTargetCount),
        String(challenge.pendingTargetCount),
        challenge.untouched ? "yes" : "no",
        challenge.stale ? "yes" : "no",
        challenge.idleInstance ? "yes" : "no",
    ])
    const solverRows = snapshot.activeSolvers.map((solver) => [solver.id, solver.challengeId ?? "-", solver.promptName, solver.status, `${solver.activeForMinutes}m (${solver.timeoutStatus})`])

    return [
        "## Constraints",
        `- Max active challenge instances: ${snapshot.constraints.maxActiveChallenges}`,
        `- Max solvers: ${snapshot.constraints.maxSolvers}`,
        `- Active challenge instances: ${snapshot.constraints.activeChallenges}`,
        `- Active solvers: ${snapshot.constraints.activeSolvers}`,
        `- Idle challenge slots: ${Math.max(snapshot.constraints.maxActiveChallenges - snapshot.constraints.activeChallenges, 0)}`,
        `- Idle solver slots: ${Math.max(snapshot.constraints.maxSolvers - snapshot.constraints.activeSolvers, 0)}`,
        `- Visible active projects: ${snapshot.challenges.length}`,
        `- Stale timeout minutes: ${Math.floor(snapshot.constraints.staleTimeoutMs / 60000)}`,
        "",
        "## Projects",
        challengeRows.length > 0
            ? formatMarkdownTable(["ID", "Name", "Instance", "Solvers", "URL Targets", "IP Targets", "Scanned", "Pending", "Untouched", "Stale", "Idle Instance"], challengeRows)
            : "No active projects.",
        "",
        "## Active Solvers",
        solverRows.length > 0 ? formatMarkdownTable(["Solver", "Project", "Prompt", "Status", "Active For"], solverRows) : "No active solvers.",
        "",
        "## Project Details",
        ...snapshot.challenges.flatMap((challenge) => [
            `### ${challenge.id} - ${challenge.name}`,
            `- Description: ${challenge.description.trim() || "无"}`,
            `- Instance status: ${challenge.instanceStatus}`,
            `- URL targets: ${challenge.urlTargetCount}`,
            `- IP targets: ${challenge.ipTargetCount}`,
            `- Scanned targets: ${challenge.scannedTargetCount}`,
            `- Pending targets: ${challenge.pendingTargetCount}`,
            `- Available unclaimed pending targets: ${challenge.availableAssets.urls.length + challenge.availableAssets.ips.length}`,
            `- Attempt count: ${challenge.attemptCount}`,
            `- Report count: ${challenge.reportCount}`,
            `- Pending first observation: ${challenge.reportCount === 0 ? "yes" : "no"}`,
            "#### Observer Assignment Reviews Awaiting Planner Decision",
            ...(challenge.solverReviews?.length ? challenge.solverReviews.map((review) => formatSolverReviewMarkdown(review)) : ["None"]),
            "- 对每份待决审查必须调用 planner_decide_solver；审核有遗漏、缺乏执行证据、虚报或偷懒时 continue 原 solver 并给整改清单；正常完成或有证据的真实阻塞允许 stop 释放容器。不能因资源已满、项目不 stale 或资产仍被认领而跳过审查。",
            "#### Shared Findings / Memory",
            formatSolverMemorySection(challenge.sharedMemory),
            "#### Shared Candidate Ideas",
            formatSolverIdeasSection(challenge.sharedIdeas),
            "#### Solver Reports and Handoff",
            ...challenge.submissions.filter((submission, index) => index >= challenge.submissions.length - 6 || [...challenge.assets.urls, ...challenge.assets.ips].some((asset) => asset.asset_hash === submission.asset_hash && !asset.scanned)).flatMap((submission) => [
                `- Solver: ${submission.solver_id ?? "manual"}; asset: ${submission.asset_hash}`,
                `  Report: ${clipTaskText(submission.report, SOLVER_HANDOFF_MAX_CHARS)}`,
                ...(submission.test_results ?? []).map((result) => `  - ${result.test_item}: ${result.status}; evidence: ${clipTaskText(result.evidence, SOLVER_MEMORY_CONTENT_MAX_CHARS)}`),
                ...(submission.discoveries ?? []).map((discovery) => `  - Discovery for planner follow-up: ${discovery}`),
            ]),
            `- Active solver ids: ${challenge.activeSolverIds.length > 0 ? challenge.activeSolverIds.join(", ") : "none"}`,
            `- Active asset claims: ${challenge.activeAssetClaims.length > 0
                ? challenge.activeAssetClaims.map((claim) => `${claim.solverId}=${claim.unknown ? "all pending assets (unscoped task)" : claim.assetHashes.join(", ")}; tests=${claim.wildcardTests ? "all" : claim.testItems.join(", ")}`).join(" | ")
                : "none"}`,
            `- Untouched: ${challenge.untouched ? "yes" : "no"}`,
            `- Stale: ${challenge.stale ? "yes" : "no"}`,
            `- Idle instance: ${challenge.idleInstance ? "yes" : "no"}`,
            ...(challenge.authority ? [
                `- Taric read_seq: ${challenge.authority.readSeq}`,
                `- Engagement closed: ${challenge.authority.closed ? "yes" : "no"}`,
                `- Coverage gate can close: ${challenge.authority.canClose ? "yes" : "no"}`,
                `- Coverage gaps: ${challenge.authority.gaps.length > 0 ? challenge.authority.gaps.join(", ") : "none"}`,
                `- Canonical Evidence refs: ${challenge.authority.evidenceRefs.length > 0 ? challenge.authority.evidenceRefs.join(", ") : "none"}`,
                `- Canonical report refs: ${challenge.authority.reportRefs.join(", ") || "none"}`,
                `- Taric Context records: ${JSON.stringify(challenge.authority.context)}`,
                "#### Canonical Work",
                challenge.authority.work.length > 0
                    ? formatMarkdownTable(["WorkItem", "Status", "Resource refs"], challenge.authority.work.map((item) => [item.id, item.status, item.resourceRefs.join(", ") || "none"]))
                    : "No admitted WorkItems.",
            ] : []),
            typeof challenge.activeForMinutes === "number" ? `- Active for minutes: ${challenge.activeForMinutes}` : "- Active for minutes: -",
            typeof challenge.minutesSinceLastAttempt === "number" ? `- Minutes since last attempt: ${challenge.minutesSinceLastAttempt}` : "- Minutes since last attempt: -",
            typeof challenge.minutesSinceLastReport === "number"
                ? `- Minutes since last report: ${challenge.minutesSinceLastReport}`
                : "- Minutes since last report: -",
            `#### URL Targets`,
            formatAssetTargetTable(challenge.assets.urls, "No URL targets."),
            `#### IP Targets`,
            formatAssetTargetTable(challenge.assets.ips, "No IP targets."),
            `#### Available Unclaimed Targets`,
            formatAssetTargetTable(
                [...challenge.availableAssets.urls, ...challenge.availableAssets.ips],
                "No unclaimed pending targets.",
            ),
            `#### Project Planner Prompt (优先级高)`,
            challenge.plannerPrompt
                ? [
                      `这是该 challenge/project 的追加 planner prompt，只约束本项目，不覆盖全局 ${DEFAULT_PLANNER_PROMPT_NAME} system prompt。`,
                      "",
                      challenge.plannerPrompt,
                  ].join("\n")
                : "-",
            "",
        ]),
    ].join("\n")
}

function formatPreviousPlannerRoundMarkdown(previousRound?: PreviousPlannerRoundRecord): string {
    if (!previousRound) return "无上一轮调度记录。"
    return [
        `- Snapshot digest: ${previousRound.snapshot_digest}`,
        `- Actions: ${previousRound.actions.length > 0 ? previousRound.actions.join(" | ") : "none"}`,
        "",
        previousRound.summary.trim() || "无摘要。",
    ].join("\n")
}

function computePlannerSnapshotDigest(snapshot: PlannerSnapshot): string {
    const payload = JSON.stringify({
        constraints: snapshot.constraints,
        activeSolvers: snapshot.activeSolvers.map((solver) => ({
            id: solver.id,
            challengeId: solver.challengeId,
            promptName: solver.promptName,
            status: solver.status,
        })),
        challenges: snapshot.challenges.map((challenge) => ({
            id: challenge.id,
            instanceStatus: challenge.instanceStatus,
            activeSolverIds: challenge.activeSolverIds,
            attemptCount: challenge.attemptCount,
            reportCount: challenge.reportCount,
            sharedMemory: challenge.sharedMemory,
            sharedIdeas: challenge.sharedIdeas,
            submissions: challenge.submissions,
            availableAssets: challenge.availableAssets,
            activeAssetClaims: challenge.activeAssetClaims,
            stale: challenge.stale,
            authority: challenge.authority,
        })),
        prompts: snapshot.availableSolverPrompts.map((prompt) => prompt.name),
    })
    return Bun.hash(payload).toString(16)
}

function wrapPlannerResourceLoader(
    base: ResourceLoader,
    snapshot: PlannerSnapshot,
    previousRound?: PreviousPlannerRoundRecord,
    preferredPromptName?: string,
): ResourceLoader {
    const stateText = formatPlannerSnapshotMarkdown(snapshot)
    const availableSolverPromptsText = formatAvailableSolverPromptsMarkdown(snapshot)
    const plannerContextParts: string[] = []
    if (preferredPromptName?.trim()) {
        plannerContextParts.push(`本次用户选择的 solver prompt: ${preferredPromptName.trim()}。除非有明确理由，否则使用它启动当前项目 solver。`)
    }
    const plannerContextText = plannerContextParts.join("\n\n") || "无额外动态调度上下文。"
    const previousPlannerRoundText = formatPreviousPlannerRoundMarkdown(previousRound)
    const basePrompt = base.getSystemPrompt() ?? ""
    const replacedPrompt = basePrompt
        .replaceAll(CHALLENGE_STATE_PLACEHOLDER, stateText)
        .replaceAll(AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER, availableSolverPromptsText)
        .replaceAll(USER_STRATEGY_PLACEHOLDER, plannerContextText)
        .replaceAll(PREVIOUS_PLANNER_ROUND_PLACEHOLDER, previousPlannerRoundText)

    return {
        getExtensions: () => base.getExtensions(),
        getSkills: () => base.getSkills(),
        getPrompts: () => base.getPrompts(),
        getThemes: () => base.getThemes(),
        getAgentsFiles: () => base.getAgentsFiles(),
        getSystemPrompt: () => replacedPrompt,
        getSystemPromptSource: () => base.getSystemPromptSource(),
        getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
        getAppendSystemPromptSources: () => base.getAppendSystemPromptSources(),
        extendResources: (paths) => base.extendResources(paths),
        reload: () => base.reload(),
    }
}

function hasAssetItems(value: string | string[] | null | undefined): boolean {
    if (Array.isArray(value)) return value.some((item) => item.trim().length > 0)
    return typeof value === "string" && value.trim().length > 0
}

function countScannedAssets(assets: ChallengeAssetsRecord): number {
    return [...assets.urls, ...assets.ips].filter((item) => item.scanned).length
}

function countPendingAssets(assets: ChallengeAssetsRecord): number {
    return [...assets.urls, ...assets.ips].filter((item) => !item.scanned).length
}

function countTotalAssets(assets: ChallengeAssetsRecord): number {
    return assets.urls.length + assets.ips.length
}

function findAssetByHash(assets: ChallengeAssetsRecord, assetHash: string): { group: "urls" | "ips"; asset: ChallengeAssetsRecord["urls"][number] } | undefined {
    const urlMatch = assets.urls.find((item) => item.asset_hash === assetHash)
    if (urlMatch) return { group: "urls", asset: urlMatch }
    const ipMatch = assets.ips.find((item) => item.asset_hash === assetHash)
    if (ipMatch) return { group: "ips", asset: ipMatch }
    return
}

function formatAssetTargetTable(items: ChallengeAssetsRecord["urls"], emptyText: string): string {
    if (items.length === 0) return emptyText
    return formatMarkdownTable(
        ["Asset Hash", "Target", "Scanned"],
        items.map((item) => [item.asset_hash, item.asset, item.scanned ? "yes" : "no"]),
    )
}

function mapApiChallengeToRecord(challenge: ChallengeApiChallenge): ChallengeRecord {
    return normalizeChallengeRecord({
        id: challenge.code,
        name: challenge.title,
        title: challenge.title,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        hint_viewed: challenge.hint_viewed,
        hint_content: null,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
    })
}

function mapRecordToApiChallenge(challenge: ChallengeInfoRecord): ChallengeApiChallenge {
    return {
        title: challenge.title,
        code: challenge.id,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        hint_viewed: challenge.hint_viewed,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
    }
}

export class ChallengeManager {
    private readonly config: ConfigManager
    private readonly memoryProvider: ChallengeMemoryProvider
    private readonly taricMemoryProvider?: ChallengeMemoryProvider
    private readonly taricMemoryProviderFactory?: TaricMemoryProviderFactory
    private readonly authorizedProjectionProvider?: AuthorizedChallengeProjectionProvider
    private readonly lifecycleService: ManagerLifecycleService
    private readonly generatedTaricProviders = new Map<string, Promise<ChallengeMemoryProvider>>()
    private api: ChallengeApiClient | undefined
    private rootDir: string | undefined
    private runtime: RuntimeManager | undefined
    private syncLoopStarted = false
    private loopTickCount = 0
    private finishingChallenges = new Set<string>()
    private plannerRunning = false
    private readonly pendingReviewPlanners = new Set<string>()
    private readonly solverReviewMutations = new Map<string, Promise<void>>()
    private readonly solverLaunchReservations = new Map<string, Array<SolverAssignment | undefined>>()
    private readonly challengeStartFlights = new Map<string, Promise<ChallengeActionResult<ChallengeApiStartData>>>()
    private noisyErrorLogState = new Map<string, { lastLoggedAt: number; suppressedCount: number }>()
    private readonly captureGenerations = new Map<string, number>()
    private authorizedStartupRecovery?: Promise<AuthorizedStartupRecovery[]>
    private readonly authorizedRecoveryByChallenge = new Map<string, AuthorizedStartupRecovery>()

    constructor(config: ConfigManager, memoryProvider?: ChallengeMemoryProvider, taricMemoryProvider?: ChallengeMemoryProvider, taricMemoryProviderFactory?: TaricMemoryProviderFactory, authorizedProjectionProvider?: AuthorizedChallengeProjectionProvider, lifecycleService?: ManagerLifecycleService) {
        this.config = config
        this.memoryProvider = memoryProvider ?? new FileChallengeMemoryProvider(async () => this.getRootDir())
        this.taricMemoryProvider = taricMemoryProvider
        this.taricMemoryProviderFactory = taricMemoryProviderFactory
        this.authorizedProjectionProvider = authorizedProjectionProvider
        this.lifecycleService = lifecycleService ?? createManagerLifecycleService()
    }

    /** 生命周期写入只经过 Manager 服务；ChallengeRecord 仅作为 competition 投影。 */
    getLifecycleService(): ManagerLifecycleService {
        return this.lifecycleService
    }

    async submitLifecycleProgress(input: LifecycleReportInput) {
        return this.lifecycleService.submitProgress(input)
    }

    async submitLifecycleFinal(input: LifecycleReportInput, batch?: Parameters<ManagerLifecycleService["submitFinal"]>[1]) {
        return this.lifecycleService.submitFinal(input, batch)
    }

    async getLifecycleProjection(challengeId: string) {
        return this.lifecycleService.projection(challengeId)
    }

    private isAuthorizedChallenge(challenge: ChallengeInfoRecord | undefined): boolean {
        return challenge?.project?.mode === "authorized_pentest" || challenge?.mode === "authorized_pentest"
    }

    private createAuthorizedGovernanceBlockedError(operation: AuthorizedPlannerSolverOperation): Error & { code: "TARIC_GOVERNANCE_REQUIRED"; operation: AuthorizedPlannerSolverOperation } {
        const error = new Error(`authorized ${operation} is blocked until Taric governance readiness is established`)
        return Object.assign(error, { code: "TARIC_GOVERNANCE_REQUIRED" as const, operation })
    }

    /** Authorized lifecycle reads must be backed by the Taric projection provider. */
    private async assertAuthorizedPlannerSolverReady(challengeId: string | undefined, operation: AuthorizedPlannerSolverOperation): Promise<void> {
        await this.recoverAuthorizedStartup(`challenge:${operation}`)
        const challenges = challengeId === undefined
            ? await this.listStoredChallenges()
            : [await this.readVisibleChallenge(challengeId)]
        for (const challenge of challenges) {
            if (!challenge) throw this.createAuthorizedGovernanceBlockedError(operation)
            if (!this.isAuthorizedChallenge(challenge)) continue
            if (!this.authorizedProjectionProvider?.prepareLifecycle) throw this.createAuthorizedGovernanceBlockedError(operation)
            const prepared = await this.authorizedProjectionProvider.prepareLifecycle(challenge.id)
            if (!prepared) throw this.createAuthorizedGovernanceBlockedError(operation)
            const recovery = this.authorizedRecoveryByChallenge.get(challenge.id)
            if (recovery?.status === "blocked" || recovery?.results.some((result) => result.status === "replan_required")) {
                const reason = recovery.reason ?? recovery.results.find((result) => result.status === "replan_required")?.reason ?? "authority_recovery_required"
                const error = new Error(`authorized ${operation} is blocked until WorkRun recovery is reconciled: ${reason}`)
                Object.assign(error, { code: "TARIC_RECOVERY_REPLAN_REQUIRED", operation, challengeId: challenge.id, reason })
                throw error
            }
        }
    }

    private async getMemoryContext(challengeId: string): Promise<{ provider: ChallengeMemoryProvider; scope: ChallengeMemoryScope }> {
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.readVisibleChallenge(id)
        const project = challenge?.project
        const challengeMemoryMode = challenge?.memory_mode
        if (challengeMemoryMode && challengeMemoryMode !== "legacy_local" && (!project || !challenge?.project_id || challenge.project_classification !== "trusted")) {
            throw new Error(`memory provider ${challengeMemoryMode} requires a trusted composite project binding`)
        }
        const scope: ChallengeMemoryScope = {
            challengeId: id,
            ...(project && challenge?.project_id ? { project, projectKey: deriveCompositeProjectKey(project) } : {}),
        }
        let provider: ChallengeMemoryProvider | undefined
        if (!challengeMemoryMode || challengeMemoryMode === "legacy_local") provider = this.memoryProvider
        else if (this.taricMemoryProvider) provider = this.taricMemoryProvider
        else if (this.taricMemoryProviderFactory && scope.projectKey) {
            const pending = this.generatedTaricProviders.get(scope.projectKey) ?? this.taricMemoryProviderFactory(scope)
            this.generatedTaricProviders.set(scope.projectKey, pending)
            provider = await pending
        }
        if (!provider) throw new TaricUnavailableError(`memory provider ${challengeMemoryMode ?? "unknown"} is not configured`, challengeMemoryMode === "taric_best_effort" ? "taric_best_effort" : "taric_required")
        if (challengeMemoryMode && provider.mode !== challengeMemoryMode) throw new Error(`memory provider mode ${provider.mode} does not match project mode ${challengeMemoryMode}`)
        if (provider.mode !== "legacy_local" && (!scope.project || !scope.projectKey)) throw new Error(`memory provider ${provider.mode} requires a trusted composite project binding`)
        return { provider, scope }
    }

    private async assertRequiredMemoryAvailable(challengeId: string): Promise<void> {
        const challenge = await this.getChallenge(challengeId)
        if (challenge?.memory_mode !== "taric_required") return
        const { provider, scope } = await this.getMemoryContext(challengeId)
        if (provider.mode !== "taric_required") throw new Error("taric_required project must use a taric_required provider")
        if (challenge.project?.mode === "authorized_pentest") assertTaricControlPlaneContract()
        await provider.assertAvailable?.(scope)
    }

    async getMemoryHealth(challengeId: string): Promise<ChallengeMemoryHealth> {
        const challenge = await this.getChallenge(challengeId)
        const mode = challenge?.memory_mode ?? "legacy_local"
        if (mode === "legacy_local") return { status: "healthy", mode, provider: "legacy_local" }
        try {
            const { provider, scope } = await this.getMemoryContext(challengeId)
            const health = await provider.getHealth?.(scope)
            if (health) return this.mapTaricHealth(mode, health)
            await provider.assertAvailable?.(scope)
            return { status: "healthy", mode, provider: "taric" }
        } catch (error) {
            return {
                status: mode === "taric_required" ? "blocked" : "degraded",
                mode,
                provider: "taric",
                ...(error instanceof Error ? { reason: error.message } : {}),
            }
        }
    }

    private mapTaricHealth(mode: ChallengeMemoryHealth["mode"], health: TaricHealth): ChallengeMemoryHealth {
        const status = health.status === "healthy" ? "healthy" : mode === "taric_required" ? "blocked" : "degraded"
        return {
            status,
            mode,
            provider: "taric",
            ...(health.reason ? { reason: health.reason } : {}),
            checkedAt: health.checkedAt,
        }
    }

    /** Capture a host-owned event; model supplied provenance is never trusted. */
    async captureHostObservation(challengeId: string, input: Omit<TaricHostObservationInput, "eventId"> & { eventId?: string }): Promise<unknown> {
        const challenge = await this.getChallenge(challengeId)
        if (this.isAuthorizedChallenge(challenge) && (!input.workRunId || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1)) {
            throw Object.assign(new Error("authorized capture requires an active Taric WorkRun generation"), { code: "TARIC_RUN_FENCE_REQUIRED" })
        }
        const { provider, scope } = await this.getMemoryContext(challengeId)
        // DTO validation owns minimization and sensitivity rejection. Keep the
        // raw value out of the audit path; only the bounded DTO reaches Taric.
        const observation = input.observation
        const requestedEventId = input.eventId?.trim()
        const eventId = requestedEventId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestedEventId)
            ? requestedEventId
            : captureEventId(`challenge:${challengeId}`, { sourceKind: input.sourceKind, observation, targetId: input.targetId, workRunId: input.workRunId, generation: input.generation })
        if (requestedEventId && requestedEventId !== eventId) {
            await this.appendCaptureAudit(challengeId, { eventId, sourceKind: input.sourceKind, outcome: "rejected_validation", code: "invalid_event_id" })
            return { outcome: "rejected_validation", code: "invalid_event_id", eventId }
        }
        // Competition solver/attempt/report events do not necessarily have a
        // trusted Taric Resource UUID. Keep a bounded audit record instead of
        // fabricating a resource or sending a payload that the Taric schema
        // must reject. Authorized workflows call the governance adapter with
        // an already-resolved Resource and continue through the host path.
        if (!captureResourceRef(observation) || typeof observation.statement !== "string" || !observation.statement.trim() || !Array.isArray(observation.artifact_refs)) {
            await this.appendCaptureAudit(challengeId, { eventId, sourceKind: input.sourceKind, outcome: "rejected_validation", code: "host_audit_only" })
            return { outcome: "rejected_validation", code: "host_audit_only", eventId }
        }
        try {
            const result = await provider.captureObservation(scope, { ...input, eventId, observation })
            const resultOutcome = result && typeof result === "object" && "outcome" in result && typeof result.outcome === "string" ? result.outcome : "accepted"
            await this.appendCaptureAudit(challengeId, { eventId, sourceKind: input.sourceKind, outcome: resultOutcome })
            return { outcome: resultOutcome, result }
        } catch (error) {
            const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "capture_rejected"
            const outcome = error instanceof TaricUnavailableError
                ? error.dispatchState === "after_dispatch" ? "indeterminate" : "deferred"
                : error instanceof CaptureDtoError ? "rejected_validation"
                : code === "authorization_error" ? "rejected_authorization"
                    : code === "validation_error" || /required|invalid|not an approved/i.test(error instanceof Error ? error.message : "") ? "rejected_validation"
                        : "failed_permanent"
            await this.appendCaptureAudit(challengeId, { eventId, sourceKind: input.sourceKind, outcome, code })
            if (provider.mode === "taric_best_effort") return { outcome, code }
            throw error
        }
    }

    private async appendCaptureAudit(challengeId: string, record: { eventId: string; sourceKind: string; outcome: string; code?: string }): Promise<void> {
        const directory = join(await this.getRootDir(), encodeURIComponent(challengeId))
        const path = join(directory, "taric-capture-audit.ndjson")
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const sourceKind = ["tool_result", "platform_result", "host_event"].includes(record.sourceKind) ? record.sourceKind : "unknown"
        const outcome = ["accepted", "deferred", "rejected_validation", "rejected_authorization", "indeterminate", "failed_permanent"].includes(record.outcome) ? record.outcome : "failed_permanent"
        const code = record.code?.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64)
        await appendFile(path, `${JSON.stringify({ eventId: record.eventId.slice(0, 128), sourceKind, outcome, ...(code ? { code } : {}), recordedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 })
        await chmod(path, 0o600)
    }

    async captureSolverEvent(solverId: string, event: unknown): Promise<void> {
        const solver = this.runtime?.get(solverId)
        const challengeId = solver?.challengeId?.trim()
        if (!challengeId) return
        const challenge = await this.getChallenge(challengeId)
        if (challenge?.memory_mode === "legacy_local") return
        // Runtime events currently carry no host-issued WorkRun fence. A local
        // event counter cannot stand in for Taric's Attempt generation.
        if (this.isAuthorizedChallenge(challenge)) {
            this.error("challenge:capture", "authorized solver event quarantined without WorkRun provenance", undefined, { challengeId, solverId })
            return
        }
        const projectId = solver?.projectId
        const generation = (this.captureGenerations.get(solverId) ?? 0) + 1
        this.captureGenerations.set(solverId, generation)
        const sanitized = sanitizeCaptureValue(event)
        try {
            await this.captureHostObservation(challengeId, {
                eventId: captureEventId(`solver:${solverId}:${generation}`, sanitized),
                sourceKind: "tool_result",
                captureKind: "solver",
                observation: {
                    solver_id: solverId,
                    ...(projectId ? { project_id: projectId } : {}),
                    generation,
                    event: sanitized,
                },
                generation,
            })
        } catch (error) {
            if (!(error instanceof TaricUnavailableError) || (await this.getChallenge(challengeId))?.memory_mode === "taric_required") {
                this.error("challenge:capture", "host event capture failed", error, { challengeId, solverId })
            }
        }
    }

    private log(scope: string, message: string, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        if (!fields || Object.keys(fields).length === 0) {
            console.log(`${prefix} ${message}`)
            return
        }
        console.log(`${prefix} ${message} ${JSON.stringify(fields)}`)
    }

    private error(scope: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        const nextFields: Record<string, unknown> = { ...(fields ?? {}) }
        const errorMessage = extractErrorMessage(error)
        if (errorMessage) {
            nextFields.error = errorMessage
        }

        if (isNoisyChallengeApiError(errorMessage)) {
            const signature = `${scope}|${message}|${errorMessage}`
            const now = Date.now()
            const state = this.noisyErrorLogState.get(signature)
            if (state && now - state.lastLoggedAt < NOISY_ERROR_THROTTLE_WINDOW_MS) {
                state.suppressedCount += 1
                return
            }
            const suppressedCount = state?.suppressedCount ?? 0
            this.noisyErrorLogState.set(signature, { lastLoggedAt: now, suppressedCount: 0 })
            if (this.noisyErrorLogState.size > NOISY_ERROR_SIGNATURE_LIMIT) {
                const oldest = this.noisyErrorLogState.keys().next()
                if (!oldest.done) this.noisyErrorLogState.delete(oldest.value)
            }
            if (suppressedCount > 0) {
                nextFields.suppressed = suppressedCount
            }
        }

        console.error(`${prefix} ${message}${Object.keys(nextFields).length > 0 ? ` ${JSON.stringify(nextFields)}` : ""}`)
    }

    attachRuntime(runtime: RuntimeManager): void {
        this.runtime = runtime
    }

    /**
     * Recover every authorized WorkRun from canonical Taric state before any
     * Planner/Solver lifecycle read. The promise is shared so concurrent Web,
     * TUI and daemon startup paths cannot claim or reclaim the same run twice.
     */
    async recoverAuthorizedStartup(source = "challenge:startup"): Promise<AuthorizedStartupRecovery[]> {
        if (this.authorizedStartupRecovery) return this.authorizedStartupRecovery
        this.authorizedStartupRecovery = (async () => {
            const provider = this.authorizedProjectionProvider
            if (!provider) return []
            let bindings
            try {
                bindings = await provider.listBindings()
            } catch (error) {
                this.error("challenge:recovery", "failed to read authorized project bindings", error, { source })
                throw Object.assign(new Error("authorized project inventory is unavailable; governed startup is blocked"), { code: "TARIC_AUTHORIZED_PROJECTION_INCOMPLETE" })
            }
            const reports: AuthorizedStartupRecovery[] = []
            for (const binding of bindings) {
                if (!provider.recoverStartup) {
                    const report: AuthorizedStartupRecovery = { challengeId: binding.challengeId, status: "blocked", results: [], reason: "authority_recovery_unavailable" }
                    reports.push(report)
                    this.authorizedRecoveryByChallenge.set(binding.challengeId, report)
                    continue
                }
                try {
                    const results = await provider.recoverStartup(binding.challengeId)
                    const report: AuthorizedStartupRecovery = {
                        challengeId: binding.challengeId,
                        status: results.some((result) => result.status === "replan_required") ? "blocked" : "complete",
                        results,
                    }
                    reports.push(report)
                    this.authorizedRecoveryByChallenge.set(binding.challengeId, report)
                    if (report.status === "blocked") this.error("challenge:recovery", "authorized WorkRun requires replanning", undefined, { source, challengeId: binding.challengeId, results })
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    const report: AuthorizedStartupRecovery = { challengeId: binding.challengeId, status: "blocked", results: [], reason }
                    reports.push(report)
                    this.authorizedRecoveryByChallenge.set(binding.challengeId, report)
                    this.error("challenge:recovery", "authorized startup recovery failed", error, { source, challengeId: binding.challengeId })
                }
            }
            return reports
        })()
        try {
            return await this.authorizedStartupRecovery
        } catch (error) {
            this.authorizedStartupRecovery = undefined
            throw error
        }
    }

    getAuthorizedStartupRecovery(): AuthorizedStartupRecovery[] {
        return [...this.authorizedRecoveryByChallenge.values()].map((report) => ({ ...report, results: [...report.results] }))
    }

    async reloadFromConfig(): Promise<void> {
        this.api = undefined
        await this.authorizedProjectionProvider?.close?.()
        this.authorizedStartupRecovery = undefined
        this.authorizedRecoveryByChallenge.clear()
        const generated = [...this.generatedTaricProviders.values()]
        this.generatedTaricProviders.clear()
        for (const pending of generated) {
            await pending.then((provider) => provider.close?.()).catch(() => {})
        }
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
    }

    async close(): Promise<void> {
        await this.memoryProvider.close?.()
        if (this.taricMemoryProvider !== this.memoryProvider) await this.taricMemoryProvider?.close?.()
        await this.authorizedProjectionProvider?.close?.()
        const generated = [...this.generatedTaricProviders.values()]
        this.generatedTaricProviders.clear()
        for (const pending of generated) {
            await pending.then((provider) => provider.close?.()).catch(() => {})
        }
    }

    async assertSolverProjectBinding(challengeId: string, projectId?: string): Promise<void> {
        const challenge = await this.getChallenge(challengeId)
        if (!challenge) {
            if (projectId) throw new Error("solver project binding refers to an unknown challenge")
            return
        }
        if (challenge.project_classification === "trusted") {
            if (!projectId || projectId !== challenge.project_id) throw new Error("solver project binding does not match the trusted challenge project")
            return
        }
        if (projectId) throw new Error("legacy challenge cannot accept a trusted project binding")
    }

    private hasPendingAssetTargets(challenge: ChallengeInfoRecord | undefined): boolean {
        if (!challenge) return false
        const assets = challenge.assets ?? EMPTY_ASSETS
        return [...assets.urls, ...assets.ips].some((item) => item.scanned !== true)
    }

    private isPlannerEnabled(challenge: ChallengeInfoRecord | undefined): boolean {
        return challenge?.planner_enabled !== false
    }

    private hasSchedulablePendingAssetTargets(challenge: ChallengeInfoRecord | undefined): boolean {
        return this.isPlannerEnabled(challenge) && this.hasPendingAssetTargets(challenge)
    }

    private getActiveAssetClaims(challengeId: string, solvers: SolverInstance[]): Array<{ solverId: string; assetHashes: string[]; testItems: string[]; unknown: boolean; wildcardTests: boolean }> {
        return solvers
            .filter((solver) => solver.challengeId === challengeId && isClaimingSolver(solver))
            .map((solver) => {
                const assetHashes = [...extractSolverAssetHashes(solver.task)]
                const testItems = [...extractSolverTestItems(solver.task)]
                return { solverId: solver.id, assetHashes, testItems, unknown: assetHashes.length === 0, wildcardTests: testItems.length === 0 }
            })
    }

    private getAvailablePendingAssets(challenge: ChallengeInfoRecord, solvers: SolverInstance[], attempts: ChallengeAttemptLogRecord[] = [], submissions: ChallengeSubmissionLogRecord[] = []): ChallengeAssetsRecord {
        const assets = challenge.assets ?? EMPTY_ASSETS
        const normalizedAssets = assets.urls.length === 0 && assets.ips.length === 0 && (challenge.entrypoint?.length ?? 0) > 0
            ? { urls: challenge.entrypoint!.map((asset) => ({ asset, asset_hash: hashChallengeAsset(asset), scanned: false })), ips: [] }
            : assets
        const claims = this.getActiveAssetClaims(challenge.id, solvers)
        if (claims.some((claim) => claim.unknown)) return { urls: [], ips: [] }
        const historicalClaims = attempts.flatMap((attempt) => {
            const assigned = solverAssignmentFromTask(attempt.task)
            if (!assigned.assetHashes || assigned.testItems) return [assigned]
            const unreported = new Set([...assigned.assetHashes].filter((hash) => !latestSolverAssetReport(submissions, attempt.solver_id, hash)))
            return unreported.size > 0 ? [{ assetHashes: unreported }] : []
        })
        if (historicalClaims.some((claim) => claim.assetHashes === undefined)) return { urls: [], ips: [] }
        const claimedHashes = new Set([
            ...claims.filter((claim) => claim.wildcardTests).flatMap((claim) => claim.assetHashes),
            ...historicalClaims.filter((claim) => claim.testItems === undefined).flatMap((claim) => claim.assetHashes),
        ])
        return {
            urls: normalizedAssets.urls.filter((asset) => asset.scanned !== true && !claimedHashes.has(asset.asset_hash.toLowerCase())),
            ips: normalizedAssets.ips.filter((asset) => asset.scanned !== true && !claimedHashes.has(asset.asset_hash.toLowerCase())),
        }
    }

    private hasUnclaimedPendingAssetTargets(challenge: ChallengeInfoRecord | undefined, solvers: SolverInstance[], attempts: ChallengeAttemptLogRecord[] = [], submissions: ChallengeSubmissionLogRecord[] = []): boolean {
        if (!challenge || !this.isPlannerEnabled(challenge)) return false
        const available = this.getAvailablePendingAssets(challenge, solvers, attempts, submissions)
        return available.urls.length > 0 || available.ips.length > 0
    }

    private async assertUsableSolverPrompt(promptName: string): Promise<string> {
        const promptNameText = requireText(promptName, "promptName")
        const prompt = await this.config.getPrompt(promptNameText)
        if (!prompt) {
            throw new Error(`prompt not found: ${promptNameText}`)
        }
        if (prompt.meta.disabled === true) {
            throw new Error(`prompt is disabled: ${promptNameText}`)
        }
        if (prompt.meta.isSubagent === true) {
            throw new Error(`subagent prompt cannot be started as solver: ${promptNameText}`)
        }
        return promptNameText
    }

    private async hasAnyPendingAssetTargets(): Promise<boolean> {
        const activeSolvers = this.runtime
            ? (await this.runtime.listAll()).filter(isClaimingSolver)
            : []
        const challenges = await this.listChallengesSafe("challenge-planner:pending-assets-check")
        const availability = await Promise.all(challenges.map(async (challenge) => {
            const [attempts, submissions] = await Promise.all([this.listAttemptLogs(challenge.id), this.listSubmissionLogs(challenge.id)])
            return this.hasUnclaimedPendingAssetTargets(challenge, activeSolvers, attempts, submissions)
        }))
        return availability.some(Boolean)
    }

    private async hasAvailableSolverSlot(settings?: HostSettings): Promise<boolean> {
        const runtime = this.runtime
        if (!runtime) return false
        const hostSettings = settings ?? (await this.config.getHostSettings())
        const maxSolvers = clampInt(hostSettings.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS, 0, 64)
        if (maxSolvers <= 0) return false
        const activeSolvers = (await runtime.listAll()).filter(isActiveSolver)
        return activeSolvers.length < maxSolvers
    }

    private async shouldRunPlannerForPendingAssets(settings?: HostSettings): Promise<boolean> {
        for (const challenge of await this.listStoredChallenges()) {
            if (!this.isAuthorizedChallenge(challenge) && (await this.pendingSolverReviews(challenge.id)).length > 0) return true
        }
        if (!(await this.hasAnyPendingAssetTargets())) return false
        return this.hasAvailableSolverSlot(settings)
    }

    private broadcastHintToRunningSolvers(challengeId: string, hintContent: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const message = hintContent.trim()
        if (!runtime || !targetChallengeId || !message) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: `赛题提示：\n${message}`,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    private async broadcastChallengeBoardUpdateToRunningSolvers(challengeId: string, message: string): Promise<void> {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const text = message.trim()
        if (!runtime || !targetChallengeId || !text) return
        const candidates = runtime.list().filter((solver) => solver.challengeId === targetChallengeId && solver.status === "running")
        const recipients = await Promise.all(candidates.map(async (solver) => {
            try {
                return await this.isSolverTaskCompleted(targetChallengeId, solver.id) ? undefined : solver
            } catch (error) {
                this.error("challenge:memory", "failed to check solver assignment before board broadcast", error, {
                    challengeId: targetChallengeId,
                    solverId: solver.id,
                })
                return solver
            }
        }))
        for (const solver of recipients) {
            if (!solver) continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: text,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    startSyncLoop(): void {
        if (this.syncLoopStarted) return
        this.syncLoopStarted = true
        this.log("challenge:sync-loop", "starting pending-assets planner loop", { intervalMs: DEFAULT_TICK_INTERVAL_MS })
        const tick = async () => {
            const tickId = ++this.loopTickCount
            let nextIntervalMs = DEFAULT_TICK_INTERVAL_MS
            try {
                const settings = await this.config.getHostSettings()
                nextIntervalMs = resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
                // Safety sweep must run even when the planner gate is closed
                // (e.g. one solver claims every pending asset while its Observer
                // review never lands) — otherwise stalled solvers are never released.
                await this.releaseStalledSolvers().catch((error) => {
                    this.error("challenge:planner", "stalled solver release sweep failed", error)
                })
                if (await this.shouldRunPlannerForPendingAssets(settings)) {
                    await this.tickPlanner("challenge-planner:loop")
                }
            } catch (error) {
                this.error("challenge:sync-loop", "tick failed", error, { tickId })
            } finally {
                setTimeout(() => {
                    void tick()
                }, nextIntervalMs)
            }
        }
        void tick()
    }

    async tickPlanner(source = "challenge-planner:manual"): Promise<string | undefined> {
        const settings = await this.config.getHostSettings()
        resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
        if (this.plannerRunning) return

        this.plannerRunning = true
        try {
            return (await this.runPlannerOnce(source)).message || undefined
        } catch (error) {
            this.error("challenge:planner", "tick failed", error, { source })
            if (error instanceof Error && error.message.includes("Planner decision timed out")) {
                await this.recoverPendingSolverReviewStops()
            }
            return
        } finally {
            this.plannerRunning = false
            this.drainSolverReviewPlanners()
        }
    }

    private drainSolverReviewPlanners(): void {
        const challengeId = this.pendingReviewPlanners.values().next().value
        if (challengeId) this.runPlannerInBackground(challengeId, "challenge-planner:solver-review")
    }

    private runPlannerInBackground(challengeId: string | undefined, source: string): void {
        if (this.plannerRunning) return
        if (!this.runtime) return
        this.plannerRunning = true
        const scopedChallengeId = challengeId?.trim()
        const reviewing = scopedChallengeId !== undefined && this.pendingReviewPlanners.delete(scopedChallengeId)
        void (async () => {
            try {
                if (scopedChallengeId) {
                    const challenge = await this.readVisibleChallenge(scopedChallengeId)
                    await this.assertAuthorizedPlannerSolverReady(scopedChallengeId, "planner")
                    if (!challenge) return
                    const activeSolvers = this.runtime
                        ? (await this.runtime.listAll()).filter(isClaimingSolver)
                        : []
                    const [attempts, submissions] = await Promise.all([this.listAttemptLogs(challenge.id), this.listSubmissionLogs(challenge.id)])
                    if (!reviewing && !this.hasUnclaimedPendingAssetTargets(challenge, activeSolvers, attempts, submissions)) return
                } else if (!(await this.hasAnyPendingAssetTargets())) {
                    return
                }
                if (!reviewing && !(await this.hasAvailableSolverSlot())) return

                if (scopedChallengeId) await this.updateChallengePlannerStatus(scopedChallengeId, "starting")
                if (scopedChallengeId) await this.updateChallengePlannerStatus(scopedChallengeId, "running")
                const result = await this.runPlannerOnce(source, scopedChallengeId ? { challengeId: scopedChallengeId } : undefined)
                if (scopedChallengeId && result.launchedSolvers.length === 0) {
                    await this.refreshChallengePlannerStatusFromSolvers(scopedChallengeId)
                }
            } catch (error) {
                this.error("challenge:planner", "background planner failed", error, { source, challengeId: scopedChallengeId })
                if (reviewing && scopedChallengeId && error instanceof Error && error.message.includes("Planner decision timed out")) {
                    // Do not lose a review merely because the model call timed out.
                    this.pendingReviewPlanners.add(scopedChallengeId)
                    await this.recoverSafeSolverReviewStops(scopedChallengeId)
                    if ((await this.pendingSolverReviews(scopedChallengeId)).length === 0) {
                        this.pendingReviewPlanners.delete(scopedChallengeId)
                    }
                }
                if (scopedChallengeId) {
                    await this.updateChallengePlannerStatus(scopedChallengeId, "stop").catch((statusError) => {
                        this.error("challenge:planner", "failed to reset planner status", statusError, { source, challengeId: scopedChallengeId })
                    })
                }
            } finally {
                this.plannerRunning = false
                this.drainSolverReviewPlanners()
            }
        })()
    }

    async runPlannerForChallenge(challengeId: string, preferredPromptName: string): Promise<PlannerRunResult> {
        const id = requireText(challengeId, "challengeId")
        const promptName = await this.assertUsableSolverPrompt(preferredPromptName)
        if (this.plannerRunning) throw new Error("planner is already running")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (!this.isPlannerEnabled(challenge)) throw new Error(`planner is disabled for challenge "${id}"`)
        await this.assertAuthorizedPlannerSolverReady(id, "planner")

        this.plannerRunning = true
        try {
            return await this.runPlannerOnce("challenge-planner:start-solver", {
                challengeId: id,
                preferredPromptName: promptName,
            })
        } catch (error) {
            this.error("challenge:planner", "project planner failed", error, { challengeId: id, preferredPromptName: promptName })
            throw error
        } finally {
            this.plannerRunning = false
            this.drainSolverReviewPlanners()
        }
    }

    private async getRootDir(): Promise<string> {
        if (this.rootDir) return this.rootDir
        const rootDir = resolveChallengeDir()
        await ensureChallengeStoreBaseDir(rootDir)
        this.rootDir = rootDir
        return rootDir
    }

    private async readPreviousPlannerRound(challengeId?: string): Promise<PreviousPlannerRoundRecord | undefined> {
        const rootDir = await this.getRootDir()
        const fileName = challengeId?.trim() ? `planner-last-round-${sanitizePlannerRoundScope(challengeId)}.json` : "planner-last-round.json"
        const file = Bun.file(join(rootDir, fileName))
        if (!(await file.exists())) return
        try {
            return (await file.json()) as PreviousPlannerRoundRecord
        } catch {
            return
        }
    }

    private async writePreviousPlannerRound(record: PreviousPlannerRoundRecord, challengeId?: string): Promise<void> {
        const rootDir = await this.getRootDir()
        const fileName = challengeId?.trim() ? `planner-last-round-${sanitizePlannerRoundScope(challengeId)}.json` : "planner-last-round.json"
        await Bun.write(join(rootDir, fileName), JSON.stringify(record, null, 2))
    }

    private async getApi(): Promise<ChallengeApiClient> {
        if (this.api) return this.api
        const rootDir = await this.getRootDir()
        const listStored = async () => listChallengeRecords(rootDir)
        const api = ChallengeApiClient.createLocal({
                listChallenges: async () => {
                    const challenges = (await listStored()).filter((challenge) => challenge.project?.mode !== "authorized_pentest" && challenge.mode !== "authorized_pentest")
                    return {
                        current_level: challenges.reduce((max, challenge) => Math.max(max, challenge.level), 0),
                        total_challenges: challenges.length,
                        // Local report coverage is not a platform Flag/solved assertion.
                        solved_challenges: 0,
                        challenges: challenges.map(mapRecordToApiChallenge),
                    }
                },
                startChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (computeChallengeCompleted(challenge)) {
                        return { already_completed: true }
                    }
                    if (challenge.instance_status === "running") {
                        return challenge.entrypoint && challenge.entrypoint.length > 0 ? challenge.entrypoint : ["127.0.0.1:8080"]
                    }
                    const runningCount = (await listStored()).filter((item) => item.instance_status === "running" || item.instance_status === "pending").length
                    if (runningCount >= 3) {
                        throw new Error("local mode: at most 3 challenges can run at the same time")
                    }
                    const entrypoint = challenge.entrypoint && challenge.entrypoint.length > 0 ? challenge.entrypoint : ["127.0.0.1:8080"]
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "running",
                            entrypoint,
                        },
                        "challenge-api:local-start",
                    )
                    return entrypoint
                },
                stopChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running" && challenge.instance_status !== "pending") {
                        throw new Error("local mode: challenge instance is not running")
                    }
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "stopped",
                            entrypoint: null,
                        },
                        "challenge-api:local-stop",
                    )
                    return null
                },
                getHint: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running") {
                        throw new Error("local mode: challenge instance is not running")
                    }
                    if (!challenge.hint_viewed) {
                        await saveChallengeRecord(
                            rootDir,
                            {
                                ...challenge,
                                hint_viewed: true,
                            },
                            "challenge-api:local-hint",
                        )
                    }
                    return {
                        code,
                        hint_content: challenge.hint_content ?? null,
                    }
                },
            })
        this.api = api
        return api
    }

    private async readVisibleChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        const id = requireText(challengeId, "challengeId")
        const projected = await this.authorizedProjectionProvider?.read(id)
        if (projected) return projected.challenge
        const local = await readChallengeRecord(await this.getRootDir(), id)
        if (this.authorizedProjectionProvider && this.isAuthorizedChallenge(local)) throw Object.assign(new Error("authorized project discovery binding is unavailable; local challenge state cannot supply authority"), { code: "TARIC_AUTHORIZED_BINDING_REQUIRED" })
        return local
    }

    private async getContext(): Promise<{ api: ChallengeApiClient; rootDir: string }> {
        const api = await this.getApi()
        const rootDir = await this.getRootDir()
        return { api, rootDir }
    }

    async listChallenges(source = "challenge-api:list"): Promise<ChallengeListResult> {
        const { api, rootDir } = await this.getContext()
        const remote = await api.listChallenges()
        const authorizedBindings = await this.authorizedProjectionProvider?.listBindings() ?? []
        const authorizedIds = new Set(authorizedBindings.map((binding) => binding.challengeId))
        for (const challenge of remote.challenges) {
            const next = mapApiChallengeToRecord(challenge)
            if (authorizedIds.has(next.id)) continue
            const existing = await readChallengeRecord(rootDir, next.id)
            await saveChallengeRecord(
                rootDir,
                {
                    ...next,
                    // Remote challenge payloads do not carry the host-trusted project binding.
                    // Preserve it across every sync so a refresh cannot silently downgrade a
                    // Taric-bound project to the legacy provider.
                    ...(existing?.project ? { project: existing.project, project_classification: existing.project_classification } : {}),
                    assets_url: hasAssetItems(next.assets_url) ? next.assets_url : existing?.assets_url ?? null,
                    assets_ip: hasAssetItems(next.assets_ip) ? next.assets_ip : existing?.assets_ip ?? null,
                    assets: existing?.assets ?? next.assets,
                    planner_prompt: existing?.planner_prompt ?? next.planner_prompt ?? null,
                    planner_enabled: existing?.planner_enabled ?? next.planner_enabled ?? true,
                    planner_status: existing?.planner_status ?? next.planner_status ?? "stop",
                    hint_viewed: existing?.hint_viewed === true || next.hint_viewed,
                    hint_content: existing?.hint_content ?? next.hint_content,
                },
                source,
            )
            if (!computeChallengeCompleted(existing) && computeChallengeCompleted(next)) {
                void this.finishChallenge(next.id)
            }
        }
        const local = await this.listStoredChallenges()
        return {
            remote,
            local,
            summary: {
                remote: remote.challenges.length,
                local: local.length,
                solved: remote.solved_challenges,
                platform_solved: remote.solved_challenges,
                reports_completed: local.filter((challenge) => computeChallengeCompleted(challenge)).length,
                total: remote.total_challenges,
            },
        }
    }

    async listChallengesSafe(_source = "challenge-api:list"): Promise<ChallengeInfoRecord[]> {
        return this.listStoredChallenges()
    }

    async listStoredChallenges(): Promise<ChallengeInfoRecord[]> {
        const rootDir = await this.getRootDir()
        const local = await listChallengeRecords(rootDir)
        if (!this.authorizedProjectionProvider) return local
        const bindings = await this.authorizedProjectionProvider.listBindings()
        const projects = await Promise.all(bindings.map((binding) => this.authorizedProjectionProvider!.read(binding.challengeId)))
        if (projects.some((projection) => !projection)) throw Object.assign(new Error("authorized project reconstruction is incomplete"), { code: "TARIC_AUTHORIZED_PROJECTION_INCOMPLETE" })
        const ids = new Set(bindings.map((binding) => binding.challengeId))
        if (local.some((challenge) => this.isAuthorizedChallenge(challenge) && !ids.has(challenge.id))) throw Object.assign(new Error("authorized project discovery binding is unavailable"), { code: "TARIC_AUTHORIZED_BINDING_REQUIRED" })
        return [...local.filter((challenge) => !ids.has(challenge.id)), ...projects.map((projection) => projection!.challenge)]
    }

    async createChallenge(challenge: ChallengeRecord, source = "manual"): Promise<ChallengeInfoRecord | undefined> {
        if (challenge.project?.mode === "authorized_pentest") {
            if (!this.authorizedProjectionProvider) throw new Error("authorized project creation requires a Taric projection provider")
            await this.authorizedProjectionProvider.registerFromManifest({ challengeId: challenge.id, title: challenge.title, project: challenge.project })
            return (await this.authorizedProjectionProvider.read(challenge.id))?.challenge
        }
        const rootDir = await this.getRootDir()
        await saveChallengeRecord(rootDir, challenge, source)
        const created = await this.readVisibleChallenge(challenge.id)
        if (this.hasSchedulablePendingAssetTargets(created)) {
            this.runPlannerInBackground(created?.id, "challenge-planner:challenge-created")
        }
        return created
    }

    async createChallengeFromInput(input: CreateChallengeInput, source = "manual"): Promise<ChallengeInfoRecord | undefined> {
        const id = crypto.randomUUID().slice(0, 8)
        const bound = await this.applyDefaultProjectBinding({ ...input, id })
        return this.createChallenge(createChallengeRecord(bound), source)
    }

    /**
     * Local deployments bind every new challenge to a trusted taric_best_effort
     * project unless the request opts out with memory_mode=legacy_local or a
     * project is supplied explicitly. A missing gateway degrades to the
     * unbound legacy_local flow instead of failing the challenge.
     */
    private async applyDefaultProjectBinding(input: CreateChallengeInput & { id: string }): Promise<CreateChallengeInput & { id: string }> {
        if (input.project !== undefined || input.memory_mode === "legacy_local") return input
        const gateway = getLocalTaricGatewayRuntime()
        if (!gateway?.engagementId) return input
        const taricSettings = (await this.config.getHostSettings()).taric
        if (taricSettings?.enabled !== true) return input
        const project: Project = {
            mode: "competition",
            provider: "local_practice",
            tenant_id: "local",
            platform_id: "breachweave-local",
            competition_id: "local-practice",
            team_id: "default",
            challenge_code: input.id,
            memory_mode: "taric_best_effort",
            taric_engagement_id: gateway.engagementId,
        }
        return { ...input, project }
    }


    async updateChallengePlannerPrompt(challengeId: string, plannerPrompt: string | null): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized planner settings are projected from Taric and cannot be stored locally"), { code: "TARIC_AUTHORITY_REQUIRED" })
        await saveChallengeRecord(
            rootDir,
            {
                ...challenge,
                planner_prompt: plannerPrompt?.trim() || null,
            },
            "challenge:planner-prompt",
        )
        const updated = await this.readVisibleChallenge(id)
        if (!updated) throw new Error(`challenge "${id}" not found`)
        return updated
    }

    async updateChallengePlannerStatus(challengeId: string, plannerStatus: ChallengePlannerStatus): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        if (plannerStatus !== "starting" && plannerStatus !== "running" && plannerStatus !== "stop" && plannerStatus !== "disabled") {
            throw new Error(`plannerStatus is invalid: ${plannerStatus}`)
        }
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (this.isAuthorizedChallenge(challenge)) {
            if (plannerStatus === "starting" || plannerStatus === "running") {
                if (!this.authorizedProjectionProvider?.prepareLifecycle) throw Object.assign(new Error("authorized planner lifecycle requires an authority projection provider"), { code: "TARIC_AUTHORITY_REQUIRED" })
                await this.assertAuthorizedPlannerSolverReady(id, "planner")
                return (await this.readVisibleChallenge(id)) ?? challenge
            }
            return challenge
        }
        if (plannerStatus === "starting" || plannerStatus === "running") await this.assertAuthorizedPlannerSolverReady(id, "planner")
        const nextStatus: ChallengePlannerStatus = challenge.planner_enabled === false ? "disabled" : plannerStatus === "disabled" ? "stop" : plannerStatus
        await saveChallengeRecord(
            rootDir,
            {
                ...challenge,
                planner_status: nextStatus,
            },
            "challenge:planner-status",
        )
        const updated = await this.readVisibleChallenge(id)
        if (!updated) throw new Error(`challenge "${id}" not found`)
        return updated
    }

    async updateChallengePlannerEnabled(challengeId: string, enabled: boolean): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized planner readiness is projected from Taric"), { code: "TARIC_AUTHORITY_REQUIRED" })
        await saveChallengeRecord(
            rootDir,
            {
                ...challenge,
                planner_enabled: enabled,
                planner_status: enabled ? "stop" : "disabled",
            },
            "challenge:planner-enabled",
        )
        const updated = await this.readVisibleChallenge(id)
        if (!updated) throw new Error(`challenge "${id}" not found`)
        if (this.hasSchedulablePendingAssetTargets(updated)) {
            this.runPlannerInBackground(id, "challenge-planner:planner-enabled")
        }
        return updated
    }

    async updateChallengeAssetScanned(challengeId: string, group: "urls" | "ips", asset: string, scanned: boolean): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const targetAsset = requireText(asset, "asset")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (challenge.project?.mode === "authorized_pentest" || challenge.mode === "authorized_pentest") {
            throw Object.assign(new Error("authorized projects require the Taric Coverage API; competition scanned state cannot be written"), { code: "COMPLETION_DOMAIN_MISMATCH" })
        }
        const assets = challenge.assets ?? EMPTY_ASSETS
        const items = assets[group]
        if (!items.some((item) => item.asset === targetAsset)) {
            throw new Error(`asset "${targetAsset}" not found in ${group}`)
        }
        await saveChallengeRecord(
            rootDir,
            {
                ...challenge,
                assets: {
                    ...assets,
                    [group]: items.map((item) => (item.asset === targetAsset ? { ...item, scanned } : item)),
                },
            },
            "challenge:asset-scanned",
        )
        const updated = await this.readVisibleChallenge(id)
        if (!updated) throw new Error(`challenge "${id}" not found`)
        if (this.hasSchedulablePendingAssetTargets(updated)) {
            this.runPlannerInBackground(id, "challenge-planner:asset-updated")
        }
        return updated
    }

    async refreshChallengePlannerStatusFromSolvers(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) return
        if (!this.isPlannerEnabled(challenge)) {
            return challenge.planner_status === "disabled" ? challenge : this.updateChallengePlannerStatus(id, "disabled")
        }
        const runtime = this.runtime
        if (!runtime) return challenge

        const solvers = await runtime.listAll()
        const hasActiveSolver = solvers.some((solver) => solver.challengeId === id && isActiveSolver(solver))
        const nextStatus: ChallengePlannerStatus = hasActiveSolver ? "running" : "stop"
        if (challenge.planner_status === nextStatus) return challenge
        return this.updateChallengePlannerStatus(id, nextStatus)
    }

    async getChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        return this.readVisibleChallenge(challengeId)
    }

    async dryRunLegacyMigration(): Promise<LegacyMigrationReport> {
        return dryRunLegacyMigration(await this.getRootDir())
    }

    async archiveLegacyUnclassified(report: LegacyMigrationReport, challengeIds: readonly string[]): Promise<LegacyArchiveResult> {
        return archiveLegacyUnclassified(report, challengeIds, resolveArchiveChallengeDir())
    }

    async startChallenge(challengeId: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const id = requireText(challengeId, "challengeId")
        const existing = this.challengeStartFlights.get(id)
        if (existing) return existing
        const flight = this.startChallengeInternal(id)
        this.challengeStartFlights.set(id, flight)
        try {
            return await flight
        } finally {
            if (this.challengeStartFlights.get(id) === flight) this.challengeStartFlights.delete(id)
        }
    }

    private async startChallengeInternal(id: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const current = await this.getChallenge(id)
        if (this.isAuthorizedChallenge(current)) {
            await this.assertAuthorizedPlannerSolverReady(id, "solver")
            await this.assertRequiredMemoryAvailable(id)
            const challenge = await this.getChallenge(id)
            if (!challenge) throw new Error(`challenge "${id}" not found`)
            return { remote: challenge.entrypoint ?? [], challenge, is_completed: computeChallengeCompleted(challenge) }
        }
        await this.assertRequiredMemoryAvailable(id)
        const { api } = await this.getContext()
        this.log("challenge:start", "starting challenge instance", { challengeId: id })
        const remote = await api.startChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:start")
        this.log("challenge:start", "challenge instance started", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            entrypoint: challenge?.entrypoint ?? null,
            alreadyCompleted: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async stopChallenge(challengeId: string): Promise<ChallengeActionResult<null>> {
        const id = requireText(challengeId, "challengeId")
        if (this.isAuthorizedChallenge(await this.getChallenge(id))) {
            throw Object.assign(new Error("authorized Work lifecycle is owned by Taric; the competition stop API is not applicable"), { code: "COMPLETION_DOMAIN_MISMATCH" })
        }
        const { api } = await this.getContext()
        this.log("challenge:stop", "stopping challenge instance", { challengeId: id })
        const remote = await api.stopChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:stop")
        this.log("challenge:stop", "challenge instance stopped", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            completed: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async submitReport(challengeId: string, input: { assetHash: string; report: string; testResults?: ChallengeTestResult[]; discoveries?: string[] } & ChallengeSubmissionMeta): Promise<ChallengeReportResult> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const assetHash = requireText(input.assetHash, "assetHash")
        const report = requireText(input.report, "report")
        const current = await this.readVisibleChallenge(id)
        if (!current) throw new Error(`challenge "${id}" not found`)
        if (current.project?.mode === "authorized_pentest" || current.mode === "authorized_pentest") {
            throw Object.assign(new Error("authorized reports require an authority-backed report snapshot and close decision"), { code: "COMPLETION_DOMAIN_MISMATCH" })
        }
        await this.assertRequiredMemoryAvailable(challengeId)
        const assets = current.assets ?? EMPTY_ASSETS
        const match = findAssetByHash(assets, assetHash)
        if (!match) {
            throw new Error(`asset hash "${assetHash}" not found`)
        }
        const attempts = await this.listAttemptLogs(id)
        const assignment = input.solverId ? attempts.findLast((attempt) => attempt.solver_id === input.solverId) : undefined
        const assignedHashes = extractSolverAssetHashes(assignment?.task)
        const assignedTests = extractSolverTestItems(assignment?.task)
        if (assignedHashes.size > 0 && !assignedHashes.has(assetHash)) {
            throw new Error(`asset hash "${assetHash}" is outside this solver assignment`)
        }
        const testResults = input.testResults?.map((item) => ({
            test_item: requireText(item.test_item, "test_results.test_item"),
            status: item.status,
            evidence: requireText(item.evidence, "test_results.evidence"),
        }))
        if (testResults?.some((item) => item.status !== "completed" && item.status !== "blocked")) {
            throw new Error("test_results.status must be completed or blocked")
        }
        if (assignedTests.size > 0) {
            const missing = [...assignedTests].filter((item) => !testResults?.some((result) => result.test_item === item))
            if (missing.length > 0) throw new Error(`test_results must cover every assigned test item, including blocked items: ${missing.join(", ")}`)
            if (testResults?.some((item) => !assignedTests.has(item.test_item))) throw new Error("test_results contains an unassigned test item; report extra findings in discoveries")
        }
        if (new Set(testResults?.map((item) => item.test_item)).size !== (testResults?.length ?? 0)) {
            throw new Error("test_results contains duplicate test items")
        }
        const discoveries = input.discoveries?.map((item) => requireText(item, "discoveries"))

        this.log("challenge:submit", "submitting report", {
            challengeId: id,
            assetHash,
            asset: match.asset.asset,
            solverId: input.solverId,
            promptName: input.promptName,
            modelName: input.modelName,
        })

        const submission = await appendChallengeSubmissionLog(rootDir, {
            challengeId: id,
            ...(current.project_id ? { projectId: current.project_id } : {}),
            solverId: input.solverId,
            promptName: input.promptName,
            modelName: input.modelName,
            assetHash,
            asset: match.asset.asset,
            report,
            testResults,
            discoveries,
        })
        await this.captureHostEventBestEffort(id, {
            sourceKind: "platform_result",
            captureKind: "report",
            observation: {
                event_type: "report_submitted",
                asset_hash: assetHash,
                asset: match.asset.asset,
                report,
                submission_id: submission.id,
            },
        })
        const submissions = await this.listSubmissionLogs(id)
        const requiredTests = new Set(attempts.filter((attempt) => extractSolverAssetHashes(attempt.task).has(assetHash)).flatMap((attempt) => [...extractSolverTestItems(attempt.task)]))
        const completedTests = completedAssetTestItems(submissions, assetHash)
        const allAssignedTestsCompleted = [...requiredTests].every((item) => completedTests.has(item))
        const needsPlannerReview = assignment !== undefined || submissions.some((item) => item.asset_hash === assetHash && (item.discoveries?.length ?? 0) > 0)
        const wasScanned = match.asset.scanned
        const scanned = allAssignedTestsCompleted && !needsPlannerReview
        let challenge = current
        if (wasScanned !== scanned) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...current,
                    assets: {
                        ...assets,
                        [match.group]: assets[match.group].map((item) => item.asset_hash === assetHash ? { ...item, scanned } : item),
                    },
                },
                "challenge:asset-scanned",
            )
            const updated = await this.readVisibleChallenge(id)
            if (!updated) throw new Error(`challenge "${id}" not found`)
            challenge = updated
        }
        if (!input.solverId && this.hasSchedulablePendingAssetTargets(challenge)) this.runPlannerInBackground(id, "challenge-planner:report-submitted")
        const nextAssets = challenge.assets ?? EMPTY_ASSETS
        const assetsTotal = countTotalAssets(nextAssets)
        const assetsScanned = countScannedAssets(nextAssets)
        const assetsPending = countPendingAssets(nextAssets)
        const assetsCompleted = computeChallengeCompleted(challenge)

        this.log("challenge:submit", "report submission finished", {
            challengeId: id,
            assetHash,
            asset: match.asset.asset,
            assets: `${assetsScanned}/${assetsTotal}`,
            completed: assetsCompleted,
        })
        if (assetsCompleted) {
            await this.finishChallenge(id)
        }
        return {
            submission,
            challenge,
            assets_total: assetsTotal,
            assets_scanned: assetsScanned,
            assets_pending: assetsPending,
            assets_completed: assetsCompleted,
            solver_task_completed: input.solverId ? await this.isSolverTaskCompleted(id, input.solverId) : false,
        }
    }

    async getHint(challengeId: string): Promise<ChallengeActionResult<ChallengeApiHintData>> {
        const { api, rootDir } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:hint", "requesting hint", { challengeId: id })
        const remote = await api.getHint(id)
        const current = await this.readVisibleChallenge(id)
        if (current) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...current,
                    hint_viewed: true,
                    hint_content: remote.hint_content,
                },
                "challenge-api:hint-content",
            )
        }
        const challenge = await this.syncChallenge(id, "challenge-api:hint")
        this.log("challenge:hint", "hint received", {
            challengeId: id,
            hintViewed: challenge?.hint_viewed === true,
            hasHintContent: Boolean(remote.hint_content?.trim()),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async isChallengeCompleted(challengeId: string): Promise<boolean> {
        const challenge = await this.readVisibleChallenge(challengeId)
        return computeChallengeCompleted(challenge)
    }

    async isSolverTaskCompleted(challengeId: string, solverId: string): Promise<boolean> {
        return (await this.getSolverReviewContext(challengeId, solverId)).solver_task_completed
    }

    async getSolverReviewContext(challengeId: string, solverId: string) {
        const attempts = await this.listAttemptLogs(challengeId)
        const attempt = attempts.findLast((item) => item.solver_id === solverId)
        const task = attempt?.task ?? ""
        const hashes = extractSolverAssetHashes(task)
        const submissions = await this.listSubmissionLogs(challengeId)
        const latest = [...hashes].map((hash) => latestSolverAssetReport(submissions, solverId, hash))
            .filter((item): item is ChallengeSubmissionLogRecord => item !== undefined)
        const submissionIds = latest.map((item) => item.id).sort()
        const reviews = (await this.listSolverReviews(challengeId)).filter((item) => item.solver_id === solverId)
        const current = reviews.findLast((item) => item.assignment_id === attempt?.id && sameSubmissionIds(item.submission_ids, submissionIds))
        const tests = extractSolverTestItems(task)
        const covered = hashes.size > 0 && [...hashes].every((hash) => hasReportedAssignment(latest.find((report) => report.asset_hash === hash), tests, false))
        return {
            task,
            assignment_id: attempt?.id ?? "",
            submissions: latest,
            submission_ids: submissionIds,
            review_required: covered && current === undefined,
            solver_task_completed: covered && current?.decision?.action !== "continue",
            solver_review_pending: covered && current?.decision === undefined,
            solver_resume_required: current?.decision?.action === "continue",
            solver_stop_approved: current?.decision?.action === "stop",
            current_review: current,
        }
    }

    async listSolverReviews(challengeId: string): Promise<SolverReviewRecord[]> {
        return listSolverReviews(await this.getRootDir(), challengeId)
    }

    private async pendingSolverReviews(challengeId: string): Promise<SolverReviewRecord[]> {
        const reviews = (await this.listSolverReviews(challengeId)).filter((item) => !item.decision)
        const current = await Promise.all(reviews.map(async (review) => {
            const context = await this.getSolverReviewContext(challengeId, review.solver_id)
            return context.current_review?.id === review.id ? review : undefined
        }))
        return current.filter((review): review is SolverReviewRecord => review !== undefined)
    }

    async submitSolverReview(challengeId: string, solverId: string, submissionIds: string[], review: SolverAssignmentReview): Promise<SolverReviewRecord> {
        return this.withSolverReviewLock(challengeId, solverId, () => this.saveSolverAssignmentReview(challengeId, solverId, submissionIds, review))
    }

    private async withSolverReviewLock<T>(challengeId: string, solverId: string, action: () => Promise<T>): Promise<T> {
        const key = JSON.stringify([challengeId, solverId])
        const previous = this.solverReviewMutations.get(key) ?? Promise.resolve()
        let release!: () => void
        const pending = new Promise<void>((resolve) => { release = resolve })
        this.solverReviewMutations.set(key, pending)
        await previous
        try {
            return await action()
        } finally {
            release()
            if (this.solverReviewMutations.get(key) === pending) this.solverReviewMutations.delete(key)
        }
    }

    private async saveSolverAssignmentReview(challengeId: string, solverId: string, submissionIds: string[], review: SolverAssignmentReview): Promise<SolverReviewRecord> {
        const context = await this.getSolverReviewContext(challengeId, solverId)
        if (!sameSubmissionIds(context.submission_ids, submissionIds)) throw new Error("solver reports changed during Observer review")
        if (context.current_review) return context.current_review
        if (!context.review_required) throw new Error("solver has not reported every assigned asset and test item")
        const hashes = extractSolverAssetHashes(context.task)
        const tests = extractSolverTestItems(context.task)
        const keys = new Set<string>()
        for (const item of review.checklist) {
            if (!hashes.has(item.asset_hash) || (tests.size > 0 && !tests.has(item.test_item))) throw new Error("Observer reviewed an unassigned item")
            const key = `${item.asset_hash}\n${item.test_item}`
            if (keys.has(key)) throw new Error("Observer checklist contains duplicate items")
            keys.add(key)
        }
        for (const hash of hashes) {
            if (tests.size === 0 && !review.checklist.some((item) => item.asset_hash === hash)) throw new Error("Observer checklist omits an assigned asset")
            for (const test of tests) {
                if (!keys.has(`${hash}\n${test}`)) throw new Error("Observer checklist omits an assigned test item")
            }
        }
        const record: SolverReviewRecord = {
            id: hashChallengeAsset(JSON.stringify([solverId, context.assignment_id, ...context.submission_ids])), challenge_id: challengeId, solver_id: solverId,
            assignment_id: context.assignment_id,
            submission_ids: context.submission_ids, review, created_at: new Date().toISOString(),
        }
        await saveSolverReview(await this.getRootDir(), record)
        this.requestSolverReviewPlanner(challengeId)
        return record
    }

    requestSolverReviewPlanner(challengeId: string): void {
        this.pendingReviewPlanners.add(challengeId)
        this.runPlannerInBackground(challengeId, "challenge-planner:solver-review")
    }

    private async recoverSafeSolverReviewStops(challengeId: string): Promise<void> {
        const reviews = await this.pendingSolverReviews(challengeId)
        for (const record of reviews) {
            const review = record.review
            const safeToStop = review.suggested_decision === "stop"
                && review.checklist.every((item) => item.verdict === "verified" || item.verdict === "blocked")
            if (!safeToStop) continue
            try {
                await this.decideSolverReview(
                    challengeId,
                    record.id,
                    "stop",
                    "Planner timed out; the Observer audit passed the stop policy checks, so the reviewed solver was released.",
                )
            } catch (error) {
                this.error("challenge:planner", "failed to recover an audited solver after planner timeout", error, {
                    challengeId,
                    reviewId: record.id,
                    solverId: record.solver_id,
                })
            }
        }
    }

    private async recoverPendingSolverReviewStops(): Promise<void> {
        const challengeIds = new Set(this.pendingReviewPlanners)
        for (const challenge of await this.listStoredChallenges()) {
            if (this.isAuthorizedChallenge(challenge)) continue
            if ((await this.pendingSolverReviews(challenge.id)).length > 0) challengeIds.add(challenge.id)
        }
        for (const challengeId of challengeIds) {
            await this.recoverSafeSolverReviewStops(challengeId)
            if ((await this.pendingSolverReviews(challengeId)).length === 0) this.pendingReviewPlanners.delete(challengeId)
        }
    }

    /**
     * Periodic safety sweep:
     * - Solvers still active for a challenge record that no longer exists are
     *   stopped and archived (their host bridge is already dead).
     * - A solver that fully reported its assignment but whose Observer review
     *   never lands (e.g. the observer keeps timing out) is released after the
     *   grace period via a degraded fallback review + stop decision.
     */
    private async releaseStalledSolvers(): Promise<void> {
        const runtime = this.runtime
        if (!runtime || typeof runtime.listAll !== "function") return
        const activeSolvers = (await runtime.listAll()).filter((solver) => typeof solver.challengeId === "string" && solver.challengeId.trim().length > 0 && isClaimingSolver(solver))
        const solversByChallenge = new Map<string, SolverInstance[]>()
        for (const solver of activeSolvers) {
            const group = solversByChallenge.get(solver.challengeId!) ?? []
            group.push(solver)
            solversByChallenge.set(solver.challengeId!, group)
        }
        for (const [challengeId, solvers] of solversByChallenge) {
            const challenge = await this.getChallenge(challengeId).catch(() => undefined)
            if (!challenge) {
                for (const solver of solvers) {
                    try {
                        await runtime.stopSolver(solver.id)
                        await runtime.deleteSolver(solver.id)
                        this.log("challenge:planner", "reaped solver of removed challenge", { challengeId, solverId: solver.id })
                    } catch (error) {
                        this.error("challenge:planner", "failed to reap solver of removed challenge", error, { challengeId, solverId: solver.id })
                    }
                }
                continue
            }
            for (const solver of solvers) {
                // A live container this daemon no longer controls (e.g. after a
                // restart) can never report or receive commands; reap it once it
                // is clearly past its launch window.
                const managed = typeof runtime.isManaged === "function" ? runtime.isManaged(solver.id) : true
                if (!managed && Date.now() - solver.createdAt > UNMANAGED_SOLVER_REAP_AFTER_MS) {
                    try {
                        await runtime.stopSolver(solver.id)
                        await runtime.deleteSolver(solver.id)
                        this.log("challenge:planner", "reaped unmanaged solver container", { challengeId, solverId: solver.id })
                    } catch (error) {
                        this.error("challenge:planner", "failed to reap unmanaged solver", error, { challengeId, solverId: solver.id })
                    }
                    continue
                }
                if (this.isAuthorizedChallenge(challenge)) continue
                try {
                    const context = await this.getSolverReviewContext(challengeId, solver.id)
                    if (!context.review_required) continue
                    const lastSubmissionAt = Math.max(0, ...context.submissions.map((submission) => parseTimestamp(submission.created_at) ?? 0))
                    if (Date.now() - lastSubmissionAt < SOLVER_REVIEW_RELEASE_GRACE_MS) continue
                    const review = buildFallbackAssignmentReview(context.task, context.submissions)
                    const record = await this.submitSolverReview(challengeId, solver.id, context.submission_ids, review)
                    await this.decideSolverReview(challengeId, record.id, "stop", "Observer 审查在宽限期内未完成；宿主按自报结果降级收尾并释放该分工。")
                    this.log("challenge:planner", "released solver with stalled observer review", { challengeId, solverId: solver.id, lastSubmissionAgoMs: Date.now() - lastSubmissionAt })
                } catch (error) {
                    this.error("challenge:planner", "stalled solver review release failed", error, { challengeId, solverId: solver.id })
                }
            }
        }
    }

    async decideSolverReview(challengeId: string, reviewId: string, action: "continue" | "stop", rationale: string, instructions?: string): Promise<void> {
        const record = (await this.listSolverReviews(challengeId)).find((item) => item.id === reviewId)
        if (!record) throw new Error("Observer review not found")
        return this.withSolverReviewLock(challengeId, record.solver_id, () => this.applySolverReviewDecision(challengeId, reviewId, action, rationale, instructions))
    }

    private async applySolverReviewDecision(challengeId: string, reviewId: string, action: "continue" | "stop", rationale: string, instructions?: string): Promise<void> {
        const runtime = this.getRuntime()
        if (!runtime) throw new Error("runtime is not attached")
        const record = (await this.listSolverReviews(challengeId)).find((item) => item.id === reviewId)
        if (!record) throw new Error("Observer review not found")
        const context = await this.getSolverReviewContext(challengeId, record.solver_id)
        if (context.current_review?.id !== reviewId) throw new Error("Observer review is stale; review the latest reports")
        if (record.decision && record.decision.action !== action) throw new Error("review already has a different Planner decision")
        if (action === "stop" && (record.review.suggested_decision !== "stop" || record.review.checklist.some((item) => item.verdict === "missing" || item.verdict === "unsupported"))) {
            throw new Error("Observer found incomplete or unsupported work; continue this solver with specific corrections")
        }
        if (action === "stop" && record.review.checklist.some((item) => {
            const report = context.submissions.find((submission) => submission.asset_hash === item.asset_hash)
            const result = report?.test_results?.find((result) => result.test_item === item.test_item)
            return result !== undefined && ((item.verdict === "blocked") !== (result.status === "blocked"))
        })) throw new Error("Observer evidence contradicts reported completion status; continue this solver to correct the report")
        const solver = (await runtime.listAll()).find((item) => item.id === record.solver_id && item.challengeId === challengeId)
        if (!solver) throw new Error("reviewed solver not found")
        const reason = requireText(rationale, "rationale")
        if (action === "continue") requireText(instructions, "instructions")
        record.decision ??= { action, rationale: reason, ...(instructions ? { instructions } : {}), decided_at: new Date().toISOString() }
        await saveSolverReview(await this.getRootDir(), record)
        if (action === "stop") {
            // Include solvers stuck in "stopping": their containers may still be alive.
            if (isClaimingSolver(solver)) await runtime.stopSolver(record.solver_id)
        } else {
            runtime.sendCommand(record.solver_id, {
                type: "resume_assignment", reviewId,
                message: `Planner 审核决定：继续原分工。\n审核结论：${record.review.summary}\n问题：${record.review.concerns.join("；")}\n遗留待办：${record.review.remaining_work.join("；")}\n整改要求：${instructions}\n只补做原分工中的遗漏、无证据或未完成项，保留已有有效证据；完成后重新提交报告接受复审。`,
            })
        }
    }

    async appendMemory(input: AddMemoryInput): Promise<MemoryEntry> {
        const { provider, scope } = await this.getMemoryContext(input.challengeId)
        const { challengeId: _challengeId, ...memoryInput } = input
        const entry = await provider.appendMemory(scope, memoryInput)
        await this.broadcastChallengeBoardUpdateToRunningSolvers(input.challengeId, formatChallengeMemoryBroadcastMessage("added", entry))
        return entry
    }

    async listMemory(challengeId: string): Promise<MemoryEntry[]> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        return provider.listMemory(scope)
    }

    async readMemoryBoard(challengeId: string): Promise<{ memory: MemoryEntry[]; ideas: IdeaRecord[]; diagnostics?: unknown }> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        if (provider.readBoard) return provider.readBoard(scope)
        const [memory, ideas] = await Promise.all([provider.listMemory(scope), provider.listIdeas(scope)])
        return { memory, ideas, diagnostics: provider.getReadDiagnostics?.() }
    }

    async getMemoryReadDiagnostics(challengeId: string): Promise<unknown> {
        const { provider } = await this.getMemoryContext(challengeId)
        return provider.getReadDiagnostics?.() ?? null
    }

    async updateMemory(challengeId: string, entryIdOrPrefix: string, patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string }): Promise<MemoryEntry> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        const entry = await provider.updateMemory(scope, entryIdOrPrefix, patch)
        await this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("updated", entry))
        return entry
    }

    async deleteMemory(challengeId: string, entryIdOrPrefix: string): Promise<MemoryEntry> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        const entry = await provider.deleteMemory(scope, entryIdOrPrefix)
        await this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("deleted", entry))
        return entry
    }

    async listIdeas(challengeId: string): Promise<IdeaRecord[]> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        return provider.listIdeas(scope)
    }

    async searchIdeas(challengeId: string, query: string): Promise<IdeaRecord[]> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        return provider.searchIdeas(scope, query)
    }

    async addIdea(challengeId: string, input: AddIdeaInput): Promise<AddIdeaResult> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        const result = await provider.addIdea(scope, input)
        if (result.created) {
            await this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("added", result.item))
        }
        return result
    }

    async updateIdea(challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        const item = await provider.updateIdea(scope, ideaIdOrPrefix, patch)
        await this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("updated", item))
        return item
    }

    async deleteIdea(challengeId: string, ideaIdOrPrefix: string): Promise<IdeaRecord> {
        const { provider, scope } = await this.getMemoryContext(challengeId)
        const item = await provider.deleteIdea(scope, ideaIdOrPrefix)
        await this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("deleted", item))
        return item
    }

    async appendAttemptLog(input: { challengeId: string; solverId: string; promptName: string; task: string }) {
        if (this.isAuthorizedChallenge(await this.getChallenge(input.challengeId))) {
            throw Object.assign(new Error("authorized attempts require an authority-backed WorkRun and cannot be written to the local attempt index"), { code: "TARIC_AUTHORITY_REQUIRED" })
        }
        const rootDir = await this.getRootDir()
        const challenge = await this.getChallenge(input.challengeId)
        const record = await appendChallengeAttemptLog(rootDir, {
            ...input,
            ...(challenge?.project_id ? { projectId: challenge.project_id } : {}),
        })
        await this.captureHostEventBestEffort(input.challengeId, {
            sourceKind: "host_event",
            captureKind: "attempt",
            observation: {
                event_type: "attempt_started",
                attempt_id: record.id,
                solver_id: input.solverId,
                prompt_name: input.promptName,
                task: input.task,
            },
        })
        return record
    }

    private async captureHostEventBestEffort(challengeId: string, input: Omit<TaricHostObservationInput, "eventId">): Promise<void> {
        if ((await this.getChallenge(challengeId))?.memory_mode === "legacy_local") return
        try {
            await this.captureHostObservation(challengeId, input)
        } catch (error) {
            const mode = (await this.getChallenge(challengeId))?.memory_mode
            if (mode === "taric_required" || !(error instanceof TaricUnavailableError)) {
                this.error("challenge:capture", "host event capture failed", error, { challengeId, sourceKind: input.sourceKind })
            }
        }
    }

    async listAttemptLogs(challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
        const projection = await this.getAuthorizedProjection(challengeId)
        if (projection) return projection.attempts
        const rootDir = await this.getRootDir()
        const challenge = await this.getChallenge(challengeId)
        if (this.authorizedProjectionProvider && this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized attempt index is unavailable from Taric authority"), { code: "TARIC_AUTHORITY_REQUIRED" })
        return listChallengeAttemptLogs(rootDir, challengeId, challenge?.project_id)
    }

    async listSubmissionLogs(challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
        const projection = await this.getAuthorizedProjection(challengeId)
        if (projection) return projection.submissions
        const rootDir = await this.getRootDir()
        const challenge = await this.getChallenge(challengeId)
        if (this.authorizedProjectionProvider && this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized report index is unavailable from Taric authority"), { code: "TARIC_AUTHORITY_REQUIRED" })
        return listChallengeSubmissionLogs(rootDir, challengeId, challenge?.project_id)
    }

    async refreshStats(challengeId: string): Promise<{ stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }> {
        const projection = await this.getAuthorizedProjection(challengeId)
        if (projection) return projection.stats
        const rootDir = await this.getRootDir()
        const challenge = await this.getChallenge(challengeId)
        if (this.authorizedProjectionProvider && this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized stats index is unavailable from Taric authority"), { code: "TARIC_AUTHORITY_REQUIRED" })
        return refreshChallengeStats(rootDir, challengeId, challenge?.project_id)
    }

    async getAuthorizedProjection(challengeId: string): Promise<AuthorizedChallengeProjection | undefined> {
        return this.authorizedProjectionProvider?.read(requireText(challengeId, "challengeId"))
    }

    async executeAuthorizedHttpAction(input: {
        challengeId: string
        workRunId: string
        generation: number
        agentId: string
        resourceId: string
        request: { url: string; method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"; headers?: Record<string, string>; body?: string; rationale: string }
    }): Promise<{ statusCode: number; outcome: string; bodyBase64?: string; diagnostic: string }> {
        const challenge = await this.getChallenge(requireText(input.challengeId, "challengeId"))
        if (!this.isAuthorizedChallenge(challenge) || input.agentId.length > 128 || !Number.isSafeInteger(input.generation) || input.generation < 1) throw Object.assign(new Error("authorized HTTP action binding is invalid"), { code: "TARIC_AUTHORITY_REQUIRED" })
        if (!this.authorizedProjectionProvider?.executeAction) throw Object.assign(new Error("authorized HTTP execution is unavailable"), { code: "TARIC_AUTHORITY_REQUIRED" })
        return this.authorizedProjectionProvider.executeAction(input)
    }

    async renewAuthorizedWorkRun(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string }): Promise<void> {
        if (!this.isAuthorizedChallenge(await this.getChallenge(requireText(input.challengeId, "challengeId"))) || !this.authorizedProjectionProvider?.renewWorkRun) {
            throw Object.assign(new Error("authorized WorkRun lease renewal is unavailable"), { code: "TARIC_AUTHORITY_REQUIRED" })
        }
        await this.authorizedProjectionProvider.renewWorkRun(input)
    }

    async finishAuthorizedWorkRun(input: { challengeId: string; workRunId: string; generation: number; agentId: string; resourceId: string }): Promise<void> {
        if (!this.isAuthorizedChallenge(await this.getChallenge(requireText(input.challengeId, "challengeId"))) || !this.authorizedProjectionProvider?.finishWorkRun) {
            throw Object.assign(new Error("authorized WorkRun completion is unavailable"), { code: "TARIC_AUTHORITY_REQUIRED" })
        }
        await this.authorizedProjectionProvider.finishWorkRun(input)
    }

    async registerAuthorizedProjectBinding(input: Pick<AuthorizedProjectBinding, "challengeId" | "title" | "project">): Promise<void> {
        if (!this.authorizedProjectionProvider) throw new Error("authorized Taric projection provider is unavailable")
        await this.authorizedProjectionProvider.registerFromManifest(input)
    }

    async deleteChallenge(challengeId: string): Promise<void> {
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.getChallenge(id)
        if (!challenge) {
            throw new Error(`challenge "${id}" not found`)
        }
        if (this.isAuthorizedChallenge(challenge)) throw Object.assign(new Error("authorized project discovery bindings can only be removed by an explicit configuration workflow"), { code: "TARIC_AUTHORITY_REQUIRED" })

        this.log("challenge:delete", "archiving challenge", { challengeId: id })

        if (challenge.instance_status === "running" || challenge.instance_status === "pending") {
            try {
                await this.stopChallenge(id)
            } catch (error) {
                this.error("challenge:delete", "failed to stop challenge instance before archive", error, { challengeId: id })
            }
        }

        if (this.runtime) {
            const solvers = await this.runtime.listAll()
            const related = solvers.filter((solver) => solver.challengeId === id)
            const active = related.filter((solver) => solver.status === "starting" || solver.status === "running" || solver.status === "stopping")
            await Promise.allSettled(active.map((solver) => this.runtime!.stopSolver(solver.id)))
            for (const solver of related) {
                try {
                    await this.runtime.deleteSolver(solver.id)
                } catch (error) {
                    this.error("challenge:delete", "failed to archive solver during challenge delete", error, {
                        challengeId: id,
                        solverId: solver.id,
                    })
                }
            }
        }

        await this.updateChallengePlannerStatus(id, "stop")
        const rootDir = await this.getRootDir()
        const archived = await archiveChallengeRecord(rootDir, id)
        if (!archived) {
            throw new Error(`challenge "${id}" not found`)
        }

        this.log("challenge:delete", "challenge archived", { challengeId: id })
    }

    private async seedSolverBoardFromChallenge(solverId: string, challengeId: string): Promise<void> {
        const [memoryItems, ideaItems] = await Promise.all([this.listMemory(challengeId), this.listIdeas(challengeId)])
        await seedSolverBoardSnapshot(
            {
                memory: memoryItems,
                ideas: ideaItems,
            },
            solverSessionDir(solverId),
        )
    }

    private resolveSolverEntrypoints(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions): PlannerAssetEntrypoint[] {
        const scopedEntryPoints = options?.entrypoints
        if (scopedEntryPoints && scopedEntryPoints.length > 0) {
            return [...new Map(scopedEntryPoints.map((item) => [item.asset_hash.toLowerCase(), { ...item, asset_hash: item.asset_hash.toLowerCase() }])).values()]
        }
        const storedAssets = [...(challenge.assets?.urls ?? []), ...(challenge.assets?.ips ?? [])]
        if (storedAssets.length > 0) return storedAssets.map((item) => ({ asset_hash: item.asset_hash.toLowerCase(), asset: item.asset }))
        return (challenge.entrypoint ?? []).map((asset) => ({ asset_hash: hashChallengeAsset(asset), asset }))
    }

    private async assertNoSolverAssetOverlap(challenge: ChallengeInfoRecord, entrypoints: PlannerAssetEntrypoint[], testItems?: string[]): Promise<void> {
        if (!this.runtime || typeof this.runtime.listAll !== "function" || entrypoints.length === 0) return
        const requested: SolverAssignment = {
            assetHashes: new Set(entrypoints.map((entrypoint) => entrypoint.asset_hash.toLowerCase())),
            testItems: normalizeTestItems(testItems) ? new Set(normalizeTestItems(testItems)) : undefined,
        }
        const activeSolvers = (await this.runtime.listAll()).filter(
            (solver) => solver.challengeId === challenge.id && isClaimingSolver(solver),
        )
        const [attempts, submissions] = await Promise.all([this.listAttemptLogs(challenge.id), this.listSubmissionLogs(challenge.id)])
        const historicalAssignments = attempts.flatMap((attempt) => {
            const assigned = solverAssignmentFromTask(attempt.task)
            if (!assigned.assetHashes) return [assigned]
            if (!assigned.testItems) {
                const unreported = new Set([...assigned.assetHashes].filter((hash) => !latestSolverAssetReport(submissions, attempt.solver_id, hash)))
                return unreported.size > 0 ? [{ assetHashes: unreported }] : []
            }
            // A blocked item is a handoff, so a later solver may take it over.
            // Completed and unreported work retain duplicate protection.
            return [...assigned.assetHashes].flatMap((hash) => {
                const report = latestSolverAssetReport(submissions, attempt.solver_id, hash)
                const remainingClaims = new Set([...assigned.testItems!].filter((item) => !report?.test_results?.some((result) => result.test_item === item && result.status === "blocked")))
                return remainingClaims.size > 0 ? [{ assetHashes: new Set([hash]), testItems: remainingClaims }] : []
            })
        })
        const activeAssignments = activeSolvers.map((solver) => ({ solverId: solver.id, assignment: solverAssignmentFromTask(solver.task) }))
        for (const { solverId, assignment: assigned } of activeAssignments) {
            if (assigned.assetHashes === undefined) {
                throw Object.assign(
                    new Error(`solver asset assignment overlaps active solver ${solverId} for challenge "${challenge.id}"`),
                    { code: "SOLVER_ASSET_CONFLICT", solverId },
                )
            }
            if (solverAssignmentsOverlap(requested, assigned)) {
                const overlap = [...requested.assetHashes!].filter((hash) => assigned.assetHashes?.has(hash))
                throw Object.assign(
                    new Error(`solver asset/test assignment overlaps active solver ${solverId} for challenge "${challenge.id}": ${overlap.join(", ")}`),
                    { code: "SOLVER_ASSET_CONFLICT", solverId, assetHashes: overlap },
                )
            }
        }
        for (const assigned of historicalAssignments) {
            if (solverAssignmentsOverlap(requested, assigned)) {
                const overlap = [...(requested.assetHashes ?? [])].filter((hash) => assigned.assetHashes?.has(hash))
                throw Object.assign(
                    new Error(`solver asset/test assignment repeats a previous attempt for challenge "${challenge.id}": ${overlap.join(", ")}`),
                    { code: "SOLVER_ASSET_CONFLICT", assetHashes: overlap },
                )
            }
        }
    }

    async launchSolver(challengeId: string, promptName: string, options?: LaunchSolverOptions): Promise<SolverInstance> {
        const id = requireText(challengeId, "challengeId")
        const requested: SolverAssignment = {
            assetHashes: options?.entrypoints && options.entrypoints.length > 0
                ? new Set(options.entrypoints.map((entrypoint) => entrypoint.asset_hash.toLowerCase()))
                : undefined,
            testItems: normalizeTestItems(options?.testItems) ? new Set(normalizeTestItems(options?.testItems)) : undefined,
        }
        const reservations = this.solverLaunchReservations.get(id) ?? []
        const overlapsReservation = reservations.some((reservation) => reservation === undefined || solverAssignmentsOverlap(requested, reservation))
        if (overlapsReservation) {
            throw Object.assign(new Error(`solver asset assignment overlaps a launch already in progress for challenge "${id}"`), { code: "SOLVER_ASSET_CONFLICT" })
        }
        const reservation = requested.assetHashes === undefined ? undefined : requested
        this.solverLaunchReservations.set(id, [...reservations, reservation])
        try {
            return await this.launchSolverInternal(id, promptName, options)
        } finally {
            const current = this.solverLaunchReservations.get(id) ?? []
            const index = current.indexOf(reservation)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) this.solverLaunchReservations.delete(id)
        }
    }

    private async launchSolverInternal(challengeId: string, promptName: string, options?: LaunchSolverOptions): Promise<SolverInstance> {
        if (!this.runtime) {
            throw new Error("runtime is not attached")
        }
        const promptNameText = requireText(promptName, "promptName")
        this.log("challenge:solver", "launch requested", { challengeId, promptName: promptNameText })

        const prompt = await this.config.getPrompt(promptNameText)
        if (!prompt) {
            throw new Error(`prompt not found: ${promptNameText}`)
        }
        if (prompt.meta.disabled === true) {
            throw new Error(`prompt is disabled: ${promptNameText}`)
        }
        if (prompt.meta.isSubagent === true) {
            throw new Error(`subagent prompt cannot be started as solver: ${promptNameText}`)
        }

        const current = await this.getChallenge(challengeId)
        if (!current) {
            throw new Error(`challenge "${challengeId}" not found`)
        }
        await this.assertNoSolverAssetOverlap(current, this.resolveSolverEntrypoints(current, options), options?.testItems)
        await this.assertAuthorizedPlannerSolverReady(challengeId, "solver")
        await this.assertRequiredMemoryAvailable(challengeId)
        if (computeChallengeCompleted(current)) {
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        const solverId = crypto.randomUUID().slice(0, 8)
        const authorized = this.isAuthorizedChallenge(current)
        const modelPref = typeof prompt.meta.model === "string" ? prompt.meta.model.trim() : ""
        if (authorized && !modelPref) throw Object.assign(new Error("authorized Solver requires a prompt with an explicitly pinned HTTP model"), { code: "TARIC_MODEL_TRANSPORT_REQUIRED" })
        const resolvedModel = authorized ? (await this.config.resolveModelPref(modelPref)).model : undefined
        const supportedModelApis = new Set(["openai-completions", "openai-responses", "anthropic-messages", "mistral-conversations", "pi-messages"])
        const modelBaseUrl = resolvedModel?.baseUrl
        if (authorized && (!resolvedModel || !supportedModelApis.has(String(resolvedModel.api)) || typeof modelBaseUrl !== "string")) {
            throw Object.assign(new Error("authorized Solver requires a supported HTTP model with a pinned base URL"), { code: "TARIC_MODEL_TRANSPORT_REQUIRED" })
        }
        if (resolvedModel) {
            const auth = await this.config.models.getApiKeyAndHeaders(resolvedModel)
            if (!auth.ok || typeof auth.apiKey !== "string" || !auth.apiKey.trim() || (auth.headers && Object.keys(auth.headers).length > 0)) {
                throw Object.assign(new Error("authorized Solver requires a model credential without custom headers"), { code: "TARIC_MODEL_TRANSPORT_REQUIRED" })
            }
        }
        const preparation = authorized ? await this.authorizedProjectionProvider?.prepareSolver?.(challengeId, solverId) : undefined
        if (authorized && !preparation) throw this.createAuthorizedGovernanceBlockedError("solver")
        const failPreparedWorkRun = async () => {
            if (!preparation) return
            await this.authorizedProjectionProvider?.failWorkRun?.({
                challengeId,
                workRunId: preparation.run.runId,
                generation: preparation.run.generation,
                agentId: solverId,
                resourceId: preparation.run.targetResourceId,
            }).catch((failure) => this.error("challenge:solver", "failed to close rejected authorized WorkRun", failure, { challengeId, solverId }))
        }
        let challenge: ChallengeInfoRecord | undefined = preparation?.projection.challenge ?? current
        if (current.instance_status === "running" || current.instance_status === "pending") {
            this.log("challenge:solver", "reuse running challenge instance", {
                challengeId,
                instanceStatus: current.instance_status,
                entrypoint: current.entrypoint ?? null,
            })
        } else {
            try {
                const started = await this.startChallenge(challengeId)
                challenge = started.challenge ?? (await this.getChallenge(challengeId))
            } catch (error) {
                await failPreparedWorkRun()
                throw error
            }
        }
        if (!challenge) {
            throw new Error(`challenge "${challengeId}" not found after start`)
        }
        if (computeChallengeCompleted(challenge)) {
            void this.finishChallenge(challengeId)
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        const taskOptions = preparation
            ? {
                ...options,
                entrypoints: preparation.projection.authority.resources
                    .filter((resource) => resource.id === preparation.run.targetResourceId)
                    .map((resource) => {
                        const identity = resource.identity as { origin?: unknown; path?: unknown }
                        if (typeof identity.origin !== "string" || typeof identity.path !== "string") return undefined
                        const asset = new URL(identity.path, identity.origin).toString()
                        return { asset_hash: hashChallengeAsset(asset), asset }
                    })
                    .filter((item): item is PlannerAssetEntrypoint => item !== undefined),
            }
            : options
        let task: string
        try {
            task = await this.buildSolverTask(challenge, taskOptions, preparation?.projection)
        } catch (error) {
            await failPreparedWorkRun()
            throw error
        }
        if (!authorized) {
            try {
                await this.seedSolverBoardFromChallenge(solverId, challengeId)
            } catch (error) {
                this.error("challenge:solver", "failed to seed solver board from challenge context", error, {
                    challengeId,
                    solverId,
                })
            }
        }
        const solverEnv: Record<string, string> = { [CHALLENGE_ENV_CHALLENGE_ID]: challengeId }
        if (challenge.project_id) solverEnv[CHALLENGE_ENV_PROJECT_ID] = challenge.project_id
        if (preparation) {
            solverEnv.TCH_TARIC_WORK_RUN_ID = preparation.run.runId
            solverEnv.TCH_TARIC_WORK_GENERATION = String(preparation.run.generation)
            solverEnv.TCH_TARIC_ATTEMPT_ID = preparation.run.attemptId
            solverEnv.TCH_TARIC_OWNER_AGENT_ID = preparation.run.owner.agent_id
            solverEnv.TCH_TARIC_SCOPE_ID = preparation.run.scopeId
            solverEnv.TCH_TARIC_SCOPE_VERSION = String(preparation.run.scopeVersion)
            solverEnv.TCH_TARIC_SCOPE_REVISION_ID = preparation.run.scopeRevisionId
            solverEnv.TCH_TARIC_RESOURCE_ID = preparation.run.targetResourceId
            solverEnv.TCH_TARIC_TASK_SESSION_ID = preparation.run.taskSessionId
        }
        let solver: SolverInstance
        try {
            solver = preparation
                ? await this.runtime.launchAuthorized(promptNameText, task, solverEnv, modelPref, { solverId })
                : await this.runtime.launch(promptNameText, task, solverEnv, { solverId })
        } catch (error) {
            await failPreparedWorkRun()
            throw error
        }
        await this.updateChallengePlannerStatus(challengeId, "running")
        if (!authorized) await this.appendAttemptLog({ challengeId, solverId: solver.id, promptName: promptNameText, task: solver.task })
        this.log("challenge:solver", "solver launched", {
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            solverName: solver.name,
        })
        return solver
    }

    async finishChallenge(challengeId: string): Promise<void> {
        const id = requireText(challengeId, "challengeId")
        if (this.finishingChallenges.has(id)) return
        this.finishingChallenges.add(id)
        this.log("challenge:finish", "finishing solved challenge", { challengeId: id })
        try {
            const challenge = await this.getChallenge(id)
            if (!computeChallengeCompleted(challenge)) return

            if (challenge && (challenge.instance_status === "running" || challenge.instance_status === "pending")) {
                try {
                    await this.stopChallenge(id)
                } catch (error) {
                    this.error("challenge:finish", "failed to stop challenge instance during finish", error, { challengeId: id })
                }
            }

            if (!this.runtime) {
                await this.updateChallengePlannerStatus(id, "stop")
                return
            }
            const solvers = await this.runtime.listAll()
            const active = solvers.filter((solver) => solver.challengeId === id && (solver.status === "starting" || solver.status === "running" || solver.status === "stopping"))
            // Reported solvers exit at agent_settled after the Observer drains
            // its final review. Killing them here would discard that handoff.
            const unfinished = (await Promise.all(active.map(async (solver) => ({ solver, completed: await this.isSolverTaskCompleted(id, solver.id) }))))
                .filter((item) => !item.completed).map((item) => item.solver)
            await Promise.allSettled(unfinished.map((solver) => this.runtime!.stopSolver(solver.id)))
            await this.updateChallengePlannerStatus(id, "stop")
            this.log("challenge:finish", "finished solved challenge cleanup", { challengeId: id, stoppedSolvers: unfinished.map((solver) => solver.id) })
        } finally {
            this.finishingChallenges.delete(id)
        }
    }

    private async runPlannerOnce(source: string, options?: PlannerRunOptions): Promise<PlannerRunResult> {
        const runtime = this.getRuntime()
        if (!runtime) throw new Error("runtime is not attached")

        const sessionOpts = await this.config.resolvePromptSession(DEFAULT_PLANNER_PROMPT_NAME)
        if (!sessionOpts?.resourceLoader) {
            this.error("challenge:planner", "planner prompt missing or failed to resolve", undefined, { promptName: DEFAULT_PLANNER_PROMPT_NAME })
            throw new Error(`planner prompt missing or failed to resolve: ${DEFAULT_PLANNER_PROMPT_NAME}`)
        }

        const snapshot = await this.buildPlannerSnapshot(source, options?.challengeId)
        if (snapshot.challenges.length === 0) {
            const message = `source=${source} unsolved=0`
            return { message, stopReason: "", launchedSolvers: [] }
        }

        const authorizedTarget = options?.challengeId ? this.isAuthorizedChallenge(await this.getChallenge(options.challengeId)) : false
        const previousRound = authorizedTarget ? undefined : await this.readPreviousPlannerRound(options?.challengeId)
        const resourceLoader = wrapPlannerResourceLoader(sessionOpts.resourceLoader, snapshot, previousRound, options?.preferredPromptName)
        await resourceLoader.reload()
        const launchedSolvers: SolverInstance[] = []

        const plannerTools = this.createPlannerTools(snapshot, launchedSolvers, options?.preferredPromptName)
        const plannerToolNames = [
            ...(sessionOpts.customTools ?? []).map((tool) => tool.name),
            ...plannerTools.map((tool) => tool.name),
        ]
        const { session } = await createAgentSession({
            ...sessionOpts,
            resourceLoader,
            // resolvePromptSession supplies the prompt's ordinary tool
            // allowlist. Planner lifecycle tools are injected at runtime and
            // must be added to that allowlist or the SDK silently filters them.
            tools: plannerToolNames,
            customTools: [...(sessionOpts.customTools ?? []), ...plannerTools],
            sessionManager: SessionManager.inMemory(),
        })

        let plannerMessage = ""
        let plannerStopReason = ""
        const plannerActions = new Map<string, string>()
        let plannerStreaming = false
        session.subscribe((event) => {
            if (event.type === "message_start") {
                plannerStreaming = false
            }
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                if (!plannerStreaming) {
                    process.stdout.write(`${formatChallengeLogScope("challenge:planner")} output\n`)
                    plannerStreaming = true
                }
                writePlannerTextChunk(event.assistantMessageEvent.delta)
            }
            if (event.type === "message_end" && event.message?.role === "assistant") {
                if (plannerStreaming) process.stdout.write("\n")
                plannerMessage = extractTextContent(event.message.content as Array<{ type: string; text?: string }> | undefined)
                plannerStopReason = event.message.stopReason ?? ""
                const modelError = "errorMessage" in event.message && typeof event.message.errorMessage === "string" ? event.message.errorMessage : undefined
                if (modelError) this.error("challenge:planner", "planner model error", undefined, { stopReason: plannerStopReason, errorMessage: modelError })
            }
            if (event.type === "tool_execution_start") {
                plannerActions.set(event.toolCallId, `${event.toolName} ${JSON.stringify(event.args ?? {})}`)
            }
            if (event.type === "tool_execution_end" && event.isError) {
                this.error("challenge:planner", "planner tool failed", undefined, { toolName: event.toolName, result: event.result })
            }
        })

        let plannerTimeout: ReturnType<typeof setTimeout> | undefined
        const decisionTimeoutMs = resolvePlannerDecisionTimeoutMs((await this.config.getHostSettings()).planner.decisionTimeoutMs)
        try {
            await Promise.race([
                session.prompt(
                    options?.challengeId
                        ? `开始当前项目调度。challengeId=${options.challengeId}${options.preferredPromptName ? `，用户选择的 solver prompt=${options.preferredPromptName}` : ""}。优先对每份 Observer 待决审查调用 planner_decide_solver，再考虑新分配。`
                        : "开始本轮比赛调度。优先处理 Observer 待决审查。",
                ),
                new Promise<never>((_resolve, reject) => {
                    plannerTimeout = setTimeout(() => {
                        void session.abort().catch(() => {})
                        reject(new Error("Planner decision timed out; pending reviews remain available for retry"))
                    }, decisionTimeoutMs)
                }),
            ])
        } finally {
            clearTimeout(plannerTimeout)
            session.dispose()
        }
        if (plannerActions.size === 0) {
            for (const [index, action] of parsePlannerTextActions(plannerMessage).entries()) {
                const args = { ...action.args }
                const challengeId = typeof args.challengeId === "string" ? args.challengeId : args.projectId
                if (typeof challengeId === "string" && challengeId.trim()) {
                    args.challengeId = challengeId.trim()
                }
                delete args.projectId
                if (Array.isArray(args.solverHandoff)) {
                    args.solverHandoff = args.solverHandoff.filter((item): item is string => typeof item === "string").join("\n")
                }
                plannerActions.set(`planner-text-${index + 1}`, `${action.toolName} ${JSON.stringify(args)}`)
                const tool = plannerTools.find((candidate) => candidate.name === action.toolName)
                if (!tool) continue
                try {
                    await tool.execute(`planner-text-${index + 1}`, args as never, undefined, undefined, undefined as never)
                } catch (error) {
                    this.error("challenge:planner", "text planner action failed", error, { toolName: action.toolName })
                }
            }
        }
        const plannerText =
            plannerMessage ||
            [
                `unsolved=${snapshot.challenges.length}`,
                `activeChallenges=${snapshot.constraints.activeChallenges}`,
                `activeSolvers=${snapshot.constraints.activeSolvers}`,
                `availablePrompts=${snapshot.availableSolverPrompts.length}`,
            ].join(" ")
        const plannerHeader = `${formatChallengeLogScope("challenge:planner")} model output${plannerStopReason ? ` [${plannerStopReason}]` : ""}`
        console.log(`${plannerHeader}\n${plannerText}`)
        if (!authorizedTarget) {
            await this.writePreviousPlannerRound(
                {
                    generated_at: new Date().toISOString(),
                    snapshot_digest: computePlannerSnapshotDigest(snapshot),
                    actions: [...plannerActions.values()],
                    summary: plannerText,
                },
                options?.challengeId,
            )
        }
        return { message: plannerMessage || plannerStopReason || "", stopReason: plannerStopReason, launchedSolvers }
    }

    private createPlannerTools(snapshot: PlannerSnapshot, launchedSolvers?: SolverInstance[], preferredPromptName?: string): ToolDefinition[] {
        const emptyObject = Type.Object({})
        const challengeIds = snapshot.challenges.map((challenge) => challenge.id)
        const solverPromptNames = snapshot.availableSolverPrompts.map((prompt) => prompt.name)
        const activeSolverIds = snapshot.activeSolvers.map((solver) => solver.id)
        const snapshotChallenges = new Map(snapshot.challenges.map((challenge) => [challenge.id, challenge]))
        const snapshotSolvers = new Map(snapshot.activeSolvers.map((solver) => [solver.id, solver]))
        const claimedAssignmentsByChallenge = new Map<string, SolverAssignment[]>()
        let launchSlotReservations = 0
        const scopedChallengeId = snapshot.challenges.length === 1 ? snapshot.challenges[0]?.id : undefined
        const challengeIdSchema = challengeIds.length > 0 ? Type.Union(challengeIds.map((id) => Type.Literal(id))) : Type.String({ description: "challenge id" })
        const promptNameSchema = solverPromptNames.length > 0 ? Type.Union(solverPromptNames.map((name) => Type.Literal(name))) : Type.String({ description: "solver prompt name" })
        const solverIdSchema = activeSolverIds.length > 0 ? Type.Union(activeSolverIds.map((id) => Type.Literal(id))) : Type.String({ description: "solver id" })

        return [
            defineTool({
                name: "planner_get_state",
                label: "Get Planner State",
                description: "Get current unsolved challenges, active challenge instances, solver allocation, attempts, submissions and stale indicators.",
                parameters: emptyObject,
                execute: async () => {
                    const snapshot = await this.buildPlannerSnapshot("challenge-planner:tool-state", scopedChallengeId)
                    return {
                        content: [{ type: "text", text: formatPlannerSnapshotMarkdown(snapshot) }],
                        details: snapshot,
                    }
                },
            }),
            defineTool({
                name: "planner_start_challenge",
                label: "Start Challenge",
                description: "Start a challenge instance. Use when you want to occupy one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    this.log("challenge:planner-tool", "start challenge requested", { challengeId: params.challengeId })
                    const result = await this.startChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_stop_challenge",
                label: "Stop Challenge",
                description: "Stop a challenge instance and free one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (challenge && !challenge.stale && !challenge.idleInstance) {
                        throw new Error(`challenge "${params.challengeId}" is not stale or idle; stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop challenge requested", { challengeId: params.challengeId })
                    const result = await this.stopChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_launch_solver",
                label: "Launch Solver",
                description:
                    "Launch one solver for a challenge. All entrypoints and testItems in this call form one assignment; use another call only when the assignment is explicitly split. Always include entrypoints and solverHandoff: a concise solver-facing startup brief distilled from current project state.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    promptName: promptNameSchema,
                    entrypoints: Type.Array(Type.Object({
                        asset_hash: Type.String({ minLength: 1, description: "MD5 asset identifier shown in the current project state." }),
                        asset: Type.String({ minLength: 1, description: "Exact asset target paired with asset_hash in the current project state." }),
                    }), {
                        minItems: 1,
                        description: "Asset entries assigned by the planner. Copy both asset_hash and asset exactly from the current project state.",
                    }),
                    testItems: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
                        minItems: 1,
                        description: "Specific test items this solver will execute for the assigned assets. Different test items may run concurrently on the same asset.",
                    })),
                    solverHandoff: Type.String({
                        minLength: 1,
                        maxLength: 1200,
                        description: "Short solver-facing startup note. Include only solver-executable guidance relevant to this challenge.",
                    }),
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (!challenge) throw new Error(`challenge "${params.challengeId}" not found`)
                    const promptName = resolvePlannerSolverPromptName(params.promptName, solverPromptNames, preferredPromptName)
                    const entrypoints = requirePlannerAssetEntrypoints(params.entrypoints, "entrypoints")
                    const testItems = normalizeTestItems(params.testItems)
                    const allowedEntryPoints = collectPlannerChallengeEntryPoints(challenge)
                    const invalidEntryPoints = entrypoints.filter((entrypoint) => allowedEntryPoints.get(entrypoint.asset_hash) !== entrypoint.asset)
                    if (invalidEntryPoints.length > 0) {
                        throw new Error(`entrypoints contain invalid asset hash/target pairs for challenge "${params.challengeId}": ${invalidEntryPoints.map((entrypoint) => entrypoint.asset_hash).join(", ")}`)
                    }
                    const assignment: SolverAssignment = {
                        assetHashes: new Set(entrypoints.map((entrypoint) => entrypoint.asset_hash.toLowerCase())),
                        testItems: testItems ? new Set(testItems) : undefined,
                    }
                    const claimedAssignments = claimedAssignmentsByChallenge.get(params.challengeId) ?? []
                    if (claimedAssignments.some((claimed) => solverAssignmentsOverlap(assignment, claimed))) {
                        throw Object.assign(
                            new Error(`asset/test assignment overlaps a solver already launched in this planner round for challenge "${params.challengeId}"`),
                            { code: "SOLVER_ASSET_CONFLICT", assetHashes: [...(assignment.assetHashes ?? [])] },
                        )
                    }
                    const availableSolverSlots = Math.max(snapshot.constraints.maxSolvers - snapshot.constraints.activeSolvers - launchSlotReservations, 0)
                    if (availableSolverSlots < 1) {
                        throw new Error(`not enough solver slots for 1 asset assignment; ${availableSolverSlots} available`)
                    }
                    const solverHandoff = clipTaskText(requireText(params.solverHandoff, "solverHandoff"), SOLVER_HANDOFF_MAX_CHARS)
                    this.log("challenge:planner-tool", "launch solver requested", { challengeId: params.challengeId, promptName, entrypoints })
                    launchSlotReservations += 1
                    try {
                        const solver = await this.launchSolver(params.challengeId, promptName, {
                            plannerHandoff: solverHandoff,
                            entrypoints,
                            testItems,
                        })
                        launchedSolvers?.push(solver)
                        claimedAssignmentsByChallenge.set(params.challengeId, [...claimedAssignments, assignment])
                        return {
                            content: [{ type: "text", text: JSON.stringify(solver, null, 2) }],
                            details: solver,
                        }
                    } catch (error) {
                        launchSlotReservations -= 1
                        this.error("challenge:planner-tool", "launch solver failed", error, { challengeId: params.challengeId, promptName })
                        throw error
                    }
                },
            }),
            defineTool({
                name: "planner_decide_solver",
                label: "Decide Solver Assignment Review",
                description: "Act on the Observer's exact checklist audit. Continue the same solver with concrete corrections for missing or unsupported work, or stop an audited completed/legitimately blocked assignment to release its container. This decision is required even when all solver slots are occupied.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    reviewId: Type.String({ minLength: 1 }),
                    decision: Type.Union([Type.Literal("continue"), Type.Literal("stop")]),
                    rationale: Type.String({ minLength: 1 }),
                    instructions: Type.Optional(Type.String({ minLength: 1 })),
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (!challenge?.solverReviews?.some((review) => review.id === params.reviewId)) throw new Error("review is not in the current Planner snapshot")
                    await this.decideSolverReview(params.challengeId, params.reviewId, params.decision, params.rationale, params.instructions)
                    return { content: [{ type: "text", text: `solver review decision applied: ${params.decision}` }], details: { reviewId: params.reviewId, decision: params.decision } }
                },
            }),
            defineTool({
                name: "planner_complete_asset",
                label: "Complete Asset Review",
                description: "Close a competition asset after reviewing solver discoveries and confirming no follow-up is needed. All assigned test items must be completed first.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    assetHash: Type.String({ minLength: 1 }),
                    rationale: Type.String({ minLength: 1 }),
                }),
                execute: async (_toolCallId, params) => {
                    requireText(params.rationale, "rationale")
                    const challenge = await this.getChallenge(params.challengeId)
                    if (!challenge || !snapshotChallenges.has(params.challengeId)) throw new Error(`challenge "${params.challengeId}" not found`)
                    const match = findAssetByHash(challenge.assets ?? EMPTY_ASSETS, params.assetHash)
                    if (!match) throw new Error(`asset hash "${params.assetHash}" not found`)
                    const active = this.runtime ? (await this.runtime.listAll()).filter((solver) => solver.challengeId === params.challengeId && isClaimingSolver(solver)) : []
                    if (active.some((solver) => {
                        const hashes = extractSolverAssetHashes(solver.task)
                        return hashes.size === 0 || hashes.has(params.assetHash)
                    })) throw new Error("wait for assigned solvers to finish their final observer review before completing the asset")
                    const [attempts, submissions] = await Promise.all([this.listAttemptLogs(params.challengeId), this.listSubmissionLogs(params.challengeId)])
                    const assetReports = submissions.filter((report) => report.asset_hash === params.assetHash)
                    if (assetReports.length === 0) throw new Error("asset has no solver report to review")
                    const required = new Set(attempts.filter((attempt) => extractSolverAssetHashes(attempt.task).has(params.assetHash)).flatMap((attempt) => [...extractSolverTestItems(attempt.task)]))
                    const completed = completedAssetTestItems(submissions, params.assetHash)
                    const pending = [...required].filter((item) => !completed.has(item))
                    if (pending.length > 0) throw new Error(`asset still has incomplete assigned test items: ${pending.join(", ")}`)
                    const auditedCompleted = new Set<string>()
                    for (const solverId of new Set(assetReports.map((report) => report.solver_id).filter((id): id is string => Boolean(id)))) {
                        const review = await this.getSolverReviewContext(params.challengeId, solverId)
                        if (!review.solver_stop_approved) throw new Error(`solver ${solverId} requires an Observer audit and Planner stop decision before asset closure`)
                        for (const item of review.current_review?.review.checklist ?? []) {
                            if (item.asset_hash === params.assetHash && item.verdict === "verified") auditedCompleted.add(item.test_item)
                        }
                    }
                    const unverified = [...required].filter((item) => !auditedCompleted.has(item))
                    if (unverified.length > 0) throw new Error(`asset still has test items without verified Observer evidence: ${unverified.join(", ")}`)
                    this.log("challenge:planner-tool", "asset discoveries reviewed", { challengeId: params.challengeId, assetHash: params.assetHash, rationale: params.rationale })
                    const updated = await this.updateChallengeAssetScanned(params.challengeId, match.group, match.asset.asset, true)
                    if (computeChallengeCompleted(updated)) await this.finishChallenge(params.challengeId)
                    return { content: [{ type: "text", text: "asset review completed" }], details: updated }
                },
            }),
            defineTool({
                name: "planner_stop_solver",
                label: "Stop Solver",
                description: "Stop a running solver to free a solver slot.",
                parameters: Type.Object({
                    solverId: solverIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const runtime = this.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    const solver = snapshotSolvers.get(params.solverId)
                    const challenge = solver?.challengeId ? snapshotChallenges.get(solver.challengeId) : undefined
                    if (challenge && !challenge.stale) {
                        throw new Error(`challenge "${challenge.id}" is not stale yet; solver stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop solver requested", { solverId: params.solverId })
                    await runtime.stopSolver(params.solverId)
                    return {
                        content: [{ type: "text", text: `stopped solver ${params.solverId}` }],
                        details: { solverId: params.solverId },
                    }
                },
            }),
        ]
    }

    private async buildPlannerSnapshot(source: string, challengeId?: string): Promise<PlannerSnapshot> {
        const runtime = this.getRuntime()
        if (!runtime) throw new Error("runtime is not attached")

        const settings = await this.config.getHostSettings()
        const maxSolvers = clampInt(settings.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS, 0, 64)
        const staleTimeoutMs = clampInt(settings.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS, 5 * 60 * 1000, 24 * 60 * 60 * 1000)
        const storedChallenges = await this.listChallengesSafe(source)
        const targetChallengeId = challengeId?.trim()
        if (targetChallengeId && !storedChallenges.some((item) => item.id === targetChallengeId)) {
            throw new Error(`challenge "${targetChallengeId}" not found`)
        }
        if (targetChallengeId) await this.assertAuthorizedPlannerSolverReady(targetChallengeId, "planner")
        const challenges = targetChallengeId
            ? storedChallenges.filter((item) => item.id === targetChallengeId)
            : storedChallenges.filter((item) => !this.isAuthorizedChallenge(item))
        const authorizedChallengeIds = new Set(storedChallenges.filter((item) => this.isAuthorizedChallenge(item)).map((item) => item.id))
        const solvers = (await runtime.listAll()).filter((solver) => !solver.challengeId || !authorizedChallengeIds.has(solver.challengeId))
        const activeSolvers = solvers.filter(isActiveSolver)
        const claimingSolvers = solvers.filter(isClaimingSolver)
        const activeChallengeIds = new Set(activeSolvers.map((solver) => solver.challengeId).filter((id): id is string => typeof id === "string" && id.trim().length > 0))
        const activeInstanceChallenges = challenges.filter(isActiveChallengeInstance)
        const activeInstanceChallengeIds = new Set(activeInstanceChallenges.map((challenge) => challenge.id))
        const attemptsByChallenge = new Map(
            await Promise.all(challenges.map(async (challenge) => [challenge.id, await this.listAttemptLogs(challenge.id)] as const)),
        )
        const submissionsByChallenge = new Map(
            await Promise.all(challenges.map(async (challenge) => [challenge.id, await this.listSubmissionLogs(challenge.id)] as const)),
        )
        const reviewsByChallenge = new Map(await Promise.all(challenges.map(async (challenge) => [challenge.id, await this.pendingSolverReviews(challenge.id)] as const)))
        const availableAssetsByChallenge = new Map(challenges.map((challenge) => [challenge.id, this.getAvailablePendingAssets(challenge, claimingSolvers, attemptsByChallenge.get(challenge.id) ?? [], submissionsByChallenge.get(challenge.id) ?? [])]))
        const activeAssetClaimsByChallenge = new Map(challenges.map((challenge) => [challenge.id, this.getActiveAssetClaims(challenge.id, claimingSolvers)]))
        const schedulable = challenges.filter((item) => {
            const activeInstance = activeInstanceChallengeIds.has(item.id)
            if (computeChallengeCompleted(item) && !activeInstance) return false
            const availableAssets = availableAssetsByChallenge.get(item.id) ?? EMPTY_ASSETS
            const hasAvailableAssets = availableAssets.urls.length > 0 || availableAssets.ips.length > 0
            const idleInstance = activeInstance && !activeChallengeIds.has(item.id)
            const needsReviewDecision = (reviewsByChallenge.get(item.id)?.length ?? 0) > 0
            if (targetChallengeId) return item.id === targetChallengeId && (hasAvailableAssets || idleInstance || needsReviewDecision)
            if (needsReviewDecision) return true
            return (this.isPlannerEnabled(item) && hasAvailableAssets) || (this.isPlannerEnabled(item) && (activeChallengeIds.has(item.id) || activeInstance))
        })
        const modelPrefs = await this.config.listModelPrefs()
        const solverPrompts = (await this.config.listAgentPrompts()).filter(
            (prompt) => prompt.meta.isSubagent !== true && prompt.meta.disabled !== true && prompt.deleted !== true && prompt.name !== DEFAULT_PLANNER_PROMPT_NAME,
        )
        const statsOverview = buildChallengeStatsOverview(
            await Promise.all(
                challenges.map(async (challenge) => {
                    const [statsResult, submissions] = await Promise.all([this.refreshStats(challenge.id), this.listSubmissionLogs(challenge.id)])
                    return {
                        challenge,
                        stats: statsResult.stats,
                        solver_stats: statsResult.solver_stats,
                        submissions,
                    }
                }),
            ),
        )
        const promptPerformanceByName = new Map(statsOverview.prompts.map((bucket) => [bucket.key, bucket]))

        const challengeItems = await Promise.all(
            schedulable.map(async (challenge) => {
                const [submissions, projection] = await Promise.all([
                    this.listSubmissionLogs(challenge.id),
                    this.isAuthorizedChallenge(challenge) ? this.getAuthorizedProjection(challenge.id) : Promise.resolve(undefined),
                ])
                let board: { memory: MemoryEntry[]; ideas: IdeaRecord[] } = { memory: [], ideas: [] }
                if (!projection) {
                    try {
                        board = await this.readMemoryBoard(challenge.id)
                    } catch (error) {
                        if (challenge.memory_mode !== "taric_best_effort" || !(error instanceof TaricUnavailableError)) throw error
                    }
                }
                const attempts = attemptsByChallenge.get(challenge.id) ?? []
                const item = this.buildPlannerSnapshotItem(
                    challenge,
                    attempts,
                    submissions,
                    claimingSolvers,
                    staleTimeoutMs,
                    projection?.authority,
                    availableAssetsByChallenge.get(challenge.id) ?? EMPTY_ASSETS,
                    activeAssetClaimsByChallenge.get(challenge.id) ?? [],
                    board,
                )
                return { ...item, solverReviews: reviewsByChallenge.get(challenge.id) ?? [] }
            }),
        )

        return {
            generatedAt: new Date().toISOString(),
            constraints: {
                maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
                maxSolvers,
                activeChallenges: activeInstanceChallenges.length,
                activeSolvers: activeSolvers.length,
                staleTimeoutMs,
            },
            activeSolvers: activeSolvers.map((solver) => ({
                id: solver.id,
                challengeId: solver.challengeId,
                promptName: solver.promptName,
                status: solver.status,
                activeForMinutes: formatMinutesFromTimestamp(solver.createdAt) ?? 0,
                timeoutStatus: solver.createdAt + staleTimeoutMs <= Date.now() ? "stale" : "normal",
            })),
            availableSolverPrompts: solverPrompts.map((prompt) => {
                const modelPrefId = typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : undefined
                const model = modelPrefId ? modelPrefs.find((entry) => entry.id === modelPrefId) : undefined
                const modelLabel = model ? `${model.provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}` : modelPrefId
                const modelBucketKey = model ? `${model.provider}/${model.modelId}` : modelPrefId

                return {
                    name: prompt.name,
                    description: prompt.meta.description,
                    modelPrefId,
                    modelLabel,
                    promptPerformance: promptPerformanceByName.get(prompt.name),
                }
            }),
            challenges: challengeItems.sort((a, b) => {
                if (a.untouched !== b.untouched) return a.untouched ? -1 : 1
                if (a.pendingTargetCount !== b.pendingTargetCount) return b.pendingTargetCount - a.pendingTargetCount
                return a.name.localeCompare(b.name)
            }),
        }
    }

    private buildPlannerSnapshotItem(
        challenge: ChallengeInfoRecord,
        attempts: ChallengeAttemptLogRecord[],
        submissions: ChallengeSubmissionLogRecord[],
        activeSolvers: SolverInstance[],
        staleTimeoutMs: number,
        authority?: AuthorizedChallengeProjection["authority"],
        availableAssets: ChallengeAssetsRecord = EMPTY_ASSETS,
        activeAssetClaims: Array<{ solverId: string; assetHashes: string[]; testItems: string[]; unknown: boolean; wildcardTests: boolean }> = [],
        board: { memory: MemoryEntry[]; ideas: IdeaRecord[] } = { memory: [], ideas: [] },
    ): PlannerSnapshotChallenge {
        const challengeSolvers = activeSolvers.filter((solver) => solver.challengeId === challenge.id)
        const idleInstance = isActiveChallengeInstance(challenge) && challengeSolvers.length === 0
        const oldestActiveSolverAt = challengeSolvers.map((solver) => solver.createdAt).sort((a, b) => a - b)[0]
        const lastAttemptAt = attempts
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]
        const lastReportAt = submissions
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]

        return {
            id: challenge.id,
            name: getChallengeDisplayName(challenge),
            title: challenge.title,
            description: challenge.description,
            instanceStatus: challenge.instance_status,
            assets: challenge.assets ?? { urls: [], ips: [] },
            availableAssets,
            activeAssetClaims,
            urlTargetCount: challenge.assets?.urls.length ?? 0,
            ipTargetCount: challenge.assets?.ips.length ?? 0,
            scannedTargetCount: countScannedAssets(challenge.assets ?? { urls: [], ips: [] }),
            pendingTargetCount: countPendingAssets(challenge.assets ?? { urls: [], ips: [] }),
            plannerPrompt: challenge.planner_prompt ?? null,
            entrypoint: challenge.entrypoint,
            attemptCount: attempts.length,
            reportCount: submissions.length,
            sharedMemory: board.memory,
            sharedIdeas: board.ideas,
            submissions,
            untouched: attempts.length === 0,
            stale: Boolean(oldestActiveSolverAt && Date.now() - oldestActiveSolverAt >= staleTimeoutMs && submissions.length === 0),
            idleInstance,
            activeSolverCount: challengeSolvers.length,
            activeSolverIds: challengeSolvers.map((solver) => solver.id),
            activeForMinutes: formatMinutesFromTimestamp(oldestActiveSolverAt),
            minutesSinceLastAttempt: formatMinutesFromTimestamp(lastAttemptAt),
            minutesSinceLastReport: formatMinutesFromTimestamp(lastReportAt),
            ...(authority ? {
                authority: {
                    readSeq: authority.readSeq,
                    closed: authority.report?.closed === true,
                    canClose: authority.coverageGate.can_close === true,
                    gaps: Array.isArray(authority.coverageGate.gaps) ? authority.coverageGate.gaps.map((gap) => typeof gap === "string" ? gap : JSON.stringify(gap)) : [],
                    work: authority.work.map((item) => ({
                        id: String(item.id),
                        status: String(item.status),
                        resourceRefs: Array.isArray(item.resource_refs) ? item.resource_refs.filter((ref): ref is string => typeof ref === "string") : [],
                    })),
                    evidenceRefs: authority.evidence.map((item) => String(item.id)),
                    context: projectModelContext(authority.context),
                    reportRefs: authority.report?.reports.map((item) => String(item.id)) ?? [],
                },
            } : {}),
        }
    }

    private async buildSolverTask(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions, authorizedProjection?: AuthorizedChallengeProjection): Promise<string> {
        const scopedEntryPoints = options?.entrypoints
        const storedAssets = [...(challenge.assets?.urls ?? []), ...(challenge.assets?.ips ?? [])]
        const defaultEntryPoints = storedAssets.length > 0
            ? storedAssets.map((item) => ({ asset_hash: item.asset_hash, asset: item.asset }))
            : (challenge.entrypoint ?? []).map((asset) => ({ asset_hash: hashChallengeAsset(asset), asset }))
        const entrypoints = scopedEntryPoints && scopedEntryPoints.length > 0
            ? [...new Map(scopedEntryPoints.map((item) => [item.asset_hash, item])).values()]
            : defaultEntryPoints
        if (!entrypoints || entrypoints.length === 0) {
            throw new Error(`challenge ${challenge.id} is missing assets or entrypoint`)
        }
        let memoryItems: MemoryEntry[] = []
        let ideaItems: IdeaRecord[] = []
        let memoryDegraded = false
        const submissionItems = await this.listSubmissionLogs(challenge.id)
        try {
            const [memory, ideas] = await Promise.all([this.listMemory(challenge.id), this.listIdeas(challenge.id)])
            memoryItems = memory
            ideaItems = ideas
        } catch (error) {
            if (challenge.memory_mode !== "taric_best_effort" || !(error instanceof TaricUnavailableError)) throw error
            memoryDegraded = true
        }
        const entrypoint = entrypoints.map((item) => `- [${item.asset_hash}] ${item.asset}`).join("\n")
        const testItems = normalizeTestItems(options?.testItems)
        const plannerHandoff = options?.plannerHandoff?.trim()
        const authority = authorizedProjection?.authority
        const authorizedTaricContext = projectModelContext(authority?.context ?? [])
        const authorizedContext = authority ? [
            `Canonical ScopeRevision: ${JSON.stringify({ scope_id: authority.scope[0]?.id, scope_revision_id: authority.scopeRevisions[0]?.id, read_seq: authority.readSeq })}`,
            `Canonical Work: ${JSON.stringify(authority.work.map((item) => ({ id: item.id, status: item.status, resource_refs: item.resource_refs, acceptance_criteria: item.acceptance_criteria })))}`,
            `Taric Context records: ${JSON.stringify(authorizedTaricContext)}`,
            `Coverage state: ${JSON.stringify({ can_close: authority.coverageGate.can_close, gaps: authority.coverageGate.gaps, cells: authority.coverage.map((item) => ({ id: item.id, resource_ref: item.resource_ref, test_category: item.test_category, status: item.status, evidence_refs: item.evidence_refs, limitations: item.limitations })) })}`,
            `Canonical Evidence refs: ${JSON.stringify(authority.evidence.map((item) => ({ id: item.id, resource_ref: item.resource_ref, resource_revision_ref: item.resource_revision_ref, statement: item.statement })))}`,
            `Canonical close/report: ${JSON.stringify({ closed: authority.report?.closed === true, can_close: authority.coverageGate.can_close, reports: authority.report?.reports.map((item) => ({ id: item.id, evidence_refs: item.evidence_refs, report_artifact_ref: item.report_artifact_ref })) ?? [] })}`,
        ] : []
        return [
            `你正在处理一个 授权安全测试 项目，目的是通过自动化测试进行安全检测，没有flag。`,
            ``,
            `项目名: ${getChallengeDisplayName(challenge)}`,
            ``,
            `项目描述:`,
            challenge.description.trim() || "无",
            ``,
            `目标入口:`,
            entrypoint,
            ``,
            ...(testItems ? [`本次测试项:`, ...testItems.map((item) => `- ${item}`), ``] : []),
            `当前 Memory 摘要:`,
            memoryDegraded ? "状态: degraded (Taric unavailable; no local fallback)" : undefined,
            formatSolverMemorySection(memoryItems),
            ``,
            `当前 Ideas 摘要:`,
            memoryDegraded ? "状态: degraded (Taric unavailable; no local fallback)" : undefined,
            formatSolverIdeasSection(ideaItems),
            ``,
            `当前 Submissions 摘要:`,
            formatSolverSubmissionsSection(submissionItems),
            ...(authorizedContext.length ? [``, `Taric 权威任务上下文（read_seq=${authority?.readSeq}）:`, ...authorizedContext] : []),
            ``,
            `要求:`,
            `- 严格逐项执行“本次测试项”；每项记录请求、响应、证据和执行状态，不能以泛化扫描替代清单。`,
            `- 与分配清单无关的新发现只记录为后续建议，不自行扩展执行范围，由 planner 决定后续分工。`,
            ...(authority ? [
                `- 只处理当前 Taric WorkItem 和 ScopeRevision 允许的目标。`,
                `- 所有目标 HTTP 请求必须使用 challenge_authorized_http；不要尝试其他网络协议或目标。`,
                `- 不要调用旧的 challenge_submit_report；观察和 Coverage 只会由后续受治理的 host capture 流程写入。`,
                `- 结束前总结请求、响应边界、已验证事实、Coverage gaps 和未完成工作，然后调用 authorized_work_complete。`,
            ] : [
                `- 以当前项目为唯一目标推进；完成某个资产测试后，立刻调用 challenge_submit_report 提交该资产的详细报告`,
                `- 找不到突破口不等于完成；逐项保留实际尝试与结果，客观受阻时填写 blocked 及阻塞证据，不得以主观判断无推进必要代替执行。`,
                `- 提交报告时必须用 test_results 逐项原样填写本次测试项：完成填 completed，受阻填 blocked，并写明 evidence；不得省略或把受阻项写成完成。`,
                `- 额外发现通过 discoveries 上报，说明证据、待验证点和建议后续测试；提交各入口报告后暂停，等待 Observer 逐项核验与 planner 继续/停止决定，不自行扩展任务。`,
            ]),
            `- 优先基于现有提示、资产信息和项目描述推进，非必要不要偏离目标（如果用户指定说要扫旁路资产）`,
            `- 如果卡住了，可以适当尝试一些可能的攻击手段，但不要偏离项目太远`,
            ...(authority ? [] : [
                `- 上面的 memory / ideas 已在 solver 启动时作为初始背景拼接给你；后续 observer 会在这个基础上继续维护 memory / ideas`,
                `- 初始上下文只带了压缩摘要；运行中如果需要整理和回看当前 memory / ideas，按需调用 memory_list / idea_list / idea_search`,
                `- 如需切换路线，优先先看 idea_list / idea_search`,
                `- 在决定攻击方向前，先看当前 Submissions 摘要，优先理解哪些入口、突破口、漏洞链已经验证过，避免无差别重复劳动`,
                `- 在重复某条路线、上下文变长、或怀疑自己忘了已验证的结论时，先看 memory_list`,
                `- 当你拿到了值得当前 solver 跨轮保留的事实、证据、失败边界、题目提示时，在回答和工具验证结果中清楚保留证据与边界，observer 会据此维护 memory`,
                `- 每个目标入口都有独立的 asset_hash；完成该入口测试后，使用对应 asset_hash 单独调用 challenge_submit_report，不要按 host 合并或替代`,
            ]),
            ``,
            `提示：`,
            `- 如果目标入口无法访问，就证明目标无法进行后续测试，直接根据已有情报通过 challenge_submit_report 提交报告`,
            ...(plannerHandoff ? [`项目级别启动补充说明（最高优先级遵循）:`, plannerHandoff, ``] : []),
        ].join("\n")
    }

    private async syncChallenge(challengeId: string, source: string): Promise<ChallengeInfoRecord | undefined> {
        const result = await this.listChallenges(source)
        return result.local.find((challenge) => challenge.id === challengeId)
    }
}
