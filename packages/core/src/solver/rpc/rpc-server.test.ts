import { afterEach, test, expect, describe, mock, spyOn } from "bun:test"
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { attachChallengeRpcCompletion as attachCompletionHandler, handleCommand } from "./rpc-server"
import { AUTHORIZED_SOLVER_ENV } from "../../challenge/env"
import type { RpcCommand, RpcResponse } from "./rpc-types"

function mockSession(overrides?: Partial<AgentSession>): AgentSession {
    return {
        prompt: mock(() => Promise.resolve()),
        abort: mock(() => Promise.resolve()),
        steer: mock(() => Promise.resolve()),
        followUp: mock(() => Promise.resolve()),
        subscribe: mock(() => () => {}),
        dispose: mock(() => {}),
        clearQueue: mock(() => ({ steering: [], followUp: [] })),
        sendCustomMessage: mock(() => Promise.resolve()),
        isStreaming: false,
        isCompacting: false,
        model: null,
        thinkingLevel: null,
        steeringMode: "all",
        followUpMode: "all",
        sessionFile: null,
        sessionId: "test-session",
        sessionName: null,
        autoCompactionEnabled: false,
        messages: [],
        pendingMessageCount: 0,
        ...overrides,
    } as unknown as AgentSession
}

const originalAuthorizedSolver = process.env[AUTHORIZED_SOLVER_ENV]
const completionDetachers: Array<() => void> = []

function attachChallengeRpcCompletion(...args: Parameters<typeof attachCompletionHandler>) {
    const [session, init, options] = args
    completionDetachers.push(attachCompletionHandler(session, init, { retryPendingReview: async () => undefined, ...options }))
}

afterEach(() => {
    for (const detach of completionDetachers.splice(0)) detach()
    if (originalAuthorizedSolver === undefined) delete process.env[AUTHORIZED_SOLVER_ENV]
    else process.env[AUTHORIZED_SOLVER_ENV] = originalAuthorizedSolver
})

function createCompletionHarness(overrides?: Partial<AgentSession>) {
    const listeners: Array<(event: AgentSessionEvent) => unknown> = []
    const session = mockSession({
        ...overrides,
        subscribe: mock((listener: (event: AgentSessionEvent) => unknown) => {
            listeners.push(listener)
            return () => undefined
        }) as AgentSession["subscribe"],
    })
    return {
        session,
        async emit(event: AgentSessionEvent) {
            await Promise.all(listeners.map((listener) => listener(event)))
        },
    }
}

