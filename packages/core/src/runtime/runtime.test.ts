import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { getAgentEndError, hashDockerfileContent, RuntimeManager } from "./runtime"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../challenge/env"
import { ChallengeManager } from "../challenge/manager"
import { createChallengeHostBridgeHandler } from "../challenge/host-bridge-handler"
import type { ChallengeInfoRecord } from "../challenge/store"
import type { ConfigManager } from "../config/index"
import { solverDir } from "./types"

const tempDirs: string[] = []

afterEach(async () => {
    delete process.env.TCH_CHALLENGE_DIR
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (!dir) continue
        await rm(dir, { recursive: true, force: true })
    }
})

async function createRuntimeManager(): Promise<{ runtime: RuntimeManager; challengeManager: ChallengeManager }> {
    const challengeDir = await mkdtemp(resolve(tmpdir(), "tch-runtime-challenge-"))
    tempDirs.push(challengeDir)
    process.env.TCH_CHALLENGE_DIR = challengeDir
    const config = {
        getHostSettings: async () => ({ runtime: {}, planner: {} }),
    } as unknown as ConfigManager
    const challengeManager = new ChallengeManager(config)
    const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challengeManager)])
    return { runtime, challengeManager }
}

describe("getAgentEndError", () => {
    test("returns assistant error from agent_end", () => {
        const event = {
            type: "agent_end",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                    timestamp: 1,
                },
                {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    errorMessage: "402 Insufficient Balance",
                    timestamp: 2,
                },
            ],
        } as unknown as AgentSessionEvent

        expect(getAgentEndError(event)).toBe("402 Insufficient Balance")
    })

    test("ignores successful agent_end", () => {
        const event = {
            type: "agent_end",
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    stopReason: "end_turn",
                    timestamp: 1,
                },
            ],
        } as unknown as AgentSessionEvent

        expect(getAgentEndError(event)).toBeUndefined()
    })
})

describe("hashDockerfileContent", () => {
    test("returns stable hash for identical content", () => {
        const content = "FROM kali\nRUN echo test\n"

        expect(hashDockerfileContent(content)).toBe(hashDockerfileContent(content))
    })

    test("returns different hashes for different content", () => {
        expect(hashDockerfileContent("FROM kali\n")).not.toBe(hashDockerfileContent("FROM kali\nRUN echo test\n"))
    })
})

