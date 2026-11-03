import { describe, expect, test } from "bun:test"
import { buildSolverStartupSnapshot, buildSubagentStartupSnapshot, resolveSolverActiveToolNames } from "./session"
import type { PromptFile } from "../config/prompts/index"
import type { SolverInitPayload } from "./rpc/rpc-types"
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent"
import { buildChallengeExtensionAppendPrompt } from "./extension/challenge-observer/ralph-loop"
import { challengeObserverExtension } from "./extension/challenge-observer/index"
import { buildObserverExtensionAppendPrompt } from "./extension/challenge-observer/observer-loop"
import { challengeObserverAgentTools } from "./extension/challenge-observer/tools"

describe("buildSolverStartupSnapshot", () => {
    test("includes task, prompt, directories, and session summary", () => {
        const init: SolverInitPayload = {
            solverId: "solver-1",
            promptName: "test",
            task: "hello",
        }
        const prompt: PromptFile = {
            name: "test",
            meta: {
                model: "model-pref",
                skills: ["recon"],
                tools: ["bash", "mcp_github_search_repos"],
                mcps: ["github"],
            },
            content: "system prompt",
        }
        const sessionOpts = {
            model: { provider: "anthropic", id: "claude-sonnet" },
            thinkingLevel: "medium",
            tools: [{ name: "bash" }],
            customTools: [{ name: "nmap" }],
        } as unknown as CreateAgentSessionOptions

        const snapshot = buildSolverStartupSnapshot(init, prompt, sessionOpts, {
            solverDir: "/tmp/solver-1",
            sessionDir: "/tmp/solver-1/session",
            workspaceDir: "/tmp/solver-1/workspace",
        })

        expect(snapshot.init.task).toBe("hello")
        expect(snapshot.prompt).toEqual({
            name: "test",
            meta: prompt.meta,
            content: "system prompt",
        })
        expect(snapshot.paths).toEqual({
            solverDir: "/tmp/solver-1",
            sessionDir: "/tmp/solver-1/session",
            workspaceDir: "/tmp/solver-1/workspace",
        })
        expect(snapshot.sessionOptions).toEqual({
            model: { provider: "anthropic", id: "claude-sonnet" },
            thinkingLevel: "medium",
            tools: [{ name: "bash" }],
            customTools: [{ name: "nmap" }],
        })
    })
})

describe("solver tool activation", () => {
    function customTools(...names: string[]): NonNullable<CreateAgentSessionOptions["customTools"]> {
        return names.map((name) => ({ name })) as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>
    }

    const prompt: PromptFile = {
        name: "challenge-prompt",
        meta: { tools: ["bash", "challenge_submit_report", "mcp_browser"] },
        content: "prompt",
    }

    test("activates custom, MCP, and observer tools for challenge sessions", () => {
        const names = resolveSolverActiveToolNames(
            prompt,
            { tools: ["bash"], customTools: customTools("challenge_submit_report", "security_kimi_search") },
            { challengeMode: true, authorizedSolver: false },
        )

        expect(names).toEqual(expect.arrayContaining([
            "bash",
            "challenge_submit_report",
            "security_kimi_search",
            "mcp_browser",
            "board_refresh",
            "memory_list",
            "idea_list",
            "idea_search",
        ]))
    })

    test("does not expose challenge or observer tools outside challenge sessions", () => {
        const names = resolveSolverActiveToolNames(
            prompt,
            { tools: ["bash"], customTools: customTools("security_kimi_search") },
            { challengeMode: false, authorizedSolver: false },
        )

        expect(names).toEqual(expect.arrayContaining(["bash", "security_kimi_search", "mcp_browser"]))
        expect(names).not.toContain("challenge_submit_report")
        expect(names).not.toContain("board_refresh")
    })

    test("authorized sessions expose only their mediated custom tools", () => {
        const names = resolveSolverActiveToolNames(
            prompt,
            { tools: [], customTools: customTools("challenge_authorized_http", "authorized_work_complete") },
            { challengeMode: true, authorizedSolver: true },
        )

        expect(names).toEqual(["challenge_authorized_http", "authorized_work_complete"])
    })
})

describe("buildSubagentStartupSnapshot", () => {
    test("includes parent tool call metadata for runtime recovery", () => {
        const prompt: PromptFile = {
            name: "recon",
            meta: {
                model: "model-pref",
                skills: ["recon"],
                tools: ["bash"],
            },
            content: "subagent prompt",
        }
        const sessionOpts = {
            model: { provider: "openai", id: "gpt" },
            tools: [{ name: "bash" }],
        } as unknown as CreateAgentSessionOptions

        const snapshot = buildSubagentStartupSnapshot("recon", "scan", "subagent:1", 2, prompt, sessionOpts, {
            subagentDir: "/tmp/sub",
            sessionDir: "/tmp/sub/session",
            workspaceDir: "/tmp/workspace",
        })

        expect(snapshot.init).toEqual({
            promptName: "recon",
            task: "scan",
            parentToolCallId: "subagent:1",
            step: 2,
        })
        expect(snapshot.paths).toEqual({
            subagentDir: "/tmp/sub",
            sessionDir: "/tmp/sub/session",
            workspaceDir: "/tmp/workspace",
        })
    })
})

describe("challenge collaboration append prompt", () => {
    test("main solver only gets read access to memory and idea boards", () => {
        const names = challengeObserverAgentTools.map((tool) => tool.name)

        expect(names).toContain("memory_list")
        expect(names).not.toContain("memory_add")
        expect(names).not.toContain("memory_update")
        expect(names).toContain("idea_list")
        expect(names).toContain("idea_search")
        expect(names).not.toContain("idea_add")
        expect(names).not.toContain("idea_update")
    })

    test("combined extension exposes append prompt through session extension contract", () => {
        expect(typeof challengeObserverExtension().appendSystemPrompt).toBe("function")
    })

    test("combined extension appends observer contract only when enabled", () => {
        const withoutObserver = challengeObserverExtension({ observerEnabled: false }).appendSystemPrompt
        const withObserver = challengeObserverExtension({ observerEnabled: true }).appendSystemPrompt

        expect(typeof withoutObserver === "function" ? withoutObserver() : withoutObserver).toBe(buildChallengeExtensionAppendPrompt())
        expect(typeof withObserver === "function" ? withObserver() : withObserver).toBe(
            `${buildChallengeExtensionAppendPrompt()}\n\n${buildObserverExtensionAppendPrompt()}`,
        )
    })

    test("challenge extension append prompt covers sync contract", () => {
        const text = buildChallengeExtensionAppendPrompt()

        expect(text).toContain("challenge extension / host bridge")
        expect(text).toContain("`idea` 是待验证的攻击假设")
        expect(text).toContain("observer sidecar 会维护")
        expect(text).toContain("系统同步或协作同步消息")
        expect(text).toContain("把报告写入工作区")
    })

    test("observer extension append prompt covers sidecar contract", () => {
        const text = buildObserverExtensionAppendPrompt()

        expect(text).toContain("observer sidecar")
        expect(text).toContain("不直接替你解题")
        expect(text).toContain("只读策略板")
        expect(text).toContain("不要把 idea 当结论")
    })
})
