import type { AddResult, HostSettings } from "../../../core/src/config/index"
import type { ChallengeAssetRecord, ChallengeAssetsRecord, ChallengeInfoRecord, ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "../../../core/src/challenge/store"
import type { AddIdeaResult, IdeaRecord, MemoryEntry } from "../../../core/src/challenge/manager"
import type { AttackTimelineEvent, AttackTimelineEventKind, AttackTimelineSnapshot } from "../../../core/src/challenge/attack-timeline"
import type { ChallengeStatsOverview, ChallengeStatsOverviewBucket, ChallengeStatsRecord, SolverStatsRecord } from "../../../core/src/challenge/stats"
import type { McpServerItem, ProbeResult } from "../../../core/src/config/mcp/index"
import type { PromptFile } from "../../../core/src/config/prompts/index"
import type { BuiltInProvider, ConfiguredModel, ModelConfigEntry, ModelDefinition, ProviderPrefEntry } from "../../../core/src/config/providers/types"
import type { ToolEntry } from "../../../core/src/config/tools/index"
import type { RuntimeMessageThread, RuntimeSolverDetails, SolverInstance } from "../../../core/src/runtime/types"
import type { Skill } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ServerEntry as McpServerEntry, McpSettings } from "pi-mcp-adapter/types.js"

// 从 @tch/core re-export，前端组件直接用
export type {
    AddResult,
    HostSettings,
    ModelConfigEntry,
    ModelDefinition,
    ToolEntry,
    ChallengeInfoRecord,
    ChallengeAssetRecord,
    ChallengeAssetsRecord,
    ChallengeAttemptLogRecord,
    ChallengeSubmissionLogRecord,
    ChallengeStatsRecord,
    ChallengeStatsOverview,
    ChallengeStatsOverviewBucket,
    AttackTimelineEvent,
    AttackTimelineEventKind,
    AttackTimelineSnapshot,
    SolverStatsRecord,
    MemoryEntry,
    IdeaRecord,
    McpServerEntry,
    McpServerItem,
    McpSettings,
    BuiltInProvider,
    ConfiguredModel,
    PromptFile,
    ProbeResult,
    SolverInstance,
    RuntimeMessageThread,
    RuntimeSolverDetails,
    Skill,
    Model,
    Api,
}
export type ProviderEntry = ProviderPrefEntry

// ── HTTP helpers ──

export interface AuthUser {
    id: string
    username: string
    createdAt: string
}

export interface AuthResult {
    user: AuthUser
    token: string
}

const AUTH_TOKEN_STORAGE_KEY = "tch-auth-token"

export function getAuthToken(): string | undefined {
    if (typeof localStorage === "undefined") return
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? undefined
}

export function setAuthToken(token: string): void {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
}

export function clearAuthToken(): void {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

function withAuthInit(init?: RequestInit): RequestInit | undefined {
    const token = getAuthToken()
    if (!token) return init

    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return { ...init, headers }
}

export function eventSourceUrl(url: string): string {
    const token = getAuthToken()
    if (!token) return url

    const resolved = new URL(url, location.origin)
    resolved.searchParams.set("token", token)
    return `${resolved.pathname}${resolved.search}`
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, withAuthInit(init))
    const text = await res.text()
    const body = text ? safeParseJson(text) : null
    if (!res.ok) {
        const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`
        throw new Error(message)
    }
    return body as T
}

function safeParseJson(text: string): Record<string, unknown> | unknown {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function resolveErrorMessage(status: number, statusText: string, body: unknown): string {
    return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${status} ${statusText}`
}

function parseDownloadFileName(contentDisposition: string | null): string | undefined {
    if (!contentDisposition) return

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1])
        } catch {
            return utf8Match[1]
        }
    }

    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
    return plainMatch?.[1]
}

