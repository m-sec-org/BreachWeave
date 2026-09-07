import { resolve } from "path"
import { mkdir } from "fs/promises"
import { homedir } from "os"
import { AuthStorage, ModelRegistry, SettingsManager, DefaultResourceLoader, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent"
import type { Skill, ToolDefinition, CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { createMcpAdapter } from "pi-mcp-adapter"
import type { ThinkingLevel } from "@mariozechner/pi-agent-core"
import { getProviders, getApiProviders, supportsXhigh, completeSimple } from "@mariozechner/pi-ai"
import type { Model, Api, KnownProvider, Context, ThinkingLevel as PiAiThinkingLevel } from "@mariozechner/pi-ai"
import * as prompts from "./prompts/index"
import type { PromptFile } from "./prompts/index"
import { customProviders } from "./providers/custom"
import { discoverModelsForProvider } from "./providers/discovery"
import type { DiscoveredModel } from "./providers/discovery"
import type { ModelDefinition, ModelConfigEntry, ProviderPrefEntry, BuiltInProvider, ConfiguredModel } from "./providers/types"
import { customTools, builtinToolDefinitions, builtinToolMap } from "./tools/index"
import { challengeToolNames } from "./tools/challenge-tools"
import { createSubagentTool } from "./tools/subagent"
import type { ToolEntry } from "./tools/index"
import * as skills from "./skills/index"
import type { ServerEntry, McpConfig, McpSettings } from "pi-mcp-adapter/types.js"
import { formatToolName } from "pi-mcp-adapter/types.js"
import * as mcp from "./mcp/index"
import type { McpServerItem, McpToolCache } from "./mcp/index"
import type { AddResult, HostRuntimeSettings, HostPlannerSettings, HostAuthSettings, HostSettings } from "./types"
export type { AddResult, HostRuntimeSettings, HostPlannerSettings, HostAuthSettings, HostSettings } from "./types"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../challenge/env"

export interface ResolvePromptSessionOptions {
    appendChallengeReportPrompt?: boolean
}

function computeHash(obj: Record<string, unknown>): string {
    const { id: _, hash: __, ...rest } = obj
    const canonical = JSON.stringify(rest, Object.keys(rest).sort())
    return Bun.hash(canonical).toString(16)
}

function providerRuntimeName(providerId: string): string {
    return `provider:${providerId}`
}

function findProviderPrefMatches(providerPrefs: ProviderPrefEntry[], providerName: string): ProviderPrefEntry[] {
    return providerPrefs.filter((entry) => entry.name === providerName)
}

function normalizeModelPrefProvider(entry: ModelConfigEntry, providerPrefs: ProviderPrefEntry[]): ModelConfigEntry {
    if (!entry.providerId) return entry
    const providerPref = providerPrefs.find((item) => item.id === entry.providerId)
    if (!providerPref || providerPref.name === entry.provider) return entry
    return { ...entry, provider: providerPref.name }
}

function stripModelTransportFields<T extends Record<string, unknown>>(entry: T): T {
    const { api: _api, baseUrl: _baseUrl, ...rest } = entry
    return rest as T
}

function sanitizeModelDefinition(entry: ModelDefinition): ModelDefinition {
    return stripModelTransportFields(entry as Record<string, unknown>) as ModelDefinition
}

function sanitizeModelDefinitions(models: unknown): ModelDefinition[] | undefined {
    if (!Array.isArray(models)) return
    const next = models
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => sanitizeModelDefinition(item as ModelDefinition))
        .filter((item) => typeof item.id === "string" && item.id.trim().length > 0)
    return next.length > 0 ? next : undefined
}

function normalizeStoredModelPref(entry: ModelConfigEntry, providerPrefs: ProviderPrefEntry[]): ModelConfigEntry {
    const normalized = normalizeModelPrefProvider(stripModelTransportFields(entry as Record<string, unknown>) as ModelConfigEntry, providerPrefs)
    return {
        ...normalized,
        hash: computeHash(normalized as unknown as Record<string, unknown>),
    }
}

function resolveModelProviderBinding(
    entry: Pick<ModelConfigEntry, "provider" | "providerId" | "modelId">,
    providerPrefs: ProviderPrefEntry[],
): { runtimeProvider: string; displayProvider: string; providerPref?: ProviderPrefEntry; error?: string } {
    if (entry.providerId) {
        const providerPref = providerPrefs.find((item) => item.id === entry.providerId)
        if (!providerPref) {
            return {
                runtimeProvider: providerRuntimeName(entry.providerId),
                displayProvider: entry.provider,
                error: `provider config ${entry.providerId} not found for ${entry.modelId}`,
            }
        }
        return {
            runtimeProvider: providerRuntimeName(providerPref.id),
            displayProvider: providerPref.name,
            providerPref,
        }
    }

    const matches = findProviderPrefMatches(providerPrefs, entry.provider)
    if (matches.length > 1) {
        return {
            runtimeProvider: entry.provider,
            displayProvider: entry.provider,
            error: `provider "${entry.provider}" is ambiguous; re-save model ${entry.modelId} with a specific provider config`,
        }
    }
    if (matches.length === 1) {
        return {
            runtimeProvider: providerRuntimeName(matches[0].id),
            displayProvider: matches[0].name,
            providerPref: matches[0],
        }
    }
    return {
        runtimeProvider: entry.provider,
        displayProvider: entry.provider,
    }
}

function resolveProviderRuntimeNameForLookup(provider: string, providerPrefs: ProviderPrefEntry[]): string {
    if (!provider) return provider
    if (provider.startsWith("provider:")) return provider

    const directMatch = providerPrefs.find((entry) => entry.id === provider)
    if (directMatch) return providerRuntimeName(directMatch.id)

    const nameMatches = findProviderPrefMatches(providerPrefs, provider)
    if (nameMatches.length === 1) return providerRuntimeName(nameMatches[0].id)

    return provider
}

function summarizeApiKey(apiKey?: string): string | undefined {
    const text = apiKey?.trim()
    if (!text) return
    if (text.length <= 16) return `${text.slice(0, 6)}...${text.slice(-4)}`
    if (text.length <= 28) return `${text.slice(0, 8)}...${text.slice(-6)}`
    return `${text.slice(0, 10)}...${text.slice(-8)}`
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
    const text = baseUrl?.trim()
    if (!text) return
    return text.replace(/\/+$/, "")
}

function canonicalizeBaseUrlForApi(api: string | undefined, baseUrl: string | undefined): string | undefined {
    const normalized = normalizeBaseUrl(baseUrl)
    if (!normalized) return
    if (api === "anthropic-messages" && normalized.endsWith("/v1")) {
        return normalized.slice(0, -3)
    }
    return normalized
}

function normalizeProviderPrefEntry(entry: ProviderPrefEntry): ProviderPrefEntry {
    const baseUrl = canonicalizeBaseUrlForApi(entry.api, entry.baseUrl)
    if (baseUrl === entry.baseUrl) return entry
    return { ...entry, baseUrl }
}

function resolveProviderTransport(config: Record<string, unknown> | undefined): { api?: string; baseUrl?: string } {
    const api = typeof config?.api === "string" ? config.api.trim() : ""
    const baseUrl = normalizeBaseUrl(typeof config?.baseUrl === "string" ? config.baseUrl : undefined)
    return {
        ...(api ? { api } : {}),
        ...(baseUrl ? { baseUrl } : {}),
    }
}

function applyProviderTransport<T extends Record<string, unknown>>(model: T, providerConfig: Record<string, unknown> | undefined): T {
    const transport = resolveProviderTransport(providerConfig)
    if (!transport.api && !transport.baseUrl) return model
    return {
        ...model,
        ...transport,
    }
}

function toPiAiThinkingLevel(value?: string): PiAiThinkingLevel | undefined {
    if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value
}

export const TCH_AGENT_HOME_DIR = resolve(homedir(), ".tch-agent")
export const DEFAULT_CONFIG_DIR = resolve(TCH_AGENT_HOME_DIR, "config")

export interface PromptSessionExtensionLike {
    factory: ExtensionFactory
    appendSystemPrompt?: string | (() => string | undefined) | undefined
}

function resolvePromptSessionExtensionFactory(extension: ExtensionFactory | PromptSessionExtensionLike): ExtensionFactory {
    return typeof extension === "function" ? extension : extension.factory
}

function resolvePromptSessionExtensionPrompt(extension: ExtensionFactory | PromptSessionExtensionLike): string | undefined {
    if (typeof extension === "function") return
    const value = typeof extension.appendSystemPrompt === "function" ? extension.appendSystemPrompt() : extension.appendSystemPrompt
    const text = value?.trim()
    return text ? text : undefined
}

export class ConfigManager {
    readonly dir: string
    readonly auth: AuthStorage
    readonly models: ModelRegistry
    readonly settings: SettingsManager
    private registeredTools = new Map<string, { def: ToolDefinition; source: string }>()
    private static instance: Promise<ConfigManager> | undefined
    private static instanceDir: string | undefined

    private constructor(dir: string) {
        this.dir = dir
        this.auth = AuthStorage.create(resolve(dir, "auth.json"))
        this.models = ModelRegistry.create(this.auth, resolve(dir, "models.json"))
        this.settings = SettingsManager.create(undefined, dir)
    }

    static async getInstance(configDir = DEFAULT_CONFIG_DIR): Promise<ConfigManager> {
        const dir = resolve(configDir)
        if (this.instance && this.instanceDir === dir) return this.instance

        const created = (async () => {
            const mgr = new ConfigManager(dir)
            await mgr.initialize()
            return mgr
        })()
        this.instanceDir = dir
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
                this.instanceDir = undefined
            }
            throw error
        })
        return this.instance
    }

    private async initialize(): Promise<void> {
        const configDir = this.dir
        const dirs = [configDir, resolve(configDir, "prompts"), resolve(configDir, "skills")]
        for (const d of dirs) await mkdir(d, { recursive: true })

        //配置重试
        this.settings.setRetryEnabled(true)
        this.settings.applyOverrides({
            retry: {
                enabled: true,
                maxRetries: 20,
                baseDelayMs: 1000,
                maxDelayMs: 60000,
            },
        })

        // 自定义 providers
        for (const p of customProviders) {
            this.models.registerProvider(p.name, p.config)
        }

        // SDK 内置工具
        for (const def of builtinToolDefinitions) {
            this.registeredTools.set(def.name, { def, source: "builtin" })
        }
        // 自定义工具
        for (const def of customTools) {
            this.registeredTools.set(def.name, { def, source: "custom" })
        }

    }

    // ── API Keys (auth.json via AuthStorage) ──

    setApiKey(provider: string, key: string) {
        this.auth.set(provider, { type: "api_key", key })
    }

    removeApiKey(provider: string) {
        this.auth.remove(provider)
    }

    getApiKey(provider: string) {
        return this.auth.get(provider)
    }

    getApiKeyValue(provider: string): string | undefined {
        const entry = this.auth.get(provider)
        return entry?.type === "api_key" ? entry.key : undefined
    }

    hasApiKey(provider: string): boolean {
        return !!this.auth.get(provider)
    }

    listApiKeys(): string[] {
        return this.auth.list()
    }

    // ── Provider Prefs (独立存储，支持同名 provider 多条配置) ──

    private providerPrefsPath() {
        return resolve(this.dir, "provider-prefs.json")
    }

    private async readProviderPrefs(): Promise<{ providers: ProviderPrefEntry[] }> {
        const file = Bun.file(this.providerPrefsPath())
        if (!(await file.exists())) return { providers: [] }
        return file.json()
    }

    private async writeProviderPrefs(data: { providers: ProviderPrefEntry[] }) {
        await Bun.write(this.providerPrefsPath(), JSON.stringify(data, null, 2))
    }

    async listProviderPrefs(): Promise<ProviderPrefEntry[]> {
        const data = await this.readProviderPrefs()
        return data.providers
    }

    async addProviderPref(entry: ProviderPrefEntry): Promise<AddResult> {
        entry = normalizeProviderPrefEntry(entry)
        if (!entry.id) entry.id = crypto.randomUUID().slice(0, 8)
        entry.hash = computeHash(entry as unknown as Record<string, unknown>)
        const data = await this.readProviderPrefs()

        // hash 相同则拒绝
        const dup = data.providers.find((p) => p.id !== entry.id && p.hash === entry.hash)
        if (dup) return { id: entry.id, rejected: `与已有配置 "${dup.name}" (${dup.id}) 完全相同` }

        const idx = data.providers.findIndex((p) => p.id === entry.id)
        if (idx >= 0) {
            data.providers[idx] = entry
        } else {
            data.providers.push(entry)
        }
        await this.writeProviderPrefs(data)

        // 同步到 models.json（运行时 provider key 使用唯一 id）
        await this.syncProviderToModelsJson(entry)
        return { id: entry.id }
    }

    async removeProviderPref(id: string) {
        const data = await this.readProviderPrefs()
        const entry = data.providers.find((p) => p.id === id)
        if (!entry) return
        data.providers = data.providers.filter((p) => p.id !== id)
        await this.writeProviderPrefs(data)

        const modelPrefs = await this.readModelPrefs()
        const removedModelIds = modelPrefs.models
            .filter((model) => model.providerId === id || (!model.providerId && model.provider === entry.name))
            .map((model) => model.id)
        if (removedModelIds.length > 0) {
            modelPrefs.models = modelPrefs.models.filter((model) => !removedModelIds.includes(model.id))
            await this.writeModelPrefs(modelPrefs)
        }

        await this.removeProvider(providerRuntimeName(entry.id))
        this.removeApiKey(providerRuntimeName(entry.id))
    }

    async updateProviderPref(id: string, patch: Partial<ProviderPrefEntry>): Promise<AddResult | undefined> {
        const data = await this.readProviderPrefs()
        const idx = data.providers.findIndex((p) => p.id === id)
        if (idx < 0) return
        const previous = data.providers[idx]
        const updated = normalizeProviderPrefEntry({ ...previous, ...patch })
        updated.hash = computeHash(updated as unknown as Record<string, unknown>)

        // hash 相同则拒绝
        const dup = data.providers.find((p) => p.id !== id && p.hash === updated.hash)
        if (dup) return { id, rejected: `与已有配置 "${dup.name}" (${dup.id}) 完全相同` }

        data.providers[idx] = updated
        await this.writeProviderPrefs(data)
        await this.syncProviderToModelsJson(updated)
        return { id }
    }

    private async syncProviderToModelsJson(entry: ProviderPrefEntry) {
        const runtimeProvider = providerRuntimeName(entry.id)
        const existing = (await this.getProvider(runtimeProvider)) ?? {}
        const config: Record<string, unknown> = {
            ...existing,
            displayName: entry.name,
            providerPrefId: entry.id,
        }
        if (entry.api) config.api = entry.api
        else delete config.api
        if (entry.baseUrl) config.baseUrl = entry.baseUrl
        else delete config.baseUrl
        await this.setProvider(runtimeProvider, config)
        if (entry.apiKey) {
            this.setApiKey(runtimeProvider, entry.apiKey)
        } else {
            this.removeApiKey(runtimeProvider)
        }
    }

    // ── Providers CRUD (models.json SDK 格式) ──

    private modelsJsonPath() {
        return resolve(this.dir, "models.json")
    }

    private async readModelsJson(): Promise<{ providers: Record<string, Record<string, unknown>> }> {
        const file = Bun.file(this.modelsJsonPath())
        if (!(await file.exists())) return { providers: {} }
        return file.json()
    }

    private async writeModelsJson(data: { providers: Record<string, Record<string, unknown>> }) {
        const providers = Object.fromEntries(
            Object.entries(data.providers).map(([name, config]) => {
                const nextConfig: Record<string, unknown> = { ...config }
                const models = sanitizeModelDefinitions(config.models)
                if (models) nextConfig.models = models
                else delete nextConfig.models
                return [name, nextConfig]
            }),
        )
        await Bun.write(this.modelsJsonPath(), JSON.stringify({ providers }, null, 2))
        this.models.refresh()
    }

    async getProvider(name: string): Promise<Record<string, unknown> | undefined> {
        const data = await this.readModelsJson()
        return data.providers[name]
    }

    async setProvider(name: string, config: Record<string, unknown>) {
        const data = await this.readModelsJson()
        data.providers[name] = config
        await this.writeModelsJson(data)
    }

    async removeProvider(name: string) {
        const data = await this.readModelsJson()
        delete data.providers[name]
        await this.writeModelsJson(data)
    }

    async listProviders(): Promise<string[]> {
        const data = await this.readModelsJson()
        return Object.keys(data.providers)
    }

    // ── Models (via ModelRegistry) ──

    listAllModels(): Model<Api>[] {
        return this.models.getAll() as Model<Api>[]
    }

    listAvailableModels(): Model<Api>[] {
        return this.models.getAvailable() as Model<Api>[]
    }

    findModel(provider: string, modelId: string): Model<Api> | undefined {
        return this.models.find(provider, modelId) as Model<Api> | undefined
    }

    modelSupportsXhigh(model: Model<Api>): boolean {
        return supportsXhigh(model)
    }

    async discoverModels(providerName: string): Promise<DiscoveredModel[]> {
        const providerPrefs = await this.listProviderPrefs()
        const runtimeProvider = resolveProviderRuntimeNameForLookup(providerName, providerPrefs)
        const config = await this.getProvider(runtimeProvider)
        const auth = this.auth.get(runtimeProvider)
        return discoverModelsForProvider({
            provider: runtimeProvider,
            protocol: config?.api as string | undefined,
            baseUrl: config?.baseUrl as string | undefined,
            apiKey: auth?.type === "api_key" ? auth.key : undefined,
            headers: config?.headers as Record<string, string> | undefined,
        })
    }

    // ── Built-in Reference (只读，UI 下拉框用) ──

    listBuiltInProviders(): BuiltInProvider[] {
        const all = (this.models.getAll() as Model<Api>[]).filter((model) => !model.provider.startsWith("provider:"))
        const grouped = new Map<string, Model<Api>[]>()
        for (const m of all) {
            const list = grouped.get(m.provider) ?? []
            list.push(m)
            grouped.set(m.provider, list)
        }
        return [...grouped.entries()].map(([provider, models]) => ({
            provider,
            apis: [...new Set(models.map((m) => m.api))],
            baseUrls: [...new Set(models.map((m) => m.baseUrl).filter(Boolean))],
            modelCount: models.length,
        }))
    }

    listBuiltInModels(provider: string): Model<Api>[] {
        return (this.models.getAll() as Model<Api>[]).filter((m) => m.provider === provider)
    }

    findBuiltInModelByApiAndId(api: string, modelId: string): Model<Api> | undefined {
        return (this.models.getAll() as Model<Api>[]).find((m) => m.api === api && m.id === modelId)
    }

    listSupportedProtocols(): string[] {
        return getApiProviders()
            .map((p) => p.api)
            .sort((a, b) => a.localeCompare(b))
    }
    // ── Provider Models (models.json providers.*.models) ──

    /** 列出所有 provider 中显式配置的 models */
    async listConfiguredModels(): Promise<ConfiguredModel[]> {
        const data = await this.readModelsJson()
        const providerPrefs = await this.listProviderPrefs()
        const result: ConfiguredModel[] = []
        for (const [provider, config] of Object.entries(data.providers)) {
            const models = sanitizeModelDefinitions(config.models) ?? []
            const providerId = typeof config.providerPrefId === "string" ? config.providerPrefId : undefined
            const displayName =
                typeof config.displayName === "string"
                    ? config.displayName
                    : providerId
                      ? providerPrefs.find((item) => item.id === providerId)?.name ?? provider
                      : provider
            const transport = resolveProviderTransport(config)
            for (const m of models) {
                result.push({ provider: displayName, providerId, runtimeProvider: provider, ...m, ...transport })
            }
        }
        return result
    }

    /** 向 provider 的 models 数组中添加模型 */
    async addModelToProvider(providerName: string, model: ModelDefinition) {
        const data = await this.readModelsJson()
        const provider = data.providers[providerName]
        if (!provider) return
        const models = (provider.models as any[]) ?? []
        const nextModel = sanitizeModelDefinition(model)
        const idx = models.findIndex((m: any) => m.id === nextModel.id)
        if (idx >= 0) {
            models[idx] = nextModel // 更新已有
        } else {
            models.push(nextModel)
        }
        provider.models = models
        await this.writeModelsJson(data)
    }

    /** 从 provider 的 models 数组中移除模型 */
    async removeModelFromProvider(providerName: string, modelId: string) {
        const data = await this.readModelsJson()
        const provider = data.providers[providerName]
        if (!provider) return
        const models = (provider.models as any[]) ?? []
        provider.models = models.filter((m: any) => m.id !== modelId)
        if ((provider.models as any[]).length === 0) delete provider.models
        await this.writeModelsJson(data)
    }

    // ── Model Prefs (model-prefs.json — per-model 用户偏好) ──

    private modelPrefsPath() {
        return resolve(this.dir, "model-prefs.json")
    }

    private async readModelPrefs(): Promise<{ models: ModelConfigEntry[] }> {
        const file = Bun.file(this.modelPrefsPath())
        if (!(await file.exists())) return { models: [] }
        const data = (await file.json()) as { models?: ModelConfigEntry[] }
        const providerPrefs = await this.listProviderPrefs()
        return {
            models: Array.isArray(data.models) ? data.models.map((entry) => normalizeStoredModelPref(entry, providerPrefs)) : [],
        }
    }

    private async writeModelPrefs(data: { models: ModelConfigEntry[] }) {
        const providerPrefs = await this.listProviderPrefs()
        await Bun.write(
            this.modelPrefsPath(),
            JSON.stringify({ models: data.models.map((entry) => normalizeStoredModelPref(entry, providerPrefs)) }, null, 2),
        )
    }

    async listModelPrefs(): Promise<ModelConfigEntry[]> {
        return (await this.readModelPrefs()).models
    }

    async addModelPref(entry: ModelConfigEntry): Promise<AddResult> {
        if (!entry.id) entry.id = crypto.randomUUID().slice(0, 8)
        const providerPrefs = await this.listProviderPrefs()
        const binding = resolveModelProviderBinding(entry, providerPrefs)
        if (binding.error) return { id: entry.id, rejected: binding.error }
        const nextEntry = normalizeStoredModelPref(
            {
                ...entry,
                provider: binding.displayProvider,
            },
            providerPrefs,
        )
        const data = await this.readModelPrefs()

        // hash 相同则拒绝
        const dup = data.models.find((m) => m.id !== nextEntry.id && m.hash === nextEntry.hash)
        if (dup) return { id: nextEntry.id, rejected: `与已有配置 "${dup.provider}:${dup.modelId}" (${dup.id}) 完全相同` }

        const idx = data.models.findIndex((m) => m.id === nextEntry.id)
        if (idx >= 0) {
            data.models[idx] = nextEntry
        } else {
            data.models.push(nextEntry)
        }
        await this.writeModelPrefs(data)

        // 写入 models.json 让 SDK 识别
        await this.ensureModelInProvider(nextEntry)
        return { id: nextEntry.id }
    }

    async removeModelPref(id: string) {
        const data = await this.readModelPrefs()
        const entry = data.models.find((m) => m.id === id)
        if (!entry) return
        data.models = data.models.filter((m) => m.id !== id)
        await this.writeModelPrefs(data)

        // 如果没有其他 pref 引用同一个 provider+modelId，从 models.json 移除
        const providerPrefs = await this.listProviderPrefs()
        const binding = resolveModelProviderBinding(entry, providerPrefs)
        const remaining = data.models.some((m) => {
            const candidateBinding = resolveModelProviderBinding(m, providerPrefs)
            return candidateBinding.runtimeProvider === binding.runtimeProvider && m.modelId === entry.modelId
        })
        if (!remaining) {
            await this.removeModelFromProvider(binding.runtimeProvider, entry.modelId)
        }
    }

    private isBuiltInProvider(name: string): boolean {
        return getProviders().includes(name as KnownProvider)
    }

    /** 确保 models.json 包含此模型定义（含 apiKey 同步） */
    private async ensureModelInProvider(entry: ModelConfigEntry) {
        const data = await this.readModelsJson()
        const providerPrefs = await this.listProviderPrefs()
        const binding = resolveModelProviderBinding(entry, providerPrefs)
        if (binding.error) throw new Error(binding.error)
        const runtimeProvider = binding.runtimeProvider
        const displayProvider = binding.displayProvider
        const providerPref = binding.providerPref

        // 如果 provider 不存在则创建
        if (!data.providers[runtimeProvider]) {
            const builtInRef = this.isBuiltInProvider(displayProvider) ? this.listBuiltInModels(displayProvider)[0] : undefined
            data.providers[runtimeProvider] = {
                ...(builtInRef && { baseUrl: builtInRef.baseUrl, api: builtInRef.api }),
                ...(providerPref?.api && { api: providerPref.api }),
                ...(providerPref?.baseUrl && { baseUrl: providerPref.baseUrl }),
                ...(providerPref && { providerPrefId: providerPref.id }),
                displayName: displayProvider,
            }
        }

        const provider = data.providers[runtimeProvider]

        // SDK 要求自定义 models[] 必须有 apiKey
        if (!provider.apiKey) {
            const auth = this.auth.get(runtimeProvider)
            if (auth?.type === "api_key") {
                provider.apiKey = auth.key
            }
        }

        // 从内建目录获取基线字段
        const builtInModel = this.isBuiltInProvider(displayProvider) ? this.listBuiltInModels(displayProvider).find((m) => m.id === entry.modelId) : undefined

        // 构建 SDK model definition
        const def: ModelDefinition = { id: entry.modelId }
        def.name = entry.name ?? builtInModel?.name
        def.reasoning = entry.reasoning ?? builtInModel?.reasoning
        def.input = entry.input ?? builtInModel?.input
        def.cost = entry.cost ?? builtInModel?.cost
        def.contextWindow = entry.contextWindow ?? builtInModel?.contextWindow
        def.maxTokens = entry.maxTokens ?? builtInModel?.maxTokens
        if (entry.headers) {
            // SDK requires Record<string, string> — strip non-string values
            const clean: Record<string, string> = {}
            for (const [k, v] of Object.entries(entry.headers)) {
                if (typeof v === "string") clean[k] = v
            }
            if (Object.keys(clean).length > 0) def.headers = clean
        }
        if (entry.compat) def.compat = entry.compat

        const models = (provider.models as any[]) ?? []
        const idx = models.findIndex((m: any) => m.id === entry.modelId)
        if (idx >= 0) {
            models[idx] = sanitizeModelDefinition(def) // 更新
        } else {
            models.push(sanitizeModelDefinition(def))
        }
        provider.models = models
        await this.writeModelsJson(data)
    }

    /** 发送一条简单消息测试模型是否可用 */
    async testModel(prefId: string): Promise<{
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
            thinkingLevel?: string
            reasoning?: boolean
            contextWindow?: number
            maxTokens?: number
            apiKeySummary?: string
            headers?: Record<string, string>
            compat?: Record<string, unknown>
        }
    }> {
        const prefs = await this.listModelPrefs()
        const pref = prefs.find((p) => p.id === prefId)
        if (!pref) return { ok: false, error: `Model config ${prefId} not found` }

        this.models.refresh()
        const loadError = this.models.getError()
        const binding = resolveModelProviderBinding(pref, await this.listProviderPrefs())
        if (binding.error) return { ok: false, error: binding.error }
        let baseModel = this.models.find(binding.runtimeProvider, pref.modelId)
        let providerConfig = await this.getProvider(binding.runtimeProvider)
        const details = {
            modelPrefId: pref.id,
            provider: binding.displayProvider,
            providerId: pref.providerId,
            providerLabel: pref.providerId ? `${binding.displayProvider} (${pref.providerId})` : binding.displayProvider,
            runtimeProvider: binding.runtimeProvider,
            modelId: pref.modelId,
            ...resolveProviderTransport(providerConfig),
            thinkingLevel: pref.thinkingLevel,
        }
        if (!baseModel) {
            await this.ensureModelInProvider(pref)
            this.models.refresh()
            baseModel = this.models.find(binding.runtimeProvider, pref.modelId)
            providerConfig = await this.getProvider(binding.runtimeProvider)
        }
        if (!baseModel) {
            const detail = loadError ? `models.json error: ${loadError}` : `Model ${binding.displayProvider}/${pref.modelId} not found in registry`
            return { ok: false, error: detail, details }
        }

        // 合并用户配置的所有字段
        const { id: _id, provider: _p, providerId: _pid, modelId: _m, thinkingLevel: _t, ...overrides } = pref
        const model = applyProviderTransport({ ...baseModel, ...overrides }, providerConfig)
        const modelRef = `${binding.displayProvider}:${pref.modelId}`
        const modelApi = typeof model.api === "string" && model.api.trim() ? model.api.trim() : "unknown"
        const modelBaseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim() ? model.baseUrl.trim() : "default"
        const auth = await this.models.getApiKeyAndHeaders(model)
        const resolvedApiKey = auth.ok ? auth.apiKey : undefined
        const resolvedDetails = {
            ...details,
            api: modelApi === "unknown" ? undefined : modelApi,
            baseUrl: modelBaseUrl === "default" ? undefined : modelBaseUrl,
            reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
            apiKeySummary: summarizeApiKey(resolvedApiKey),
            headers: auth.ok && auth.headers && Object.keys(auth.headers).length > 0 ? auth.headers : undefined,
            compat: model.compat && typeof model.compat === "object" ? (model.compat as Record<string, unknown>) : undefined,
        }
        if (!auth.ok) return { ok: false, error: auth.error, details: resolvedDetails }

        const resourceLoader = new DefaultResourceLoader({
            agentDir: this.dir,
            settingsManager: this.settings,
            systemPromptOverride: () => "You are a test assistant. Respond with exactly: OK",
        })
        try {
            await resourceLoader.reload()
            const { session } = await createAgentSession({
                model,
                thinkingLevel: toPiAiThinkingLevel(pref.thinkingLevel),
                tools: [],
                customTools: [],
                resourceLoader,
                authStorage: this.auth,
                modelRegistry: this.models,
                settingsManager: this.settings,
                sessionManager: SessionManager.inMemory(),
            })
            try {
                await session.bindExtensions({})
                await session.prompt("ping", { source: "interactive" })

                const result = [...session.messages].reverse().find((message) => message.role === "assistant")
                if (!result) {
                    return { ok: false, error: "empty assistant response", details: resolvedDetails }
                }
                if (result.stopReason === "error") {
                    const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : ""
                    const errText = result.content
                        .filter((c): c is { type: "text"; text: string } => c.type === "text")
                        .map((c) => c.text)
                        .join("")
                        .trim()
                    const detail = errorMessage || errText || (result.content.length > 0 ? JSON.stringify(result.content) : "") || "unknown error"
                    return { ok: false, error: detail, details: resolvedDetails }
                }

                const text = result.content
                    .filter((c): c is { type: "text"; text: string } => c.type === "text")
                    .map((c) => c.text)
                    .join("")
                    .trim()
                if (!text) {
                    return {
                        ok: false,
                        error: result.content.length > 0 ? JSON.stringify(result.content) : "empty assistant response",
                        details: resolvedDetails,
                    }
                }
                return { ok: true, response: text, details: resolvedDetails }
            } finally {
                session.dispose()
            }
        } catch (e: any) {
            return { ok: false, error: e.message ?? String(e), details: resolvedDetails }
        }
    }

    // ── Tools (SDK 内置 + 自定义 + MCP) ──

    /** 注册自定义工具 */
    registerTool(def: ToolDefinition) {
        this.registeredTools.set(def.name, { def, source: "custom" })
    }

    /** 列出所有工具（UI 展示用），含 MCP 服务器工具 */
    listTools(): ToolEntry[] {
        const entries: ToolEntry[] = [...this.registeredTools.values()].map(({ def, source }) => ({
            name: def.name,
            label: def.label,
            description: def.description,
            source,
            parameters: def.parameters ? JSON.parse(JSON.stringify(def.parameters)) : undefined,
        }))

        // MCP 服务器工具（从缓存读取）
        const cache = this.loadMcpToolCache()
        if (cache) {
            const mcpConfig = this.getMcpConfig()
            const prefix = mcpConfig.settings?.toolPrefix ?? "server"
            const globalDirect = mcpConfig.settings?.directTools

            for (const [serverName, serverCache] of Object.entries(cache.servers)) {
                const serverDef = mcpConfig.mcpServers[serverName]
                if (!serverDef) continue

                const directFilter = serverDef.directTools ?? globalDirect ?? false

                for (const tool of serverCache.tools) {
                    const isDirect = directFilter === true || (Array.isArray(directFilter) && directFilter.includes(tool.name))
                    entries.push({
                        name: formatToolName(tool.name, serverName, prefix),
                        label: tool.name,
                        description: tool.description ?? "",
                        source: "mcp",
                        parameters: tool.inputSchema ? JSON.parse(JSON.stringify(tool.inputSchema)) : undefined,
                        server: serverName,
                        direct: isDirect,
                    })
                }
            }
        }

        return entries
    }

    /** 按名字获取单个工具定义 */
    getTool(name: string): ToolDefinition | undefined {
        return this.registeredTools.get(name)?.def
    }

    /** 按名字列表批量获取（用于组装给 agent） */
    resolveTools(names: string[]): ToolDefinition[] {
        const result: ToolDefinition[] = []
        for (const n of names) {
            const entry = this.registeredTools.get(n)
            if (entry) result.push(entry.def)
        }
        return result
    }

    /** 获取所有工具定义 */
    allTools(): ToolDefinition[] {
        return [...this.registeredTools.values()].map(({ def }) => def)
    }

    // ── MCP Tool Cache ──

    loadMcpToolCache() {
        return mcp.loadMcpToolCache(this.dir)
    }
    async saveMcpToolCache(cache: McpToolCache) {
        await mcp.saveMcpToolCache(this.dir, cache)
    }
    async probeMcpServer(name: string) {
        return mcp.probeMcpServer(this.dir, name)
    }
    async probeMcpDraftServer(server: ServerEntry, name = "draft") {
        return mcp.probeMcpServerDefinition(name, server)
    }
    async probeAllMcpServers() {
        return mcp.probeAllMcpServers(this.dir)
    }

    // ── Skills ──

    listSkills(): Skill[] {
        return skills.listSkills(this.dir)
    }
    getSkill(name: string): Skill | undefined {
        return skills.getSkill(this.dir, name)
    }
    async addSkillFromZip(zipData: ArrayBuffer) {
        return skills.addSkillFromZip(this.dir, zipData)
    }
    async addSkillFromGit(url: string) {
        return skills.addSkillFromGit(this.dir, url)
    }
    async removeSkill(name: string) {
        return skills.removeSkill(this.dir, name)
    }

    // ── Prompts ──

    async getPrompt(name: string) {
        return prompts.loadPrompt(this.dir, name)
    }
    async setPrompt(prompt: PromptFile) {
        return prompts.savePrompt(this.dir, prompt)
    }
    async removePrompt(name: string) {
        return prompts.removePrompt(this.dir, name)
    }
    async listPrompts() {
        return prompts.listPrompts(this.dir)
    }
    async listAgentPrompts() {
        return prompts.listAgentPrompts(this.dir)
    }
    async listSubagentPrompts() {
        return prompts.listSubagentPrompts(this.dir)
    }
    toPromptTemplate(prompt: PromptFile) {
        return prompts.toPromptTemplate(prompt)
    }

    /**
     * 根据 PromptFile 解析出完整的会话配置。
     * 根据 PromptFile 解析出 CreateAgentSessionOptions。
     * - model: model-pref 短 ID → Model<Api>（合并用户覆盖）
     * - thinkingLevel: 从 model-pref 提取
     * - customTools: meta.tools 过滤出的 ToolDefinition[]
     * - resourceLoader: 注入 prompt 内容为系统提示，过滤 skills
     * 调用方可在返回值基础上 spread 覆盖其他字段（cwd、tools 等）。
     */
    async resolvePromptSession(
        promptName: string,
        extensions?: Array<ExtensionFactory | PromptSessionExtensionLike | undefined>,
        options?: ResolvePromptSessionOptions,
    ): Promise<CreateAgentSessionOptions | undefined> {
        const prompt = await prompts.loadPrompt(this.dir, promptName)
        if (!prompt) return undefined
        if (prompt.meta.disabled === true) return undefined

        // 1) 解析模型与思考等级
        const promptModelPrefId = typeof prompt.meta.model === "string" ? prompt.meta.model.trim() : ""
        let resolvedPromptModel: { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined
        if (promptModelPrefId) {
            try {
                resolvedPromptModel = await this.resolveModelPref(promptModelPrefId)
            } catch (error: any) {
                throw new Error(`prompt "${promptName}" model "${promptModelPrefId}": ${error?.message ?? String(error)}`)
            }
        }
        const model = resolvedPromptModel?.model
        const thinkingLevel = resolvedPromptModel?.thinkingLevel

        // 2) 从 prompt 提取工具白名单（仅显式声明才启用）
        const requestedToolNames =
            (prompt.meta.skills?.length ?? 0) > 0
                ? [...new Set(["read", ...(prompt.meta.tools ?? [])])]
                : (prompt.meta.tools ?? [])

        // 3) 比赛工具按环境开关过滤
        const challengeId = process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim()
        const challengeToolsEnabled = Boolean(challengeId)
        const enabledToolNames = requestedToolNames.filter((name) => challengeToolsEnabled || !challengeToolNames.has(name))

        // 4) 分离内置工具与自定义工具
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builtinTools: any[] = []
        const customToolNames: string[] = []
        for (const n of enabledToolNames) {
            if (n in builtinToolMap) {
                builtinTools.push(builtinToolMap[n])
            } else if (this.registeredTools.has(n)) {
                customToolNames.push(n)
            }
            // 其余视为 MCP 工具
        }

        // 5) 构建自定义工具定义（包含 subagent 工具）
        const customToolDefs = customToolNames.length > 0 ? this.resolveTools(customToolNames) : []
        const subagents = prompt.meta.subagents
        if (prompt.meta.isSubagent !== true && subagents && subagents.length > 0) {
            const allSubagentPrompts = await this.listSubagentPrompts()
            const enabledSubagentPrompts = allSubagentPrompts.filter((subagent) => subagent.meta.disabled !== true && subagents.includes(subagent.name))
            if (enabledSubagentPrompts.length > 0) {
                customToolDefs.push(createSubagentTool(enabledSubagentPrompts))
            }
        }

        // 6) 构建 skills 过滤集
        const enabledSkillNames = new Set(prompt.meta.skills ?? [])

        // 7) 构建 MCP 扩展
        const enabledMcpServers = (prompt.meta.mcps ?? []).filter((name) => name in this.getMcpConfig().mcpServers)
        const mcpExtension =
            enabledMcpServers.length > 0
                ? createMcpAdapter({
                      configPath: this.mcpJsonPath(),
                      enabledServers: enabledMcpServers,
                      enabledTools: enabledToolNames,
                  })
                : undefined

        // 8) 组装 ResourceLoader
        const resolvedExtensions = (extensions ?? []).filter((item): item is ExtensionFactory | PromptSessionExtensionLike => !!item)
        const challengeReportPrompt = options?.appendChallengeReportPrompt === true
            ? await prompts.loadPrompt(this.dir, prompts.CHALLENGE_REPORT_PROMPT_NAME)
            : undefined
        const systemPromptSections = [
            prompt.content,
            ...resolvedExtensions.map(resolvePromptSessionExtensionPrompt).filter((item): item is string => !!item),
            ...(challengeReportPrompt?.content ? [challengeReportPrompt.content] : []),
        ]

        const resourceLoader = new DefaultResourceLoader({
            agentDir: this.dir,
            systemPromptOverride: () => systemPromptSections.join("\n\n"),
            extensionFactories: [mcpExtension, ...resolvedExtensions.map(resolvePromptSessionExtensionFactory)].filter(
                (factory): factory is ExtensionFactory => !!factory,
            ),
            skillsOverride: (base) => ({
                ...base,
                skills: base.skills.filter((s) => enabledSkillNames.has(s.name)),
            }),
        })
        await resourceLoader.reload()

        // 9) 组装会话配置
        const opts: CreateAgentSessionOptions = {
            tools: builtinTools,
            customTools: customToolDefs,
            resourceLoader,
            authStorage: this.auth,
            modelRegistry: this.models,
            settingsManager: this.settings,
        }
        if (model) opts.model = model
        if (thinkingLevel) opts.thinkingLevel = thinkingLevel

        if (!opts.customTools || opts.customTools.length === 0) {
            opts.customTools = undefined
        }

        return opts
    }

    async resolveModelPref(modelPrefId: string): Promise<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
        const modelPref = modelPrefId.trim()
        if (!modelPref) throw new Error("model config id is required")

        const prefs = await this.listModelPrefs()
        const pref = prefs.find((item) => item.id === modelPref)
        if (!pref) throw new Error(`model config ${modelPref} not found`)

        this.models.refresh()
        const loadError = this.models.getError()
        const binding = resolveModelProviderBinding(pref, await this.listProviderPrefs())
        if (binding.error) throw new Error(binding.error)

        let baseModel = this.models.find(binding.runtimeProvider, pref.modelId)
        if (!baseModel) {
            await this.ensureModelInProvider(pref)
            this.models.refresh()
            baseModel = this.models.find(binding.runtimeProvider, pref.modelId)
        }
        if (!baseModel) {
            const detail = loadError ? `models.json error: ${loadError}` : `model ${binding.displayProvider}/${pref.modelId} not found in registry`
            throw new Error(detail)
        }

        const providerConfig = await this.getProvider(binding.runtimeProvider)
        const { id: _id, provider: _p, providerId: _pid, modelId: _m, hash: _h, thinkingLevel, ...overrides } = pref
        const model: Model<Api> = applyProviderTransport({ ...baseModel, ...overrides }, providerConfig)

        return {
            model,
            thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
        }
    }

    async getChallengePlannerPrompt() {
        return prompts.loadPrompt(this.dir, prompts.CHALLENGE_PLANNER_PROMPT_NAME)
    }

    async setChallengePlannerPrompt(content: string, model?: string) {
        const existing = await this.getChallengePlannerPrompt()
        await prompts.savePrompt(this.dir, {
            name: prompts.CHALLENGE_PLANNER_PROMPT_NAME,
            meta: {
                ...(existing?.meta ?? {}),
                ...(typeof model === "string" && model.trim() ? { model: model.trim() } : { model: undefined }),
            },
            content,
        })
        return this.getChallengePlannerPrompt()
    }

    // ── MCP Servers ──

    mcpJsonPath() {
        return mcp.mcpJsonPath(this.dir)
    }
    getMcpConfig() {
        return mcp.getMcpConfig(this.dir)
    }
    listMcpServers() {
        return mcp.listMcpServers(this.dir)
    }
    addMcpServer(name: string, server: ServerEntry) {
        return mcp.addMcpServer(this.dir, name, server)
    }
    removeMcpServer(name: string) {
        return mcp.removeMcpServer(this.dir, name)
    }
    updateMcpServer(name: string, patch: Partial<ServerEntry>) {
        return mcp.updateMcpServer(this.dir, name, patch)
    }
    renameMcpServer(oldName: string, newName: string) {
        return mcp.renameMcpServer(this.dir, oldName, newName)
    }
    getMcpSettings() {
        return mcp.getMcpSettings(this.dir)
    }
    setMcpSettings(settings: McpSettings) {
        return mcp.setMcpSettings(this.dir, settings)
    }

    // ── Host Settings (runtime/planner) ──

    private globalSettingsPath(): string {
        return resolve(this.dir, "settings.json")
    }

    private async readGlobalSettingsRaw(): Promise<Record<string, unknown>> {
        const file = Bun.file(this.globalSettingsPath())
        if (!(await file.exists())) return {}
        const content = await file.text()
        if (!content.trim()) return {}
        try {
            const parsed = JSON.parse(content) as unknown
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
            return parsed as Record<string, unknown>
        } catch {
            return {}
        }
    }

    private async writeGlobalSettingsRaw(data: Record<string, unknown>): Promise<void> {
        await Bun.write(this.globalSettingsPath(), JSON.stringify(data, null, 2))
    }

    async getHostAuthSettings(): Promise<HostAuthSettings> {
        const raw = await this.readGlobalSettingsRaw()
        const tch = raw.tch && typeof raw.tch === "object" && !Array.isArray(raw.tch) ? (raw.tch as { auth?: HostAuthSettings }) : {}
        return tch.auth ?? { registrationEnabled: true }
    }

    async setHostAuthSettings(patch: Partial<HostAuthSettings>): Promise<HostAuthSettings> {
        const current = await this.getHostAuthSettings()
        const merged: HostAuthSettings = {
            ...current,
            ...patch,
        }
        const raw = await this.readGlobalSettingsRaw()
        const tch = raw.tch && typeof raw.tch === "object" && !Array.isArray(raw.tch) ? (raw.tch as Record<string, unknown>) : {}
        raw.tch = { ...tch, auth: merged }
        await this.writeGlobalSettingsRaw(raw)
        await this.settings.reload()
        return merged
    }

    async getHostSettings(): Promise<HostSettings> {
        await this.settings.reload()
        const raw = await this.readGlobalSettingsRaw()
        const tch =
            raw.tch && typeof raw.tch === "object" && !Array.isArray(raw.tch)
                ? (raw.tch as { runtime?: HostRuntimeSettings; planner?: HostPlannerSettings; auth?: HostAuthSettings })
                : {}
        const planner = tch.planner ?? {}
        return {
            runtime: tch.runtime ?? {},
            planner: {
                tickIntervalMs: planner.tickIntervalMs,
                staleTimeoutMs: planner.staleTimeoutMs,
            },
            auth: { registrationEnabled: tch.auth?.registrationEnabled ?? true },
        }
    }

    async setHostSettings(patch: Partial<HostSettings>): Promise<HostSettings> {
        const current = await this.getHostSettings()
        const internalAuth = await this.getHostAuthSettings()
        const plannerPatch = patch.planner ?? {}
        const merged: HostSettings = {
            runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
            planner: {
                tickIntervalMs: plannerPatch.tickIntervalMs ?? current.planner.tickIntervalMs,
                staleTimeoutMs: plannerPatch.staleTimeoutMs ?? current.planner.staleTimeoutMs,
            },
            auth: { ...current.auth, registrationEnabled: patch.auth?.registrationEnabled ?? current.auth.registrationEnabled },
        }

        const raw = await this.readGlobalSettingsRaw()
        const auth: HostAuthSettings = {
            ...internalAuth,
            registrationEnabled: merged.auth.registrationEnabled,
        }
        raw.tch = { ...merged, auth }
        await this.writeGlobalSettingsRaw(raw)
        await this.settings.reload()
        return merged
    }
}
