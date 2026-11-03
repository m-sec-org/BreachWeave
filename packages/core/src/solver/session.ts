import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { mkdir } from "node:fs/promises"
import { ConfigManager } from "../config/index"
import type { PromptFile } from "../config/prompts/index"
import type { SolverInitPayload } from "./rpc/rpc-types"
import { solverDir, solverSessionDir, solverWorkspaceDir } from "../runtime/types"
import { challengeObserverExtension } from "./extension/challenge-observer/index"
import { pentestCompactionExtension } from "./extension/pentest-compaction"
import { scopeGuardExtension } from "./extension/scope-guard"
import { largeToolResultExtension } from "./extension/large-tool-result"
import { rtkRewriteExtension } from "./extension/rtk-rewrite"
import { AUTHORIZED_MODEL_ORIGIN_ENV, AUTHORIZED_SOLVER_ENV, CHALLENGE_ENV_CHALLENGE_ID } from "../challenge/env"
import { registerAuthorizedWorkFinishedCallback, requestHostBridge } from "../challenge/host-bridge-client"
import { createAuthorizedModelFetch } from "./authorized-model-fetch"
import { challengeToolNames } from "../config/tools/challenge-tools"
import { challengeObserverAgentTools } from "./extension/challenge-observer/tools"

export interface SolverSession {
    session: AgentSession
    sessionDir: string
    workspaceDir: string
}

export interface SubagentSession {
    session: AgentSession
    baseDir: string
    sessionDir: string
    workspaceDir: string
}

export type SolverStartupDebugValue = string | number | boolean | null | undefined | SolverStartupDebugValue[] | { [key: string]: SolverStartupDebugValue }

