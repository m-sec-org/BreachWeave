import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SolverAssignmentReview } from "../../../challenge/solver-review"
import type { SolverAssignmentReviewContext } from "./types"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"

let reviewContext: SolverAssignmentReviewContext = { task: "", submissions: [], submission_ids: [], review_required: false }
let onPrompt: (() => Promise<void>) | undefined
const requestHostBridge = mock(async (toolName?: string, _params?: unknown): Promise<unknown> => {
    if (toolName === "challenge_get_solver_review_context") return reviewContext
    if (toolName === "challenge_submit_solver_review") {
        expect(lastSession?.dispose).toHaveBeenCalled()
        return { accepted: true }
    }
    return {
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
    }
})

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
let lastSession: { prompt: ReturnType<typeof mock>; subscribe: ReturnType<typeof mock>; abort: ReturnType<typeof mock>; dispose: ReturnType<typeof mock> } | undefined

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
            await onPrompt?.()
            subscriber?.({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "observer summary" }] },
            })
        }),
        abort: mock(async () => {}),
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
    buildSessionContext: () => ({ messages: [] }),
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
    onPrompt = undefined
    reviewContext = { task: "", submissions: [], submission_ids: [], review_required: false }
    requestHostBridge.mockClear()
    resolveModelPref.mockClear()
    createAgentSession.mockClear()
    sessionManagerCreate.mockClear()
})

afterEach(async () => {
    delete process.env.TCH_SOLVER_SESSION_DIR
    delete process.env.TCH_SOLVER_WORKSPACE
    delete process.env[CHALLENGE_ENV_CHALLENGE_ID]
    await rm(solverSessionDir, { recursive: true, force: true })
    await rm(solverWorkspaceDir, { recursive: true, force: true })
})

