import { ChallengeApiClient } from "./api-client"
import type { ChallengeApiChallenge, ChallengeApiHintData, ChallengeApiListData, ChallengeApiStartData } from "./api-client"
import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { ResourceLoader, ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ConfigManager, HostSettings } from "../config/index"
import { join } from "path"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
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
    computeChallengeCompleted,
    ensureChallengeStoreBaseDir,
    listChallengeRecords,
    readChallengeRecord,
    resolveChallengeDir,
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
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeIdea,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeMemory,
    updateChallengeIdea,
} from "./memory"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import { solverSessionDir } from "../runtime/types"
import { seedSolverBoardSnapshot } from "../solver/board-store"
import { Type } from "@sinclair/typebox"
import { CHALLENGE_PLANNER_PROMPT_NAME } from "../config/prompts/index"

export type { IdeaStatus, MemoryKind, MemoryEntry, AddMemoryInput, IdeaRecord, AddIdeaInput, AddIdeaResult, UpdateIdeaInput } from "./memory"

const DEFAULT_PLANNER_PROMPT_NAME = CHALLENGE_PLANNER_PROMPT_NAME
const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_STALE_TIMEOUT_MS = 60 * 60 * 1000
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
}

interface LaunchSolverOptions {
    plannerHandoff?: string
    entrypoints?: PlannerAssetEntrypoint[]
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
    urlTargetCount: number
    ipTargetCount: number
    scannedTargetCount: number
    pendingTargetCount: number
    plannerPrompt?: string | null
    entrypoint: string[] | null
    attemptCount: number
    reportCount: number
    untouched: boolean
    stale: boolean
    idleInstance: boolean
    activeSolverCount: number
    activeSolverIds: string[]
    activeForMinutes?: number
    minutesSinceLastAttempt?: number
    minutesSinceLastReport?: number
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
    return new Map([...challenge.assets.urls, ...challenge.assets.ips].map((item) => [item.asset_hash, item.asset]))
}

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)))
}