describe("competition RPC completion", () => {
    test("waits for the settled boundary and Planner stop approval before releasing an assignment", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: true, solver_stop_approved: true }))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, exit })

        await harness.emit({ type: "agent_end", messages: [], willRetry: false })
        expect(readCompletion).not.toHaveBeenCalled()
        expect(harness.session.dispose).not.toHaveBeenCalled()

        await harness.emit({ type: "agent_settled", aborted: false })
        expect(readCompletion).toHaveBeenCalledTimes(1)
        expect(harness.session.dispose).toHaveBeenCalledTimes(1)
        expect(exit).toHaveBeenCalledTimes(1)
    })

    test("retains an incomplete assignment and retries the completion check on the next settled turn", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: false, solver_stop_approved: false }))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, exit })

        await harness.emit({ type: "agent_settled", aborted: false })
        expect(exit).not.toHaveBeenCalled()
        readCompletion.mockResolvedValue({ is_completed: false, solver_task_completed: true, solver_stop_approved: true })
        await harness.emit({ type: "agent_settled", aborted: false })

        expect(exit).toHaveBeenCalledTimes(1)
    })

    test("exits after the settled completion boundary even when collaboration messages are queued", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        Object.assign(harness.session, { pendingMessageCount: 1 })
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: true, solver_stop_approved: true }))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, exit })

        await harness.emit({ type: "agent_settled", aborted: false })

        expect(harness.session.dispose).toHaveBeenCalledTimes(1)
        expect(exit).toHaveBeenCalledTimes(1)
    })

    test("keeps the RPC available when the host completion check fails", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: async () => { throw new Error("host unavailable") },
            exit,
        })

        await harness.emit({ type: "agent_settled", aborted: false })

        expect(exit).not.toHaveBeenCalled()
        expect(harness.session.dispose).not.toHaveBeenCalled()
    })

    test("does not terminate a new turn that starts while the completion check is pending", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        let resolveCompletion!: (state: { is_completed: boolean; solver_task_completed: boolean; solver_stop_approved: boolean }) => void
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: () => new Promise((resolve) => { resolveCompletion = resolve }),
            exit,
        })

        const pending = harness.emit({ type: "agent_settled", aborted: false })
        Object.assign(harness.session, { isStreaming: true })
        resolveCompletion({ is_completed: false, solver_task_completed: true, solver_stop_approved: true })
        await pending

        expect(exit).not.toHaveBeenCalled()
    })

    test("leaves standalone and authorized RPC lifecycles to their existing owners", async () => {
        const readCompletion = mock(async () => ({ is_completed: true, solver_task_completed: true }))
        const exit = mock(() => undefined)
        const standalone = createCompletionHarness()
        delete process.env[AUTHORIZED_SOLVER_ENV]
        attachChallengeRpcCompletion(standalone.session, {}, { readCompletion, exit })
        process.env[AUTHORIZED_SOLVER_ENV] = "1"
        const authorized = createCompletionHarness()
        attachChallengeRpcCompletion(authorized.session, { challengeId: "challenge-1" }, { readCompletion, exit })

        await standalone.emit({ type: "agent_settled", aborted: false })
        await authorized.emit({ type: "agent_settled", aborted: false })

        expect(readCompletion).not.toHaveBeenCalled()
        expect(exit).not.toHaveBeenCalled()
    })

    test.each([
        { is_completed: true, solver_task_completed: true },
        { is_completed: false, solver_task_completed: true, solver_review_pending: true },
    ])("never treats reported coverage or project completion as Planner stop approval: %j", async (state) => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: async () => state,
            exit,
        })

        await harness.emit({ type: "agent_settled", aborted: false })

        expect(exit).not.toHaveBeenCalled()
        expect(harness.session.dispose).not.toHaveBeenCalled()
    })

    test("clears queued collaboration on report coverage and accepts only a Planner resume", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: async () => ({ is_completed: false, solver_review_pending: true }),
        })

        await harness.emit({ type: "tool_execution_end", toolName: "challenge_submit_report", toolCallId: "report-1", isError: false,
            result: { content: [], details: { solver_task_completed: true } } })
        expect(harness.session.clearQueue).toHaveBeenCalledTimes(1)
        for (const type of ["prompt", "steer", "follow_up"] as const) {
            expect(await handleCommand(harness.session, { type, message: "collaboration sync" })).toMatchObject({ success: false })
        }
        expect(harness.session.prompt).not.toHaveBeenCalled()
        expect(harness.session.steer).not.toHaveBeenCalled()
        expect(harness.session.followUp).not.toHaveBeenCalled()

        const resumed = await handleCommand(harness.session, { type: "resume_assignment", message: "补齐第 2 项证据", reviewId: "review-1" })

        expect(resumed).toMatchObject({ success: true, command: "resume_assignment" })
        expect(harness.session.clearQueue).toHaveBeenCalledTimes(2)
        expect(harness.session.sendCustomMessage).toHaveBeenCalledWith({
            customType: "planner-assignment-resume",
            content: [{ type: "text", text: "补齐第 2 项证据" }],
            display: true,
            details: { reviewId: "review-1" },
        }, { triggerTurn: true })
        expect(await handleCommand(harness.session, { type: "follow_up", message: "new evidence" })).toMatchObject({ success: true })
    })

    test("does not overwrite a Planner resume with an older pending completion response", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        let resolveCompletion!: (state: { is_completed: boolean; solver_review_pending: boolean }) => void
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: () => new Promise((resolve) => { resolveCompletion = resolve }),
        })
        const pending = harness.emit({ type: "agent_settled", aborted: false })
        await handleCommand(harness.session, { type: "resume_assignment", message: "继续原任务", reviewId: "review-2" })
        resolveCompletion({ is_completed: false, solver_review_pending: true })
        await pending

        expect(await handleCommand(harness.session, { type: "prompt", message: "继续" })).toMatchObject({ success: true })
    })

    test("deduplicates Planner review replays before and after a resumed turn settles", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        let resolveResume!: () => void
        const sendCustomMessage = mock(() => new Promise<void>((resolve) => { resolveResume = resolve }))
        const harness = createCompletionHarness({ sendCustomMessage })
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" })
        const command = { type: "resume_assignment", message: "补齐原任务证据", reviewId: "review-1" } as const

        expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })
        expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })
        resolveResume()
        await Promise.resolve()
        expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })

        expect(sendCustomMessage).toHaveBeenCalledTimes(1)
        expect(harness.session.clearQueue).toHaveBeenCalledTimes(1)
        await harness.emit({ type: "tool_execution_end", toolName: "challenge_submit_report", toolCallId: "report-2", isError: false,
            result: { content: [], details: { solver_task_completed: true } } })
        expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })
        expect(sendCustomMessage).toHaveBeenCalledTimes(1)
        expect(harness.session.clearQueue).toHaveBeenCalledTimes(2)
        expect(await handleCommand(harness.session, { type: "follow_up", message: "sync" })).toMatchObject({ success: false })
    })

    test("restores the pause and host polling when resumed-turn preparation fails", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const write = spyOn(process.stdout, "write").mockImplementation(() => true)
        try {
            const sendCustomMessage = mock(async (): Promise<void> => undefined)
            sendCustomMessage.mockRejectedValueOnce(new Error("resume preparation failed"))
            const harness = createCompletionHarness({ sendCustomMessage })
            const command = { type: "resume_assignment", message: "补齐原任务证据", reviewId: "review-1" } as const
            const readCompletion = mock(async () => {
                await handleCommand(harness.session, command)
                return { is_completed: false, solver_resume_required: true }
            })
            attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, retryDelayMs: 5 })

            expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })
            expect(await handleCommand(harness.session, { type: "steer", message: "sync" })).toMatchObject({ success: false })
            await Bun.sleep(20)

            expect(readCompletion).toHaveBeenCalledTimes(1)
            expect(sendCustomMessage).toHaveBeenCalledTimes(2)
            expect(harness.session.clearQueue).toHaveBeenCalledTimes(2)
            expect(await handleCommand(harness.session, { type: "follow_up", message: "new evidence" })).toMatchObject({ success: true })
            expect(await handleCommand(harness.session, command)).toMatchObject({ success: true })
            expect(sendCustomMessage).toHaveBeenCalledTimes(2)
        } finally {
            write.mockRestore()
        }
    })

    test.each([false, true])("a rejected older resumed turn cannot roll back a newer report or Planner resume: %j", async (resumeAgain) => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const write = spyOn(process.stdout, "write").mockImplementation(() => true)
        try {
            let rejectResume!: (error: Error) => void
            const sendCustomMessage = mock(async (): Promise<void> => undefined)
            sendCustomMessage.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectResume = reject }))
            const harness = createCompletionHarness({ sendCustomMessage })
            const readCompletion = mock(async () => ({ is_completed: false }))
            attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion })
            const previousCommand = { type: "resume_assignment", message: "补齐原任务证据", reviewId: "review-1" } as const
            await handleCommand(harness.session, previousCommand)
            await harness.emit({ type: "tool_execution_end", toolName: "challenge_submit_report", toolCallId: "report-2", isError: false,
                result: { content: [], details: { solver_task_completed: true } } })
            if (resumeAgain) await handleCommand(harness.session, { type: "resume_assignment", message: "继续补齐证据", reviewId: "review-2" })

            rejectResume(new Error("older turn failed after report"))
            await Promise.resolve()
            expect(await handleCommand(harness.session, previousCommand)).toMatchObject({ success: true })

            expect(sendCustomMessage).toHaveBeenCalledTimes(resumeAgain ? 2 : 1)
            expect(harness.session.clearQueue).toHaveBeenCalledTimes(resumeAgain ? 3 : 2)
            expect(await handleCommand(harness.session, { type: "follow_up", message: "sync" })).toMatchObject({ success: resumeAgain })
            expect(readCompletion).not.toHaveBeenCalled()
        } finally {
            write.mockRestore()
        }
    })

    test("rechecks pending review without starting another model turn", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_review_pending: true, solver_stop_approved: false }))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, exit, retryDelayMs: 5 })

        await harness.emit({ type: "agent_settled", aborted: false })
        readCompletion.mockResolvedValue({ is_completed: false, solver_review_pending: false, solver_stop_approved: true })
        await Bun.sleep(15)

        expect(readCompletion).toHaveBeenCalledTimes(2)
        expect(exit).toHaveBeenCalledTimes(1)
        expect(harness.session.prompt).not.toHaveBeenCalled()
        expect(harness.session.sendCustomMessage).not.toHaveBeenCalled()
    })

    test("retries failed final audits and host checks while keeping the reported solver paused", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_stop_approved: true }))
        readCompletion.mockRejectedValueOnce(new Error("host unavailable"))
        const retryPendingReview = mock(async () => undefined)
        retryPendingReview.mockRejectedValueOnce(new Error("observer unavailable"))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion, retryPendingReview, exit, retryDelayMs: 5,
        })
        await harness.emit({ type: "tool_execution_end", toolName: "challenge_submit_report", toolCallId: "report-1", isError: false,
            result: { content: [], details: { solver_task_completed: true } } })

        await harness.emit({ type: "agent_settled", aborted: false })
        expect(retryPendingReview).not.toHaveBeenCalled()
        expect(await handleCommand(harness.session, { type: "steer", message: "sync" })).toMatchObject({ success: false })
        await Bun.sleep(40)

        expect(retryPendingReview).toHaveBeenCalledTimes(2)
        expect(readCompletion).toHaveBeenCalledTimes(2)
        expect(exit).toHaveBeenCalledTimes(1)
        expect(harness.session.prompt).not.toHaveBeenCalled()
    })
})

