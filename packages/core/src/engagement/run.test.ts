import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { ENGAGEMENT_ENV_DIR, ENGAGEMENT_ENV_ID } from "./env"
import { ENGAGEMENT_POLICY_FILE } from "./bootstrap"
import type { BootstrapEngagementInput } from "./bootstrap"
import type { TestPolicy } from "./policy"
import { prepareEngagementRun, runEngagement, ENGAGEMENT_SOLVER_PROMPT } from "./run"
import type { SolverInitPayload } from "../solver/rpc/rpc-types"
import type { SolverSession } from "../solver/session"

const createdDirs: string[] = []
const touchedEnvKeys = [ENGAGEMENT_ENV_ID, ENGAGEMENT_ENV_DIR, "TCH_SOLVER_WORKSPACE", "TCH_SOLVER_SESSION_DIR"]

async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "engagement-run-"))
    createdDirs.push(dir)
    return dir
}

afterEach(async () => {
    for (const key of touchedEnvKeys) {
        delete process.env[key]
    }
    while (createdDirs.length > 0) {
        const dir = createdDirs.pop()!
        await rm(dir, { recursive: true, force: true })
    }
})

function makePolicy(overrides?: Partial<TestPolicy>): TestPolicy {
    return {
        vulnClasses: ["sqli", "idor"],
        depth: "standard",
        redLine: "poc-safe",
        ...overrides,
    }
}

/** A minimal fake AgentSession — only the methods runEngagement touches. */
interface FakeSessionCalls {
    subscribed: Array<(event: AgentSessionEvent) => void>
    prompts: Array<{ message: string; options: unknown }>
    disposed: number
}

function makeFakeSolverSession(sessionDir: string, workspaceDir: string): { solver: SolverSession; calls: FakeSessionCalls } {
    const calls: FakeSessionCalls = { subscribed: [], prompts: [], disposed: 0 }
    const session = {
        subscribe(listener: (event: AgentSessionEvent) => void) {
            calls.subscribed.push(listener)
        },
        async prompt(message: string, options: unknown) {
            calls.prompts.push({ message, options })
        },
        dispose() {
            calls.disposed += 1
        },
    }
    // The fake only implements the surface runEngagement uses; cast at the SDK boundary.
    return { solver: { session: session as unknown as SolverSession["session"], sessionDir, workspaceDir }, calls }
}

describe("prepareEngagementRun", () => {
    test("sets ENGAGEMENT_ID / ENGAGEMENT_DIR / TCH_SOLVER_WORKSPACE / TCH_SOLVER_SESSION_DIR", () => {
        const { env } = prepareEngagementRun({
            engagementId: "eng-1",
            workspaceDir: "/tmp/ws",
            task: "test the target",
        })
        expect(env[ENGAGEMENT_ENV_ID]).toBe("eng-1")
        expect(env[ENGAGEMENT_ENV_DIR]).toBe("/tmp/ws")
        expect(env.TCH_SOLVER_WORKSPACE).toBe("/tmp/ws")
        expect(env.TCH_SOLVER_SESSION_DIR).toBe(join("/tmp/ws", "session"))
    })

    test("init carries the ENGAGEMENT_SOLVER prompt + task + solverId fallback", () => {
        const { init } = prepareEngagementRun({
            engagementId: "eng-1",
            workspaceDir: "/tmp/ws",
            task: "run it",
        })
        expect(init.promptName).toBe(ENGAGEMENT_SOLVER_PROMPT)
        expect(init.promptName).toBe("ENGAGEMENT_SOLVER")
        expect(init.task).toBe("run it")
        // solverId falls back to engagementId when not injected (deterministic planner).
        expect(init.solverId).toBe("eng-1")
    })

    test("uses the injected solverId when provided", () => {
        const { init } = prepareEngagementRun({
            engagementId: "eng-1",
            workspaceDir: "/tmp/ws",
            task: "run it",
            solverId: "abcd1234",
        })
        expect(init.solverId).toBe("abcd1234")
    })

    test("is pure — does not mutate process.env", () => {
        const before = process.env[ENGAGEMENT_ENV_ID]
        prepareEngagementRun({ engagementId: "eng-x", workspaceDir: "/tmp/ws", task: "t" })
        expect(process.env[ENGAGEMENT_ENV_ID]).toBe(before)
    })
})