function resolvePlannerTickIntervalMs(value?: number): number {
    return clampInt(value ?? DEFAULT_TICK_INTERVAL_MS, 5_000, 10 * 60 * 1000)
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

function formatSolverMemorySection(items: MemoryEntry[]): string {
    if (items.length === 0) return "无"
    const selected = selectRecentItems(items, SOLVER_MEMORY_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Kind", "Content", "Refs", "Source", "Updated"],
        selected.map((item) => [
            item.id,
            item.kind,
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
        ["ID", "Status", "Idea", "Result", "Updated"],
        selected.map((item) => [
            item.id,
            item.status,
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
            `- Attempt count: ${challenge.attemptCount}`,
            `- Report count: ${challenge.reportCount}`,
            `- Active solver ids: ${challenge.activeSolverIds.length > 0 ? challenge.activeSolverIds.join(", ") : "none"}`,
            `- Untouched: ${challenge.untouched ? "yes" : "no"}`,
            `- Stale: ${challenge.stale ? "yes" : "no"}`,
            `- Idle instance: ${challenge.idleInstance ? "yes" : "no"}`,
            typeof challenge.activeForMinutes === "number" ? `- Active for minutes: ${challenge.activeForMinutes}` : "- Active for minutes: -",
            typeof challenge.minutesSinceLastAttempt === "number" ? `- Minutes since last attempt: ${challenge.minutesSinceLastAttempt}` : "- Minutes since last attempt: -",
            typeof challenge.minutesSinceLastReport === "number"
                ? `- Minutes since last report: ${challenge.minutesSinceLastReport}`
                : "- Minutes since last report: -",
            `#### URL Targets`,
            formatAssetTargetTable(challenge.assets.urls, "No URL targets."),
            `#### IP Targets`,
            formatAssetTargetTable(challenge.assets.ips, "No IP targets."),
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
            stale: challenge.stale,
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
        getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
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
    private api: ChallengeApiClient | undefined
    private rootDir: string | undefined
    private runtime: RuntimeManager | undefined
    private syncLoopStarted = false
    private loopTickCount = 0
    private finishingChallenges = new Set<string>()
    private plannerRunning = false
    private noisyErrorLogState = new Map<string, { lastLoggedAt: number; suppressedCount: number }>()

    constructor(config: ConfigManager) {
        this.config = config
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

    reloadFromConfig(): void {
        this.api = undefined
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
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
        return (await this.listChallengesSafe("challenge-planner:pending-assets-check")).some((challenge) => this.hasSchedulablePendingAssetTargets(challenge))
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

    private broadcastChallengeBoardUpdateToRunningSolvers(challengeId: string, message: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const text = message.trim()
        if (!runtime || !targetChallengeId || !text) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
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
            return
        } finally {
            this.plannerRunning = false
        }
    }

    private runPlannerInBackground(challengeId: string | undefined, source: string): void {
        if (this.plannerRunning) return
        if (!this.runtime) return
        this.plannerRunning = true
        const scopedChallengeId = challengeId?.trim()
        void (async () => {
            try {
                if (scopedChallengeId) {
                    const challenge = await this.readVisibleChallenge(scopedChallengeId)
                    if (!this.hasSchedulablePendingAssetTargets(challenge)) return
                } else if (!(await this.hasAnyPendingAssetTargets())) {
                    return
                }
                if (!(await this.hasAvailableSolverSlot())) return

                if (scopedChallengeId) await this.updateChallengePlannerStatus(scopedChallengeId, "starting")
                if (scopedChallengeId) await this.updateChallengePlannerStatus(scopedChallengeId, "running")
                const result = await this.runPlannerOnce(source, scopedChallengeId ? { challengeId: scopedChallengeId } : undefined)
                if (scopedChallengeId && result.launchedSolvers.length === 0) {
                    await this.refreshChallengePlannerStatusFromSolvers(scopedChallengeId)
                }
            } catch (error) {
                this.error("challenge:planner", "background planner failed", error, { source, challengeId: scopedChallengeId })
                if (scopedChallengeId) {
                    await this.updateChallengePlannerStatus(scopedChallengeId, "stop").catch((statusError) => {
                        this.error("challenge:planner", "failed to reset planner status", statusError, { source, challengeId: scopedChallengeId })
                    })
                }
            } finally {
                this.plannerRunning = false
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
                    const challenges = await listStored()
                    return {
                        current_level: challenges.reduce((max, challenge) => Math.max(max, challenge.level), 0),
                        total_challenges: challenges.length,
                        solved_challenges: challenges.filter((challenge) => computeChallengeCompleted(challenge)).length,
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
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        return readChallengeRecord(rootDir, id)
    }

    private async getContext(): Promise<{ api: ChallengeApiClient; rootDir: string }> {
        const api = await this.getApi()
        const rootDir = await this.getRootDir()
        return { api, rootDir }
    }

    async listChallenges(source = "challenge-api:list"): Promise<ChallengeListResult> {
        const { api, rootDir } = await this.getContext()
        const remote = await api.listChallenges()
        for (const challenge of remote.challenges) {
            const next = mapApiChallengeToRecord(challenge)
            const existing = await readChallengeRecord(rootDir, next.id)
            await saveChallengeRecord(
                rootDir,
                {
                    ...next,
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
        const local = await listChallengeRecords(rootDir)
        return {
            remote,
            local,
            summary: {
                remote: remote.challenges.length,
                local: local.length,
                solved: remote.solved_challenges,
                total: remote.total_challenges,
            },
        }
    }

    async listChallengesSafe(_source = "challenge-api:list"): Promise<ChallengeInfoRecord[]> {
        return this.listStoredChallenges()
    }

    async listStoredChallenges(): Promise<ChallengeInfoRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeRecords(rootDir)
    }

    async createChallenge(challenge: ChallengeRecord, source = "manual"): Promise<ChallengeInfoRecord | undefined> {
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
        return this.createChallenge(createChallengeRecord({ ...input, id }), source)
    }

    async updateChallengePlannerPrompt(challengeId: string, plannerPrompt: string | null): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.readVisibleChallenge(id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
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

    async startChallenge(challengeId: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
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
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
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

    async submitReport(challengeId: string, input: { assetHash: string; report: string } & ChallengeSubmissionMeta): Promise<ChallengeReportResult> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const assetHash = requireText(input.assetHash, "assetHash")
        const report = requireText(input.report, "report")
        const current = await this.readVisibleChallenge(id)
        if (!current) throw new Error(`challenge "${id}" not found`)
        const assets = current.assets ?? EMPTY_ASSETS
        const match = findAssetByHash(assets, assetHash)
        if (!match) {
            throw new Error(`asset hash "${assetHash}" not found`)
        }

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
            solverId: input.solverId,
            promptName: input.promptName,
            modelName: input.modelName,
            assetHash,
            asset: match.asset.asset,
            report,
        })
        const wasScanned = match.asset.scanned
        let challenge = current
        if (!wasScanned) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...current,
                    assets: {
                        ...assets,
                        [match.group]: assets[match.group].map((item) => item.asset_hash === assetHash ? { ...item, scanned: true } : item),
                    },
                },
                "challenge:asset-scanned",
            )
            const updated = await this.readVisibleChallenge(id)
            if (!updated) throw new Error(`challenge "${id}" not found`)
            challenge = updated
            if (this.hasSchedulablePendingAssetTargets(updated)) {
                this.runPlannerInBackground(id, "challenge-planner:asset-updated")
            }
        }
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
            setTimeout(() => {
                void this.finishChallenge(id)
            }, 0)
        }
        return {
            submission,
            challenge,
            assets_total: assetsTotal,
            assets_scanned: assetsScanned,
            assets_pending: assetsPending,
            assets_completed: assetsCompleted,
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

    async appendMemory(input: AddMemoryInput): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await appendChallengeMemory(rootDir, input)
        this.broadcastChallengeBoardUpdateToRunningSolvers(input.challengeId, formatChallengeMemoryBroadcastMessage("added", entry))
        return entry
    }

    async listMemory(challengeId: string): Promise<MemoryEntry[]> {
        const rootDir = await this.getRootDir()
        return listChallengeMemory(rootDir, challengeId)
    }

    async updateMemory(challengeId: string, entryIdOrPrefix: string, patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string }): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await updateChallengeMemory(rootDir, challengeId, entryIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("updated", entry))
        return entry
    }

    async deleteMemory(challengeId: string, entryIdOrPrefix: string): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await deleteChallengeMemory(rootDir, challengeId, entryIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("deleted", entry))
        return entry
    }

    async listIdeas(challengeId: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeIdeas(rootDir, challengeId)
    }

    async searchIdeas(challengeId: string, query: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return searchChallengeIdeas(rootDir, challengeId, query)
    }

    async addIdea(challengeId: string, input: AddIdeaInput): Promise<AddIdeaResult> {
        const rootDir = await this.getRootDir()
        const result = await addChallengeIdea(rootDir, challengeId, input)
        if (result.created) {
            this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("added", result.item))
        }
        return result
    }

    async updateIdea(challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await updateChallengeIdea(rootDir, challengeId, ideaIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("updated", item))
        return item
    }

    async deleteIdea(challengeId: string, ideaIdOrPrefix: string): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await deleteChallengeIdea(rootDir, challengeId, ideaIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("deleted", item))
        return item
    }

    async appendAttemptLog(input: { challengeId: string; solverId: string; promptName: string; task: string }) {
        const rootDir = await this.getRootDir()
        return appendChallengeAttemptLog(rootDir, input)
    }

    async listAttemptLogs(challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeAttemptLogs(rootDir, challengeId)
    }

    async listSubmissionLogs(challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeSubmissionLogs(rootDir, challengeId)
    }

    async refreshStats(challengeId: string): Promise<{ stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }> {
        const rootDir = await this.getRootDir()
        return refreshChallengeStats(rootDir, challengeId)
    }

    async deleteChallenge(challengeId: string): Promise<void> {
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.getChallenge(id)
        if (!challenge) {
            throw new Error(`challenge "${id}" not found`)
        }

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

    async launchSolver(challengeId: string, promptName: string, options?: LaunchSolverOptions): Promise<SolverInstance> {
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
        if (computeChallengeCompleted(current)) {
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        let challenge: ChallengeInfoRecord | undefined = current
        if (current.instance_status === "running" || current.instance_status === "pending") {
            this.log("challenge:solver", "reuse running challenge instance", {
                challengeId,
                instanceStatus: current.instance_status,
                entrypoint: current.entrypoint ?? null,
            })
        } else {
            const started = await this.startChallenge(challengeId)
            challenge = started.challenge ?? (await this.getChallenge(challengeId))
        }
        if (!challenge) {
            throw new Error(`challenge "${challengeId}" not found after start`)
        }
        if (computeChallengeCompleted(challenge)) {
            void this.finishChallenge(challengeId)
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        const solverId = crypto.randomUUID().slice(0, 8)
        const task = await this.buildSolverTask(challenge, options)
        try {
            await this.seedSolverBoardFromChallenge(solverId, challengeId)
        } catch (error) {
            this.error("challenge:solver", "failed to seed solver board from challenge context", error, {
                challengeId,
                solverId,
            })
        }
        const solver = await this.runtime.launch(promptNameText, task, { [CHALLENGE_ENV_CHALLENGE_ID]: challengeId }, { solverId })
        await this.updateChallengePlannerStatus(challengeId, "running")
        await this.appendAttemptLog({
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            task: solver.task,
        })
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
            await Promise.allSettled(active.map((solver) => this.runtime!.stopSolver(solver.id)))
            await this.updateChallengePlannerStatus(id, "stop")
            this.log("challenge:finish", "finished solved challenge cleanup", { challengeId: id, stoppedSolvers: active.map((solver) => solver.id) })
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

        const previousRound = await this.readPreviousPlannerRound(options?.challengeId)
        const resourceLoader = wrapPlannerResourceLoader(sessionOpts.resourceLoader, snapshot, previousRound, options?.preferredPromptName)
        await resourceLoader.reload()
        const launchedSolvers: SolverInstance[] = []

        const { session } = await createAgentSession({
            ...sessionOpts,
            resourceLoader,
            customTools: [...(sessionOpts.customTools ?? []), ...this.createPlannerTools(snapshot, launchedSolvers)],
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
            }
            if (event.type === "tool_execution_start") {
                plannerActions.set(event.toolCallId, `${event.toolName} ${JSON.stringify(event.args ?? {})}`)
            }
            if (event.type === "tool_execution_end" && event.isError) {
                this.error("challenge:planner", "planner tool failed", undefined, { toolName: event.toolName, result: event.result })
            }
        })

        await session.prompt(
            options?.challengeId
                ? `开始当前项目调度。challengeId=${options.challengeId}${options.preferredPromptName ? `，用户选择的 solver prompt=${options.preferredPromptName}` : ""}。如果需要启动 solver，优先使用用户选择的 prompt。`
                : "开始本轮比赛调度。",
        )
        session.dispose()
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
        await this.writePreviousPlannerRound(
            {
                generated_at: new Date().toISOString(),
                snapshot_digest: computePlannerSnapshotDigest(snapshot),
                actions: [...plannerActions.values()],
                summary: plannerText,
            },
            options?.challengeId,
        )
        return { message: plannerMessage || plannerStopReason || "", stopReason: plannerStopReason, launchedSolvers }
    }

    private createPlannerTools(snapshot: PlannerSnapshot, launchedSolvers?: SolverInstance[]): ToolDefinition[] {
        const emptyObject = Type.Object({})
        const challengeIds = snapshot.challenges.map((challenge) => challenge.id)
        const solverPromptNames = snapshot.availableSolverPrompts.map((prompt) => prompt.name)
        const activeSolverIds = snapshot.activeSolvers.map((solver) => solver.id)
        const snapshotChallenges = new Map(snapshot.challenges.map((challenge) => [challenge.id, challenge]))
        const snapshotSolvers = new Map(snapshot.activeSolvers.map((solver) => [solver.id, solver]))
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
                    "Launch a solver for a challenge. Always include entrypoints and solverHandoff: a concise solver-facing startup brief distilled from current project state.",
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
                    solverHandoff: Type.String({
                        minLength: 1,
                        maxLength: 1200,
                        description: "Short solver-facing startup note. Include only solver-executable guidance relevant to this challenge.",
                    }),
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (!challenge) throw new Error(`challenge "${params.challengeId}" not found`)
                    const promptName = requireText(params.promptName, "promptName")
                    const entrypoints = requirePlannerAssetEntrypoints(params.entrypoints, "entrypoints")
                    const allowedEntryPoints = collectPlannerChallengeEntryPoints(challenge)
                    const invalidEntryPoints = entrypoints.filter((entrypoint) => allowedEntryPoints.get(entrypoint.asset_hash) !== entrypoint.asset)
                    if (invalidEntryPoints.length > 0) {
                        throw new Error(`entrypoints contain invalid asset hash/target pairs for challenge "${params.challengeId}": ${invalidEntryPoints.map((entrypoint) => entrypoint.asset_hash).join(", ")}`)
                    }
                    const solverHandoff = clipTaskText(requireText(params.solverHandoff, "solverHandoff"), SOLVER_HANDOFF_MAX_CHARS)
                    this.log("challenge:planner-tool", "launch solver requested", { challengeId: params.challengeId, promptName, entrypoints })
                    try {
                        const solver = await this.launchSolver(params.challengeId, promptName, { plannerHandoff: solverHandoff, entrypoints })
                        launchedSolvers?.push(solver)
                        return {
                            content: [{ type: "text", text: JSON.stringify(solver, null, 2) }],
                            details: solver,
                        }
                    } catch (error) {
                        this.error("challenge:planner-tool", "launch solver failed", error, { challengeId: params.challengeId, promptName })
                        throw error
                    }
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
        const challenges = await this.listChallengesSafe(source)
        const targetChallengeId = challengeId?.trim()
        if (targetChallengeId && !challenges.some((item) => item.id === targetChallengeId)) {
            throw new Error(`challenge "${targetChallengeId}" not found`)
        }
        const solvers = await runtime.listAll()
        const activeSolvers = solvers.filter(isActiveSolver)
        const activeChallengeIds = new Set(activeSolvers.map((solver) => solver.challengeId).filter((id): id is string => typeof id === "string" && id.trim().length > 0))
        const activeInstanceChallenges = challenges.filter(isActiveChallengeInstance)
        const activeInstanceChallengeIds = new Set(activeInstanceChallenges.map((challenge) => challenge.id))
        const schedulable = challenges.filter((item) => {
            const activeInstance = activeInstanceChallengeIds.has(item.id)
            if (computeChallengeCompleted(item) && !activeInstance) return false
            if (targetChallengeId) return item.id === targetChallengeId
            return this.hasSchedulablePendingAssetTargets(item) || (this.isPlannerEnabled(item) && (activeChallengeIds.has(item.id) || activeInstance))
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
                const [attempts, submissions] = await Promise.all([this.listAttemptLogs(challenge.id), this.listSubmissionLogs(challenge.id)])
                return this.buildPlannerSnapshotItem(challenge, attempts, submissions, activeSolvers, staleTimeoutMs)
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
            urlTargetCount: challenge.assets?.urls.length ?? 0,
            ipTargetCount: challenge.assets?.ips.length ?? 0,
            scannedTargetCount: countScannedAssets(challenge.assets ?? { urls: [], ips: [] }),
            pendingTargetCount: countPendingAssets(challenge.assets ?? { urls: [], ips: [] }),
            plannerPrompt: challenge.planner_prompt ?? null,
            entrypoint: challenge.entrypoint,
            attemptCount: attempts.length,
            reportCount: submissions.length,
            untouched: attempts.length === 0,
            stale: Boolean(oldestActiveSolverAt && Date.now() - oldestActiveSolverAt >= staleTimeoutMs && submissions.length === 0),
            idleInstance,
            activeSolverCount: challengeSolvers.length,
            activeSolverIds: challengeSolvers.map((solver) => solver.id),
            activeForMinutes: formatMinutesFromTimestamp(oldestActiveSolverAt),
            minutesSinceLastAttempt: formatMinutesFromTimestamp(lastAttemptAt),
            minutesSinceLastReport: formatMinutesFromTimestamp(lastReportAt),
        }
    }

    private async buildSolverTask(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions): Promise<string> {
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
        const [memoryItems, ideaItems, submissionItems] = await Promise.all([this.listMemory(challenge.id), this.listIdeas(challenge.id), this.listSubmissionLogs(challenge.id)])
        const entrypoint = entrypoints.map((item) => `- [${item.asset_hash}] ${item.asset}`).join("\n")
        const plannerHandoff = options?.plannerHandoff?.trim()
        return [
            `你正在处理一个 CTF 项目，目的是通过自动化测试进行安全检测，没有flag。`,
            ``,
            `项目名: ${getChallengeDisplayName(challenge)}`,
            ``,
            `项目描述:`,
            challenge.description.trim() || "无",
            ``,
            `目标入口:`,
            entrypoint,
            ``,
            `当前 Memory 摘要:`,
            formatSolverMemorySection(memoryItems),
            ``,
            `当前 Ideas 摘要:`,
            formatSolverIdeasSection(ideaItems),
            ``,
            `当前 Submissions 摘要:`,
            formatSolverSubmissionsSection(submissionItems),
            ``,
            `要求:`,
            `- 以当前项目为唯一目标推进；完成某个资产测试后，立刻调用 challenge_submit_report 提交该资产的详细报告`,
            `- 如果一直找不到突破口，并且你觉得已经没有推进的必要，以当前已有的情报完成任务，并通过 challenge_submit_report 进行报告提交`,
            `- 优先基于现有提示、资产信息和项目描述推进，非必要不要偏离目标（如果用户指定说要扫旁路资产）`,
            `- 如果卡住了，可以适当尝试一些可能的攻击手段，但不要偏离项目太远`,
            `- 上面的 memory / ideas 已在 solver 启动时作为初始背景拼接给你；后续 observer 会在这个基础上继续维护 memory / ideas`,
            `- 初始上下文只带了压缩摘要；运行中如果需要整理和回看当前 memory / ideas，按需调用 memory_list / idea_list / idea_search`,
            `- 如需切换路线，优先先看 idea_list / idea_search`,
            `- 在决定攻击方向前，先看当前 Submissions 摘要，优先理解哪些入口、突破口、漏洞链已经验证过，避免无差别重复劳动`,
            `- 在重复某条路线、上下文变长、或怀疑自己忘了已验证的结论时，先看 memory_list`,
            `- 当你拿到了值得当前 solver 跨轮保留的事实、证据、失败边界、题目提示时，在回答和工具验证结果中清楚保留证据与边界，observer 会据此维护 memory`,
            `- 每个目标入口都有独立的 asset_hash；完成该入口测试后，使用对应 asset_hash 单独调用 challenge_submit_report，不要按 host 合并或替代`,
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
