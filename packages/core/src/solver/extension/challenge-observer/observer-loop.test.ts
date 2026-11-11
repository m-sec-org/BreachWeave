import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { buildSessionContext as sdkBuildSessionContext } from "@earendil-works/pi-coding-agent"

const reviewCalls: Array<[string, unknown, unknown]> = []
const runSolverObserverReview = mock(async (challengeId: string, payload: unknown, options: unknown) => {
    reviewCalls.push([challengeId, payload, options])
    return { applied: true, summary: "ok" }
})

const requestHostBridge = mock(async (): Promise<{ is_completed: boolean; solver_task_completed?: boolean }> => ({ is_completed: false }))

mock.module("../../../challenge/host-bridge-client", () => ({
    requestHostBridge,
    markAuthorizedWorkFinished: mock(() => {}),
}))

const { attachObserverLoop, buildObserverExtensionAppendPrompt, retryPendingSolverReview } = await import("./observer-loop")
const { loadRecentObserverRounds } = await import("./observer-store")

let sessionDir = ""

interface HandlerMap {
    [event: string]: Array<(...args: unknown[]) => Promise<void> | void>
}

function createExtensionApiHarness() {
    const handlers: HandlerMap = {}
    const sendUserMessage = mock(async () => undefined)
    return {
        pi: {
            on(event: string, handler: (...args: unknown[]) => Promise<void> | void) {
                handlers[event] ??= []
                handlers[event].push(handler)
            },
            sendUserMessage,
        },
        sendUserMessage,
        async emit(event: string, ...args: unknown[]) {
            for (const handler of handlers[event] ?? []) {
                await handler(...args)
            }
        },
    }
}

function buildSessionContext(entries: unknown[]): ReturnType<typeof sdkBuildSessionContext> {
    return {
        messages: entries,
    } as ReturnType<typeof sdkBuildSessionContext>
}

function attachObserverLoopForTest(pi: Parameters<typeof attachObserverLoop>[0], options: Parameters<typeof attachObserverLoop>[1] = {}) {
    attachObserverLoop(pi, {
        ...options,
        runReview: options.runReview ?? runSolverObserverReview,
        buildSessionContext: options.buildSessionContext ?? buildSessionContext,
    })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timeout waiting for predicate")
        }
        await Bun.sleep(10)
    }
}

beforeEach(async () => {
    sessionDir = await mkdtemp(resolve(tmpdir(), "tch-observer-runtime-"))
    process.env.TCH_SOLVER_SESSION_DIR = sessionDir
    process.env[CHALLENGE_ENV_CHALLENGE_ID] = "chal-1"
    reviewCalls.length = 0
    runSolverObserverReview.mockClear()
    requestHostBridge.mockClear()
    requestHostBridge.mockResolvedValue({ is_completed: false })
})

afterEach(async () => {
    delete process.env.TCH_SOLVER_SESSION_DIR
    delete process.env[CHALLENGE_ENV_CHALLENGE_ID]
    await rm(sessionDir, { recursive: true, force: true })
})