describe("RuntimeManager host bridge", () => {
    test("getDetails restores subagent parent tool call id from startup snapshot", async () => {
        const { runtime } = await createRuntimeManager()
        const solverId = `solver-${Date.now()}`
        const baseDir = solverDir(solverId)
        tempDirs.push(baseDir)
        await rm(baseDir, { recursive: true, force: true })
        await mkdir(resolve(baseDir, "session"), { recursive: true })
        await Bun.write(
            resolve(baseDir, "startup.json"),
            JSON.stringify({
                createdAt: 1,
                init: { promptName: "pentest-orchestrator", task: "solve" },
                prompt: { name: "pentest-orchestrator", meta: {}, content: "main" },
                paths: { solverDir: baseDir, sessionDir: resolve(baseDir, "session"), workspaceDir: resolve(baseDir, "workspace") },
                sessionOptions: {},
            }),
        )
        await Bun.write(resolve(baseDir, "session", "0001.jsonl"), "")
        const subagentDir = resolve(baseDir, "workspace", ".subagents", "recon-subagent:1")
        await mkdir(resolve(subagentDir, "session"), { recursive: true })
        await Bun.write(
            resolve(subagentDir, "startup.json"),
            JSON.stringify({
                createdAt: 2,
                init: { promptName: "recon", task: "scan", parentToolCallId: "subagent:1", step: 1 },
                prompt: { name: "recon", meta: {}, content: "sub" },
                paths: { subagentDir, sessionDir: resolve(subagentDir, "session"), workspaceDir: resolve(baseDir, "workspace") },
                sessionOptions: {},
            }),
        )
        await Bun.write(resolve(subagentDir, "session", "0001.jsonl"), "")

        const details = await runtime.getDetails(solverId)
        const subagentThread = details?.threads.find((thread) => thread.kind === "subagent")

        expect(subagentThread?.parentToolCallId).toBe("subagent:1")
        expect(subagentThread?.promptName).toBe("recon")
        expect(subagentThread?.task).toBe("scan")
    })

    test("challenge_get_hint returns cached hint without remote fetch or broadcast", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const getChallenge = mock(
            async () =>
                ({
                    id: "web-001",
                    name: "t",
                    title: "t",
                    difficulty: "easy",
                    description: "",
                    level: 1,
                    hint_viewed: true,
                    hint_content: "cached hint",
                    instance_status: "running",
                    entrypoint: null,
                    assets: { urls: [], ips: [] },
                    created_at: "2026-04-12T00:00:00.000Z",
                    updated_at: "2026-04-12T00:00:00.000Z",
                    source: "test",
                }) satisfies ChallengeInfoRecord,
        )
        const getHint = mock(async () => {
            throw new Error("should not fetch remote hint")
        })
        const isChallengeCompleted = mock(async () => false)
        const sendCommand = mock(() => {})

        ;(challengeManager as unknown as { getChallenge: typeof getChallenge }).getChallenge = getChallenge
        ;(challengeManager as unknown as { getHint: typeof getHint }).getHint = getHint
        ;(challengeManager as unknown as { isChallengeCompleted: typeof isChallengeCompleted }).isChallengeCompleted = isChallengeCompleted
        ;(runtime as unknown as { sendCommand: typeof sendCommand }).sendCommand = sendCommand
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_get_hint", {})

        expect(getHint).not.toHaveBeenCalled()
        expect(sendCommand).not.toHaveBeenCalled()
        expect(data).toEqual({ code: "web-001", hint_content: "cached hint" })
    })

    test("challenge_get_hint broadcasts fresh hint to running solvers on same challenge", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const getChallenge = mock(async () => undefined)
        const getHint = mock(async () => ({
            remote: { code: "web-001", hint_content: "fresh hint" },
            challenge: undefined,
            is_completed: false,
        }))
        const sendCommand = mock(() => {})

        ;(challengeManager as unknown as { getChallenge: typeof getChallenge }).getChallenge = getChallenge
        ;(challengeManager as unknown as { getHint: typeof getHint }).getHint = getHint
        ;(runtime as unknown as { sendCommand: typeof sendCommand }).sendCommand = sendCommand
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-a", {
            id: "solver-a",
            containerId: "solver-a",
            name: "solver-a",
            promptName: "prompt-a",
            task: "solve",
            challengeId: "web-001",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-b", {
            id: "solver-b",
            containerId: "solver-b",
            name: "solver-b",
            promptName: "prompt-b",
            task: "solve",
            challengeId: "web-001",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-c", {
            id: "solver-c",
            containerId: "solver-c",
            name: "solver-c",
            promptName: "prompt-c",
            task: "solve",
            challengeId: "other",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_get_hint", {})

        expect(getHint).toHaveBeenCalledWith("web-001")
        expect(sendCommand).toHaveBeenCalledTimes(2)
        expect(sendCommand).toHaveBeenNthCalledWith(1, "solver-a", {
            type: "steer",
            message:
                "系统同步：赛题 hint 已更新。\n- 立即吸收这条 hint，并结合当前路线评估是否需要转向。\n- 如果它改变了攻击面理解，优先刷新 memory_list / idea_list。\n- hint:\nfresh hint",
        })
        expect(sendCommand).toHaveBeenNthCalledWith(2, "solver-b", {
            type: "steer",
            message:
                "系统同步：赛题 hint 已更新。\n- 立即吸收这条 hint，并结合当前路线评估是否需要转向。\n- 如果它改变了攻击面理解，优先刷新 memory_list / idea_list。\n- hint:\nfresh hint",
        })
        expect(data).toEqual({ code: "web-001", hint_content: "fresh hint" })
    })

    test("challenge_submit_report uses solver-scoped manager", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const fakeResult = {
            submission: { id: "submission-1", asset_hash: "asset-md5", asset: "https://target.example", report: "### report" },
            challenge: {
                id: "web-001",
                title: "t",
                difficulty: "easy",
                description: "",
                level: 1,
                hint_viewed: false,
                instance_status: "running",
                entrypoint: null,
                assets: { urls: [{ asset: "https://target.example", scanned: true }], ips: [] },
                updated_at: new Date().toISOString(),
                source: "test",
            },
            assets_total: 1,
            assets_scanned: 1,
            assets_pending: 0,
            assets_completed: true,
        }
        const submitReport = mock(async () => fakeResult)

        ;(challengeManager as unknown as { submitReport: typeof submitReport }).submitReport = submitReport
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-a", {
            id: "solver-a",
            containerId: "solver-a",
            name: "solver-a",
            promptName: "test-prompt",
            task: "solve it",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_submit_report", {
            asset_hash: "asset-md5",
            report: "### report",
        })

        expect(submitReport).toHaveBeenCalledWith("web-001", {
            assetHash: "asset-md5",
            report: "### report",
            solverId: "solver-a",
            promptName: "test-prompt",
            modelName: undefined,
        })
        expect(data.challenge_id).toBe("web-001")
        expect(data.assets_completed).toBe(true)
    })

    test("challenge_is_completed uses solver-scoped manager", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const isChallengeCompleted = mock(async () => true)

        ;(challengeManager as unknown as { isChallengeCompleted: typeof isChallengeCompleted }).isChallengeCompleted = isChallengeCompleted
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_is_completed", {})

        expect(isChallengeCompleted).toHaveBeenCalledWith("web-001")
        expect(data.challenge_id).toBe("web-001")
        expect(data.is_completed).toBe(true)
    })
})
