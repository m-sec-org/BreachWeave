import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { PENTEST_PHASES, ensurePentestWorkspace, isForwardPhaseTransition, readRunState, transitionToPhase, type PentestPhase } from "./pentest-workspace"

const EngagementTransitionPhaseParams = Type.Object({
    to: Type.Union(
        PENTEST_PHASES.map((phase) => Type.Literal(phase)),
        { description: "Target phase to advance to (forward or in-place only)" },
    ),
    reason: Type.String({ description: "Why this phase transition happens" }),
})
type EngagementTransitionPhaseInput = Static<typeof EngagementTransitionPhaseParams>

export const engagementTransitionPhaseTool = defineTool({
    name: "engagement_transition_phase",
    label: "Engagement Transition Phase",
    description:
        "Advance the engagement phase state machine forward (SCOPE→RECON→HYPOTHESIZE→TEST→DOCUMENT→REPORT). " +
        "Forward or in-place only; backward moves (reentry) are handled by ingest_sub_agent_output, not this tool.",
    promptSnippet: "engagement_transition_phase: advance the engagement phase forward with a reason",
    parameters: EngagementTransitionPhaseParams,
    async execute(_toolCallId, params: EngagementTransitionPhaseInput, _signal, _onUpdate, ctx) {
        await ensurePentestWorkspace(ctx.cwd)

        const targetPhase = params.to as PentestPhase
        const runState = await readRunState(ctx.cwd)
        if (!isForwardPhaseTransition(runState.current_phase, targetPhase)) {
            throw new Error(
                `cannot move backward from ${runState.current_phase} to ${targetPhase}; reentry is handled by ingest_sub_agent_output (reentry semantics), not engagement_transition_phase`,
            )
        }

        const nextState = await transitionToPhase(ctx.cwd, targetPhase, params.reason)

        return {
            content: [{ type: "text", text: `Phase → ${nextState.current_phase} (completed: ${nextState.completed_phases.join(", ") || "none"})` }],
            details: {
                current_phase: nextState.current_phase,
                completed_phases: nextState.completed_phases,
            },
        }
    },
})
