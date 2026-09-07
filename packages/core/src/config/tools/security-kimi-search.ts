import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import type { ConfiguredModel, ProviderPrefEntry } from "../providers/types"

const QWEN_DEFAULT_MODEL = "qwen-plus"
const KIMI_MAX_ROUNDS = 6
const KIMI_REQUIRED_TEMPERATURE = 0.6

const KimiSecuritySearchParams = Type.Object({
    query: Type.String({ description: "Security research query, e.g. CVE PoC, EXP chain, or bypass technique." }),
})

interface KimiSecuritySearchInput {
    query: string
}

type SearchProviderName = "kimi" | "qwen"
type KimiMessageRole = "system" | "user" | "assistant" | "tool"
type MountedConfigState = Awaited<ReturnType<typeof loadMountedConfigState>>

interface KimiToolCall {
    id: string
    function: {
        name: string
        arguments: string
    }
}

interface KimiMessage {
    role: KimiMessageRole
    content: string | null
    tool_calls?: KimiToolCall[]
    tool_call_id?: string
    name?: string
}

interface KimiChoice {
    finishReason: string | null
    message: {
        content: string | null
        toolCalls: KimiToolCall[]
    }
}

interface KimiRunResult {
    answer: string
    rounds: number
    toolCalls: number
}

interface KimiModelCandidate {
    providerId?: string
    runtimeProvider: string
    id: string
    api?: string
    baseUrl?: string
}

interface ProviderRequestConfig {
    api: string
    runtimeProvider: string
    modelId: string
    baseUrl: string
    requestUrl: string
    apiKey: string
}

interface SearchSourceResult {
    provider: SearchProviderName
    content: string
    error?: string
    api?: string
    modelId?: string
    runtimeProvider?: string
    baseUrl?: string
    requestUrl?: string
    rounds?: number
    toolCalls?: number
}

const KIMI_WEB_SEARCH_TOOLS = [
    {
        type: "builtin_function",
        function: {
            name: "$web_search",
        },
    },
] as const

const SECURITY_SEARCH_SYSTEM_PROMPT = `你是网络安全领域的智能搜索助手，服务于已授权的 CTF 与渗透测试场景。

你的主要任务：
1. 联网检索 CVE、PoC、EXP、漏洞利用链、绕过技巧等。
2. 对检索结果做技术归纳：影响版本、利用前提、关键利用步骤。
3. 优先给出高价值检索线索：payload 方向、利用条件。

输出要求：
- 先给结论摘要，再给细化要点。
- 明确区分“已确认事实”和“推测/待验证信息”。`

function normalizeBaseUrl(baseUrl?: string): string | undefined {
    const text = baseUrl?.trim()
    if (!text) return
    return text.replace(/\/+$/, "")
}

function buildChatCompletionsUrl(baseUrl: string): string {
    const normalized = normalizeBaseUrl(baseUrl)
    if (!normalized) {
        throw new Error("provider baseUrl is empty")
    }
    if (normalized.endsWith("/chat/completions")) return normalized
    return `${normalized}/chat/completions`
}

function pickProviderPref(providerPrefs: ProviderPrefEntry[], providerName: SearchProviderName): ProviderPrefEntry | undefined {
    return providerPrefs.find((entry) => entry.name === providerName)
}

function pickProviderPrefById(providerPrefs: ProviderPrefEntry[], providerId?: string): ProviderPrefEntry | undefined {
    if (!providerId) return
    return providerPrefs.find((entry) => entry.id === providerId)
}

function providerApiFromConfig(
    providerConfig: Record<string, unknown> | undefined,
    providerPref: ProviderPrefEntry | undefined,
): string | undefined {
    const fromProviderConfig = typeof providerConfig?.api === "string" ? providerConfig.api.trim() : ""
    if (fromProviderConfig) return fromProviderConfig
    const fromProviderPref = typeof providerPref?.api === "string" ? providerPref.api.trim() : ""
    return fromProviderPref || undefined
}

function providerBaseUrlFromConfig(
    providerConfig: Record<string, unknown> | undefined,
    providerPref: ProviderPrefEntry | undefined,
): string | undefined {
    const fromProviderConfig = typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined
    const fromProviderPref = typeof providerPref?.baseUrl === "string" ? providerPref.baseUrl : undefined
    return normalizeBaseUrl(fromProviderConfig) ?? normalizeBaseUrl(fromProviderPref)
}

function providerApiKeyFromConfig(providerConfig: Record<string, unknown> | undefined): string | undefined {
    const apiKey = typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : ""
    return apiKey || undefined
}

function providerApiKeyFromPref(providerPref: ProviderPrefEntry | undefined): string | undefined {
    const apiKey = typeof providerPref?.apiKey === "string" ? providerPref.apiKey.trim() : ""
    return apiKey || undefined
}

