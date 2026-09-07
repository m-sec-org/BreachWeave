import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai"

export interface DiscoveredModel {
    id: string
    name: string
}

const DISCOVERY_TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = "2023-06-01"

export async function discoverModelsForProvider(options: { provider: string; protocol?: string; baseUrl?: string; apiKey?: string; headers?: Record<string, string> }): Promise<DiscoveredModel[]> {
    const { provider, protocol, baseUrl, apiKey } = options

    // Built-in provider — return from SDK catalog
    if (getProviders().includes(provider as KnownProvider)) {
        return getModels(provider as KnownProvider).map((model) => ({ id: model.id, name: model.name }))
    }

    // Custom provider — need baseUrl and apiKey
    if (!baseUrl) throw new Error(`No baseUrl configured for provider: ${provider}`)
    if (!apiKey) throw new Error(`No API key for provider: ${provider}`)
    assertValidBaseUrl(baseUrl)
    assertValidApiKey(apiKey, provider)

    switch (protocol) {
        case "openai-completions":
        case "openai-responses":
            return discoverOpenAiModels(baseUrl, apiKey, options.headers)
        case "anthropic-messages":
            return discoverAnthropicModels(baseUrl, apiKey, options.headers)
        default:
            throw new Error(`Model discovery not supported for protocol: ${protocol}`)
    }
}

async function discoverOpenAiModels(baseUrl: string, apiKey: string, extraHeaders?: Record<string, string>): Promise<DiscoveredModel[]> {
    const headers = new Headers(extraHeaders)
    if (!hasHeader(headers, "authorization")) {
        headers.set("Authorization", `Bearer ${apiKey}`)
    }
    headers.set("Accept", "application/json")

    const response = await fetch(buildDiscoveryUrl(baseUrl), {
        headers,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })

    const body = await readJsonOrThrow(response)
    const models = Array.isArray(body?.data) ? body.data : []

    return models
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null
            const record = entry as Record<string, unknown>
            const id = typeof record.id === "string" ? record.id : null
            const name = typeof record.name === "string" ? record.name : typeof record.display_name === "string" ? record.display_name : id
            return id ? { id, name: name ?? id } : null
        })
        .filter((entry): entry is DiscoveredModel => entry !== null)
}

async function discoverAnthropicModels(baseUrl: string, apiKey: string, extraHeaders?: Record<string, string>): Promise<DiscoveredModel[]> {
    const headers = new Headers(extraHeaders)
    if (!hasHeader(headers, "x-api-key")) {
        headers.set("x-api-key", apiKey)
    }
    if (!hasHeader(headers, "anthropic-version")) {
        headers.set("anthropic-version", ANTHROPIC_VERSION)
    }
    headers.set("Accept", "application/json")

    const response = await fetch(buildAnthropicDiscoveryUrl(baseUrl), {
        headers,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })

    const body = await readJsonOrThrow(response)
    const models = Array.isArray(body?.data) ? body.data : []

    return models
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null
            const record = entry as Record<string, unknown>
            const id = typeof record.id === "string" ? record.id : null
            const name = typeof record.display_name === "string" ? record.display_name : id
            return id ? { id, name: name ?? id } : null
        })
        .filter((entry): entry is DiscoveredModel => entry !== null)
}

function buildDiscoveryUrl(baseUrl: string): string {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    return new URL("models", normalized).toString()
}

function buildAnthropicDiscoveryUrl(baseUrl: string): string {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    return new URL("v1/models", normalized).toString()
}

function hasHeader(headers: Headers, name: string): boolean {
    return headers.has(name) || headers.has(name.toLowerCase()) || headers.has(name.toUpperCase())
}

function assertValidBaseUrl(baseUrl: string) {
    try {
        new URL(baseUrl)
    } catch {
        throw new Error("Base URL 格式不正确，请检查 Provider 配置")
    }
}

function assertValidApiKey(apiKey: string, provider: string) {
    if (apiKey !== apiKey.trim()) {
        throw new Error(`Provider "${provider}" 的 API Key 首尾包含空白字符，请重新粘贴`)
    }

    for (const char of apiKey) {
        const code = char.charCodeAt(0)
        if (code < 0x20 || code === 0x7f) {
            throw new Error(`Provider "${provider}" 的 API Key 包含不可见控制字符，请重新粘贴`)
        }
    }

    try {
        new Headers({ Authorization: `Bearer ${apiKey}` })
    } catch {
        throw new Error(`Provider "${provider}" 的 API Key 包含非法字符，请重新粘贴`)
    }
}

async function readJsonOrThrow(response: Response): Promise<Record<string, unknown> | null> {
    const text = await response.text()
    const json = text ? safeParseJson(text) : null
    if (!response.ok) {
        throw new Error(`Model discovery failed (${response.status}): ${text || response.statusText}`)
    }
    return json
}

function safeParseJson(text: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(text)
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
        return null
    }
}