function post(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

function del(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

function patch(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

async function download(url: string): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(url, withAuthInit())
    if (!res.ok) {
        const text = await res.text()
        throw new Error(resolveErrorMessage(res.status, res.statusText, text ? safeParseJson(text) : null))
    }

    return {
        blob: await res.blob(),
        fileName: parseDownloadFileName(res.headers.get("Content-Disposition")) ?? "download.bin",
    }
}

// ── API Keys ──

export const auth = {
    settings: () => json<{ registrationEnabled: boolean }>("/api/auth/settings"),
    register: (username: string, password: string) =>
        json<AuthResult>("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        }),
    login: (username: string, password: string) =>
        json<AuthResult>("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        }),
    me: () => json<{ user: AuthUser }>("/api/auth/me"),
}

export const apiKeys = {
    list: () => json<string[]>("/api/config/api-keys"),
    set: (provider: string, key: string) => post("/api/config/api-keys", { provider, key }),
    remove: (provider: string) => del("/api/config/api-keys", { provider }),
}

// ── Providers ──

export const providers = {
    list: () => json<ProviderEntry[]>("/api/config/providers"),
    add: (entry: Omit<ProviderEntry, "id" | "hash"> & { id?: string }) =>
        json<AddResult>("/api/config/providers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        }),
    update: (id: string, fields: Partial<ProviderEntry>) =>
        json<AddResult>("/api/config/providers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...fields }),
        }),
    remove: (id: string) => del("/api/config/providers", { id }),
}

// ── Models ──

export const models = {
    list: () => json<Model<Api>[]>("/api/config/models"),
}

export const providerModels = {
    list: () => json<ConfiguredModel[]>("/api/config/provider-models"),
    add: (provider: string, model: ModelDefinition) => post("/api/config/provider-models", { provider, model }),
    remove: (provider: string, modelId: string) => del("/api/config/provider-models", { provider, modelId }),
}

export const modelPrefs = {
    list: () => json<ModelConfigEntry[]>("/api/config/model-prefs"),
    add: (entry: ModelConfigEntry) =>
        json<AddResult>("/api/config/model-prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        }),
    remove: (id: string) => del("/api/config/model-prefs", { id }),
    test: (id: string) =>
        json<{
            ok: boolean
            error?: string
            response?: string
            details?: {
                modelPrefId: string
                provider: string
                providerId?: string
                providerLabel: string
                runtimeProvider: string
                modelId: string
                api?: string
                baseUrl?: string
                baseOrigin?: string
                baseHost?: string
                basePath?: string
                thinkingLevel?: string
                reasoning?: boolean
                contextWindow?: number
                maxTokens?: number
                apiKeySummary?: string
                headers?: Record<string, string>
                compat?: Record<string, unknown>
            }
        }>("/api/config/test-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        }),
}

// ── Skills ──

export const skills = {
    list: () => json<Pick<Skill, "name" | "description" | "filePath">[]>("/api/config/skills"),
    upload: async (file: File) => {
        const form = new FormData()
        form.append("file", file)
        const res = await fetch("/api/config/skills", withAuthInit({ method: "POST", body: form }))
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || `${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<{ name: string }>
    },
    remove: (name: string) => del("/api/config/skills", { name }),
    content: (name: string) => json<{ content: string }>(`/api/config/skills/${encodeURIComponent(name)}/content`),
    installFromGit: async (url: string) => {
        const res = await fetch("/api/config/skills-git", withAuthInit({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        }))
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || `${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<{ name: string }>
    },
}

// ── Prompts ──

export const prompts = {
    listAgents: () => json<PromptFile[]>("/api/config/prompts?type=agent"),
    listSubagents: () => json<PromptFile[]>("/api/config/prompts?type=subagent"),
    set: (prompt: PromptFile) => post("/api/config/prompts", prompt),
    remove: (name: string) => del("/api/config/prompts", { name }),
}

// ── Tools ──

export const tools = {
    list: () => json<ToolEntry[]>("/api/config/tools"),
}

// ── MCP Servers ──

export const mcpServers = {
    list: () => json<McpServerItem[]>("/api/config/mcp"),
    add: (name: string, server: McpServerEntry) => post("/api/config/mcp", { name, server }),
    remove: (name: string) => del("/api/config/mcp", { name }),
    update: (name: string, server: Partial<McpServerEntry>, newName?: string) => patch("/api/config/mcp", { name, server, newName }),
    probe: (name?: string) =>
        json<ProbeResult | ProbeResult[]>("/api/config/mcp-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        }),
    probeDraft: (name: string, server: McpServerEntry) =>
        json<ProbeResult>("/api/config/mcp-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, server }),
        }),
}

// ── MCP Settings ──

export const mcpSettings = {
    get: () => json<McpSettings>("/api/config/mcp-settings"),
    set: (settings: McpSettings) => post("/api/config/mcp-settings", settings),
}

export const hostSettings = {
    get: () => json<HostSettings>("/api/config/host-settings"),
    set: (settings: Partial<HostSettings>) =>
        json<HostSettings>("/api/config/host-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
        }),
}

export const hostPlannerPrompt = {
    get: () => json<PromptFile>("/api/config/host-planner-prompt"),
    set: (content: string, model?: string) =>
        json<PromptFile>("/api/config/host-planner-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, model }),
        }),
}

export interface ChallengeDetails {
    challenge: ChallengeInfoRecord
    memory: MemoryEntry[]
    ideas: IdeaRecord[]
    attempts: ChallengeAttemptLogRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    stats: ChallengeStatsRecord
    solver_stats: SolverStatsRecord[]
    solvers: SolverInstance[]
    authority_work?: import("../authorized-work-view").AuthorizedWorkItemView[]
    authority_coverage?: import("../authorized-work-view").AuthorizedCoverageCellView[]
    authority_reports?: import("../authorized-work-view").AuthorizedReportIndexView[]
    authority_read_seq?: number
    lifecycle?: {
        challengeId: string
        runtime: "running" | "stopping" | "stopped" | "unknown"
        assignmentPhase: string
        reportPhase: "none" | "incremental" | "final" | "pending_commit"
        reviewState: string
        finalizationState: "open" | "unknown"
        pendingDiagnostics: string[]
    }
}

export type ChallengeListItem = ChallengeInfoRecord & {
    submission_count: number
}

export interface CreateChallengePayload {
    name: string
    description?: string
    assetsUrl?: string[] | null
    assetsIp?: string[] | null
    plannerPrompt?: string | null
    plannerEnabled?: boolean
}

export interface StartSolverAccepted {
    accepted: true
    challengeId: string
    promptName: string
    message: string
}

export const challenges = {
    list: () => json<ChallengeListItem[]>("/api/challenges"),
    create: (input: CreateChallengePayload) =>
        json<ChallengeInfoRecord>("/api/challenges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    get: (id: string) => json<ChallengeDetails>(`/api/challenges/${encodeURIComponent(id)}`),
    plannerPrompt: (id: string) => json<{ content: string }>(`/api/challenges/${encodeURIComponent(id)}/planner-prompt`),
    updatePlannerPrompt: (id: string, content: string | null) =>
        json<{ content: string; challenge: ChallengeInfoRecord }>(`/api/challenges/${encodeURIComponent(id)}/planner-prompt`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
        }),
    updatePlannerEnabled: (id: string, enabled: boolean) =>
        json<{ enabled: boolean; challenge: ChallengeInfoRecord }>(`/api/challenges/${encodeURIComponent(id)}/planner-enabled`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        }),
    markAssetScanned: (id: string, input: { group: "urls" | "ips" | "url" | "ip"; asset: string; scanned?: boolean }) =>
        json<ChallengeInfoRecord>(`/api/challenges/${encodeURIComponent(id)}/assets/scanned`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    attackTimeline: (id: string) => json<AttackTimelineSnapshot>(`/api/challenges/${encodeURIComponent(id)}/attack-timeline`),
    exportSolverSessions: (id: string) => download(`/api/challenges/${encodeURIComponent(id)}/solver-sessions.zip`),
    startSolver: (id: string, promptName: string) =>
        json<StartSolverAccepted>(`/api/challenges/${encodeURIComponent(id)}/solvers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptName }),
        }),
    addMemory: (id: string, input: { kind: MemoryEntry["kind"]; content: string; refs?: string[]; source?: string }) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    updateMemory: (
        id: string,
        entryId: string,
        patch: { kind?: MemoryEntry["kind"]; content?: string; refs?: string[]; source?: string },
    ) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory/${encodeURIComponent(entryId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }),
    deleteMemory: (id: string, entryId: string) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory/${encodeURIComponent(entryId)}`, {
            method: "DELETE",
        }),
    addIdea: (id: string, input: { content: string; status?: IdeaRecord["status"]; result?: string }) =>
        json<AddIdeaResult>(`/api/challenges/${encodeURIComponent(id)}/ideas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    updateIdea: (
        id: string,
        ideaId: string,
        patch: { content?: string; status?: IdeaRecord["status"]; result?: string },
    ) =>
        json<IdeaRecord>(`/api/challenges/${encodeURIComponent(id)}/ideas/${encodeURIComponent(ideaId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }),
    deleteIdea: (id: string, ideaId: string) =>
        json<IdeaRecord>(`/api/challenges/${encodeURIComponent(id)}/ideas/${encodeURIComponent(ideaId)}`, {
            method: "DELETE",
        }),
    remove: (id: string) =>
        json<{ ok: boolean }>(`/api/challenges/${encodeURIComponent(id)}`, {
            method: "DELETE",
        }),
    statsOverview: () => json<ChallengeStatsOverview>("/api/challenges/stats-overview"),
}

// ── Built-in Reference ──

export const builtIn = {
    providers: () => json<BuiltInProvider[]>("/api/config/built-in/providers"),
    protocols: () => json<string[]>("/api/config/built-in/protocols"),
    models: (provider: string) => json<Model<Api>[]>(`/api/config/built-in/models/${encodeURIComponent(provider)}`),
    lookupModel: (api: string, modelId: string) =>
        json<Model<Api> | null>(`/api/config/built-in/model-lookup?api=${encodeURIComponent(api)}&modelId=${encodeURIComponent(modelId)}`),
    discoverModels: (provider: string) => json<Array<{ id: string; name: string }>>(`/api/config/discover-models/${encodeURIComponent(provider)}`),
}

// ── Runtime (Container Management) ──

export interface RuntimeStatus {
    docker: boolean
    solvers: number
}

export const runtime = {
    status: () => json<RuntimeStatus>("/api/runtime/status"),
    list: () => json<SolverInstance[]>("/api/runtime/solvers"),
    start: (promptName: string, task: string) =>
        json<SolverInstance>("/api/runtime/solvers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptName, task }),
        }),
    get: (id: string) => json<RuntimeSolverDetails>(`/api/runtime/solvers/${id}`),
    stop: (id: string) => json<{ ok: boolean }>(`/api/runtime/solvers/${id}`, { method: "DELETE" }),
    send: (id: string, message: Record<string, unknown>) => post(`/api/runtime/solvers/${id}/message`, message),
}