describe("runSolverObserverReview", () => {
    const finalPayload = { reason: "agent_end", rounds: [], session_context: "", branch_entry_count: 0, message_count: 0 } as const
    const review: SolverAssignmentReview = {
        summary: "全部分工有工具证据，允许交由 planner 收尾。",
        checklist: [{ asset_hash: "asset-1", test_item: "验证上传限制", verdict: "verified", evidence: "entry result-1: rejected executable upload" }],
        concerns: [],
        remaining_work: [],
        suggested_decision: "stop",
    }

    function requireAssignmentReview() {
        reviewContext = {
            task: "目标入口: [asset-1] http://target\n本次测试项:\n- 验证上传限制",
            submissions: [{ id: "submission-1", challenge_id: "chal-1", asset_hash: "asset-1", asset: "http://target", report: "完整报告：上传响应证据", test_results: [{ test_item: "验证上传限制", status: "completed", evidence: "HTTP response: rejected executable upload" }], created_at: "2026-11-04T00:00:00Z" }],
            submission_ids: ["submission-1"],
            review_required: true,
        }
    }

    function reviewTools() {
        return capturedCreateSessionOptions?.customTools as Array<{ name: string; execute: (callId: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }>
    }

    test("forces independent final audit with complete reports and history even with no recent rounds or periodic observer", async () => {
        requireAssignmentReview()
        const completeEvidence = `executed payload=${"proof".repeat(100)} rejected executable upload`
        await Bun.write(join(solverSessionDir, "main.jsonl"), JSON.stringify({ type: "message", id: "result-1", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: completeEvidence }] } }))
        onPrompt = async () => {
            expect(capturedLoaderOptions?.systemPromptOverride()).toContain("逐个资产、逐个清单项")
            expect(capturedLoaderOptions?.systemPromptOverride()).toContain("偷懒、捏造、作弊疑点")
            expect(reviewTools().map((tool) => tool.name)).toEqual(["query_solver_history", "submit_assignment_review"])
            await expect(reviewTools()[1]!.execute("early", review)).rejects.toThrow("Inspect the complete solver history")
            const history = await reviewTools()[0]!.execute("history", {})
            expect(history.content[0]?.text).toContain(completeEvidence)
            await reviewTools()[1]!.execute("review", review)
            expect(requestHostBridge.mock.calls.some(([name]) => name === "challenge_submit_solver_review")).toBe(false)
        }

        const result = await runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] }, { periodicEnabled: false })

        expect(result.applied).toBe(true)
        expect(capturedPrompt).toContain(reviewContext.task)
        expect(capturedPrompt).toContain("完整报告：上传响应证据")
        expect(capturedPrompt).toContain("HTTP response: rejected executable upload")
        expect(requestHostBridge).toHaveBeenCalledWith("challenge_submit_solver_review", { submission_ids: ["submission-1"], review })
        expect(requestHostBridge.mock.calls.some(([name]) => name === "challenge_get_state")).toBe(false)
    })

    test("keeps all execution evidence while omitting thinking and bounding oversized history fields", async () => {
        requireAssignmentReview()
        await Bun.write(join(solverSessionDir, "main.jsonl"), [
            JSON.stringify({ type: "message", id: "system-1", message: { role: "system", content: [{ type: "text", text: "repeated system prompt" }] } }),
            JSON.stringify({ type: "message", id: "thinking-1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] } }),
            JSON.stringify({ type: "message", id: "tool-call-1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: `start-${"x".repeat(5000)}-end` } }] } }),
            JSON.stringify({ type: "message", id: "tool-result-1", message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", content: [{ type: "text", text: `begin-${"y".repeat(12000)}-finish` }] } }),
        ].join("\n"))
        onPrompt = async () => {
            const history = await reviewTools()[0]!.execute("history", {})
            const text = history.content[0]?.text ?? ""
            expect(text).toContain("tool-call-1")
            expect(text).toContain("tool-result-1")
            expect(text).toContain("truncated")
            expect(text).toContain("begin-")
            expect(text).toContain("-finish")
            expect(text).not.toContain("repeated system prompt")
            expect(text).not.toContain("private reasoning")
            await reviewTools()[1]!.execute("review", review)
        }

        await expect(runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] }, { periodicEnabled: false })).resolves.toMatchObject({ applied: true })
    })

    test("does not treat a normal final response as a structured review", async () => {
        requireAssignmentReview()
        await expect(runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] })).rejects.toThrow("did not submit a structured assignment review")
        expect(lastSession?.dispose).toHaveBeenCalled()
        expect(requestHostBridge.mock.calls.some(([name]) => name === "challenge_submit_solver_review")).toBe(false)
    })

    test("rejects invalid structured review without accepting the audit", async () => {
        requireAssignmentReview()
        onPrompt = async () => { await reviewTools()[1]!.execute("review", { ...review, checklist: [] }) }
        await expect(runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] })).rejects.toThrow("Invalid structured assignment review")
        expect(lastSession?.dispose).toHaveBeenCalled()
        expect(requestHostBridge.mock.calls.some(([name]) => name === "challenge_submit_solver_review")).toBe(false)
    })

    test("aborts and disposes an audit that exceeds its timeout", async () => {
        requireAssignmentReview()
        onPrompt = () => new Promise<void>(() => {})
        await expect(runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] }, { reviewTimeoutMs: 5 })).rejects.toThrow("review timed out")
        expect(lastSession?.abort).toHaveBeenCalled()
        expect(lastSession?.dispose).toHaveBeenCalled()
        expect(requestHostBridge.mock.calls.some(([name]) => name === "challenge_submit_solver_review")).toBe(false)
    })

    test.each(["periodic", "hint"] as const)("bounds a hanging %s review and releases its session", async (reason) => {
        onPrompt = () => new Promise<void>(() => {})
        await expect(runSolverObserverReview("chal-1", {
            ...finalPayload,
            reason,
            rounds: [{ round: 6, assistant_summary: "recent activity", tool_logs: [] }],
        }, { reviewTimeoutMs: 5 })).rejects.toThrow(`${reason} review timed out`)
        expect(lastSession?.abort).toHaveBeenCalled()
        expect(lastSession?.dispose).toHaveBeenCalled()
    })

    test("a hanging periodic review times out so the queued final assignment audit can run", async () => {
        const { attachObserverLoop } = await import("./observer-loop")
        const handlers: Record<string, (...args: unknown[]) => Promise<void> | void> = {}
        const started = Promise.withResolvers<void>()
        let periodicSession: typeof lastSession
        let prompts = 0
        onPrompt = async () => {
            prompts += 1
            if (prompts === 1) {
                periodicSession = lastSession
                started.resolve()
                await new Promise<void>(() => {})
                return
            }
            expect(periodicSession?.abort).toHaveBeenCalled()
            expect(periodicSession?.dispose).toHaveBeenCalled()
            await reviewTools()[1]!.execute("review", review)
        }
        process.env[CHALLENGE_ENV_CHALLENGE_ID] = "chal-1"
        attachObserverLoop({
            on(event: string, handler: (...args: unknown[]) => Promise<void> | void) { handlers[event] = handler },
        } as never, {
            runReview: (challengeId, payload, options) => runSolverObserverReview(challengeId, payload, { ...options, reviewTimeoutMs: 30 }),
            buildSessionContext: () => ({ messages: [] }) as never,
        })
        const ctx = { sessionManager: { getEntries: () => [] } }
        for (let round = 1; round <= 6; round += 1) {
            await handlers.message_end?.({ message: { role: "assistant", content: [{ type: "text", text: `round ${round}` }] } }, ctx)
        }
        await started.promise
        requireAssignmentReview()

        await handlers.agent_end?.({}, ctx)

        expect(prompts).toBe(2)
        expect(requestHostBridge).toHaveBeenCalledWith("challenge_submit_solver_review", { submission_ids: ["submission-1"], review })
        expect(lastSession?.dispose).toHaveBeenCalled()
    })

    test("gives long full-history audits more time with a ten-minute upper bound", async () => {
        requireAssignmentReview()
        const timer = spyOn(globalThis, "setTimeout")
        const budgets: number[] = []
        try {
            for (const count of [200, 2000]) {
                const entries = Array.from({ length: count }, (_, index) => JSON.stringify({ type: "message", id: `entry-${index}`, message: { role: "assistant", content: [] } })).join("\n")
                await Bun.write(join(solverSessionDir, "main.jsonl"), entries)
                onPrompt = async () => {
                    for (let offset = 0; offset < count; offset += 20) await reviewTools()[0]!.execute("history", { offset, limit: 20 })
                    await reviewTools()[1]!.execute("review", review)
                }
                await runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] })
                budgets.push(Number(timer.mock.calls.at(-1)?.[1]))
            }
        } finally {
            timer.mockRestore()
        }
        expect(budgets[0]).toBeGreaterThan(120_000)
        expect(budgets[1]).toBeGreaterThan(budgets[0]!)
        expect(budgets[1]).toBe(600_000)
    })

    test("gives large evidence entries more time even when the message count is small", async () => {
        requireAssignmentReview()
        const timer = spyOn(globalThis, "setTimeout")
        try {
            const count = 20
            const entries = Array.from({ length: count }, (_, index) => JSON.stringify({
                type: "message",
                id: `entry-${index}`,
                message: { role: "toolResult", content: [{ type: "text", text: "evidence-".padEnd(10_000, "x") }] },
            })).join("\n")
            await Bun.write(join(solverSessionDir, "main.jsonl"), entries)
            onPrompt = async () => {
                for (let offset = 0; offset < count; offset += 20) await reviewTools()[0]!.execute("history", { offset, limit: 20 })
                await reviewTools()[1]!.execute("review", review)
            }
            await runSolverObserverReview("chal-1", { ...finalPayload, rounds: [] })
            expect(Number(timer.mock.calls.at(-1)?.[1])).toBeGreaterThan(120_000)
        } finally {
            timer.mockRestore()
        }
    })

    test("skips board maintenance when only the mandatory audit is enabled and no review is required", async () => {
        const result = await runSolverObserverReview("chal-1", { ...finalPayload, rounds: [{ round: 1, assistant_summary: "done", tool_logs: [] }] }, { periodicEnabled: false })
        expect(result).toEqual({ applied: false })
        expect(requestHostBridge).toHaveBeenCalledWith("challenge_get_solver_review_context", {})
        expect(createAgentSession).not.toHaveBeenCalled()
    })
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
