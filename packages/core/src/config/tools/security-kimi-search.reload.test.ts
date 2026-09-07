import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import type { ConfiguredModel, ProviderPrefEntry } from "../providers/types"

const reloadAuth = mock(() => {})
const refreshModels = mock(() => {})
const listConfiguredModels = mock(async (): Promise<ConfiguredModel[]> => [])
const listProviderPrefs = mock(async (): Promise<ProviderPrefEntry[]> => [])
const getApiKeyValue = mock(((_provider: string): string | undefined => undefined))
const getProvider = mock(async (_provider: string): Promise<Record<string, unknown> | undefined> => undefined)
const getHostSettings = mock(async () => ({
    runtime: {},
    planner: {},
}))

const getInstance = mock(async () => ({
    auth: { reload: reloadAuth },
    models: { refresh: refreshModels },
    listConfiguredModels,
    listProviderPrefs,
    getApiKeyValue,
    getProvider,
    getHostSettings,
}))

mock.module("../index", () => ({
    ConfigManager: {
        getInstance,
    },
}))

const { securityKimiSearchTool } = await import("./security-kimi-search")

const originalFetch = globalThis.fetch

beforeEach(() => {
    getInstance.mockClear()
    reloadAuth.mockClear()
    refreshModels.mockClear()
    listConfiguredModels.mockReset()
    listProviderPrefs.mockReset()
    getApiKeyValue.mockReset()
    getProvider.mockReset()
    getHostSettings.mockClear()
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

test("reloads auth storage before resolving kimi api key", async () => {
    listConfiguredModels.mockResolvedValue([
        {
            provider: "kimi-300",
            runtimeProvider: "provider:65d9d2f9",
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            api: "openai-completions",
            baseUrl: "https://api.moonshot.cn/v1",
        },
    ])
    listProviderPrefs.mockResolvedValue([])
    getApiKeyValue.mockImplementation((provider: string) => (provider === "provider:65d9d2f9" ? "sk-kimi-test" : undefined))
    getProvider.mockResolvedValue(undefined)

    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: {
                                content: "search ok",
                                tool_calls: [],
                            },
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await securityKimiSearchTool.execute(
        "tool-call-1",
        { query: "CVE-2025-55182" },
        undefined,
        undefined,
        {
            cwd: process.cwd(),
            model: { provider: "provider:65d9d2f9", id: "kimi-k2.5" },
        } as unknown as ExtensionContext,
    )

    expect(reloadAuth).toHaveBeenCalled()
    expect(refreshModels).toHaveBeenCalled()
    expect(getApiKeyValue).toHaveBeenCalledWith("provider:65d9d2f9")
    expect(fetchMock).toHaveBeenCalled()
    expect(result.content).toEqual([{ type: "text", text: "# kimi result\nsearch ok" }])
})

test("uses kimi provider that actually has an api key", async () => {
    listConfiguredModels.mockResolvedValue([
        {
            provider: "kimi-a",
            runtimeProvider: "provider:65d9d2f9",
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            api: "openai-completions",
            baseUrl: "https://api.moonshot.cn/v1",
        },
        {
            provider: "kimi-b",
            runtimeProvider: "provider:81b0a0b9",
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:3001/v1",
        },
    ])
    listProviderPrefs.mockResolvedValue([])
    getApiKeyValue.mockImplementation((provider: string) => {
        if (provider === "provider:65d9d2f9") return undefined
        if (provider === "provider:81b0a0b9") return "sk-kimi-live"
        return undefined
    })
    getProvider.mockResolvedValue(undefined)

    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: {
                                content: "search ok",
                                tool_calls: [],
                            },
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await securityKimiSearchTool.execute(
        "tool-call-2",
        { query: "CVE-2025-55182" },
        undefined,
        undefined,
        {
            cwd: process.cwd(),
            model: { provider: "provider:65d9d2f9", id: "kimi-k2.5" },
        } as unknown as ExtensionContext,
    )

    expect(getApiKeyValue).toHaveBeenCalledWith("provider:65d9d2f9")
    expect(getApiKeyValue).toHaveBeenCalledWith("provider:81b0a0b9")
    expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3001/v1/chat/completions",
        expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: "Bearer sk-kimi-live",
            }),
        }),
    )
})

test("falls back to provider apiKey embedded in configured provider entry", async () => {
    listConfiguredModels.mockResolvedValue([
        {
            provider: "kimi-300",
            runtimeProvider: "provider:81b0a0b9",
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            api: "openai-completions",
            baseUrl: "https://api.moonshot.cn/v1",
        },
    ])
    listProviderPrefs.mockResolvedValue([])
    getApiKeyValue.mockReturnValue(undefined)
    getProvider.mockImplementation(async (provider: string) =>
        provider === "provider:81b0a0b9"
            ? {
                  apiKey: "sk-inline-provider-key",
              }
            : undefined,
    )

    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            finish_reason: "stop",
                            message: {
                                content: "search ok",
                                tool_calls: [],
                            },
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await securityKimiSearchTool.execute(
        "tool-call-3",
        { query: "CVE-2025-55182" },
        undefined,
        undefined,
        {
            cwd: process.cwd(),
            model: { provider: "provider:81b0a0b9", id: "kimi-k2.5" },
        } as unknown as ExtensionContext,
    )

    expect(getProvider).toHaveBeenCalledWith("provider:81b0a0b9")
    expect(fetchMock).toHaveBeenCalledWith(
        "https://api.moonshot.cn/v1/chat/completions",
        expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: "Bearer sk-inline-provider-key",
            }),
        }),
    )
})
