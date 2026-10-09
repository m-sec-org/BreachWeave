// Engagement completion oracle + context provider.
//
// Externalized termination ("结束条件外置"): the enterprise analog of the CTF
// host-bridge `challenge_is_completed` oracle. An engagement is "done" when the
// test policy's coverage is met (goal achieved or no open hypotheses after the
// TEST/DOCUMENT phases) OR a budget backstop (tool-call / wall-clock) is hit.
//
// Pure over its inputs so it is trivially testable; thin readers wrap the
// pentest-workspace RunState / HypothesisBacklog on disk.

import {
    readHypothesisBacklog,
    readRunPolicy,
    readRunState,
    type HypothesisBacklog,
    type RunPolicy,
    type RunState,
} from "../config/tools/pentest-workspace"

export type EngagementCompletionReason = "goal_achieved" | "coverage_met" | "budget_exhausted" | "in_progress"

export interface EngagementBudget {
    /** Hard cap on total tool calls for the engagement. */
    maxToolCalls?: number
    /** Tool calls consumed so far. */
    toolCallsUsed?: number
    /** Hard cap on wall-clock duration (ms). */
    maxDurationMs?: number
    /** Engagement start (epoch ms). */
    startedAt?: number
}

export interface EngagementCompletion {
    complete: boolean
    reason: EngagementCompletionReason
    detail: string
}

/** Oracle interface — injected into the Observer / continuation kernel (replaces host-bridge). */
export interface CompletionOracle {
    isComplete(): Promise<boolean>
}

export interface HypothesisCounts {
    total: number
    candidate: number
    verified: number
    rejected: number
    inconclusive: number
}

export interface EngagementContext {
    engagementId: string
    phase: RunState["current_phase"]
    completedPhases: RunState["completed_phases"]
    cycle: number
    goalAchieved: boolean
    allowedTargets: string[]
    hypotheses: HypothesisCounts
    completion: EngagementCompletion
}

/** Context provider interface — injected into the Observer review (replaces challenge_get_state). */
export interface EngagementContextProvider {
    getContext(): Promise<EngagementContext>
}

export function countHypotheses(backlog: HypothesisBacklog): HypothesisCounts {
    const counts: HypothesisCounts = { total: 0, candidate: 0, verified: 0, rejected: 0, inconclusive: 0 }
    for (const hypothesis of backlog.hypotheses) {
        counts.total += 1
        if (hypothesis.status === "candidate") counts.candidate += 1
        else if (hypothesis.status === "verified") counts.verified += 1
        else if (hypothesis.status === "rejected") counts.rejected += 1
        else if (hypothesis.status === "inconclusive") counts.inconclusive += 1
    }
    return counts
}

/**
 * Decide whether an engagement is complete.
 *
 * Order: goal_achieved > budget_exhausted > coverage_met > in_progress.
 * Coverage is "met" once TEST and DOCUMENT phases are done and no hypothesis is
 * still an open `candidate`. Budget acts as a hard backstop regardless of coverage.
 */
export function computeEngagementComplete(input: {
    runState: RunState
    backlog: HypothesisBacklog
    budget?: EngagementBudget
    now?: number
}): EngagementCompletion {
    const { runState, backlog, budget } = input

    if (runState.goal_achieved) {
        return { complete: true, reason: "goal_achieved", detail: `goal achieved${runState.goal_output_id ? ` (${runState.goal_output_id})` : ""}` }
    }

    if (budget) {
        if (typeof budget.maxToolCalls === "number" && typeof budget.toolCallsUsed === "number" && budget.toolCallsUsed >= budget.maxToolCalls) {
            return { complete: true, reason: "budget_exhausted", detail: `tool-call budget exhausted (${budget.toolCallsUsed}/${budget.maxToolCalls})` }
        }
        if (typeof budget.maxDurationMs === "number" && typeof budget.startedAt === "number") {
            const now = typeof input.now === "number" ? input.now : budget.startedAt + budget.maxDurationMs
            if (now - budget.startedAt >= budget.maxDurationMs) {
                return { complete: true, reason: "budget_exhausted", detail: `time budget exhausted (${Math.floor((now - budget.startedAt) / 1000)}s)` }
            }
        }
    }

    const completed = new Set(runState.completed_phases)
    const counts = countHypotheses(backlog)
    const phasesDone = completed.has("TEST") && completed.has("DOCUMENT")
    if (phasesDone && counts.candidate === 0) {
        return {
            complete: true,
            reason: "coverage_met",
            detail: `coverage met: TEST+DOCUMENT complete, ${counts.total} hypotheses resolved (0 open)`,
        }
    }

    return {
        complete: false,
        reason: "in_progress",
        detail: `phase=${runState.current_phase}, open_hypotheses=${counts.candidate}, cycle=${runState.cycle}`,
    }
}

/** Read workspace state and compute completion. */
export async function readEngagementCompletion(cwd: string, budget?: EngagementBudget, now?: number): Promise<EngagementCompletion> {
    const [runState, backlog] = await Promise.all([readRunState(cwd), readHypothesisBacklog(cwd)])
    return computeEngagementComplete({ runState, backlog, budget, now })
}

/** Build the injectable completion oracle for an engagement workspace. */
export function createEngagementCompletionOracle(cwd: string, budget?: EngagementBudget): CompletionOracle {
    return {
        async isComplete() {
            const completion = await readEngagementCompletion(cwd, budget)
            return completion.complete
        },
    }
}

export async function readEngagementContext(cwd: string, engagementId: string, budget?: EngagementBudget): Promise<EngagementContext> {
    const [runState, backlog, policy] = await Promise.all([readRunState(cwd), readHypothesisBacklog(cwd), readRunPolicy(cwd)])
    return buildEngagementContext({ engagementId, runState, backlog, policy, budget })
}

export function buildEngagementContext(input: {
    engagementId: string
    runState: RunState
    backlog: HypothesisBacklog
    policy: RunPolicy
    budget?: EngagementBudget
    now?: number
}): EngagementContext {
    const { engagementId, runState, backlog, policy, budget } = input
    return {
        engagementId,
        phase: runState.current_phase,
        completedPhases: runState.completed_phases,
        cycle: runState.cycle,
        goalAchieved: runState.goal_achieved,
        allowedTargets: policy.allowed_targets,
        hypotheses: countHypotheses(backlog),
        completion: computeEngagementComplete({ runState, backlog, budget, now: input.now }),
    }
}

/** Build the injectable context provider for an engagement workspace. */
export function createEngagementContextProvider(cwd: string, engagementId: string, budget?: EngagementBudget): EngagementContextProvider {
    return {
        async getContext() {
            return readEngagementContext(cwd, engagementId, budget)
        },
    }
}

/** Format the engagement context for the observer review prompt (analog of "## Challenge State"). */
export function formatEngagementContext(ctx: EngagementContext): string {
    const h = ctx.hypotheses
    return [
        "## Engagement State",
        `- id: ${ctx.engagementId}`,
        `- phase: ${ctx.phase}`,
        `- completed_phases: ${ctx.completedPhases.length > 0 ? ctx.completedPhases.join(", ") : "-"}`,
        `- cycle: ${ctx.cycle}`,
        `- allowed_targets: ${ctx.allowedTargets.length > 0 ? ctx.allowedTargets.join(", ") : "-"}`,
        `- hypotheses: ${h.total} total (candidate ${h.candidate} / verified ${h.verified} / rejected ${h.rejected} / inconclusive ${h.inconclusive})`,
        `- completion: ${ctx.completion.complete ? "complete" : "in_progress"} (${ctx.completion.reason}) — ${ctx.completion.detail}`,
    ].join("\n")
}