function resolveRuntimeProvider(providerName: SearchProviderName, providerPref: ProviderPrefEntry | undefined): string {
    if (typeof providerPref?.id === "string" && providerPref.id.trim()) {
        return `provider:${providerPref.id}`
    }
    return providerName
}

function resolveEnvApiKey(provider: SearchProviderName): string | undefined {
    const candidates =
        provider === "kimi"
            ? [process.env.KIMI_API_KEY, process.env.MOONSHOT_API_KEY]
            : [process.env.DASHSCOPE_API_KEY, process.env.QWEN_API_KEY]
    for (const value of candidates) {
        const key = value?.trim()
        if (key) return key
    }
}

function isKimiModel(model: Pick<ConfiguredModel, "id" | "name">): boolean {
    const candidates = [model.name, model.id]
    return candidates.some((value) => typeof value === "string" && value.toLowerCase().includes("kimi"))
}

function listKimiModelCandidates(models: ConfiguredModel[]): KimiModelCandidate[] {
    return models
        .filter((model) => isKimiModel(model) && normalizeBaseUrl(typeof model.baseUrl === "string" ? model.baseUrl : undefined))
        .map((model) => ({
            providerId: typeof model.providerId === "string" ? model.providerId : undefined,
            runtimeProvider: typeof model.runtimeProvider === "string" ? model.runtimeProvider : model.provider,
            id: model.id,
            api: typeof model.api === "string" ? model.api : undefined,
            baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
        }))
}

function orderKimiModelCandidates(candidates: KimiModelCandidate[], preferredRuntimeProvider?: string): KimiModelCandidate[] {
    if (!preferredRuntimeProvider) return candidates
    return candidates.toSorted((a, b) => {
        const aPreferred = a.runtimeProvider === preferredRuntimeProvider ? 1 : 0
        const bPreferred = b.runtimeProvider === preferredRuntimeProvider ? 1 : 0
        return bPreferred - aPreferred
    })
}

async function loadMountedConfigState() {
    const { ConfigManager } = await import("../index")
    const config = await ConfigManager.getInstance()
    config.auth.reload()
    config.models.refresh()
    return {
        config,
        providerPrefs: await config.listProviderPrefs(),
    }
}

async function resolveMountedProviderApiKey(
    state: MountedConfigState,
    runtimeProvider: string,
    provider: SearchProviderName,
    providerPref?: ProviderPrefEntry,
): Promise<string | undefined> {
    const authKey = state.config.getApiKeyValue(runtimeProvider)?.trim()
    if (authKey) return authKey

    const providerConfig = await state.config.getProvider(runtimeProvider)
    const inlineKey = providerApiKeyFromConfig(providerConfig)
    if (inlineKey) return inlineKey

    const prefKey = providerApiKeyFromPref(providerPref)
    if (prefKey) return prefKey

    return resolveEnvApiKey(provider)
}

async function resolveNamedProviderRequestConfig(
    state: MountedConfigState,
    provider: Exclude<SearchProviderName, "kimi">,
    modelId: string,
): Promise<ProviderRequestConfig> {
    const providerPref = pickProviderPref(state.providerPrefs, provider)
    const runtimeProvider = resolveRuntimeProvider(provider, providerPref)
    const runtimeProviderConfig = await state.config.getProvider(runtimeProvider)
    const directProviderConfig = runtimeProvider === provider ? runtimeProviderConfig : await state.config.getProvider(provider)
    const providerConfig = runtimeProviderConfig ?? directProviderConfig

    const api = providerApiFromConfig(providerConfig, providerPref)
    if (!api) {
        throw new Error(`provider "${provider}" api is not configured`)
    }
    if (api !== "openai-completions") {
        throw new Error(`provider "${provider}" api must be "openai-completions", got "${api}"`)
    }

    const resolvedBaseUrl = providerBaseUrlFromConfig(providerConfig, providerPref)
    if (!resolvedBaseUrl) {
        throw new Error(`provider "${provider}" baseUrl is not configured`)
    }

    const apiKey = await resolveMountedProviderApiKey(state, runtimeProvider, provider, providerPref)
    if (!apiKey) {
        throw new Error(`missing api key for provider "${runtimeProvider}"`)
    }

    const baseUrl = resolvedBaseUrl
    return {
        api,
        runtimeProvider,
        modelId,
        baseUrl,
        requestUrl: buildChatCompletionsUrl(baseUrl),
        apiKey,
    }
}

