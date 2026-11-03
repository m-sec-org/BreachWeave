import { afterEach, test, expect, describe, mock } from "bun:test"
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { attachChallengeRpcCompletion, handleCommand } from "./rpc-server"
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

afterEach(() => {
    if (originalAuthorizedSolver === undefined) delete process.env[AUTHORIZED_SOLVER_ENV]
    else process.env[AUTHORIZED_SOLVER_ENV] = originalAuthorizedSolver
})

function createCompletionHarness() {
    const listeners: Array<(event: AgentSessionEvent) => unknown> = []
    const session = mockSession({
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
    test("waits for the final Observer review boundary before releasing a completed assignment", async () => {
        delete process.env[AUTHORIZED_SOLVER_ENV]
        const harness = createCompletionHarness()
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: true }))
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
        const readCompletion = mock(async () => ({ is_completed: false, solver_task_completed: false }))
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, { readCompletion, exit })

        await harness.emit({ type: "agent_settled", aborted: false })
        expect(exit).not.toHaveBeenCalled()
        readCompletion.mockResolvedValue({ is_completed: false, solver_task_completed: true })
        await harness.emit({ type: "agent_settled", aborted: false })

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
        let resolveCompletion!: (state: { is_completed: boolean; solver_task_completed: boolean }) => void
        const exit = mock(() => undefined)
        attachChallengeRpcCompletion(harness.session, { challengeId: "challenge-1" }, {
            readCompletion: () => new Promise((resolve) => { resolveCompletion = resolve }),
            exit,
        })

        const pending = harness.emit({ type: "agent_settled", aborted: false })
        Object.assign(harness.session, { isStreaming: true })
        resolveCompletion({ is_completed: false, solver_task_completed: true })
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