export interface SolverStartupSnapshot {
    createdAt: number
    init: SolverInitPayload
    prompt: PromptFile
    paths: { solverDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

export interface SubagentStartupSnapshot {
    createdAt: number
    init: { promptName: string; task: string; parentToolCallId?: string; step?: number }
    prompt: PromptFile
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

function readInjectedPath(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

/**
 * The SDK keeps custom tools registered separately from the active tool
 * allowlist. Solver sessions must activate the tools that the prompt and the
 * challenge extension registered, otherwise the model cannot submit its report
 * or refresh the shared board.
 */
export function resolveSolverActiveToolNames(
    prompt: PromptFile,
    sessionOpts: Pick<CreateAgentSessionOptions, "tools" | "customTools">,
    options: { challengeMode: boolean; authorizedSolver: boolean },
): string[] {
    const names = new Set<string>(sessionOpts.tools ?? [])
    for (const tool of sessionOpts.customTools ?? []) names.add(tool.name)

    if (!options.authorizedSolver) {
        for (const name of prompt.meta.tools ?? []) {
            if (options.challengeMode || !challengeToolNames.has(name)) names.add(name)
        }
    }

    if (options.challengeMode && !options.authorizedSolver) {
        for (const tool of challengeObserverAgentTools) names.add(tool.name)
    }

    return [...names]
}

function installAuthorizedModelFetch(): void {
    const origin = process.env[AUTHORIZED_MODEL_ORIGIN_ENV]?.trim()
    if (!origin) throw new Error("authorized Solver requires a host-approved model origin")
    globalThis.fetch = createAuthorizedModelFetch(origin)
}

function installAuthorizedWorkHeartbeat(): void {
    const binding = {
        challengeId: process.env.TCH_CHALLENGE_ID?.trim(),
        workRunId: process.env.TCH_TARIC_WORK_RUN_ID?.trim(),
        generation: Number(process.env.TCH_TARIC_WORK_GENERATION),
        resourceId: process.env.TCH_TARIC_RESOURCE_ID?.trim(),
    }
    if (!binding.challengeId || !binding.workRunId || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !binding.resourceId) {
        throw new Error("authorized Solver requires a complete WorkRun heartbeat binding")
    }
    let pending: Promise<unknown> | undefined
    const timer = setInterval(() => {
        if (pending) return
        pending = requestHostBridge("authorized_work_renew", {}, 15_000).catch(() => {
            // Every target action independently checks the canonical lease.
        }).finally(() => {
            pending = undefined
        })
    }, 15_000)
    registerAuthorizedWorkFinishedCallback(() => {
        clearInterval(timer)
    })
}

export function buildSolverStartupSnapshot(
    init: SolverInitPayload,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { solverDir: string; sessionDir: string; workspaceDir: string },
): SolverStartupSnapshot {
    return {
        createdAt: Date.now(),
        init,
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

export function buildSubagentStartupSnapshot(
    promptName: string,
    task: string,
    parentToolCallId: string | undefined,
    step: number | undefined,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string },
): SubagentStartupSnapshot {
    return {
        createdAt: Date.now(),
        init: { promptName, task, parentToolCallId, step },
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

function sanitizeForDebug(value: unknown, depth = 0): SolverStartupDebugValue {
    if (value == null) return value
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    if (depth >= 4) return `[${value.constructor?.name || "Object"}]`

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForDebug(item, depth + 1))
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 0) return `[${value.constructor?.name || "Object"}]`

        return Object.fromEntries(entries.map(([key, item]) => [key, sanitizeForDebug(item, depth + 1)]))
    }

    return String(value)
}

/**
 * Create an AgentSession configured for a solver.
 * Resolves prompt config, prepares directories, returns the session.
 * Caller is responsible for sending prompts and disposing.
 */
export async function createSolverSession(init: SolverInitPayload): Promise<SolverSession> {
    const config = await ConfigManager.getInstance()

    const workspaceDir = readInjectedPath("TCH_SOLVER_WORKSPACE") ?? solverWorkspaceDir(init.solverId)
    const sessionDir = readInjectedPath("TCH_SOLVER_SESSION_DIR") ?? solverSessionDir(init.solverId)
    const baseDir = readInjectedPath("TCH_SOLVER_BASE_DIR") ?? solverDir(init.solverId)
    const startupPath = readInjectedPath("TCH_SOLVER_STARTUP_PATH") ?? `${baseDir}/startup.json`
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const prompt = await config.getPrompt(init.promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    if (prompt.meta.isSubagent) {
        throw new Error(`subagent prompt cannot be started as solver: ${init.promptName}`)
    }

    const observerEnabled = prompt.meta.observerEnabled === true
    const authorizedSolver = process.env[AUTHORIZED_SOLVER_ENV] === "1"
    const promptModel = typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : undefined
    const observerModel = typeof prompt.meta.observerModel === "string" && prompt.meta.observerModel.trim() ? prompt.meta.observerModel.trim() : promptModel

    const extensions = [
        // largeToolResultExtension({ workspaceRoot: workspaceDir }),
        ...(!authorizedSolver ? [challengeObserverExtension({ observerEnabled, observerModel })] : []),
        // rtkRewriteExtension(),
    ]

    const resolvedSessionOpts = await config.resolvePromptSession(init.promptName, extensions, { appendChallengeReportPrompt: !authorizedSolver, authorizedSolver })
    if (!resolvedSessionOpts) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    const sessionOpts = {
        ...resolvedSessionOpts,
        tools: resolveSolverActiveToolNames(prompt, resolvedSessionOpts, {
            challengeMode: Boolean(process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim()),
            authorizedSolver,
        }),
    }
    if (authorizedSolver) installAuthorizedModelFetch()
    const startupSnapshot = buildSolverStartupSnapshot(init, prompt, sessionOpts, {
        solverDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(startupPath, JSON.stringify(startupSnapshot, null, 2))

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})
    if (authorizedSolver) installAuthorizedWorkHeartbeat()

    return { session, sessionDir, workspaceDir }
}

export async function createSubagentSession(promptName: string, task: string): Promise<SubagentSession> {
    const solverWorkspace = process.env.TCH_SOLVER_WORKSPACE?.trim()
    if (!solverWorkspace) {
        throw new Error("TCH_SOLVER_WORKSPACE is required for subagent sessions")
    }

    const config = await ConfigManager.getInstance()
    const prompt = await config.getPrompt(promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${promptName}`)
    }
    if (prompt.meta.isSubagent !== true) {
        throw new Error(`prompt is not a subagent: ${promptName}`)
    }

    const baseDir = process.cwd()
    const sessionDir = `${baseDir}/session`
    const workspaceDir = solverWorkspace
    const parentToolCallId = process.env.TCH_SUBAGENT_PARENT_TOOL_CALL_ID?.trim() || undefined
    const stepValue = process.env.TCH_SUBAGENT_STEP?.trim()
    const step = stepValue && Number.isFinite(Number(stepValue)) ? Number(stepValue) : undefined
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const extensionFactories: ExtensionFactory[] = [
        // rtkRewriteExtension(),
        // largeToolResultExtension({ workspaceRoot: workspaceDir }),
        // pentestCompactionExtension(),
        // scopeGuardExtension({ workspaceRoot: workspaceDir, agentRole: "subagent" }),
    ]

    const sessionOpts = await config.resolvePromptSession(promptName, extensionFactories)
    if (!sessionOpts) {
        throw new Error(`prompt not found: ${promptName}`)
    }

    const startupSnapshot = buildSubagentStartupSnapshot(promptName, task, parentToolCallId, step, prompt, sessionOpts, {
        subagentDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(`${baseDir}/startup.json`, JSON.stringify(startupSnapshot, null, 2))

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    return { session, baseDir, sessionDir, workspaceDir }
}