describe("handleCommand", () => {
    test("prompt — returns success immediately (fire-and-forget)", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { type: "prompt", message: "hello" })

        expect(resp.type).toBe("response")
        expect(resp.command).toBe("prompt")
        expect(resp.success).toBe(true)
        expect(session.prompt).toHaveBeenCalledWith("hello", { streamingBehavior: undefined, source: "rpc" })
    })

    test("prompt — preserves command id", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { id: "req-1", type: "prompt", message: "x" })

        expect(resp.id).toBe("req-1")
        expect(resp.command).toBe("prompt")
        expect(resp.success).toBe(true)
    })

    test("prompt — emits error on rejection via stdout", async () => {
        const outputs: string[] = []
        const originalWrite = process.stdout.write
        process.stdout.write = ((chunk: string | Uint8Array) => {
            outputs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
            return true
        }) as typeof process.stdout.write

        const session = mockSession({
            prompt: mock(() => Promise.reject(new Error("model error"))) as unknown as AgentSession["prompt"],
        })
        const resp = await handleCommand(session, { type: "prompt", message: "fail" })

        // Immediate response is success (fire-and-forget)
        expect(resp.success).toBe(true)

        // Wait for the catch handler to write error to stdout
        await new Promise((r) => setTimeout(r, 10))

        const errResp = JSON.parse(outputs[0].trim()) as RpcResponse
        expect(errResp.command).toBe("prompt")
        expect(errResp.success).toBe(false)
        if (!errResp.success) {
            expect(errResp.error).toBe("model error")
        }

        process.stdout.write = originalWrite
    })

    test("abort — awaits session.abort", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { type: "abort" })

        expect(session.abort).toHaveBeenCalled()
        expect(resp.command).toBe("abort")
        expect(resp.success).toBe(true)
    })

    test("abort — preserves command id", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { id: "req-2", type: "abort" })

        expect(resp.id).toBe("req-2")
    })

    test("get_state — returns full session state", async () => {
        const session = mockSession({ isStreaming: true } as Partial<AgentSession>)
        const resp = await handleCommand(session, { type: "get_state" })

        expect(resp.command).toBe("get_state")
        expect(resp.success).toBe(true)
        if (resp.success) {
            const data = resp.data as Record<string, unknown>
            expect(data.isStreaming).toBe(true)
            expect(data.sessionId).toBe("test-session")
            expect(data.messageCount).toBe(0)
        }
    })

    test("get_state — preserves id", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { id: "s1", type: "get_state" })

        expect(resp.id).toBe("s1")
    })

    test("unknown command — returns error", async () => {
        const session = mockSession()
        const resp = await handleCommand(session, { type: "unknown_cmd" } as unknown as RpcCommand)

        expect(resp.command).toBe("unknown_cmd")
        expect(resp.success).toBe(false)
        if (!resp.success) {
            expect(resp.error).toContain("Unknown command")
        }
    })
})
