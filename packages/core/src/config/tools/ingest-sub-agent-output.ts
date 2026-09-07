import { join } from "path"
import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { isContractFailedOutput, parseSubAgentOutputRecord, type CandidateFindingRecord, type StructuredHypothesisRecord } from "./pentest-output"
import {
    clearActiveHypothesis,
    ensurePentestWorkspace,
    markGoalAchieved,
    readHypothesisBacklog,
    readRunPolicy,
    readRunState,
    transitionToPhase,
    writeHypothesisBacklog,
} from "./pentest-workspace"

const IngestSubAgentOutputParams = Type.Object({
    output_id: Type.String({ description: "Sub-agent output id, e.g. recon-001" }),
})
type IngestSubAgentOutputInput = Static<typeof IngestSubAgentOutputParams>

function mergeEvidenceRefs(left: string[], right: string[]): string[] {
    return [...new Set([...left, ...right].map((item) => item.trim()).filter((item) => item.length > 0))]
}

function statusFromFinding(status: CandidateFindingRecord["status"] | undefined): "candidate" | "verified" | "rejected" | "inconclusive" {
    if (status === "verified") return "verified"
    if (status === "rejected") return "rejected"
    return "inconclusive"
}

function summarizeHypothesis(
    outputId: string,
    hypotheses: StructuredHypothesisRecord[],
    findings: CandidateFindingRecord[],
    backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>,
) {
    const findingById = new Map(findings.map((finding) => [finding.hypothesis_id, finding]))
    const existingById = new Map(backlog.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]))
    const now = new Date().toISOString()

    return hypotheses.map((hypothesis) => {
        const existing = existingById.get(hypothesis.hypothesis_id)
        const finding = findingById.get(hypothesis.hypothesis_id)

        return {
            id: hypothesis.hypothesis_id,
            statement: existing?.statement ?? hypothesis.statement,
            kind: existing?.kind ?? hypothesis.kind,
            entry_point: existing?.entry_point ?? hypothesis.entry_point,
            priority: existing?.priority ?? hypothesis.priority,
            confidence: existing?.confidence ?? hypothesis.confidence,
            why_plausible: hypothesis.why_plausible,
            next_test: hypothesis.next_test,
            origin_cycle: existing?.origin_cycle ?? 0,
            status: statusFromFinding(finding?.status),
            attempt_count: existing?.attempt_count ?? 0,
            source_output_id: outputId,
            source_artifact: join("sub-agents", `${outputId}.json`),
            evidence_refs: mergeEvidenceRefs(existing?.evidence_refs ?? [], finding ? [finding.evidence] : []),
            last_result: finding ? `${finding.status}:${finding.evidence}` : (existing?.last_result ?? ""),
            last_updated: now,
            last_tested_at: finding ? now : existing?.last_tested_at,
        }
    })
}

function autoCloseRemainingCandidates(input: {
    backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>
    keepHypothesisId: string
    outputId: string
}) {
    const now = new Date().toISOString()
    const autoClosedHypothesisIds: string[] = []
    const hypotheses = input.backlog.hypotheses.map((hypothesis) => {
        if (hypothesis.id === input.keepHypothesisId || hypothesis.status !== "candidate") {
            return hypothesis
        }
        autoClosedHypothesisIds.push(hypothesis.id)
        return {
            ...hypothesis,
            status: "inconclusive" as const,
            source_output_id: input.outputId,
            source_artifact: join("sub-agents", `${input.outputId}.json`),
            last_result: `auto_closed:goal_achieved:${input.outputId}`,
            last_updated: now,
        }
    })
    return {
        backlog: {
            hypotheses,
            updated_at: now,
        },
        autoClosedHypothesisIds,
    }
}

function priorityScore(priority: "high" | "medium" | "low"): number {
    switch (priority) {
        case "high":
            return 3
        case "medium":
            return 2
        case "low":
            return 1
    }
}

function selectNextHypothesis(backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>) {
    return backlog.hypotheses
        .filter((hypothesis) => hypothesis.status === "candidate")
        .sort((a, b) => {
            const byPriority = priorityScore(b.priority) - priorityScore(a.priority)
            if (byPriority !== 0) return byPriority
            const byConfidence = b.confidence - a.confidence
            if (byConfidence !== 0) return byConfidence
            const byAttempts = a.attempt_count - b.attempt_count
            if (byAttempts !== 0) return byAttempts
            return a.id.localeCompare(b.id)
        })[0]
}

