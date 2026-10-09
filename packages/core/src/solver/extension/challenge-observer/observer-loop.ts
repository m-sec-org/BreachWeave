import { buildSessionContext } from "@mariozechner/pi-coding-agent"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { requestHostBridge } from "../../../challenge/host-bridge-client"
import { enqueueObserverReview, loadLatestObserverRoundNumber, loadRecentObserverRounds, persistObserverRound, takeNextObserverReview, updateObserverState } from "./observer-store"
import { runSolverObserverReview } from "./observer-agent"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

const OBSERVER_REVIEW_EVERY_ROUNDS = 6
const OBSERVER_REVIEW_WINDOW_ROUNDS = 10
const OBSERVER_REMINDER_COOLDOWN_ROUNDS = 6
const OBSERVER_REMINDER_REPEAT_WINDOW_ROUNDS = 12
const OBSERVER_REMINDER_ACTIVITY_WINDOW_ROUNDS = 3
const TOOL_ARGS_PREVIEW_CHARS = 160
const TOOL_RESULT_PREVIEW_CHARS = 160
const ASSISTANT_SUMMARY_PREVIEW_CHARS = 220
const SESSION_BASELINE_PREVIEW_CHARS = 600
const SESSION_NOTE_PREVIEW_CHARS = 240
const SESSION_NOTE_LIMIT = 4
const SESSION_DIRECTIVE_LIMIT = 6

interface SessionContextMessageLike {
    role?: unknown
    content?: unknown
}

export function buildObserverExtensionAppendPrompt(): string {
    return [
        "## Observer Sidecar Contract",
        "- 已启用 observer sidecar。observer 会定期审查你最近几轮行为，保守地维护 ideas 和 memory。",
        "- observer 不直接替你解题，也不会替你验证漏洞；它负责整理策略看板和 durable memory，你负责实际验证与推进。",
        "- ideas 看板由 observer 异步维护。你把它当成只读策略板，用来避免重复试错和判断下一步。",
        "- observer 维护的 ideas 只是候选假设。不要把 idea 当结论，必须通过你的实测结果来确认、证伪或推进。",
        "- 如果 observer 新增或更新了某条 idea / memory，先理解其含义，再决定是否立即验证；不要机械照抄，也不要无视。",
        "- observer 的判断也是建议，不是替你下结论；如果它和你当前实测冲突，优先重新验证关键分歧点。",
    ].join("\n")
}

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function normalizeReminderFingerprint(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ")
}

function buildReminderActivityFingerprint(payload: ObserverReviewPayload): string {
    const recentRounds = payload.rounds.slice(-OBSERVER_REMINDER_ACTIVITY_WINDOW_ROUNDS)
    return normalizeReminderFingerprint(
        recentRounds
            .map((round) => [
                `round:${round.round}`,
                `assistant:${round.assistant_summary}`,
                ...round.tool_logs.map((log) => `${log.tool_name}|${log.args_summary}|${log.result_summary}|${log.is_error ? "error" : "ok"}`),
            ])
            .flat()
            .join("\n"),
    )
}

async function isChallengeCompletedByHostBridge(): Promise<boolean> {
    try {
        const result = await requestHostBridge<{ is_completed: boolean }>("challenge_is_completed", {})
        return result.is_completed === true
    } catch {
        return false
    }
}

export interface ObserverReviewOptions {
    observerModel?: string
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
}

// Mode adapter: the observer loop mechanics (round buffering, async review queue, anti-nag)
// are shared; only the id / completion oracle / force-trigger / review runner differ by mode.
export interface ObserverLoopHost {
    getId(): string | undefined
    isComplete(): Promise<boolean>
    forceReviewReason(toolName: string, isError: boolean): ObserverReviewPayload["reason"] | undefined
    runReview(id: string, payload: ObserverReviewPayload, options: ObserverReviewOptions): Promise<{ applied: boolean; summary?: string }>
}

/** Default (CTF) host: host-bridge completion oracle + challenge_get_hint force trigger. */
export function createChallengeObserverHost(): ObserverLoopHost {
    return {
        getId: () => process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim() || undefined,
        isComplete: isChallengeCompletedByHostBridge,
        forceReviewReason: (toolName, isError) => (!isError && toolName === "challenge_get_hint" ? "hint" : undefined),
        runReview: (id, payload, options) => runSolverObserverReview(id, payload, options),
    }
}

