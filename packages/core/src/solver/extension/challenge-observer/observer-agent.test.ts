import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const requestHostBridge = mock(async () => ({
    challenge_id: "chal-1",
    is_completed: false,
    challenge: {
        id: "chal-1",
        title: "Upload",
        difficulty: "easy",
        level: 1,
        instance_status: "running",
        entrypoint: ["http://target"],
        assets: { urls: [{ asset: "http://target", scanned: false }], ips: [] },
        hint_viewed: true,
        hint_content: "focus on upload parser",
        updated_at: "2026-04-12T00:00:00.000Z",
    },
}))

const resolveModelPref = mock(async () => ({
    model: { provider: "openai", id: "kimi-fast" },
    thinkingLevel: "low",
}))

const configInstance = {
    auth: {},
    models: {},
    settings: {},
    resolveModelPref,
}

let capturedLoaderOptions: { systemPromptOverride: () => string } | undefined
let capturedCreateSessionOptions: Record<string, unknown> | undefined
let capturedPrompt = ""
let lastSession: { prompt: ReturnType<typeof mock>; subscribe: ReturnType<typeof mock>; dispose: ReturnType<typeof mock> } | undefined

class FakeDefaultResourceLoader {
    constructor(options: { systemPromptOverride: () => string }) {
        capturedLoaderOptions = options
    }

    async reload(): Promise<void> {}
}

const sessionManagerCreate = mock((cwd: string, sessionDir: string) => ({ cwd, sessionDir }))

const createAgentSession = mock(async (options: Record<string, unknown>) => {
    capturedCreateSessionOptions = options
    let subscriber: ((event: unknown) => void) | undefined
    lastSession = {
        subscribe: mock((fn: (event: unknown) => void) => {
            subscriber = fn
            return () => {}
        }),
        prompt: mock(async (message: string) => {
            capturedPrompt = message
            subscriber?.({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "observer summary" }] },
            })
        }),
        dispose: mock(() => {}),
    }
    return { session: lastSession }
})

mock.module("../../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

mock.module("../../../config/index", () => ({
    DEFAULT_CONFIG_DIR: "/tmp/test-config",
    ConfigManager: {
        getInstance: async () => configInstance,
    },
}))

mock.module("@earendil-works/pi-coding-agent", () => ({
    defineTool: <T>(tool: T) => tool,
    DefaultResourceLoader: FakeDefaultResourceLoader,
    SessionManager: {
        create: sessionManagerCreate,
        open: mock(() => ({
            getEntries: () => [],
        })),
    },
    createAgentSession,
}))

const { runSolverObserverReview } = await import("./observer-agent")

let solverSessionDir = ""
let solverWorkspaceDir = ""

beforeEach(async () => {
    solverSessionDir = await mkdtemp(resolve(tmpdir(), "tch-observer-session-"))
    solverWorkspaceDir = await mkdtemp(resolve(tmpdir(), "tch-observer-workspace-"))
    process.env.TCH_SOLVER_SESSION_DIR = solverSessionDir
    process.env.TCH_SOLVER_WORKSPACE = solverWorkspaceDir
    capturedLoaderOptions = undefined
    capturedCreateSessionOptions = undefined
    capturedPrompt = ""
    lastSession = undefined
    requestHostBridge.mockClear()
    resolveModelPref.mockClear()
    createAgentSession.mockClear()
    sessionManagerCreate.mockClear()
})

afterEach(async () => {
    delete process.env.TCH_SOLVER_SESSION_DIR
    delete process.env.TCH_SOLVER_WORKSPACE
    await rm(solverSessionDir, { recursive: true, force: true })
    await rm(solverWorkspaceDir, { recursive: true, force: true })
})

describe("runSolverObserverReview", () => {
    test("returns early when no rounds are provided", async () => {
        const result = await runSolverObserverReview("chal-1", {
            reason: "periodic",
            rounds: [],
            session_context: "",
            branch_entry_count: 0,
            message_count: 0,
        })

        expect(result).toEqual({ applied: false })
        expect(requestHostBridge).not.toHaveBeenCalled()
        expect(createAgentSession).not.toHaveBeenCalled()
    })

    test("creates observer session and prompts with challenge context", async () => {
        const assignmentContext = [
            "## Assigned Test Checklist",
            "本次测试项:",
            "- 验证上传解析器的文件类型限制。",
            "- 记录所有未完成项、失败边界与复现证据。",
            "## Project Startup Constraints",
            "项目级别启动补充说明（最高优先级遵循）:",
            "只测试分配的上传入口；其他发现交由 planner 后续分配。",
        ].join("\n")
        const result = await runSolverObserverReview(
            "chal-1",
            {
                reason: "hint",
                rounds: [{ round: 2, assistant_summary: "try upload", tool_logs: [] }],
                session_context: assignmentContext,
                branch_entry_count: 3,
                message_count: 7,
            },
            { observerModel: "kimi-fast" },
        )

        expect(result).toEqual({ applied: true, summary: "observer summary" })
        expect(resolveModelPref).toHaveBeenCalledWith("kimi-fast")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("observer sidecar")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("如果本轮无需修改，只回复 `NO_CHANGE`")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("必须在 `memory_add` 中设置 `publish_to_challenge: true`")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("memory 保持在 12 条以内")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("每轮 user prompt 只提供动态上下文")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("send_efficiency_reminder")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("query_solver_history")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("对照分配清单检查最近行为")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("尚未验证的新发现只能作为候选 idea")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("不能因某一项有结果就视为整份清单完成")
        expect(sessionManagerCreate).toHaveBeenCalledWith(solverWorkspaceDir, join(solverSessionDir, ".observer"))
        expect(capturedCreateSessionOptions).toMatchObject({
            cwd: solverWorkspaceDir,
            model: { provider: "openai", id: "kimi-fast" },
            thinkingLevel: "low",
            noTools: "builtin",
        })
        expect(capturedCreateSessionOptions?.tools).toBeUndefined()
        const customTools = capturedCreateSessionOptions?.customTools as Array<{ name?: string }> | undefined
        const customToolNames = customTools?.map((tool) => tool.name) ?? []
        expect(customToolNames).toContain("memory_list")
        expect(customToolNames).toContain("query_solver_history")
        expect(customToolNames).toContain("send_efficiency_reminder")
        expect(capturedPrompt).toContain("## Challenge State")
        expect(capturedPrompt).toContain("- id: chal-1")
        expect(capturedPrompt).toContain("<solver-context>")
        expect(capturedPrompt).toContain(assignmentContext)
        expect(capturedPrompt).toContain("</solver-context>")
        expect(capturedPrompt).toContain("focus on upload parser")
        expect(capturedPrompt).toContain("## Recent Solver Activity")
        expect(capturedPrompt).toContain("### Round 2")
        expect(capturedPrompt).toContain("- assistant: try upload")
        expect(capturedPrompt).toContain("没有改动就只回复 `NO_CHANGE`")
        expect(capturedPrompt).toContain("主动在 `memory_add` / `idea_add` 中设置 `publish_to_challenge: true`")
        expect(capturedPrompt).toContain("明确越界或持续离题时，通过 `send_efficiency_reminder`")
        expect(capturedPrompt).toContain("供 planner 和后继 solver 使用")
        expect(capturedPrompt).not.toContain("不要自己解题，只做策略看板维护。")
        expect(capturedPrompt).not.toContain("目标是维护 ideas / memory 看板，不是解释 solver 过程。")
        expect(lastSession?.dispose).toHaveBeenCalled()
    })
})
