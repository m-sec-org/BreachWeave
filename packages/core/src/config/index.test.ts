import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { ConfigManager } from "./index"
import type { ModelConfigEntry } from "./providers/types"
import { CHALLENGE_REPORT_PROMPT_NAME } from "./prompts/index"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../challenge/env"

let configDir: string
let config: ConfigManager

beforeEach(async () => {
    configDir = await mkdtemp(resolve(tmpdir(), "tch-test-"))
    config = await ConfigManager.getInstance(configDir)
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_CHALLENGE_ID]
    await rm(configDir, { recursive: true, force: true })
})

describe("Taric host profiles", () => {
    test("persists only explicit embedded host capabilities", async () => {
        const settings = await config.setHostSettings({ taric: { profile: "embedded_bun", embeddedHostCapabilities: ["content_read", "admit", "content_read"] } })
        expect(settings.taric?.embeddedHostCapabilities).toEqual(["content_read", "admit"])
        expect((await config.getHostSettings()).taric?.embeddedHostCapabilities).toEqual(["content_read", "admit"])
        const empty = await config.setHostSettings({ taric: { embeddedHostCapabilities: [] } })
        expect(empty.taric?.embeddedHostCapabilities).toEqual([])
    })

    test("persists acceptance and authority profiles independently of transport", async () => {
        const updated = await config.setHostSettings({ taric: {
            enabled: true,
            profile: "authenticated_proxy",
            acceptanceProfile: "production_hardened",
            authorityProfile: "multi_host_authority",
        } })
        expect(updated.taric).toMatchObject({ profile: "authenticated_proxy", acceptanceProfile: "production_hardened", authorityProfile: "multi_host_authority" })
        expect((await config.getHostSettings()).taric).toMatchObject(updated.taric!)
        const local = await config.setHostSettings({ taric: { acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite" } })
        expect(local.taric).toMatchObject({ profile: "authenticated_proxy", acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite" })
    })
})

// ── API Keys ──

describe("api keys", () => {
    test("set and get api key", () => {
        config.setApiKey("anthropic", "sk-test-123")
        const cred = config.getApiKey("anthropic")
        expect(cred).toEqual({ type: "api_key", key: "sk-test-123" })
    })

    test("has api key", () => {
        expect(config.hasApiKey("anthropic")).toBe(false)
        config.setApiKey("anthropic", "sk-x")
        expect(config.hasApiKey("anthropic")).toBe(true)
    })

    test("remove api key", () => {
        config.setApiKey("anthropic", "sk-x")
        config.removeApiKey("anthropic")
        expect(config.hasApiKey("anthropic")).toBe(false)
    })

    test("list api keys", () => {
        config.setApiKey("a", "k1")
        config.setApiKey("b", "k2")
        expect(config.listApiKeys().sort()).toEqual(["a", "b"])
    })
})

// ── Providers (models.json SDK format) ──

describe("providers", () => {
    test("set and get provider config", async () => {
        await config.setProvider("anthropic", { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" })
        const p = await config.getProvider("anthropic")
        expect(p?.baseUrl).toBe("https://api.anthropic.com")
        expect(p?.api).toBe("anthropic-messages")
    })

    test("set provider with headers and modelOverrides", async () => {
        await config.setProvider("my-proxy", {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Custom": "value" },
            modelOverrides: { "gpt-4o": { headers: { "X-Model": "test" } } },
        })
        const p = await config.getProvider("my-proxy")
        expect(p?.headers).toEqual({ "X-Custom": "value" })
        expect((p?.modelOverrides as any)?.["gpt-4o"]).toBeDefined()
    })

    test("list providers", async () => {
        await config.setProvider("a", { api: "anthropic-messages" })
        await config.setProvider("b", { api: "openai-completions" })
        expect((await config.listProviders()).sort()).toEqual(["a", "b"])
    })

    test("remove provider", async () => {
        await config.setProvider("tmp", { api: "openai-completions" })
        await config.removeProvider("tmp")
        expect(await config.getProvider("tmp")).toBeUndefined()
    })

    test("get non-existent provider returns undefined", async () => {
        expect(await config.getProvider("nope")).toBeUndefined()
    })

    test("update existing provider", async () => {
        await config.setProvider("p", { api: "openai-completions" })
        await config.setProvider("p", { api: "anthropic-messages", baseUrl: "https://x.com" })
        const p = await config.getProvider("p")
        expect(p?.api).toBe("anthropic-messages")
        expect(p?.baseUrl).toBe("https://x.com")
    })

    test("models.json is SDK format", async () => {
        await config.setProvider("test", { api: "openai-completions", baseUrl: "https://test.com" })
        const raw = await Bun.file(resolve(configDir, "models.json")).json()
        expect(raw.providers.test.api).toBe("openai-completions")
        expect(raw.providers.test.baseUrl).toBe("https://test.com")
    })
})

// ── Models (via ModelRegistry) ──

describe("models", () => {
    test("listAllModels returns built-in models", () => {
        const models = config.listAllModels()
        expect(models.length).toBeGreaterThan(0)
    })

    test("findModel finds built-in model", () => {
        const all = config.listAllModels()
        if (all.length > 0) {
            const first = all[0]
            const found = config.findModel(first.provider, first.id)
            expect(found?.id).toBe(first.id)
        }
    })

    test("modelSupportsXhigh works", () => {
        const all = config.listAllModels()
        const model = all.find((m) => m.reasoning)
        if (model) {
            const result = config.modelSupportsXhigh(model)
            expect(typeof result).toBe("boolean")
        }
    })
})

// ── Built-in Reference ──

describe("built-in reference", () => {
    test("listBuiltInProviders returns provider info", () => {
        const providers = config.listBuiltInProviders()
        expect(providers.length).toBeGreaterThan(0)
        const anthropic = providers.find((p) => p.provider === "anthropic")
        expect(anthropic).toBeDefined()
        expect(anthropic!.apis).toContain("anthropic-messages")
        expect(anthropic!.baseUrls.some((u) => u.includes("anthropic.com"))).toBe(true)
        expect(anthropic!.modelCount).toBeGreaterThan(0)
    })

    test("listBuiltInModels returns Model<Api> objects", () => {
        const models = config.listBuiltInModels("anthropic")
        expect(models.length).toBeGreaterThan(0)
        expect(models[0].provider).toBe("anthropic")
        expect(models[0].api).toBe("anthropic-messages")
        expect(models[0].id).toBeDefined()
        expect(models[0].baseUrl).toBeDefined()
        expect(typeof models[0].reasoning).toBe("boolean")
        expect(models[0].contextWindow).toBeGreaterThan(0)
    })

    test("listSupportedProtocols returns protocols from SDK", () => {
        const protocols = config.listSupportedProtocols()
        expect(protocols.length).toBeGreaterThan(0)
        expect(protocols).toContain("anthropic-messages")
        expect(protocols).toContain("openai-completions")
    })
})

// ── Skills (SDK Skill type via loadSkillsFromDir) ──

describe("skills", () => {
    test("creating skill folder with SKILL.md, getSkill returns SDK Skill", async () => {
        const skillDir = resolve(configDir, "skills", "recon")
        await Bun.write(resolve(skillDir, "SKILL.md"), "---\ndescription: Recon skill\n---\n# Recon\nDo recon stuff")
        const skill = config.getSkill("recon")
        expect(skill).toBeDefined()
        expect(skill!.name).toBe("recon")
        expect(skill!.filePath).toContain("recon/SKILL.md")
        expect(skill!.baseDir).toContain("recon")
        expect(skill!.description).toBe("Recon skill")
        // Verify folder structure
        expect(await Bun.file(resolve(configDir, "skills", "recon", "SKILL.md")).exists()).toBe(true)
    })

    test("listSkills returns SDK Skill[] via loadSkillsFromDir", async () => {
        await Bun.write(resolve(configDir, "skills", "a", "SKILL.md"), "---\ndescription: Skill A\n---\nskill a")
        await Bun.write(resolve(configDir, "skills", "b", "SKILL.md"), "---\ndescription: Skill B\n---\nskill b")
        const skills = config.listSkills()
        expect(skills).toHaveLength(2)
        expect(skills.map((s) => s.name).sort()).toEqual(["a", "b"])
        // Each should be a full SDK Skill object
        for (const s of skills) {
            expect(s.filePath).toContain("SKILL.md")
            expect(s.description).toBeDefined()
            expect(typeof s.disableModelInvocation).toBe("boolean")
        }
    })

    test("remove skill deletes entire folder", async () => {
        await Bun.write(resolve(configDir, "skills", "tmp", "SKILL.md"), "---\ndescription: Tmp\n---\ntemp")
        await config.removeSkill("tmp")
        expect(config.getSkill("tmp")).toBeUndefined()
        expect(await Bun.file(resolve(configDir, "skills", "tmp", "SKILL.md")).exists()).toBe(false)
    })

    test("get non-existent skill returns undefined", () => {
        expect(config.getSkill("nope")).toBeUndefined()
    })
})

// ── Prompts CRUD ──

describe("prompts", () => {
    test("set and get prompt", async () => {
        await config.setPrompt({
            name: "ctf-solver",
            meta: { model: "anthropic/claude-sonnet-4-20250514", mcps: ["github", "filesystem"] },
            content: "You are a CTF solver agent.",
        })
        const prompt = await config.getPrompt("ctf-solver")
        expect(prompt?.name).toBe("ctf-solver")
        expect(prompt?.meta.model).toBe("anthropic/claude-sonnet-4-20250514")
        expect(prompt?.meta.mcps).toEqual(["github", "filesystem"])
        expect(prompt?.content).toContain("CTF solver")
    })

    test("list prompts", async () => {
        await config.setPrompt({ name: "a", meta: {}, content: "prompt a" })
        await config.setPrompt({ name: "b", meta: {}, content: "prompt b" })
        await config.setPrompt({ name: CHALLENGE_REPORT_PROMPT_NAME, meta: {}, content: "report template" })
        const list = await config.listPrompts()
        expect(list.length).toBeGreaterThanOrEqual(2)
        expect(list.map((p) => p.name)).toContain("a")
        expect(list.map((p) => p.name)).toContain("b")
        expect(list.map((p) => p.name)).not.toContain(CHALLENGE_REPORT_PROMPT_NAME)
    })

    test("listAgentPrompts and listSubagentPrompts split by isSubagent", async () => {
        await config.setPrompt({ name: "agent-a", meta: {}, content: "agent" })
        await config.setPrompt({ name: "sub-a", meta: { isSubagent: true }, content: "subagent" })

        const agentPrompts = await config.listAgentPrompts()
        const subagentPrompts = await config.listSubagentPrompts()

        expect(agentPrompts.map((p) => p.name)).toContain("agent-a")
        expect(agentPrompts.map((p) => p.name)).not.toContain("sub-a")
        expect(subagentPrompts.map((p) => p.name)).toContain("sub-a")
        expect(subagentPrompts.map((p) => p.name)).not.toContain("agent-a")
    })

    test("remove prompt", async () => {
        await config.setPrompt({ name: "tmp", meta: {}, content: "temp" })
        await config.removePrompt("tmp")
        expect(await config.getPrompt("tmp")).toBeUndefined()
    })

    test("empty mcps array is preserved as an empty whitelist", async () => {
        await config.setPrompt({ name: "no-mcp", meta: { mcps: [] }, content: "no mcp" })
        const prompt = await config.getPrompt("no-mcp")
        expect(prompt?.meta.mcps).toEqual([])
    })

    test("default challenge submit report tool is added to prompt metadata", async () => {
        await config.setPrompt({ name: "default-report-tool", meta: {}, content: "default report tool" })
        const prompt = await config.getPrompt("default-report-tool")

        expect(prompt?.meta.tools).toEqual(["challenge_submit_report"])
    })

    test("default challenge submit report tool is deduplicated with existing tools", async () => {
        await config.setPrompt({
            name: "dedupe-report-tool",
            meta: { tools: ["bash", "challenge_submit_report"] },
            content: "dedupe report tool",
        })
        const prompt = await config.getPrompt("dedupe-report-tool")

        expect(prompt?.meta.tools).toEqual(["bash", "challenge_submit_report"])
    })

    test("default challenge submit report tool is combined with read for skill prompts", async () => {
        await config.setPrompt({
            name: "skill-report-tool",
            meta: { skills: ["web"], tools: ["bash"] },
            content: "skill report tool",
        })
        const prompt = await config.getPrompt("skill-report-tool")

        expect(prompt?.meta.tools).toEqual(["read", "bash", "challenge_submit_report"])
    })

    test("legacy numeric-looking model ids load back as strings", async () => {
        await Bun.write(resolve(configDir, "prompts", "legacy-model.md"), "---\nmodel: 82221541\nobserverModel: 140876c0\n---\nlegacy prompt")

        const prompt = await config.getPrompt("legacy-model")

        expect(prompt?.meta.model).toBe("82221541")
        expect(prompt?.meta.observerModel).toBe("140876c0")
    })

    test("subagent metadata is preserved", async () => {
        await config.setPrompt({
            name: "planner",
            meta: {
                isSubagent: false,
                subagents: ["worker", "reviewer"],
            },
            content: "planner prompt",
        })
        const prompt = await config.getPrompt("planner")
        expect(prompt?.meta.isSubagent).toBe(false)
        expect(prompt?.meta.subagents).toEqual(["worker", "reviewer"])
    })

    test("subagent prompt cannot persist subagents", async () => {
        await config.setPrompt({
            name: "worker",
            meta: {
                isSubagent: true,
                subagents: ["other"],
            },
            content: "worker prompt",
        })
        const prompt = await config.getPrompt("worker")
        expect(prompt?.meta.isSubagent).toBe(true)
        expect(prompt?.meta.subagents).toBeUndefined()
    })

    test("builtin prompt does not overwrite user changes on restart", async () => {
        const promptPath = resolve(configDir, "prompts", "msec-security.md")
        const original = await Bun.file(promptPath).text()

        await Bun.write(promptPath, `${original}\n\nuser override`)
        config = await ConfigManager.getInstance(configDir)

        expect(await Bun.file(promptPath).text()).toContain("user override")
    })

    test("rejects an empty challenge planner prompt without changing its settings", async () => {
        const existing = await config.setChallengePlannerPrompt("Keep the configured planner instructions.", "planner-model")

        await expect(config.setChallengePlannerPrompt(" \n\t ", "replacement-model")).rejects.toThrow("challenge planner prompt content is required")

        expect(await config.getChallengePlannerPrompt()).toEqual(existing)
    })
})

// ── resolvePromptSession ──

describe("resolvePromptSession", () => {
    // ── 基础 ──

    test("returns undefined for non-existent prompt", async () => {
        expect(await config.resolvePromptSession("nope")).toBeUndefined()
    })

    test("always sets modelRuntime", async () => {
        await config.setPrompt({ name: "basic", meta: {}, content: "basic prompt" })
        const opts = await config.resolvePromptSession("basic")
        expect(opts).toBeDefined()
        expect(opts!.modelRuntime).toBe(config.modelRuntime)
    })

    test("always sets resourceLoader", async () => {
        await config.setPrompt({ name: "basic2", meta: {}, content: "prompt content" })
        const opts = await config.resolvePromptSession("basic2")
        expect(opts!.resourceLoader).toBeDefined()
    })

    test("mcps configured → resourceLoader gets MCP extension factory", async () => {
        await config.addMcpServer("chrome", { command: "npx", args: ["chrome-devtools-mcp@latest"] })
        await config.setPrompt({
            name: "with-mcp-extension",
            meta: { mcps: ["chrome"], tools: ["mcp_chrome_click"] },
            content: "prompt content",
        })
        const opts = await config.resolvePromptSession("with-mcp-extension")
        const loader = opts!.resourceLoader as any
        expect(loader.extensionFactories).toHaveLength(1)
    })

    test("subagents configured → resolvePromptSession injects subagent tool", async () => {
        await config.setPrompt({
            name: "main-agent",
            meta: { subagents: ["worker"] },
            content: "main prompt",
        })
        await config.setPrompt({
            name: "worker",
            meta: { isSubagent: true },
            content: "worker prompt",
        })

        const opts = await config.resolvePromptSession("main-agent")

        expect(opts?.customTools?.find((tool) => tool.name === "subagent")).toBeDefined()
    })

    // ── 工具分类 ──

    test("no tools configured → all builtin tools disabled", async () => {
        await config.setPrompt({ name: "no-tools", meta: {}, content: "basic prompt" })
        const opts = await config.resolvePromptSession("no-tools")
        expect(opts!.tools).toEqual([])
        expect(opts!.customTools).toBeUndefined()
    })

    test("default challenge submit report tool is filtered outside challenge sessions", async () => {
        await config.setPrompt({ name: "default-report-tool-filtered", meta: {}, content: "basic prompt" })
        const opts = await config.resolvePromptSession("default-report-tool-filtered")

        expect(opts!.tools).toEqual([])
        expect(opts!.customTools).toBeUndefined()
    })

    test("default challenge submit report tool is enabled in challenge sessions", async () => {
        process.env[CHALLENGE_ENV_CHALLENGE_ID] = "challenge-a"
        await config.setPrompt({ name: "default-report-tool-enabled", meta: {}, content: "basic prompt" })
        const opts = await config.resolvePromptSession("default-report-tool-enabled")

        expect(opts!.tools).toEqual([])
        expect(opts!.customTools?.map((tool) => tool.name)).toContain("challenge_submit_report")
    })

    test("authorized Solver ignores prompt networking tools and exposes only mediated HTTP", async () => {
        process.env[CHALLENGE_ENV_CHALLENGE_ID] = "authorized-project"
        await config.addMcpServer("browser", { command: "browser-mcp", args: [] })
        await config.setPrompt({
            name: "authorized-tools",
            meta: { tools: ["bash", "read", "challenge_submit_report", "security_kimi_search"], mcps: ["browser"], subagents: ["worker"] },
            content: "authorized",
        })
        const opts = await config.resolvePromptSession("authorized-tools", undefined, { authorizedSolver: true, appendChallengeReportPrompt: false })
        expect(opts?.tools).toEqual([])
        expect(opts?.customTools?.map((tool) => tool.name)).toEqual(["challenge_authorized_http", "authorized_work_complete"])
        expect((opts?.resourceLoader as unknown as { extensionFactories: unknown[] }).extensionFactories).toEqual([])
    })

    test("empty tools array → all builtin tools disabled", async () => {
        await config.setPrompt({ name: "empty-tools", meta: { tools: [] }, content: "empty" })
        const opts = await config.resolvePromptSession("empty-tools")
        expect(opts!.tools).toEqual([])
        expect(opts!.customTools).toBeUndefined()
    })

    test("all 7 builtin tools recognized", async () => {
        await config.setPrompt({
            name: "all-builtins",
            meta: { tools: ["bash", "read", "edit", "write", "grep", "find", "ls"] },
            content: "all tools",
        })
        const opts = await config.resolvePromptSession("all-builtins")
        expect(opts!.tools).toHaveLength(7)
        expect(opts!.customTools).toBeUndefined()
    })

    test("builtin tools in prompt → opts.tools set", async () => {
        await config.setPrompt({
            name: "with-builtins",
            meta: { tools: ["bash", "read", "grep"] },
            content: "use these tools",
        })
        const opts = await config.resolvePromptSession("with-builtins")
        expect(opts!.tools).toHaveLength(3)
        expect(opts!.customTools).toBeUndefined()
    })

    test("custom tool in prompt → opts.customTools set", async () => {
        await config.setPrompt({
            name: "with-custom",
            meta: { tools: ["security_kimi_search"] },
            content: "use security search",
        })
        const opts = await config.resolvePromptSession("with-custom")
        expect(opts!.tools).toEqual([])
        expect(opts!.customTools).toHaveLength(1)
        expect(opts!.customTools![0].name).toBe("security_kimi_search")
    })

    test("mixed builtin + custom tools", async () => {
        await config.setPrompt({
            name: "mixed",
            meta: { tools: ["bash", "read", "security_kimi_search"] },
            content: "mixed tools",
        })
        const opts = await config.resolvePromptSession("mixed")
        expect(opts!.tools).toHaveLength(2)
        expect(opts!.customTools).toHaveLength(1)
        expect(opts!.customTools![0].name).toBe("security_kimi_search")
    })

    test("unknown tool names (MCP) → not in tools or customTools", async () => {
        await config.setPrompt({
            name: "with-mcp",
            meta: { tools: ["bash", "mcp_server_search"] },
            content: "with mcp tool",
        })
        const opts = await config.resolvePromptSession("with-mcp")
        expect(opts!.tools).toHaveLength(1) // only bash
        expect(opts!.customTools).toBeUndefined() // mcp_server_search is MCP, not customTools
    })

    test("duplicate tool names only appear once in result", async () => {
        await config.setPrompt({
            name: "dup-tools",
            meta: { tools: ["bash", "bash", "read"] },
            content: "dup",
        })
        const opts = await config.resolvePromptSession("dup-tools")
        expect(opts!.tools).toHaveLength(2)
    })

    // ── Model 解析 ──

    test("no model configured → opts.model and opts.thinkingLevel undefined", async () => {
        await config.setPrompt({ name: "no-model", meta: {}, content: "no model" })
        const opts = await config.resolvePromptSession("no-model")
        expect(opts!.model).toBeUndefined()
        expect(opts!.thinkingLevel).toBeUndefined()
    })

    test("model pref ID not found → resolvePromptSession throws", async () => {
        await config.setPrompt({ name: "bad-model", meta: { model: "nonexistent-id" }, content: "bad model" })
        await expect(config.resolvePromptSession("bad-model")).rejects.toThrow(
            'prompt "bad-model" model "nonexistent-id": model config nonexistent-id not found',
        )
    })

    test("model pref exists but base model not in registry → resolvePromptSession throws", async () => {
        // Add a model pref pointing to a provider/model that doesn't exist
        await config.addModelPref({
            id: "ghost-pref",
            provider: "nonexistent-provider",
            modelId: "nonexistent-model",
        })
        await config.setPrompt({ name: "ghost-model", meta: { model: "ghost-pref" }, content: "ghost" })
        await expect(config.resolvePromptSession("ghost-model")).rejects.toThrow(
            'prompt "ghost-model" model "ghost-pref": models.json error:',
        )
    })

    test("valid model pref → opts.model set with merged overrides", async () => {
        // Use a builtin model from the registry
        const allModels = config.listAllModels()
        const baseModel = allModels.find((m) => m.provider === "anthropic")
        if (!baseModel) return // skip if no anthropic models

        const result = await config.addModelPref({
            id: "test-pref",
            provider: baseModel.provider,
            modelId: baseModel.id,
        })
        expect(result.rejected).toBeUndefined()

        await config.setPrompt({ name: "with-model", meta: { model: "test-pref" }, content: "with model" })
        const opts = await config.resolvePromptSession("with-model")
        expect(opts!.model).toBeDefined()
        expect(opts!.model!.id).toBe(baseModel.id)
        expect(opts!.model!.provider).toBe(baseModel.provider)
    })

    test("model pref persistence strips inherited api and baseUrl", async () => {
        const openaiModel = config.listAllModels().find((model) => model.provider === "openai")
        if (!openaiModel) return

        await config.addProviderPref({
            id: "openai-strip",
            name: "openai",
            api: "openai-responses",
            baseUrl: "https://example-strip.invalid/v1",
            apiKey: "sk-strip",
        })

        const staleEntry = {
            id: "strip-pref",
            provider: "openai",
            providerId: "openai-strip",
            modelId: openaiModel.id,
            api: "google-generative-ai",
            baseUrl: "https://stale-pref.invalid/v1",
        }
        const result = await config.addModelPref(staleEntry as unknown as ModelConfigEntry)
        expect(result.rejected).toBeUndefined()

        const raw = (await Bun.file(resolve(configDir, "model-prefs.json")).json()) as {
            models: Array<Record<string, unknown>>
        }
        const saved = raw.models.find((model) => model.id === "strip-pref")
        expect(saved?.api).toBeUndefined()
        expect(saved?.baseUrl).toBeUndefined()
    })

    test("legacy numeric-looking prompt model ids still resolve model prefs", async () => {
        const allModels = config.listAllModels()
        const baseModel = allModels.find((m) => m.provider === "anthropic")
        if (!baseModel) return

        await config.addModelPref({
            id: "82221541",
            provider: baseModel.provider,
            modelId: baseModel.id,
        })
        await Bun.write(resolve(configDir, "prompts", "legacy-numeric-pref.md"), "---\nmodel: 82221541\n---\nlegacy")

        const opts = await config.resolvePromptSession("legacy-numeric-pref")

        expect(opts!.model).toBeDefined()
        expect(opts!.model!.id).toBe(baseModel.id)
        expect(opts!.model!.provider).toBe(baseModel.provider)
    })

    test("same-name provider prefs require providerId and bind to the selected provider config", async () => {
        const openaiModel = config.listAllModels().find((model) => model.provider === "openai")
        if (!openaiModel) return

        await config.addProviderPref({
            id: "openai-a",
            name: "openai",
            api: "openai-responses",
            baseUrl: "https://example-a.invalid/v1",
            apiKey: "sk-a",
        })
        await config.addProviderPref({
            id: "openai-b",
            name: "openai",
            api: "openai-responses",
            baseUrl: "https://example-b.invalid/v1",
            apiKey: "sk-b",
        })

        const rejected = await config.addModelPref({
            id: "ambiguous-openai",
            provider: "openai",
            modelId: openaiModel.id,
        })
        expect(rejected.rejected).toContain('provider "openai" is ambiguous')

        const result = await config.addModelPref({
            id: "bound-openai",
            provider: "openai",
            providerId: "openai-b",
            modelId: openaiModel.id,
        })
        expect(result.rejected).toBeUndefined()

        await config.setPrompt({ name: "bound-openai-prompt", meta: { model: "bound-openai" }, content: "bound" })
        const opts = await config.resolvePromptSession("bound-openai-prompt")

        expect(opts!.model).toBeDefined()
        expect(opts!.model!.provider).toBe("provider:openai-b")
        expect(opts!.model!.baseUrl).toBe("https://example-b.invalid/v1")
    })

    test("updating provider protocol preserves configured models in models.json", async () => {
        const openaiModel = config.listAllModels().find((model) => model.provider === "openai")
        if (!openaiModel) return

        await config.addProviderPref({
            id: "openai-a",
            name: "openai",
            api: "openai-responses",
            baseUrl: "https://example-a.invalid/v1",
            apiKey: "sk-a",
        })
        await config.addModelPref({
            id: "bound-openai",
            provider: "openai",
            providerId: "openai-a",
            modelId: openaiModel.id,
        })

        let raw = (await Bun.file(resolve(configDir, "models.json")).json()) as {
            providers: Record<string, { api?: string; baseUrl?: string; apiKey?: string; models?: Array<Record<string, unknown>> }>
        }
        expect(raw.providers["provider:openai-a"]?.apiKey).toBe("sk-a")
        expect(raw.providers["provider:openai-a"]?.models?.some((model) => model.id === openaiModel.id)).toBe(true)

        raw.providers["provider:openai-a"] = {
            ...raw.providers["provider:openai-a"],
            models: raw.providers["provider:openai-a"]?.models?.map((model) =>
                model.id === openaiModel.id
                    ? {
                          ...model,
                          api: "google-generative-ai",
                          baseUrl: "https://stale-model.invalid/v1",
                      }
                    : model,
            ),
        }
        await Bun.write(resolve(configDir, "models.json"), JSON.stringify(raw, null, 2))
        config.models.refresh()

        await config.updateProviderPref("openai-a", {
            api: "openai-completions",
            baseUrl: "https://example-b.invalid/v1",
        })

        raw = (await Bun.file(resolve(configDir, "models.json")).json()) as {
            providers: Record<string, { api?: string; baseUrl?: string; apiKey?: string; models?: Array<Record<string, unknown>> }>
        }
        expect(raw.providers["provider:openai-a"]?.api).toBe("openai-completions")
        expect(raw.providers["provider:openai-a"]?.baseUrl).toBe("https://example-b.invalid/v1")
        expect(raw.providers["provider:openai-a"]?.apiKey).toBe("sk-a")
        expect(raw.providers["provider:openai-a"]?.models?.some((model) => model.id === openaiModel.id)).toBe(true)
        expect(raw.providers["provider:openai-a"]?.models?.find((model) => model.id === openaiModel.id)?.api).toBeUndefined()
        expect(raw.providers["provider:openai-a"]?.models?.find((model) => model.id === openaiModel.id)?.baseUrl).toBeUndefined()

        const configured = await config.listConfiguredModels()
        const resolved = configured.find((model) => model.runtimeProvider === "provider:openai-a" && model.id === openaiModel.id)
        expect(resolved?.api).toBe("openai-completions")
        expect(resolved?.baseUrl).toBe("https://example-b.invalid/v1")
    })

    test("stale protocol fields in saved configs do not override provider protocol during prompt resolution", async () => {
        const openaiModel = config.listAllModels().find((model) => model.provider === "openai")
        if (!openaiModel) return

        await config.addProviderPref({
            id: "openai-stale",
            name: "openai",
            api: "openai-responses",
            baseUrl: "https://example-stale-a.invalid/v1",
            apiKey: "sk-stale",
        })
        await config.addModelPref({
            id: "stale-openai",
            provider: "openai",
            providerId: "openai-stale",
            modelId: openaiModel.id,
        })
        await config.updateProviderPref("openai-stale", {
            api: "openai-completions",
            baseUrl: "https://example-stale-b.invalid/v1",
        })

        const modelPrefsPath = resolve(configDir, "model-prefs.json")
        const rawModelPrefs = (await Bun.file(modelPrefsPath).json()) as {
            models: Array<Record<string, unknown>>
        }
        rawModelPrefs.models = rawModelPrefs.models.map((model) =>
            model.id === "stale-openai"
                ? {
                      ...model,
                      api: "google-generative-ai",
                      baseUrl: "https://stale-pref.invalid/v1",
                  }
                : model,
        )
        await Bun.write(modelPrefsPath, JSON.stringify(rawModelPrefs, null, 2))

        const modelsJsonPath = resolve(configDir, "models.json")
        const rawModels = (await Bun.file(modelsJsonPath).json()) as {
            providers: Record<string, { api?: string; baseUrl?: string; models?: Array<Record<string, unknown>> }>
        }
        rawModels.providers["provider:openai-stale"] = {
            ...rawModels.providers["provider:openai-stale"],
            models: rawModels.providers["provider:openai-stale"]?.models?.map((model) =>
                model.id === openaiModel.id
                    ? {
                          ...model,
                          api: "google-generative-ai",
                          baseUrl: "https://stale-model.invalid/v1",
                      }
                    : model,
            ),
        }
        await Bun.write(modelsJsonPath, JSON.stringify(rawModels, null, 2))
        config.models.refresh()

        await config.setPrompt({ name: "stale-openai-prompt", meta: { model: "stale-openai" }, content: "bound" })
        const opts = await config.resolvePromptSession("stale-openai-prompt")

        expect(opts!.model).toBeDefined()
        expect(opts!.model!.provider).toBe("provider:openai-stale")
        expect(opts!.model!.api).toBe("openai-completions")
        expect(opts!.model!.baseUrl).toBe("https://example-stale-b.invalid/v1")

        const listed = await config.listModelPrefs()
        const saved = listed.find((model) => model.id === "stale-openai") as Record<string, unknown> | undefined
        expect(saved?.api).toBeUndefined()
        expect(saved?.baseUrl).toBeUndefined()
    })

    test("model pref with thinkingLevel → opts.thinkingLevel set", async () => {
        const allModels = config.listAllModels()
        const reasoningModel = allModels.find((m) => m.reasoning)
        if (!reasoningModel) return // skip if no reasoning models

        await config.addModelPref({
            id: "think-pref",
            provider: reasoningModel.provider,
            modelId: reasoningModel.id,
            thinkingLevel: "high",
        })
        await config.setPrompt({ name: "with-thinking", meta: { model: "think-pref" }, content: "think" })
        const opts = await config.resolvePromptSession("with-thinking")
        expect(opts!.thinkingLevel).toBe("high")
    })

    // ── resourceLoader: skillsOverride ──

    test("no skills configured → skillsOverride returns empty skills", async () => {
        await config.setPrompt({ name: "no-skills", meta: {}, content: "no skills" })
        const opts = await config.resolvePromptSession("no-skills")
        const loader = opts!.resourceLoader as any
        const overrideFn = loader.skillsOverride
        expect(overrideFn).toBeDefined()
        const result = overrideFn({ skills: [{ name: "recon" }, { name: "exploit" }] })
        expect(result.skills).toHaveLength(0)
    })

    test("skills configured → skillsOverride filters skills", async () => {
        await config.setPrompt({ name: "with-skills", meta: { skills: ["recon", "exploit"] }, content: "skills" })
        const opts = await config.resolvePromptSession("with-skills")
        const loader = opts!.resourceLoader as any
        const overrideFn = loader.skillsOverride
        expect(overrideFn).toBeDefined()

        const baseSkills = [{ name: "recon" }, { name: "exploit" }, { name: "unrelated" }]
        const result = overrideFn({ skills: baseSkills })
        expect(result.skills).toHaveLength(2)
        expect(result.skills.map((s: any) => s.name).sort()).toEqual(["exploit", "recon"])
    })

    test("skills filter with no matching base skills → empty result", async () => {
        await config.setPrompt({ name: "orphan-skills", meta: { skills: ["missing"] }, content: "orphan" })
        const opts = await config.resolvePromptSession("orphan-skills")
        const loader = opts!.resourceLoader as any
        const overrideFn = loader.skillsOverride
        const result = overrideFn({ skills: [{ name: "other" }] })
        expect(result.skills).toHaveLength(0)
    })

    // ── resourceLoader: systemPrompt ──

    test("resourceLoader normalizes systemPrompt to systemPromptOverride", async () => {
        await config.setPrompt({ name: "sys-prompt", meta: {}, content: "You are a CTF solver." })
        const opts = await config.resolvePromptSession("sys-prompt")
        const loader = opts!.resourceLoader as any
        expect(loader.systemPromptOverride(undefined)).toBe("You are a CTF solver.")
    })

    test("resourceLoader appends prompt text from prompt session extensions", async () => {
        await config.setPrompt({ name: "sys-prompt-ext", meta: {}, content: "Base prompt" })
        const opts = await config.resolvePromptSession("sys-prompt-ext", [
            {
                factory: (() => undefined) as ExtensionFactory,
                appendSystemPrompt: "Observer contract",
            },
        ])
        const loader = opts!.resourceLoader as any

        expect(loader.systemPromptOverride(undefined)).toBe("Base prompt\n\nObserver contract")
    })

    test("resourceLoader appends multiple prompt session extension texts without overwrite", async () => {
        await config.setPrompt({ name: "sys-prompt-ext-multi", meta: {}, content: "Base prompt" })
        const opts = await config.resolvePromptSession("sys-prompt-ext-multi", [
            {
                factory: (() => undefined) as ExtensionFactory,
                appendSystemPrompt: "Challenge contract",
            },
            {
                factory: (() => undefined) as ExtensionFactory,
                appendSystemPrompt: "Observer contract",
            },
        ])
        const loader = opts!.resourceLoader as any

        expect(loader.systemPromptOverride(undefined)).toBe("Base prompt\n\nChallenge contract\n\nObserver contract")
    })

    test("resourceLoader does not append challenge report prompt by default", async () => {
        await config.setPrompt({ name: CHALLENGE_REPORT_PROMPT_NAME, meta: {}, content: "Report template" })
        await config.setPrompt({ name: "sys-prompt-no-report", meta: {}, content: "Base prompt" })

        const opts = await config.resolvePromptSession("sys-prompt-no-report")
        const loader = opts!.resourceLoader as any

        expect(loader.systemPromptOverride(undefined)).toBe("Base prompt")
    })

    test("resourceLoader appends challenge report prompt after extension prompts when enabled", async () => {
        await config.setPrompt({ name: CHALLENGE_REPORT_PROMPT_NAME, meta: {}, content: "Report template" })
        await config.setPrompt({ name: "sys-prompt-report", meta: {}, content: "Base prompt" })

        const opts = await config.resolvePromptSession(
            "sys-prompt-report",
            [
                {
                    factory: (() => undefined) as ExtensionFactory,
                    appendSystemPrompt: "Observer contract",
                },
            ],
            { appendChallengeReportPrompt: true },
        )
        const loader = opts!.resourceLoader as any

        expect(loader.systemPromptOverride(undefined)).toBe("Base prompt\n\nObserver contract\n\nReport template")
    })
})

// ── Tools + MCP Integration ──

describe("tools", () => {
    test("listTools hides challenge memory tools from config surface", () => {
        const names = config.listTools().map((tool) => tool.name)

        expect(names).not.toContain("memory_add")
        expect(names).not.toContain("memory_list")
        expect(names).not.toContain("memory_idea_add")
        expect(names).not.toContain("memory_idea_list")
        expect(names).not.toContain("memory_idea_search")
        expect(names).not.toContain("memory_idea_update")
        expect(names).not.toContain("idea_add")
        expect(names).not.toContain("idea_list")
        expect(names).not.toContain("idea_search")
        expect(names).not.toContain("idea_update")
    })

    test("listTools includes builtin and custom", () => {
        const list = config.listTools()
        const names = list.map((t) => t.name)
        // SDK builtin
        expect(names).toContain("bash")
        expect(names).toContain("read")
        // custom
        expect(names).toContain("security_kimi_search")
        const searchEntry = list.find((t) => t.name === "security_kimi_search")!
        expect(searchEntry.source).toBe("custom")
    })

    test("listTools includes MCP server tools from cache", async () => {
        const cache = {
            version: 1,
            servers: {
                "test-server": {
                    configHash: "abc",
                    tools: [
                        { name: "search_repos", description: "Search repositories" },
                        { name: "get_file", description: "Get file contents", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
                    ],
                    resources: [],
                    cachedAt: Date.now(),
                },
            },
        }
        await config.saveMcpToolCache(cache)
        // Add matching MCP server config
        await config.addMcpServer("test-server", { command: "npx", args: ["-y", "test-mcp"] })

        const list = config.listTools()
        const mcpTools = list.filter((t) => t.source === "mcp")
        expect(mcpTools.length).toBe(2)
        expect(mcpTools[0].server).toBe("test-server")
        // Default prefix is "server" → "mcp_test_server_search_repos"
        expect(mcpTools[0].name).toContain("search_repos")
        expect(mcpTools[0].direct).toBe(false)
    })

    test("listTools marks direct tools", async () => {
        const cache = {
            version: 1,
            servers: {
                myserver: {
                    configHash: "x",
                    tools: [{ name: "tool_a" }, { name: "tool_b" }],
                    resources: [],
                    cachedAt: Date.now(),
                },
            },
        }
        await config.saveMcpToolCache(cache)
        await config.addMcpServer("myserver", { command: "test", directTools: ["tool_a"] })

        const list = config.listTools()
        const mcpTools = list.filter((t) => t.source === "mcp")
        const toolA = mcpTools.find((t) => t.label === "tool_a")!
        const toolB = mcpTools.find((t) => t.label === "tool_b")!
        expect(toolA.direct).toBe(true)
        expect(toolB.direct).toBe(false)
    })

    test("MCP cache round-trip", async () => {
        expect(config.loadMcpToolCache()).toBeNull()
        const cache = {
            version: 1,
            servers: {
                s1: { configHash: "h", tools: [{ name: "t1" }], resources: [], cachedAt: 1 },
            },
        }
        await config.saveMcpToolCache(cache)
        const loaded = config.loadMcpToolCache()
        expect(loaded).toEqual(cache)
    })
})

// ── Directory Structure ──

describe("initialization", () => {
    test("creates config directories", async () => {
        const dir = await mkdtemp(resolve(tmpdir(), "tch-init-"))
        try {
            await ConfigManager.getInstance(dir)
            const { readdir } = await import("fs/promises")
            await expect(readdir(resolve(dir, "prompts"))).resolves.toBeDefined()
            await expect(readdir(resolve(dir, "skills"))).resolves.toBeDefined()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