describe("attachObserverLoop", () => {
    test("keeps mandatory final review when periodic observer is disabled and no rounds exist", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, { periodicEnabled: false })
        const ctx = { sessionManager: { getEntries: () => [] } }

        await harness.emit("agent_end", {}, ctx)
        expect(reviewCalls).toHaveLength(1)
        expect(reviewCalls[0]?.[1]).toMatchObject({ reason: "agent_end", rounds: [] })
        expect(reviewCalls[0]?.[2]).toMatchObject({ periodicEnabled: false })

        for (let i = 0; i < 6; i += 1) {
            await harness.emit("tool_execution_end", { toolCallId: `hint-${i}`, toolName: "challenge_get_hint", result: "hint", isError: false })
            await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "next" }] } }, ctx)
        }
        expect(reviewCalls).toHaveLength(1)
    })

    test("propagates required final review failure and retries it without another solver turn", async () => {
        const harness = createExtensionApiHarness()
        let attempts = 0
        const runReview = mock(async () => {
            attempts += 1
            if (attempts === 1) throw new Error("audit unavailable")
            return { applied: true }
        })
        attachObserverLoopForTest(harness.pi as never, { periodicEnabled: false, runReview })
        const ctx = { sessionManager: { getEntries: () => [] } }

        await expect(harness.emit("agent_end", {}, ctx)).rejects.toThrow("audit unavailable")
        await retryPendingSolverReview()
        expect(attempts).toBe(2)
        await retryPendingSolverReview()
        expect(attempts).toBe(2)
    })

    test("abandons the final review after repeated failures so the solver is not retried forever", async () => {
        const harness = createExtensionApiHarness()
        const runReview = mock(async () => {
            throw new Error("assignment review timed out")
        })
        attachObserverLoopForTest(harness.pi as never, { periodicEnabled: false, runReview })
        const ctx = { sessionManager: { getEntries: () => [] } }

        await expect(harness.emit("agent_end", {}, ctx)).rejects.toThrow("assignment review timed out")
        await expect(retryPendingSolverReview()).rejects.toThrow("assignment review timed out")
        await expect(retryPendingSolverReview()).rejects.toThrow("assignment review timed out")
        expect(runReview).toHaveBeenCalledTimes(3)

        await expect(retryPendingSolverReview()).resolves.toBeUndefined()
        expect(runReview).toHaveBeenCalledTimes(3)
    })
    test("retains the full initial assignment and project constraints after session compaction", async () => {
        const harness = createExtensionApiHarness()
        const checklist = Array.from({ length: 12 }, (_, index) => `- 测试项 ${index + 1}: 验证已分配入口的响应、权限边界与可复现证据，记录成功条件和失败边界，不扩大资产范围。`)
        const startupConstraints = [
            "仅测试已分配的 DVWA SQL Injection 模块，其他模块交给后继 solver。",
            "保留登录态并使用指定测试账号。".repeat(20),
            "其他发现只上报候选方向，不继续测试；最后一条补充约束必须保留。",
        ].join("\n\n")
        const initialTask = [
            "目标入口:\n- [66edf0e4270fe56e0133c72dafb11d31] http://target/",
            "本次测试项:",
            ...checklist,
            "",
            "当前 Memory 摘要:",
            "无关的历史背景不应混入分配清单。",
            "",
            "要求:",
            "- 按分配清单验证并提交证据。",
            "",
            "项目级别启动补充说明（最高优先级遵循）:",
            startupConstraints,
        ].join("\n")
        const compactedMessages = [{ role: "user", content: "压缩摘要：当前正在验证 SQL 注入。" }]
        attachObserverLoopForTest(harness.pi as never, {
            buildSessionContext: () => ({ messages: compactedMessages }) as ReturnType<typeof sdkBuildSessionContext>,
        })
        const ctx = {
            sessionManager: {
                getEntries: () => [
                    { type: "message", message: { role: "user", content: initialTask } },
                    { type: "compaction", summary: "省略了初始清单的压缩摘要" },
                    { type: "message", message: compactedMessages[0] },
                ],
            },
        }

        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "已验证第一个测试项" }] } }, ctx)
        await harness.emit("agent_end", {}, ctx)
        await waitUntil(() => reviewCalls.length === 1)

        const payload = reviewCalls[0]?.[1] as { reason: string; session_context: string; message_count: number }
        expect(payload.reason).toBe("agent_end")
        expect(payload.message_count).toBe(1)
        expect(payload.session_context).toContain(`本次测试项:\n${checklist.join("\n")}`)
        expect(payload.session_context).toContain(`项目级别启动补充说明（最高优先级遵循）:\n${startupConstraints}`)
        expect(payload.session_context).not.toContain("无关的历史背景不应混入分配清单。")
    })

    test("solver contract keeps discoveries outside the assignment for later dispatch", () => {
        const prompt = buildObserverExtensionAppendPrompt()
        expect(prompt).toContain("严格按初始任务的“本次测试项”执行")
        expect(prompt).toContain("不自行扩散测试")
        expect(prompt).toContain("供 planner 和后继 solver 决定后续分配")
    })

    test("agent_end waits for the active review and the final review to finish", async () => {
        const harness = createExtensionApiHarness()
        const periodicReview = Promise.withResolvers<void>()
        const finalReview = Promise.withResolvers<void>()
        const reasons: string[] = []
        const runReview = mock(async (_challengeId: string, payload: { reason: string }) => {
            reasons.push(payload.reason)
            await (payload.reason === "agent_end" ? finalReview.promise : periodicReview.promise)
            return { applied: true }
        })
        attachObserverLoopForTest(harness.pi as never, { runReview })
        let payloadReads = 0
        const ctx = {
            sessionManager: {
                getEntries() {
                    payloadReads += 1
                    return []
                },
            },
        }
        for (let i = 1; i <= 6; i += 1) {
            await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `round ${i}` }] } }, ctx)
        }
        await waitUntil(() => reasons.length === 1)

        let agentEndResolved = false
        const agentEnd = harness.emit("agent_end", {}, ctx).then(() => {
            agentEndResolved = true
        })
        await waitUntil(() => payloadReads === 2)
        expect(agentEndResolved).toBe(false)
        expect(reasons).toEqual(["periodic"])

        periodicReview.resolve()
        await waitUntil(() => reasons.length === 2)
        expect(reasons).toEqual(["periodic", "agent_end"])
        expect(agentEndResolved).toBe(false)

        finalReview.resolve()
        await agentEnd
        expect(agentEndResolved).toBe(true)
    })

    test("persists rounds and triggers periodic review every 6 assistant rounds", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, { observerModel: "kimi-fast" })
        const ctx = {
            sessionManager: {
                getEntries: () => [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "你正在处理一道CTF赛题。\n\n题目标题: demo\n目标入口:\n- http://target\n\n要求:\n- Solve the challenge and submit the flag.\n- Prefer checking auth edges before broad fuzzing.\n- Check ideas before repeating a route.",
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            { type: "thinking", thinking: "ignore me" },
                            { type: "text", text: "I will inspect the entrypoint." },
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "text", text: "huge tool result should not appear" }],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "Prefer checking auth edges before broad fuzzing." }],
                    },
                ],
            },
        }

        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round one" }] } }, ctx)
        expect(reviewCalls).toHaveLength(0)

        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round two" }] } }, ctx)
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round three" }] } }, ctx)
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round four" }] } }, ctx)
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round five" }] } }, ctx)
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "round six" }] } }, ctx)
        await waitUntil(() => reviewCalls.length === 1)

        const [challengeId, payload, options] = reviewCalls[0]
        expect(challengeId).toBe("chal-1")
        expect(options).toMatchObject({ observerModel: "kimi-fast" })
        expect((options as { sendCorrectionNotice?: unknown }).sendCorrectionNotice).toEqual(expect.any(Function))
        expect(payload).toMatchObject({
            reason: "periodic",
            rounds: [
                { round: 1, assistant_summary: "round one" },
                { round: 2, assistant_summary: "round two" },
                { round: 3, assistant_summary: "round three" },
                { round: 4, assistant_summary: "round four" },
                { round: 5, assistant_summary: "round five" },
                { round: 6, assistant_summary: "round six" },
            ],
            branch_entry_count: 4,
            message_count: 4,
        })
        expect((payload as { session_context: string }).session_context).toContain("## Solver Directives")
        expect((payload as { session_context: string }).session_context).toContain("Solve the challenge and submit the flag.")
        expect((payload as { session_context: string }).session_context).toContain("Check ideas before repeating a route.")
        expect((payload as { session_context: string }).session_context).toContain("## Recent User Context")
        expect((payload as { session_context: string }).session_context).toContain("Prefer checking auth edges before broad fuzzing.")
        expect((payload as { session_context: string }).session_context).not.toContain("huge tool result should not appear")
        expect((payload as { session_context: string }).session_context).not.toContain("ignore me")
        expect((payload as { session_context: string }).session_context).not.toContain("题目标题: demo")
        expect((payload as { session_context: string }).session_context).not.toContain("目标入口:")

        const rounds = await loadRecentObserverRounds(6)
        expect(rounds).toHaveLength(6)
        expect(rounds.map((item) => item.round)).toEqual([1, 2, 3, 4, 5, 6])
    })

    test("records tool logs and forces hint review after challenge_get_hint", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, {})
        const ctx = { sessionManager: { getEntries: () => [] } }

        await harness.emit("tool_execution_start", {
            toolCallId: "tool-1",
            args: { source: "remote" },
        })
        await harness.emit("tool_execution_end", {
            toolCallId: "tool-1",
            toolName: "challenge_get_hint",
            result: { content: [{ type: "text", text: "hint loaded" }] },
            isError: false,
        })
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "checked hint" }] } }, ctx)
        await waitUntil(() => reviewCalls.length === 1)

        const [, payload] = reviewCalls[0]
        expect(payload).toMatchObject({
            reason: "hint",
            rounds: [
                {
                    round: 1,
                    assistant_summary: "checked hint",
                    tool_logs: [
                        {
                            tool_name: "challenge_get_hint",
                            args_summary: "{\"source\":\"remote\"}",
                            result_summary: "hint loaded",
                            is_error: false,
                        },
                    ],
                },
            ],
        })

        const rounds = await loadRecentObserverRounds(1)
        expect(rounds[0]?.tool_logs[0]?.tool_name).toBe("challenge_get_hint")
    })

    test("dedupes repeated efficiency reminders within the cooldown window", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, {})
        const ctx = { sessionManager: { getEntries: () => [] } }

        for (let i = 1; i <= 6; i += 1) {
            await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `round ${i}` }] } }, ctx)
        }
        await waitUntil(() => reviewCalls.length === 1)

        const [, , options] = reviewCalls[0]
        const sendCorrectionNotice = (options as { sendCorrectionNotice: (message: string) => Promise<boolean> }).sendCorrectionNotice
        expect(await sendCorrectionNotice("重复纠偏")).toBe(true)
        expect(await sendCorrectionNotice("重复纠偏")).toBe(false)
        expect(harness.sendUserMessage).toHaveBeenCalledTimes(1)
        expect(harness.sendUserMessage).toHaveBeenCalledWith("纠偏提醒：重复纠偏", { deliverAs: "steer" })

        for (let i = 7; i <= 12; i += 1) {
            await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `changed round ${i}` }] } }, ctx)
        }
        await waitUntil(() => reviewCalls.length === 2)

        const [, nextPayload, nextOptions] = reviewCalls[1]
        expect((nextPayload as { rounds: Array<{ round: number }> }).rounds.at(-1)?.round).toBe(12)
        const nextSendCorrectionNotice = (nextOptions as { sendCorrectionNotice: (message: string) => Promise<boolean> }).sendCorrectionNotice
        expect(await nextSendCorrectionNotice("新的纠偏")).toBe(true)
        expect(harness.sendUserMessage).toHaveBeenCalledTimes(2)
    })

    test("suppresses efficiency reminders after the challenge is completed", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, {})
        const ctx = { sessionManager: { getEntries: () => [] } }

        for (let i = 1; i <= 6; i += 1) {
            await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `round ${i}` }] } }, ctx)
        }
        await waitUntil(() => reviewCalls.length === 1)

        requestHostBridge.mockResolvedValueOnce({ is_completed: true })
        const [, , options] = reviewCalls[0]
        const sendCorrectionNotice = (options as { sendCorrectionNotice: (message: string) => Promise<boolean> }).sendCorrectionNotice
        expect(await sendCorrectionNotice("完成后不该发")).toBe(false)
        expect(harness.sendUserMessage).not.toHaveBeenCalled()
    })

    test("suppresses efficiency reminders after the solver assignment is completed", async () => {
        const harness = createExtensionApiHarness()
        attachObserverLoopForTest(harness.pi as never, {})
        const ctx = { sessionManager: { getEntries: () => [] } }
        await harness.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "assigned checklist completed" }] } }, ctx)
        await harness.emit("agent_end", {}, ctx)

        requestHostBridge.mockResolvedValueOnce({ is_completed: false, solver_task_completed: true })
        const options = reviewCalls[0]?.[2] as { sendCorrectionNotice: (message: string) => Promise<boolean> }
        expect(await options.sendCorrectionNotice("本分工已完成，不应继续发送提醒")).toBe(false)
        expect(harness.sendUserMessage).not.toHaveBeenCalled()
    })
})