describe("runEngagement (fake deps)", () => {
    test("bootstraps, sets process.env, creates the ENGAGEMENT_SOLVER session, and prompts", async () => {
        const dir = await makeTmpDir()
        const sessionDir = join(dir, "session")

        const bootstrapCalls: BootstrapEngagementInput[] = []
        const createSessionCalls: SolverInitPayload[] = []
        const { solver, calls } = makeFakeSolverSession(sessionDir, dir)

        const bootstrapInput: BootstrapEngagementInput = {
            engagementId: "eng-run",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: ["https://api.corp.com/"],
            policy: makePolicy(),
        }

        const result = await runEngagement(
            {
                engagementId: "eng-run",
                workspaceDir: dir,
                task: "assess api.corp.com",
                bootstrap: bootstrapInput,
            },
            {
                bootstrap: async (input) => {
                    bootstrapCalls.push(input)
                    // Emulate the real bootstrap's on-disk effect enough to assert against.
                    await Bun.write(join(input.workspaceDir, ENGAGEMENT_POLICY_FILE), JSON.stringify({ engagementId: input.engagementId }))
                    return { env: {} }
                },
                createSession: async (init) => {
                    createSessionCalls.push(init)
                    return solver
                },
            },
        )

        // bootstrap called with the given input + wrote its file.
        expect(bootstrapCalls).toHaveLength(1)
        expect(bootstrapCalls[0]?.engagementId).toBe("eng-run")
        expect(await Bun.file(join(dir, ENGAGEMENT_POLICY_FILE)).exists()).toBe(true)

        // env set on process.env with the critical solver-workspace wiring.
        expect(process.env[ENGAGEMENT_ENV_ID]).toBe("eng-run")
        expect(process.env[ENGAGEMENT_ENV_DIR]).toBe(dir)
        expect(process.env.TCH_SOLVER_WORKSPACE).toBe(dir)
        expect(process.env.TCH_SOLVER_SESSION_DIR).toBe(sessionDir)

        // createSession got the ENGAGEMENT_SOLVER init.
        expect(createSessionCalls).toHaveLength(1)
        expect(createSessionCalls[0]?.promptName).toBe("ENGAGEMENT_SOLVER")
        expect(createSessionCalls[0]?.task).toBe("assess api.corp.com")

        // session.prompt called with the task + interactive options.
        expect(calls.prompts).toHaveLength(1)
        expect(calls.prompts[0]?.message).toBe("assess api.corp.com")
        expect(calls.prompts[0]?.options).toEqual({ source: "interactive", expandPromptTemplates: true })

        // returned handle mirrors the session dirs.
        expect(result.sessionDir).toBe(sessionDir)
        expect(result.workspaceDir).toBe(dir)
    })

    test("skips bootstrap when no bootstrap input is given", async () => {
        const dir = await makeTmpDir()
        let bootstrapCalled = 0
        const { solver } = makeFakeSolverSession(join(dir, "session"), dir)

        await runEngagement(
            { engagementId: "eng-nobootstrap", workspaceDir: dir, task: "t" },
            {
                bootstrap: async () => {
                    bootstrapCalled += 1
                    return { env: {} }
                },
                createSession: async () => solver,
            },
        )

        expect(bootstrapCalled).toBe(0)
    })

    test("subscribes the onEvent listener when provided", async () => {
        const dir = await makeTmpDir()
        const { solver, calls } = makeFakeSolverSession(join(dir, "session"), dir)
        const events: AgentSessionEvent[] = []

        await runEngagement(
            { engagementId: "eng-events", workspaceDir: dir, task: "t", onEvent: (event) => events.push(event) },
            { createSession: async () => solver, bootstrap: async () => ({ env: {} }) },
        )

        expect(calls.subscribed).toHaveLength(1)
    })

    test("passes the injected solverId through to createSession", async () => {
        const dir = await makeTmpDir()
        const createSessionCalls: SolverInitPayload[] = []
        const { solver } = makeFakeSolverSession(join(dir, "session"), dir)

        await runEngagement(
            { engagementId: "eng-sid", workspaceDir: dir, task: "t", solverId: "deadbeef" },
            {
                createSession: async (init) => {
                    createSessionCalls.push(init)
                    return solver
                },
                bootstrap: async () => ({ env: {} }),
            },
        )

        expect(createSessionCalls[0]?.solverId).toBe("deadbeef")
    })
})
