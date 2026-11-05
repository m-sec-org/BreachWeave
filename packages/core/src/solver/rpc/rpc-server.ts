/**
 * Solver RPC server — runs inside the container.
 *
 * Protocol follows pi-coding-agent SDK RPC (rpc-types.ts / rpc-mode.ts):
 *
 * Bootstrap (solver-specific, not part of SDK RPC):
 *   1. Read a single JSONL line from stdin: SolverInitPayload
 *   2. Resolve prompt config → create AgentSession
 *   3. Emit { type: "response", command: "init", success: true }
 *
 * After bootstrap, stdin/stdout follow the SDK RPC protocol exactly:
 *   - stdin:  RpcCommand  (all SDK commands)
 *   - stdout: RpcResponse | AgentSessionEvent
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { createSolverSession } from "../session"
import { retryPendingSolverReview } from "../extension/challenge-observer/observer-loop"
import type { SolverInitPayload, RpcCommand, RpcResponse } from "./rpc-types"
import { serializeJsonLine, attachJsonlLineReader } from "./jsonl"
import { requestHostBridge, resolveHostBridgeResponse } from "../../challenge/host-bridge-client"
import { AUTHORIZED_SOLVER_ENV } from "../../challenge/env"

export interface RunSolverRpcOptions {
    env?: string[]
}

interface ChallengeRpcCompletionState {
    is_completed: boolean
    solver_task_completed?: boolean
    solver_review_pending?: boolean
    solver_resume_required?: boolean
    solver_stop_approved?: boolean
}

interface ChallengeRpcCompletionOptions {
    readCompletion?: () => Promise<ChallengeRpcCompletionState>
    exit?: () => void
    retryDelayMs?: number
    retryPendingReview?: () => Promise<void>
}

interface ChallengeRpcAssignmentState {
    awaitingReview: boolean
    generation: number
    resumedReviewIds: Set<string>
    scheduleRetry: () => void
    cancelRetry?: () => void
}

const CHALLENGE_ASSIGNMENT_STATES = new WeakMap<AgentSession, ChallengeRpcAssignmentState>()

// ── Helpers ──

function output(value: unknown) {
    process.stdout.write(serializeJsonLine(value))
}

function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
    if (data === undefined) return { id, type: "response", command, success: true }
    return { id, type: "response", command, success: true, data }
}

function error(id: string | undefined, command: string, message: string): RpcResponse {
    return { id, type: "response", command, success: false, error: message }
}

function shouldForwardEvent(event: AgentSessionEvent) {
    if (event.type === "message_update") return false
    if (event.type === "tool_execution_update") return event.toolName === "subagent"
    return true
}

function applyEnvPairs(pairs?: string[]) {
    if (!pairs) return
    for (const pair of pairs) {
        const raw = pair.trim()
        if (!raw) continue
        const eqIndex = raw.indexOf("=")
        if (eqIndex <= 0) {
            throw new Error(`invalid --env pair: ${raw}`)
        }
        const key = raw.slice(0, eqIndex).trim()
        const value = raw.slice(eqIndex + 1)
        if (!key) {
            throw new Error(`invalid --env key: ${raw}`)
        }
        process.env[key] = value
    }
}

export function attachChallengeRpcCompletion(
    session: AgentSession,
    init: Pick<SolverInitPayload, "challengeId">,
    options: ChallengeRpcCompletionOptions = {},
): () => void {
    if (!init.challengeId?.trim() || process.env[AUTHORIZED_SOLVER_ENV] === "1") return () => undefined
    const readCompletion = options.readCompletion ?? (() => requestHostBridge<ChallengeRpcCompletionState>("challenge_is_completed", {}))
    const exit = options.exit ?? (() => process.exit(0))
    const retryPendingReview = options.retryPendingReview ?? retryPendingSolverReview
    const state: ChallengeRpcAssignmentState = { awaitingReview: false, generation: 0, resumedReviewIds: new Set(), scheduleRetry }
    CHALLENGE_ASSIGNMENT_STATES.set(session, state)
    let checking = false
    let finished = false

    function scheduleRetry() {
        if (finished || state.cancelRetry || !state.awaitingReview) return
        const timer = setTimeout(() => {
            state.cancelRetry = undefined
            void checkCompletion(true)
        }, options.retryDelayMs ?? 10000)
        timer.unref()
        state.cancelRetry = () => {
            clearTimeout(timer)
            state.cancelRetry = undefined
        }
    }

    async function checkCompletion(retryAudit = false) {
        if (checking || finished) return
        state.cancelRetry?.()
        checking = true
        const generation = state.generation
        try {
            if (retryAudit) await retryPendingReview()
            const completion = await readCompletion()
            // A Planner resume can arrive while the host is answering this check.
            if (generation !== state.generation) return
            if (completion.solver_review_pending === true || completion.solver_stop_approved === true
                || (completion.solver_task_completed === true && completion.solver_resume_required !== true)) {
                state.awaitingReview = true
                session.clearQueue()
            }
            if (completion.solver_stop_approved !== true) return
            if (session.isStreaming || session.isCompacting) return
            finished = true
            session.dispose()
            exit()
        } catch (error) {
            console.error(`[solver] completion check failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            checking = false
            scheduleRetry()
        }
    }

    const unsubscribe = session.subscribe(async (event) => {
        if (event.type === "tool_execution_end" && !event.isError && event.toolName === "challenge_submit_report") {
            const result: unknown = event.result
            if (result && typeof result === "object" && "details" in result) {
                const details = result.details
                if (details && typeof details === "object" && "solver_task_completed" in details && details.solver_task_completed === true) {
                    state.awaitingReview = true
                    state.generation += 1
                    session.clearQueue()
                    scheduleRetry()
                }
            }
        }
        // The Observer's final audit runs before agent_settled. Reporting checklist
        // coverage alone never authorizes exit; only the Planner can approve stop.
        if (event.type === "agent_settled") await checkCompletion()
    })

    return () => {
        finished = true
        state.cancelRetry?.()
        unsubscribe()
        CHALLENGE_ASSIGNMENT_STATES.delete(session)
    }
}

// ── Server ──

export async function runSolverRpc(options?: RunSolverRpcOptions): Promise<never> {
    applyEnvPairs(options?.env)

    // 1. Bootstrap — read init payload (first JSONL line)
    const raw = await new Promise<string>((resolve, reject) => {
        const detach = attachJsonlLineReader(process.stdin, (line) => {
            detach()
            resolve(line)
        })
        process.stdin.on("end", () => reject(new Error("stdin closed before init")))
    })

    let init: SolverInitPayload
    try {
        init = JSON.parse(raw) as SolverInitPayload
    } catch {
        output(error(undefined, "init", `invalid JSON: ${raw.slice(0, 100)}`))
        process.exit(1)
    }
    if (!init.solverId || !init.promptName) {
        output(error(undefined, "init", "missing solverId or promptName"))
        process.exit(1)
    }

    // 2. Create session
    let session: AgentSession
    try {
        const result = await createSolverSession(init)
        session = result.session
    } catch (err) {
        output(error(undefined, "init", err instanceof Error ? err.message : String(err)))
        process.exit(1)
    }

    // 3. Forward events + start initial prompt
    session.subscribe((event: AgentSessionEvent) => {
        if (!shouldForwardEvent(event)) return
        output(event)
    })
    attachChallengeRpcCompletion(session, init)

    output(success(undefined, "init"))

    session.prompt(init.task, { source: "rpc" }).catch((err) => {
        output(error(undefined, "solver", err instanceof Error ? err.message : String(err)))
        if (CHALLENGE_ASSIGNMENT_STATES.get(session)?.awaitingReview) return
        session.dispose()
        process.exit(1)
    })

    // 4. Enter RPC command loop
    attachJsonlLineReader(process.stdin, (line) => {
        void handleInputLine(session, line)
    })

    process.stdin.on("end", () => {
        session.dispose()
        process.exit(0)
    })

    return new Promise(() => {})
}

async function handleInputLine(session: AgentSession, line: string) {
    try {
        const cmd = JSON.parse(line) as RpcCommand
        const response = await handleCommand(session, cmd)
        output(response)
    } catch (e: unknown) {
        output(error(undefined, "parse", `Failed to parse command: ${e instanceof Error ? e.message : String(e)}`))
    }
}

export async function handleCommand(session: AgentSession, cmd: RpcCommand): Promise<RpcResponse> {
    const id = cmd.id
    const assignment = CHALLENGE_ASSIGNMENT_STATES.get(session)
    if (assignment?.awaitingReview && (cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up")) {
        return error(id, cmd.type, "Assignment report submitted; awaiting Observer audit and Planner decision")
    }

    switch (cmd.type) {
        // Prompting
        case "prompt": {
            session.prompt(cmd.message, { streamingBehavior: cmd.streamingBehavior, source: "rpc" }).catch((e: Error) => output(error(id, "prompt", e.message)))
            return success(id, "prompt")
        }

        case "steer": {
            await session.steer(cmd.message)
            return success(id, "steer")
        }

        case "follow_up": {
            await session.followUp(cmd.message)
            return success(id, "follow_up")
        }

        case "resume_assignment": {
            if (assignment?.resumedReviewIds.has(cmd.reviewId)) return success(id, "resume_assignment")
            session.clearQueue()
            if (assignment) {
                assignment.awaitingReview = false
                assignment.generation += 1
                assignment.resumedReviewIds.add(cmd.reviewId)
                assignment.cancelRetry?.()
            }
            const generation = assignment?.generation
            session.sendCustomMessage({
                customType: "planner-assignment-resume",
                content: [{ type: "text", text: cmd.message }],
                display: true,
                details: { reviewId: cmd.reviewId },
            }, { triggerTurn: true }).catch((e: Error) => {
                // sendCustomMessage can reject during preparation or after an entire
                // turn. Never roll back a newer report or Planner decision.
                if (assignment && assignment.generation === generation && CHALLENGE_ASSIGNMENT_STATES.get(session) === assignment) {
                    assignment.awaitingReview = true
                    assignment.resumedReviewIds.delete(cmd.reviewId)
                    assignment.scheduleRetry()
                }
                output(error(id, "resume_assignment", e.message))
            })
            return success(id, "resume_assignment")
        }

        case "abort": {
            await session.abort()
            return success(id, "abort")
        }

        // State
        case "get_state": {
            return success(id, "get_state", {
                model: session.model,
                thinkingLevel: session.thinkingLevel,
                isStreaming: session.isStreaming,
                isCompacting: session.isCompacting,
                steeringMode: session.steeringMode,
                followUpMode: session.followUpMode,
                sessionFile: session.sessionFile,
                sessionId: session.sessionId,
                sessionName: session.sessionName,
                autoCompactionEnabled: session.autoCompactionEnabled,
                messageCount: session.messages.length,
                pendingMessageCount: session.pendingMessageCount,
            })
        }

        // Model
        case "set_model": {
            const models = await session.modelRuntime.getAvailable()
            const model = models.find((m) => m.provider === cmd.provider && m.id === cmd.modelId)
            if (!model) return error(id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`)
            await session.setModel(model)
            return success(id, "set_model", model)
        }

        case "cycle_model": {
            const result = await session.cycleModel()
            return success(id, "cycle_model", result ?? null)
        }

        case "get_available_models": {
            const models = await session.modelRuntime.getAvailable()
            return success(id, "get_available_models", { models })
        }

        // Thinking
        case "set_thinking_level": {
            session.setThinkingLevel(cmd.level)
            return success(id, "set_thinking_level")
        }

        case "cycle_thinking_level": {
            const level = session.cycleThinkingLevel()
            return success(id, "cycle_thinking_level", level ? { level } : null)
        }

        // Queue modes
        case "set_steering_mode": {
            session.setSteeringMode(cmd.mode)
            return success(id, "set_steering_mode")
        }

        case "set_follow_up_mode": {
            session.setFollowUpMode(cmd.mode)
            return success(id, "set_follow_up_mode")
        }

        // Compaction
        case "compact": {
            const result = await session.compact(cmd.customInstructions)
            return success(id, "compact", result)
        }

        case "set_auto_compaction": {
            session.setAutoCompactionEnabled(cmd.enabled)
            return success(id, "set_auto_compaction")
        }

        // Retry
        case "set_auto_retry": {
            session.setAutoRetryEnabled(cmd.enabled)
            return success(id, "set_auto_retry")
        }

        case "abort_retry": {
            session.abortRetry()
            return success(id, "abort_retry")
        }

        // Bash
        case "bash": {
            const result = await session.executeBash(cmd.command)
            return success(id, "bash", result)
        }

        case "abort_bash": {
            session.abortBash()
            return success(id, "abort_bash")
        }

        // Session
        case "get_session_stats": {
            return success(id, "get_session_stats", session.getSessionStats())
        }

        case "export_html": {
            const path = await session.exportToHtml(cmd.outputPath)
            return success(id, "export_html", { path })
        }

        case "get_fork_messages": {
            const messages = session.getUserMessagesForForking()
            return success(id, "get_fork_messages", { messages })
        }

        case "get_last_assistant_text": {
            const text = session.getLastAssistantText()
            return success(id, "get_last_assistant_text", { text })
        }

        case "set_session_name": {
            const name = cmd.name.trim()
            if (!name) return error(id, "set_session_name", "Session name cannot be empty")
            session.setSessionName(name)
            return success(id, "set_session_name")
        }

        // Messages
        case "get_messages": {
            return success(id, "get_messages", { messages: session.messages })
        }

        // Internal bridge response (host -> solver process)
        case "host_bridge_response": {
            resolveHostBridgeResponse(cmd.request_id, cmd.success, cmd.data, cmd.error)
            return success(id, "host_bridge_response")
        }

        default: {
            const unknown = cmd as { type: string }
            return error(id, unknown.type, `Unknown command: ${unknown.type}`)
        }
    }
}
