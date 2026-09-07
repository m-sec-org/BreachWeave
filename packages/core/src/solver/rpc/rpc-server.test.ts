import { test, expect, describe, mock } from "bun:test"
import type { AgentSession } from "@mariozechner/pi-coding-agent"
import { handleCommand } from "./rpc-server"
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
