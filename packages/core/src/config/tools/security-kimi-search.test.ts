import { test, expect } from "bun:test"
import { ConfigManager } from "../index"
import { securityKimiSearchTool } from "./security-kimi-search"

const DEFAULT_QUERY = "请检索 CVE-2024-4577 的公开 PoC、利用条件、受影响版本和缓解建议"
const KIMI_SEARCH_TEST_TIMEOUT_MS = 120000

function hasEnvKimiApiKey(): boolean {
    return Boolean(process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim())
}

function isKimiModel(model: { id: string; name?: string }): boolean {
    return [model.name, model.id].some((value) => typeof value === "string" && value.toLowerCase().includes("kimi"))
}

async function resolveConfiguredKimiRuntimeProvider(config: ConfigManager): Promise<string | undefined> {
    const models = await config.listConfiguredModels()
    return models.find(isKimiModel)?.runtimeProvider
}

async function hasConfiguredKimiApiKey(config: ConfigManager): Promise<boolean> {
    if (hasEnvKimiApiKey()) return true

    const runtimeProvider = await resolveConfiguredKimiRuntimeProvider(config)
    if (!runtimeProvider) return false
    return Boolean(config.getApiKeyValue(runtimeProvider) || (await config.getProvider(runtimeProvider))?.apiKey)
}

function extractTextContent(content: unknown): string {
    if (!Array.isArray(content)) return ""
    const textParts: string[] = []
    for (const item of content) {
        if (!item || typeof item !== "object") continue
        const entry = item as { type?: unknown; text?: unknown }
        if (entry.type === "text" && typeof entry.text === "string") {
            textParts.push(entry.text)
        }
    }
    return textParts.join("\n").trim()
}

function extractSourceError(details: unknown, source: "kimi" | "qwen"): string {
    if (!details || typeof details !== "object") return ""
    const entry = (details as Record<string, unknown>)[source]
    if (!entry || typeof entry !== "object") return ""
    return typeof (entry as { error?: unknown }).error === "string" ? (entry as { error: string }).error : ""
}

test(
    "security_kimi_search prints response",
    async () => {
        const config = await ConfigManager.getInstance()
        if (!(await hasConfiguredKimiApiKey(config))) {
            console.log('[skip] configure provider "kimi" api key or set KIMI_API_KEY/MOONSHOT_API_KEY to run security_kimi_search test')
            return
        }

        const query = process.env.KIMI_SEARCH_TEST_QUERY?.trim() || DEFAULT_QUERY
        const result = await securityKimiSearchTool.execute(
            "test-tool-call-id",
            { query },
            undefined,
            undefined,
            {
                cwd: process.cwd(),
            } as never,
        )

        const text = extractTextContent(result.content)
        console.log("security_kimi_search response:")
        console.log(text)
        if (text.length === 0) {
            const kimiError = extractSourceError(result.details, "kimi")
            const qwenError = extractSourceError(result.details, "qwen")
            if (kimiError || qwenError) {
                console.log("security_kimi_search skipped due to upstream provider errors:")
                console.log(JSON.stringify(result.details, null, 2))
                return
            }
        }
        expect(text.length).toBeGreaterThan(0)
    },
    KIMI_SEARCH_TEST_TIMEOUT_MS,
)
