// Engagement launcher (Slice 6): the single entrypoint that makes an engagement
// one-click runnable — bootstrap a workspace, set the activation env, and start
// the ENGAGEMENT_SOLVER (whose continuation extension self-drives the ralph loop
// until the completion oracle judges coverage met / budget exhausted).
//
// `prepareEngagementRun` is PURE + SDK-free (planner only): it maps an engagement
// into the env + SolverInitPayload without touching disk, the SDK, randomness, or
// the clock. `runEngagement` is the orchestration wrapper; its deps are injectable
// so it is unit-testable without the SDK / a real model.

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { join } from "node:path"
import { bootstrapEngagement as realBootstrapEngagement, type BootstrapEngagementInput } from "./bootstrap"
import { ENGAGEMENT_ENV_DIR, ENGAGEMENT_ENV_ID } from "./env"
import { createSolverSession as realCreateSolverSession, type SolverSession } from "../solver/session"
import type { SolverInitPayload } from "../solver/rpc/rpc-types"

/** The builtin engine prompt an engagement always runs as (Slice 4). */
export const ENGAGEMENT_SOLVER_PROMPT = "ENGAGEMENT_SOLVER"

export interface PrepareEngagementRunInput {
    engagementId: string
    workspaceDir: string
    task: string
    /** Solver id (8-char random) — injected by the caller; never generated inside the pure planner. */
    solverId?: string
}

export interface PreparedEngagementRun {
    env: Record<string, string>
    init: SolverInitPayload
}

/**
 * Plan an engagement run (PURE).
 *
 * The env MUST make the solver's ctx.cwd the engagement workspace so that
 * document_finding / run-state / report land in the same dir the oracle + report
 * layers read from:
 * - ENGAGEMENT_ID / ENGAGEMENT_DIR — activate the engagement kernel (session.ts).
 * - TCH_SOLVER_WORKSPACE=workspaceDir — solver ctx.cwd = engagement workspace.
 * - TCH_SOLVER_SESSION_DIR=<workspaceDir>/session — observer `.observer` + board.
 *
 * init.promptName is always ENGAGEMENT_SOLVER; solverId falls back to the engagement
 * id when the caller does not inject one (keeps the planner deterministic).
 */
export function prepareEngagementRun(input: PrepareEngagementRunInput): PreparedEngagementRun {
    const { engagementId, workspaceDir, task } = input
    const solverId = input.solverId ?? engagementId
    const sessionDir = join(workspaceDir, "session")

    const env: Record<string, string> = {
        [ENGAGEMENT_ENV_ID]: engagementId,
        [ENGAGEMENT_ENV_DIR]: workspaceDir,
        TCH_SOLVER_WORKSPACE: workspaceDir,
        TCH_SOLVER_SESSION_DIR: sessionDir,
    }

    return {
        env,
        init: {
            solverId,
            promptName: ENGAGEMENT_SOLVER_PROMPT,
            task,
        },
    }
}

export type EngagementEventListener = (event: AgentSessionEvent) => void

export interface RunEngagementInput {
    /** Engagement workspace root (= solver ctx.cwd). */
    workspaceDir: string
    /** The task prompt handed to the solver. */
    task: string
    /** Engagement id; defaults to the workspace basename when omitted by the caller. */
    engagementId: string
    /** Solver id (8-char random) — injected at the orchestration/CLI layer. */
    solverId?: string
    /**
     * When present, bootstrap the workspace first (compile policy + write run-policy/
     * engagement-policy/run-state). Omit when the workspace is already bootstrapped.
     */
    bootstrap?: BootstrapEngagementInput
    /** Optional live session event subscriber. */
    onEvent?: EngagementEventListener
}

/** Injectable dependencies so runEngagement can be unit-tested without the SDK / a model. */
export interface RunEngagementDeps {
    createSession?: (init: SolverInitPayload) => Promise<SolverSession>
    bootstrap?: (input: BootstrapEngagementInput) => Promise<unknown>
}

export interface RunEngagementResult {
    session: SolverSession["session"]
    sessionDir: string
    workspaceDir: string
}

/**
 * Orchestrate an engagement run.
 *
 * Steps:
 * 1. Optional bootstrap (when input.bootstrap given) — Slice 2.
 * 2. prepareEngagementRun (PURE) → env + init.
 * 3. Object.assign(process.env, env) so the kernel + solver ctx.cwd activate.
 * 4. createSession(init) — real createSolverSession by default.
 * 5. Optional subscribe(onEvent).
 * 6. await session.prompt(task, { source: "interactive", expandPromptTemplates: true })
 *    — the continuation extension self-drives until the oracle judges completion.
 */
export async function runEngagement(input: RunEngagementInput, deps?: RunEngagementDeps): Promise<RunEngagementResult> {
    const bootstrap = deps?.bootstrap ?? realBootstrapEngagement
    const createSession = deps?.createSession ?? realCreateSolverSession

    if (input.bootstrap) {
        await bootstrap(input.bootstrap)
    }

    const { env, init } = prepareEngagementRun({
        engagementId: input.engagementId,
        workspaceDir: input.workspaceDir,
        task: input.task,
        solverId: input.solverId,
    })
    Object.assign(process.env, env)

    const { session, sessionDir, workspaceDir } = await createSession(init)

    if (input.onEvent) {
        session.subscribe(input.onEvent)
    }

    await session.prompt(init.task, {
        source: "interactive",
        expandPromptTemplates: true,
    })

    return { session, sessionDir, workspaceDir }
}