async function shouldSendEfficiencyReminder(host: ObserverLoopHost, payload: ObserverReviewPayload, message: string): Promise<boolean> {
    const text = message.trim()
    if (!text) return false
    if (await host.isComplete()) return false

    const currentRound = payload.rounds.at(-1)?.round ?? 0
    const messageFingerprint = normalizeReminderFingerprint(text)
    const activityFingerprint = buildReminderActivityFingerprint(payload)

    return updateObserverState((state) => {
        const lastReminder = state.last_reminder
        const roundsSinceLast = lastReminder ? currentRound - lastReminder.round : Number.POSITIVE_INFINITY
        const sameMessage = lastReminder?.message_fingerprint === messageFingerprint
        const sameActivity = lastReminder?.activity_fingerprint === activityFingerprint
        const withinCooldown = roundsSinceLast < OBSERVER_REMINDER_COOLDOWN_ROUNDS
        const repeatedPattern =
            roundsSinceLast < OBSERVER_REMINDER_REPEAT_WINDOW_ROUNDS && (sameMessage || sameActivity)

        const allowed = !withinCooldown && !repeatedPattern
        return {
            nextState: allowed
                ? {
                      ...state,
                      last_reminder: {
                          sent_at: new Date().toISOString(),
                          round: currentRound,
                          message_fingerprint: messageFingerprint,
                          activity_fingerprint: activityFingerprint,
                      },
                  }
                : state,
            result: allowed,
        }
    })
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function summarizeArgs(value: unknown): string {
    return clipText(safeJsonStringify(value), TOOL_ARGS_PREVIEW_CHARS)
}

function summarizeResult(value: unknown): string {
    if (typeof value === "string") return clipText(value, TOOL_RESULT_PREVIEW_CHARS)
    if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
        const content = (value as { content?: unknown }).content
        if (Array.isArray(content)) {
            const text = content
                .map((block) => {
                    if (!block || typeof block !== "object") return safeJsonStringify(block)
                    if ((block as { type?: unknown }).type === "text") return typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""
                    return safeJsonStringify(block)
                })
                .join("\n")
            return clipText(text, TOOL_RESULT_PREVIEW_CHARS)
        }
    }
    return clipText(safeJsonStringify(value), TOOL_RESULT_PREVIEW_CHARS)
}

function extractAssistantSummary(content: Array<{ type: string; text?: string }> | undefined): string {
    const text = (content ?? [])
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
    return clipText(text, ASSISTANT_SUMMARY_PREVIEW_CHARS)
}

function extractMessageText(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object" && "type" in item)
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim()
}

function normalizeInlineText(text: string): string {
    return text.replace(/\s+/g, " ").trim()
}

function extractStructuredLines(text: string, heading: string): string[] {
    const lines = text.split("\n")
    const start = lines.findIndex((line) => line.trim() === heading)
    if (start < 0) return []

    const items: string[] = []
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i]?.trim() ?? ""
        if (!line) continue
        if (line.endsWith(":")) break
        items.push(line)
    }
    return items
}

function buildBaselineSummary(text: string): string {
    const directives = extractStructuredLines(text, "要求:")
        .map((line) => normalizeInlineText(line.replace(/^[-*]\s*/, "")))
        .filter((line) => line.length > 0)
        .slice(0, SESSION_DIRECTIVE_LIMIT)

    if (directives.length > 0) {
        return ["## Solver Directives", ...directives.map((line) => `- ${clipText(line, SESSION_NOTE_PREVIEW_CHARS)}`)].join("\n")
    }

    return ["## Solver Baseline", clipText(text, SESSION_BASELINE_PREVIEW_CHARS)].join("\n")
}

function buildCompactSessionContext(messages: SessionContextMessageLike[]): string {
    const entries = messages
        .map((message) => ({
            role: message.role,
            text: extractMessageText(message.content),
        }))
        .filter((item) => (item.role === "user" || item.role === "assistant") && item.text.length > 0)

    if (entries.length === 0) return ""

    const baseline = entries.find((item) => item.role === "user")?.text ?? ""
    const recentUserNotes = entries
        .filter((item) => item.role === "user" && item.text !== baseline)
        .slice(-SESSION_NOTE_LIMIT)

    const parts: string[] = []
    if (baseline) {
        parts.push(buildBaselineSummary(baseline))
    }
    if (recentUserNotes.length > 0) {
        if (parts.length > 0) parts.push("")
        parts.push("## Recent User Context")
        for (const item of recentUserNotes) {
            parts.push(`- ${clipText(normalizeInlineText(item.text), SESSION_NOTE_PREVIEW_CHARS)}`)
        }
    }
    return parts.join("\n")
}

function buildObserverPayload(
    ctx: ExtensionContext,
    reason: ObserverReviewPayload["reason"],
    rounds: ObserverRoundPayload[],
): ObserverReviewPayload {
    const entries = ctx.sessionManager.getEntries()
    const sessionContext = buildSessionContext(entries)
    return {
        reason,
        rounds,
        session_context: buildCompactSessionContext(sessionContext.messages),
        branch_entry_count: entries.length,
        message_count: sessionContext.messages.length,
    }
}