async function resolveKimiRequestConfig(state: MountedConfigState, preferredRuntimeProvider?: string): Promise<ProviderRequestConfig> {
    const configuredModels = await state.config.listConfiguredModels()
    const candidates = orderKimiModelCandidates(listKimiModelCandidates(configuredModels), preferredRuntimeProvider)
    const providerCandidates = [...new Set(candidates.map((item) => item.runtimeProvider).filter((item) => item.length > 0))]

    if (candidates.length === 0) {
        throw new Error("No configured Kimi model found")
    }

    for (const candidate of candidates) {
        const providerPref = pickProviderPrefById(state.providerPrefs, candidate.providerId)
        const apiKey = await resolveMountedProviderApiKey(state, candidate.runtimeProvider, "kimi", providerPref)
        if (!apiKey) continue

        const api = typeof candidate.api === "string" ? candidate.api.trim() : ""
        if (!api) {
            throw new Error(`Provider "${candidate.runtimeProvider}" api is not configured`)
        }
        if (api !== "openai-completions") {
            throw new Error(`Provider "${candidate.runtimeProvider}" api must be "openai-completions", got "${api}"`)
        }

        const resolvedBaseUrl = normalizeBaseUrl(candidate.baseUrl)
        if (!resolvedBaseUrl) {
            throw new Error(`Provider "${candidate.runtimeProvider}" baseUrl is not configured`)
        }

        const baseUrl = resolvedBaseUrl
        return {
            api,
            runtimeProvider: candidate.runtimeProvider,
            modelId: candidate.id,
            baseUrl,
            requestUrl: buildChatCompletionsUrl(baseUrl),
            apiKey,
        }
    }

    throw new Error(
        `Missing Kimi API key for provider "${candidates[0].runtimeProvider}" (candidates: ${providerCandidates.join(", ") || "none"})`,
    )
}

async function resolveProviderRequestConfig(
    state: MountedConfigState,
    provider: SearchProviderName,
    preferredRuntimeProvider?: string,
): Promise<ProviderRequestConfig> {
    if (provider === "kimi") {
        return resolveKimiRequestConfig(state, preferredRuntimeProvider)
    }
    return resolveNamedProviderRequestConfig(state, "qwen", QWEN_DEFAULT_MODEL)
}

function normalizeToolCalls(raw: unknown): KimiToolCall[] {
    if (!Array.isArray(raw)) return []
    const toolCalls: KimiToolCall[] = []
    for (const item of raw) {
        if (!item || typeof item !== "object") continue
        const call = item as {
            id?: unknown
            function?: {
                name?: unknown
                arguments?: unknown
            }
        }
        if (typeof call.id !== "string") continue
        if (!call.function || typeof call.function.name !== "string") continue
        toolCalls.push({
            id: call.id,
            function: {
                name: call.function.name,
                arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
            },
        })
    }
    return toolCalls
}

function parseToolArguments(raw: string): Record<string, unknown> {
    const text = raw.trim()
    if (!text) return {}
    try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
        }
    } catch {
        return {}
    }
    return {}
}

function searchImpl(args: Record<string, unknown>): Record<string, unknown> {
    return args
}

function stringifyError(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

async function createKimiCompletion(
    messages: KimiMessage[],
    modelId: string,
    apiKey: string,
    requestUrl: string,
    signal: AbortSignal | undefined,
): Promise<KimiChoice> {
    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: modelId,
            messages,
            temperature: KIMI_REQUIRED_TEMPERATURE,
            tools: KIMI_WEB_SEARCH_TOOLS,
            thinking: { type: "disabled" },
        }),
        signal,
    })
    if (!response.ok) throw new Error(await response.text())

    const data = (await response.json()) as {
        choices?: Array<{
            finish_reason?: unknown
            message?: {
                content?: unknown
                tool_calls?: unknown
            }
        }>
    }

    const firstChoice = data.choices?.[0]
    if (!firstChoice) {
        throw new Error("kimi search returned no choices")
    }

    return {
        finishReason:
            typeof firstChoice.finish_reason === "string" || firstChoice.finish_reason === null
                ? firstChoice.finish_reason
                : null,
        message: {
            content: typeof firstChoice.message?.content === "string" ? firstChoice.message.content : null,
            toolCalls: normalizeToolCalls(firstChoice.message?.tool_calls),
        },
    }
}

async function runKimiSearch(
    query: string,
    requestConfig: ProviderRequestConfig,
    signal: AbortSignal | undefined,
): Promise<KimiRunResult> {
    const messages: KimiMessage[] = [
        { role: "system", content: SECURITY_SEARCH_SYSTEM_PROMPT },
        { role: "user", content: query },
    ]

    let rounds = 0
    let toolCalls = 0
    let answer = ""

    while (rounds < KIMI_MAX_ROUNDS) {
        rounds += 1
        const choice = await createKimiCompletion(messages, requestConfig.modelId, requestConfig.apiKey, requestConfig.requestUrl, signal)
        const content = choice.message.content?.trim()
        if (content) answer = content

        if (choice.finishReason !== "tool_calls") break
        if (choice.message.toolCalls.length === 0) break

        messages.push({
            role: "assistant",
            content: choice.message.content ?? "",
            tool_calls: choice.message.toolCalls,
        })

        for (const toolCall of choice.message.toolCalls) {
            const toolName = toolCall.function.name
            const toolArguments = parseToolArguments(toolCall.function.arguments)
            const toolResult = toolName === "$web_search" ? searchImpl(toolArguments) : { error: `No tool found: ${toolName}` }
            toolCalls += 1
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                name: toolName,
                content: JSON.stringify(toolResult),
            })
        }
    }

    if (!answer) {
        throw new Error("kimi search returned empty response")
    }
    return { answer, rounds, toolCalls }
}