function countRemainingCandidates(backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>): number {
    return backlog.hypotheses.filter((hypothesis) => hypothesis.status === "candidate").length
}

function computeCoverageScore(input: {
    assets: string[]
    hypotheses: StructuredHypothesisRecord[]
    findings: CandidateFindingRecord[]
    coverageGaps: string[]
}): number {
    const base = Math.min(100, input.assets.length * 8 + input.hypotheses.length * 6 + input.findings.length * 4)
    const penalty = input.coverageGaps.length * 12
    return Math.max(0, Math.min(100, base - penalty))
}

function hasVerifiedInCycle(backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>, cycle: number): boolean {
    return backlog.hypotheses.some((hypothesis) => hypothesis.origin_cycle === cycle && hypothesis.status === "verified")
}

function buildFailureFeedbackRefs(backlog: Awaited<ReturnType<typeof readHypothesisBacklog>>, cycle: number): string[] {
    return [
        ...new Set(
            backlog.hypotheses
                .filter(
                    (hypothesis) =>
                        hypothesis.origin_cycle === cycle &&
                        (hypothesis.status === "rejected" || hypothesis.status === "inconclusive"),
                )
                .map((hypothesis) => hypothesis.source_artifact)
                .filter((artifact) => artifact.length > 0),
        ),
    ]
}