export function attachObserverLoop(pi: ExtensionAPI, options: { observerModel?: string; host?: ObserverLoopHost }): void {
    const host = options.host ?? createChallengeObserverHost()
    const id = host.getId()
    if (!id) return
    const idText = id
    let reviewRunning = false

    const roundStateReady = updateObserverState((state) => ({
        nextState: {
            ...state,
            round: Math.max(state.round, 0),
        },
        result: undefined,
    })).then(async () => {
        const latestRound = await loadLatestObserverRoundNumber()
        await updateObserverState((state) => ({
            nextState: {
                ...state,
                round: Math.max(state.round, latestRound),
            },
            result: undefined,
        }))
    })

    async function drainReviewQueue(): Promise<void> {
        if (reviewRunning) return
        reviewRunning = true

        try {
            while (true) {
                const next = await takeNextObserverReview()
                if (!next) return
                try {
                    await host.runReview(idText, next, {
                        observerModel: options.observerModel,
                        sendCorrectionNotice: async (message) => {
                            if (!(await shouldSendEfficiencyReminder(host, next, message))) {
                                return false
                            }
                            pi.sendUserMessage(`纠偏提醒：${message.trim()}`, { deliverAs: "steer" })
                            return true
                        },
                    })
                } catch (error) {
                    console.error(`[observer] review failed: ${error instanceof Error ? error.message : String(error)}`)
                }
            }
        } finally {
            reviewRunning = false
        }
    }

    function enqueueReview(payload: ObserverReviewPayload): void {
        void enqueueObserverReview(payload)
            .then(() => drainReviewQueue())
            .catch((error) => {
                console.error(`[observer] enqueue failed: ${error instanceof Error ? error.message : String(error)}`)
            })
    }

    pi.on("tool_execution_start", async (event) => {
        await roundStateReady
        await updateObserverState((state) => ({
            nextState: {
                ...state,
                tool_args_by_call_id: {
                    ...state.tool_args_by_call_id,
                    [event.toolCallId]: summarizeArgs(event.args),
                },
            },
            result: undefined,
        }))
    })

    pi.on("tool_execution_end", async (event) => {
        await roundStateReady
        await updateObserverState((state) => {
            const nextToolArgsByCallId = { ...state.tool_args_by_call_id }
            const argsSummary = nextToolArgsByCallId[event.toolCallId] ?? ""
            delete nextToolArgsByCallId[event.toolCallId]
            const nextToolLogs: ObserverToolLog[] = [
                ...state.current_round_tool_logs,
                {
                    tool_name: event.toolName,
                    args_summary: argsSummary,
                    result_summary: summarizeResult(event.result),
                    is_error: event.isError,
                },
            ]
            return {
                nextState: {
                    ...state,
                    current_round_tool_logs: nextToolLogs,
                    tool_args_by_call_id: nextToolArgsByCallId,
                    force_review_reason: host.forceReviewReason(event.toolName, event.isError) ?? state.force_review_reason,
                },
                result: undefined,
            }
        })
    })

    pi.on("message_end", async (event, ctx) => {
        if (event.message?.role !== "assistant") return

        await roundStateReady
        const assistantSummary = "content" in event.message ? extractAssistantSummary(event.message.content as Array<{ type: string; text?: string }> | undefined) : ""
        const { roundRecord, reviewReason } = await updateObserverState((state) => {
            const nextRound = state.round + 1
            const roundRecord: ObserverRoundPayload = {
                round: nextRound,
                assistant_summary: assistantSummary,
                tool_logs: state.current_round_tool_logs,
            }
            const periodicDue = nextRound % OBSERVER_REVIEW_EVERY_ROUNDS === 0
            const reviewReason = state.force_review_reason ?? (periodicDue ? "periodic" : undefined)
            return {
                nextState: {
                    ...state,
                    round: nextRound,
                    current_round_tool_logs: [],
                    force_review_reason: undefined,
                },
                result: { roundRecord, reviewReason },
            }
        })
        await persistObserverRound(roundRecord)
        const recentRounds = await loadRecentObserverRounds(OBSERVER_REVIEW_WINDOW_ROUNDS)

        if (!reviewReason) return
        const reviewRounds = recentRounds.slice(-OBSERVER_REVIEW_WINDOW_ROUNDS)
        if (reviewRounds.length === 0) return
        if (!reviewRounds.some((item) => item.tool_logs.length > 0 || item.assistant_summary.trim().length > 0)) return
        enqueueReview(buildObserverPayload(ctx, reviewReason, reviewRounds))
    })

    pi.on("agent_end", async (_event, ctx) => {
        await roundStateReady
        const reviewRounds = await loadRecentObserverRounds(OBSERVER_REVIEW_WINDOW_ROUNDS)
        if (reviewRounds.length === 0) return
        enqueueReview(buildObserverPayload(ctx, "agent_end", reviewRounds))
    })

    void drainReviewQueue()
}
