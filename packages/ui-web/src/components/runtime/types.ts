import type { IdeaRecord, MemoryEntry } from "../../lib/api"

export interface AgentPromptView {
    name: string
    meta: {
        subagents?: string[]
    }
}

export interface RuntimeSolverView {
    id: string
    name: string
    promptName: string
    task: string
    status: string
    createdAt: number
    challengeId?: string
    error?: string
}

export interface RuntimeThreadView {
    id: string
    kind: "main" | "subagent" | "observer"
    label: string
    parentToolCallId?: string
    promptName?: string
    task?: string
    sessionId?: string
    createdAt?: number
    messages: Record<string, unknown>[]
}

export interface RuntimeDetailsView {
    solver: RuntimeSolverView
    threads: RuntimeThreadView[]
    memory: MemoryEntry[]
    ideas: IdeaRecord[]
}

export interface RuntimeStatusView {
    docker: boolean
    solvers: number
}

export interface RuntimeAgentEvent {
    type: string
    message?: Record<string, unknown>
    toolCallId?: string
    toolName?: string
    args?: unknown
    partialResult?: unknown
    result?: unknown
    isError?: boolean
    timestamp?: number
}

export interface SubagentResultView {
    agent?: string
    task?: string
    messages?: Record<string, unknown>[]
    step?: number
}

export const statusColors: Record<string, string> = {
    starting: "text-amber-500",
    running: "text-emerald-500",
    stopping: "text-orange-500",
    stopped: "text-zinc-400",
    error: "text-red-500",
}

export function isLiveStatus(status: string) {
    return status === "starting" || status === "running" || status === "stopping"
}

export function formatDateTime(value?: number) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function firstMessageTimestamp(messages: Record<string, unknown>[] | undefined): number | undefined {
    const first = messages?.find((message) => typeof (message as { timestamp?: unknown }).timestamp === "number") as
        | { timestamp?: number }
        | undefined
    return first?.timestamp
}

export function applyAgentEvent(details: RuntimeDetailsView, event: RuntimeAgentEvent) {
    if (event.type === "message_end" && event.message) {
        return {
            ...details,
            threads: details.threads.map((thread) => (thread.kind === "main" ? { ...thread, messages: [...thread.messages, event.message!] } : thread)),
        }
    }

    const toolResultMessage = buildToolResultMessage(event)
    if (!toolResultMessage) return details

    return {
        ...details,
        threads: details.threads.map((thread) => {
            if (thread.kind !== "main") return thread
            return {
                ...thread,
                messages: upsertToolResultMessage(thread.messages, toolResultMessage),
            }
        }),
    }
}

function buildToolResultMessage(event: RuntimeAgentEvent): Record<string, unknown> | undefined {
    if (event.type !== "tool_execution_end") return
    if (!event.toolCallId || !event.toolName) return

    const payload = event.result
    const details =
        payload && typeof payload === "object" && "details" in payload ? (payload as { details?: unknown }).details : undefined

    return {
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(payload),
        details,
        isError: event.isError === true,
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
    }
}

function normalizeToolResultContent(payload: unknown): Record<string, unknown>[] {
    if (payload && typeof payload === "object" && "content" in payload) {
        const content = (payload as { content?: unknown }).content
        if (Array.isArray(content)) {
            return content.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        }
    }

    if (typeof payload === "string" && payload.trim()) {
        return [{ type: "text", text: payload }]
    }

    if (payload == null) return []

    try {
        return [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    } catch {
        return [{ type: "text", text: String(payload) }]
    }
}

function upsertToolResultMessage(messages: Record<string, unknown>[], nextMessage: Record<string, unknown>) {
    const toolCallId = typeof nextMessage.toolCallId === "string" ? nextMessage.toolCallId : ""
    if (!toolCallId) return [...messages, nextMessage]

    const index = messages.findIndex(
        (message) => message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId === toolCallId,
    )
    if (index < 0) return [...messages, nextMessage]

    const merged = [...messages]
    merged[index] = {
        ...merged[index],
        ...nextMessage,
    }
    return merged
}

function getSubagentResults(event: RuntimeAgentEvent) {
    if (event.toolName !== "subagent") return []
    const payload = event.type === "tool_execution_update" ? event.partialResult : event.type === "tool_execution_end" ? event.result : undefined
    if (!payload || typeof payload !== "object") return []
    const details = "details" in payload ? (payload as { details?: unknown }).details : undefined
    if (!details || typeof details !== "object") return []
    const results = "results" in details ? (details as { results?: unknown }).results : undefined
    if (!Array.isArray(results)) return []
    return results as SubagentResultView[]
}

function subagentThreadLabel(event: RuntimeAgentEvent, result: SubagentResultView, index: number) {
    return `${result.agent ?? "subagent"}-${event.toolCallId}${result.step !== undefined ? `-${result.step}` : `-${index + 1}`}`
}

function mergeThreadMessages(current: Record<string, unknown>[], incoming: Record<string, unknown>[]) {
    if (incoming.length === 0) return current
    if (current.length === 0) return incoming

    const seen = new Set(current.map((message) => JSON.stringify(message)))
    const merged = [...current]
    for (const message of incoming) {
        const key = JSON.stringify(message)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(message)
    }
    return merged
}

export function mergeSubagentThreads(details: RuntimeDetailsView, event: RuntimeAgentEvent) {
    const results = getSubagentResults(event)
    if (results.length === 0 || !event.toolCallId) return details

    const nextThreads = [...details.threads]
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        const label = subagentThreadLabel(event, result, index)
        const incomingMessages = result.messages ?? []
        const existingIndex = nextThreads.findIndex(
            (thread) => thread.kind === "subagent" && thread.parentToolCallId === event.toolCallId && thread.label === label,
        )
        const existing = existingIndex >= 0 ? nextThreads[existingIndex] : undefined
        const mergedMessages = mergeThreadMessages(existing?.messages ?? [], incomingMessages)
        const nextThread: RuntimeThreadView = {
            id: `${details.solver.id}:subagent:${label}`,
            kind: "subagent",
            label,
            parentToolCallId: event.toolCallId,
            promptName: result.agent,
            task: result.task,
            createdAt: existing?.createdAt ?? firstMessageTimestamp(incomingMessages),
            messages: mergedMessages,
        }
        if (existingIndex >= 0) nextThreads[existingIndex] = nextThread
        else nextThreads.push(nextThread)
    }

    nextThreads.sort((a, b) => {
        if (a.kind === "main") return -1
        if (b.kind === "main") return 1
        return a.label.localeCompare(b.label)
    })

    return {
        ...details,
        threads: nextThreads,
    }
}
