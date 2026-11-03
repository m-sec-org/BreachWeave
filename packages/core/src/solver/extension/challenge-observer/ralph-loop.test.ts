import { describe, expect, mock, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { attachChallengeContinuation, buildChallengeExtensionAppendPrompt } from "./ralph-loop"

function createContinuationHarness() {
    const handlers: Record<string, (event: unknown) => unknown | Promise<unknown>> = {}
    const sendMessage = mock(() => undefined)
    const pi = {
        on(event: string, handler: (event: unknown) => unknown | Promise<unknown>) {
            handlers[event] = handler
        },
        sendMessage,
    } as unknown as ExtensionAPI
    return {
        pi,
        sendMessage,
        async emit(event: string, payload: unknown) {
            return handlers[event]?.(payload)
        },
        async endTurn() {
            await handlers.agent_end?.({ messages: [] })
            await new Promise<void>((resolve) => setImmediate(resolve))
        },
    }
}

describe("challenge solver continuation", () => {
    test.each([
        { is_completed: true, solver_task_completed: false },
        { is_completed: false, solver_task_completed: true },
    ])("stops when the challenge or current assignment is complete: %j", async (state) => {
        const harness = createContinuationHarness()
        const readCompletion = mock(async () => state)
        attachChallengeContinuation(harness.pi, { readCompletion })

        await harness.endTurn()

        expect(readCompletion).toHaveBeenCalledTimes(1)
        expect(harness.sendMessage).not.toHaveBeenCalled()
    })

    test("continues only the assigned checklist while its report remains incomplete", async () => {
        const harness = createContinuationHarness()
        attachChallengeContinuation(harness.pi, {
            readCompletion: async () => ({ is_completed: false, solver_task_completed: false }),
        })

        await harness.endTurn()

        expect(harness.sendMessage).toHaveBeenCalledTimes(1)
        const [message, options] = harness.sendMessage.mock.calls[0] as unknown as [{ content: Array<{ text: string }> }, { triggerTurn: boolean }]
        expect(message.content[0]?.text).toContain("仅继续本次分配的资产和测试项清单")
        expect(message.content[0]?.text).toContain("test_results")
        expect(message.content[0]?.text).toContain("discoveries")
        expect(message.content[0]?.text).not.toContain("多个 flag")
        expect(options.triggerTurn).toBe(true)
    })

    test("keeps continuation available when the host completion check fails", async () => {
        const harness = createContinuationHarness()
        attachChallengeContinuation(harness.pi, {
            readCompletion: async () => { throw new Error("host unavailable") },
        })

        await harness.endTurn()

        expect(harness.sendMessage).toHaveBeenCalledTimes(1)
    })

    test("append prompt ends completed assignments and hands extra discoveries to the planner", () => {
        const prompt = buildChallengeExtensionAppendPrompt()

        expect(prompt).toContain("本次分工完成并提交报告后结束")
        expect(prompt).toContain("`test_results`")
        expect(prompt).toContain("`discoveries`")
        expect(prompt).not.toContain("剩余 flag")
    })

    test("blocks all further tools once the final assignment report succeeds, then ends without another host check", async () => {
        const harness = createContinuationHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: false }))
        attachChallengeContinuation(harness.pi, { readCompletion })

        await harness.emit("tool_execution_end", {
            toolName: "challenge_submit_report",
            isError: false,
            result: { details: { solver_task_completed: true } },
        })
        for (const toolName of ["bash", "read", "challenge_submit_report"]) {
            expect(await harness.emit("tool_call", { toolName })).toMatchObject({
                block: true,
                terminate: true,
                reason: expect.stringContaining("本次分工报告已齐全"),
            })
        }
        await harness.endTurn()

        expect(readCompletion).not.toHaveBeenCalled()
        expect(harness.sendMessage).not.toHaveBeenCalled()
    })

    test.each([
        { toolName: "challenge_submit_report", isError: true, result: { details: { solver_task_completed: true } } },
        { toolName: "challenge_submit_report", isError: false, result: { details: { solver_task_completed: false } } },
        { toolName: "challenge_submit_report", isError: false, result: { content: [] } },
        { toolName: "bash", isError: false, result: { details: { solver_task_completed: true } } },
    ])("keeps execution available after a failed, incomplete, or unrelated result: %j", async (result) => {
        const harness = createContinuationHarness()
        attachChallengeContinuation(harness.pi, {
            readCompletion: async () => ({ is_completed: false, solver_task_completed: false }),
        })

        await harness.emit("tool_execution_end", result)

        expect(await harness.emit("tool_call", { toolName: "bash" })).toBeUndefined()
        await harness.endTurn()
        expect(harness.sendMessage).toHaveBeenCalledTimes(1)
    })

    test("completion blocks only the reporting solver's extension instance", async () => {
        const solver = createContinuationHarness()
        const independentSession = createContinuationHarness()
        attachChallengeContinuation(solver.pi)
        attachChallengeContinuation(independentSession.pi)

        await solver.emit("tool_execution_end", {
            toolName: "challenge_submit_report",
            isError: false,
            result: { details: { solver_task_completed: true } },
        })

        expect(await solver.emit("tool_call", { toolName: "bash" })).toMatchObject({ block: true })
        expect(await independentSession.emit("tool_call", { toolName: "memory_add" })).toBeUndefined()
    })
})