async function runQwenSearch(query: string, requestConfig: ProviderRequestConfig, signal: AbortSignal | undefined): Promise<string> {
    const response = await fetch(requestConfig.requestUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requestConfig.apiKey}`,
        },
        body: JSON.stringify({
            model: requestConfig.modelId,
            messages: [
                { role: "system", content: SECURITY_SEARCH_SYSTEM_PROMPT },
                { role: "user", content: query },
            ],
            enable_search: true,
            search_options: {
                forced_search: true,
            },
        }),
        signal,
    })
    if (!response.ok) throw new Error(await response.text())

    const data = (await response.json()) as {
        choices?: Array<{
            message?: {
                content?: unknown
            }
        }>
    }
    const content = data.choices?.[0]?.message?.content
    return typeof content === "string" ? content.trim() : ""
}

async function runKimiSource(
    query: string,
    state: MountedConfigState,
    preferredRuntimeProvider: string | undefined,
    signal: AbortSignal | undefined,
): Promise<SearchSourceResult> {
    try {
        const providerConfig = await resolveProviderRequestConfig(state, "kimi", preferredRuntimeProvider)
        const result = await runKimiSearch(query, providerConfig, signal)
        return {
            provider: "kimi",
            content: result.answer,
            api: providerConfig.api,
            modelId: providerConfig.modelId,
            runtimeProvider: providerConfig.runtimeProvider,
            baseUrl: providerConfig.baseUrl,
            requestUrl: providerConfig.requestUrl,
            rounds: result.rounds,
            toolCalls: result.toolCalls,
        }
    } catch (error: unknown) {
        return {
            provider: "kimi",
            content: "",
            error: stringifyError(error),
        }
    }
}

async function runQwenSource(query: string, state: MountedConfigState, signal: AbortSignal | undefined): Promise<SearchSourceResult> {
    try {
        const providerConfig = await resolveProviderRequestConfig(state, "qwen")
        const content = await runQwenSearch(query, providerConfig, signal)
        return {
            provider: "qwen",
            content,
            api: providerConfig.api,
            modelId: providerConfig.modelId,
            runtimeProvider: providerConfig.runtimeProvider,
            baseUrl: providerConfig.baseUrl,
            requestUrl: providerConfig.requestUrl,
        }
    } catch (error: unknown) {
        return {
            provider: "qwen",
            content: "",
            error: stringifyError(error),
        }
    }
}

export const securityKimiSearchTool: ToolDefinition = {
    name: "security_kimi_search",
    label: "Security Kimi Search",
    description: "Search cybersecurity intelligence with multi-source web search (Kimi + Qwen) for CVE PoC, EXP chains, and bypass techniques.",
    promptSnippet: "security_kimi_search:联网检索安全情报（Kimi+Qwen 双源）并汇总关键线索",
    promptGuidelines: [
        "When exploit intelligence may be outdated or uncertain, call security_kimi_search first.",
        "Prefer concrete evidence: affected versions, prerequisites, exploit chain, and mitigation clues.",
    ],
    parameters: KimiSecuritySearchParams,
    async execute(_toolCallId, params: KimiSecuritySearchInput, signal, _onUpdate, ctx: ExtensionContext) {
        const query = params.query.trim()
        if (!query) {
            throw new Error("query must be a non-empty string")
        }

        const state = await loadMountedConfigState()
        const [kimiResult, qwenResult] = await Promise.all([
            runKimiSource(query, state, ctx.model?.provider, signal),
            runQwenSource(query, state, signal),
        ])
        const mergedContent = [
            qwenResult.content.length > 0 ? `# Qwen Result (MAIN)\n${qwenResult.content}` : "",
            kimiResult.content.length > 0 ? `# Kimi Result (REFERENCE)\n${kimiResult.content}` : "",
        ]
            .filter((content) => content.length > 0)
            .join("\n\n")

        return {
            content: [{ type: "text", text: mergedContent }],
            details: {
                query,
                models: {
                    kimi: kimiResult.modelId,
                    qwen: qwenResult.modelId ?? QWEN_DEFAULT_MODEL,
                },
                kimi: kimiResult,
                qwen: qwenResult,
            },
        }
    },
}