export const ingestSubAgentOutputTool = defineTool({
    name: "ingest_sub_agent_output",
    label: "Ingest Sub-Agent Output",
    description: "Load sub-agents/<output_id>.json, validate it, and summarize hypotheses/findings for the orchestrator.",
    promptSnippet: "ingest_sub_agent_output: parse output and summarize next actions",
    parameters: IngestSubAgentOutputParams,
    async execute(_toolCallId, params: IngestSubAgentOutputInput, _signal, _onUpdate, ctx) {
        await ensurePentestWorkspace(ctx.cwd)

        const file = Bun.file(join(ctx.cwd, "sub-agents", `${params.output_id}.json`))
        if (!(await file.exists())) {
            throw new Error(`sub-agent output is missing: sub-agents/${params.output_id}.json`)
        }

        const record = parseSubAgentOutputRecord(await file.json())
        if (isContractFailedOutput(record)) {
            const respawnInputArtifactsHint = [join("evidence", record.role, record.output_id)]
            const summary = [
                `Ingested sub-agent output: ${params.output_id}`,
                `ingest_status=contract_failed`,
                `next_action=respawn_same_stage`,
                `actionable_reason=${record.reason}`,
                `respawn_input_artifacts_hint=${respawnInputArtifactsHint.join(", ")}`,
            ].join("\n")
            return {
                content: [{ type: "text", text: summary }],
                details: {
                    ...record,
                    ingest_status: "contract_failed",
                    next_action: "respawn_same_stage",
                    actionable_reason: record.reason,
                    respawn_input_artifacts_hint: respawnInputArtifactsHint,
                },
            }
        }

        const backlog = await readHypothesisBacklog(ctx.cwd)
        const runState = await readRunState(ctx.cwd)
        if (
            record.role === "targeted-pentest" &&
            runState.active_hypothesis_id &&
            record.hypotheses[0]?.hypothesis_id !== runState.active_hypothesis_id
        ) {
            throw new Error(
                `Output hypothesis_id "${record.hypotheses[0]?.hypothesis_id ?? "none"}" does not match active_hypothesis_id "${runState.active_hypothesis_id}"`,
            )
        }
        if (record.role === "targeted-pentest" && !record.hypotheses[0]) {
            throw new Error(`Invalid sub-agent output: targeted-pentest must emit one hypothesis`)
        }

        const summarizedHypotheses = summarizeHypothesis(
            record.output_id,
            record.hypotheses,
            record.candidate_findings,
            backlog,
        )

        let nextBacklog = {
            hypotheses: [
                ...backlog.hypotheses.filter((hypothesis) => !summarizedHypotheses.some((item) => item.id === hypothesis.id)),
                ...summarizedHypotheses,
            ],
            updated_at: new Date().toISOString(),
        }
        let autoClosedHypothesisIds: string[] = []
        const goalAchieved = record.role === "targeted-pentest" && record.goal?.achieved === true
        if (goalAchieved) {
            const lockHypothesisId = record.hypotheses[0]?.hypothesis_id
            if (!lockHypothesisId) {
                throw new Error(`Invalid sub-agent output: targeted-pentest must emit one hypothesis`)
            }
            const autoCloseResult = autoCloseRemainingCandidates({
                backlog: nextBacklog,
                keepHypothesisId: lockHypothesisId,
                outputId: record.output_id,
            })
            nextBacklog = autoCloseResult.backlog
            autoClosedHypothesisIds = autoCloseResult.autoClosedHypothesisIds
        }
        await writeHypothesisBacklog(ctx.cwd, nextBacklog)

        if (record.role === "targeted-pentest") {
            await clearActiveHypothesis(ctx.cwd)
        }
        if (goalAchieved) {
            await markGoalAchieved(ctx.cwd, {
                output_id: record.output_id,
                evidence_refs: record.goal?.evidence_refs ?? [],
            })
            if (runState.current_phase === "TEST") {
                await transitionToPhase(ctx.cwd, "DOCUMENT", `goal_achieved:${params.output_id}`)
            }
        }

        const nextHypothesis = selectNextHypothesis(nextBacklog)
        const remainingCandidateCount = goalAchieved ? 0 : countRemainingCandidates(nextBacklog)
        const coverageScore = computeCoverageScore({
            assets: record.assets,
            hypotheses: record.hypotheses,
            findings: record.candidate_findings,
            coverageGaps: record.coverage_gaps,
        })
        const policy = await readRunPolicy(ctx.cwd)
        let reentrySignal:
            | {
                  triggered: boolean
                  reason: string
                  next_phase: string
                  cycle: number
                  failure_feedback_refs: string[]
              }
            | undefined

        const shouldAttemptReentry =
            record.role === "targeted-pentest" &&
            record.stage === "test" &&
            runState.current_phase === "TEST" &&
            !goalAchieved &&
            policy.reentry.enabled &&
            remainingCandidateCount === 0 &&
            !hasVerifiedInCycle(nextBacklog, runState.cycle)

        if (shouldAttemptReentry) {
            const failureFeedbackRefs = buildFailureFeedbackRefs(nextBacklog, runState.cycle)
            if (runState.reentry_count < policy.reentry.max_cycles) {
                const reason = `auto_reentry:cycle=${runState.cycle}:source=${params.output_id}`
                const nextState = await transitionToPhase(ctx.cwd, "RECON", reason)
                reentrySignal = {
                    triggered: true,
                    reason,
                    next_phase: nextState.current_phase,
                    cycle: nextState.cycle,
                    failure_feedback_refs: failureFeedbackRefs,
                }
            } else {
                reentrySignal = {
                    triggered: false,
                    reason: `auto_reentry_blocked:max_cycles_reached(${runState.reentry_count}/${policy.reentry.max_cycles})`,
                    next_phase: runState.current_phase,
                    cycle: runState.cycle,
                    failure_feedback_refs: failureFeedbackRefs,
                }
            }
        }
        const summary = [
            `Ingested sub-agent output: ${params.output_id}`,
            `role=${record.role}, stage=${record.stage}`,
            `assets=${record.assets.length}, hypotheses=${record.hypotheses.length}, candidate_findings=${record.candidate_findings.length}, evidence_refs=${record.evidence_refs.length}`,
            `coverage_score=${coverageScore}, remaining_candidate_count=${remainingCandidateCount}, next_hypothesis=${nextHypothesis?.id ?? "none"}`,
            reentrySignal ? `reentry=${reentrySignal.reason}` : "reentry=none",
            goalAchieved ? "goal_achieved=true" : "goal_achieved=false",
            goalAchieved ? `stop_now=true, auto_closed_hypotheses=${autoClosedHypothesisIds.join(", ") || "none"}` : "stop_now=false",
        ].join("\n")

        return {
            content: [{ type: "text", text: summary }],
            details: {
                ...record,
                ingest_status: "ok",
                active_hypothesis_id: runState.active_hypothesis_id,
                hypotheses: summarizedHypotheses,
                coverage_score: coverageScore,
                next_hypothesis: nextHypothesis,
                remaining_candidate_count: remainingCandidateCount,
                reentry_signal: reentrySignal,
                goal_achieved: goalAchieved,
                stop_now: goalAchieved,
                auto_closed_hypotheses: autoClosedHypothesisIds,
                suggested_actions: goalAchieved
                    ? ["document_finding", "report"]
                    : nextHypothesis
                      ? [`continue hypothesis ${nextHypothesis.id}`]
                      : ["review findings", "decide next subagent"],
            },
        }
    },
})
