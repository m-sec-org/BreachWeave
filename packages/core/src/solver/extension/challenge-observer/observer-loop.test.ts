import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"

const reviewCalls: Array<[string, unknown, unknown]> = []
const runSolverObserverReview = mock(async (challengeId: string, payload: unknown, options: unknown) => {
    reviewCalls.push([challengeId, payload, options])
    return { applied: true, summary: "ok" }
})

const requestHostBridge = mock(async () => ({ is_completed: false }))

mock.module("../../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

const { attachObserverLoop } = await import("./observer-loop")
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

function buildSessionContext(entries: unknown[]) {
    return {
        messages: entries,
    }
}

function attachObserverLoopForTest(pi: Parameters<typeof attachObserverLoop>[0], options: Parameters<typeof attachObserverLoop>[1] = {}) {
    attachObserverLoop(pi, {
        ...options,
        runReview: runSolverObserverReview,
        buildSessionContext,
    })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 200): Promise<void> {
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
})
