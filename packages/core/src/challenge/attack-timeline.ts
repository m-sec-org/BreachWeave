import { readdir, stat } from "fs/promises"
import { join, resolve } from "path"
import type { ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "./store"
import type { IdeaRecord, MemoryEntry } from "./memory"
import type { SolverStatsRecord } from "./stats"
import { ARCHIVE_SOLVERS_DIR, SOLVERS_DIR } from "../runtime/types"

export type AttackTimelineLane = "challenge" | "solver" | "observer" | "board" | "submission"

export type AttackTimelineEventKind =
    | "solver_started"
    | "solver_ended"
    | "message"
    | "tool_call"
    | "tool_result"
    | "memory_added"
    | "memory_updated"
    | "idea_added"
    | "idea_updated"
    | "report_submitted"
    | "observer_reminder"

export interface AttackTimelineEvent {
    id: string
    timestamp: number
    challengeId: string
    solverId?: string
    lane: AttackTimelineLane
    kind: AttackTimelineEventKind
    title: string
    summary: string
    payload?: unknown
}

export interface AttackTimelineSnapshot {
    challengeId: string
    updatedAt: string
    events: AttackTimelineEvent[]
}

export interface BuildAttackTimelineInput {
    challengeId: string
    attempts: ChallengeAttemptLogRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    memory: MemoryEntry[]
    ideas: IdeaRecord[]
    solverStats: SolverStatsRecord[]
}

interface JsonlEntry {
    type?: string
    id?: string
    timestamp?: string
    message?: Record<string, unknown>
}

interface ToolCallPart {
    type?: string
    id?: string
    name?: string
    arguments?: unknown
}

const IMPORTANT_TOOL_PREFIXES = ["challenge_", "memory_", "idea_", "send_efficiency_reminder"]
const BOARD_MUTATION_TOOL_NAMES = new Set(["memory_add", "memory_update", "memory_delete", "idea_add", "idea_update", "idea_delete"])

function parseIsoTimestamp(value?: string): number | undefined {
    if (!value) return
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function clipText(value: string, maxChars: number): string {
    const text = value.replace(/\s+/g, " ").trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function safeJson(value: unknown, maxChars = 260): string {
    try {
        return clipText(JSON.stringify(value), maxChars)
    } catch {
        return clipText(String(value), maxChars)
    }
}

function submissionTimelineSummary(submission: ChallengeSubmissionLogRecord): string {
    const asset = submission.asset.replace(/\s+/g, " ").trim()
    const report = submission.report.replace(/\s+/g, " ").trim()
    if (asset && report) return clipText(`${asset} · ${report}`, 280)
    return asset || "测试报告已提交"
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n")
}

function contentToolCalls(content: unknown): ToolCallPart[] {
    if (!Array.isArray(content)) return []
    return content.filter((part): part is ToolCallPart => Boolean(part) && typeof part === "object" && (part as ToolCallPart).type === "toolCall")
}

function messageTimestamp(entry: JsonlEntry, message: Record<string, unknown>): number | undefined {
    const messageValue = message.timestamp
    if (typeof messageValue === "number" && Number.isFinite(messageValue)) return messageValue
    return parseIsoTimestamp(entry.timestamp)
}

function isImportantTool(toolName: string): boolean {
    return IMPORTANT_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}

function resolveObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function extractMemoryEntry(details: unknown): MemoryEntry | undefined {
    const object = resolveObject(details)
    const entry = resolveObject(object?.entry)
    if (typeof entry?.id !== "string") return
    return entry as unknown as MemoryEntry
}

function extractIdeaRecord(details: unknown): IdeaRecord | undefined {
    const object = resolveObject(details)
    const item = resolveObject(object?.item)
    if (typeof item?.id === "string") return item as unknown as IdeaRecord
    const nestedItem = resolveObject(resolveObject(object)?.item)
    if (typeof nestedItem?.id === "string") return nestedItem as unknown as IdeaRecord
    return
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
            .map((entry) => resolve(dir, entry.name))
            .sort()
    } catch {
        return []
    }
}

async function readJsonlEntries(dir: string): Promise<JsonlEntry[]> {
    const files = await listFiles(dir, ".jsonl")
    const entries: JsonlEntry[] = []
    for (const file of files) {
        const text = await Bun.file(file).text().catch(() => "")
        for (const rawLine of text.split("\n")) {
            const line = rawLine.trim()
            if (!line) continue
            try {
                const parsed = JSON.parse(line) as unknown
                if (parsed && typeof parsed === "object") entries.push(parsed as JsonlEntry)
            } catch {
                // Ignore partial or corrupt JSONL lines from interrupted solver runs.
            }
        }
    }
    return entries
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

async function resolveSolverSessionDir(solverId: string): Promise<string | undefined> {
    const active = join(SOLVERS_DIR, solverId, "session")
    if (await isDirectory(active)) return active
    const archived = join(ARCHIVE_SOLVERS_DIR, solverId, "session")
    if (await isDirectory(archived)) return archived
    return
}

function createEvent(input: Omit<AttackTimelineEvent, "id"> & { idParts: string[] }): AttackTimelineEvent {
    return {
        id: input.idParts.join(":"),
        timestamp: input.timestamp,
        challengeId: input.challengeId,
        solverId: input.solverId,
        lane: input.lane,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        payload: input.payload,
    }
}

function buildMessageEvents(challengeId: string, solverId: string, entry: JsonlEntry, observer: boolean): AttackTimelineEvent[] {
    const message = entry.message
    if (!message) return []
    const timestamp = messageTimestamp(entry, message)
    if (!timestamp) return []
    const role = typeof message.role === "string" ? message.role : "message"
    const text = contentText(message.content)
    const events: AttackTimelineEvent[] = []

    if (text && (observer || role === "user" || role === "assistant")) {
        events.push(
            createEvent({
                idParts: ["message", solverId, entry.id ?? `${timestamp}`, `${timestamp}`, role],
                timestamp,
                challengeId,
                solverId,
                lane: observer ? "observer" : "solver",
                kind: "message",
                title: observer ? `Observer ${role}` : `Solver ${role}`,
                summary: clipText(text, 280),
                payload: { entry, message },
            }),
        )
    }

    for (const toolCall of contentToolCalls(message.content)) {
        const toolName = typeof toolCall.name === "string" ? toolCall.name : "tool"
        if (!isImportantTool(toolName)) continue
        events.push(
            createEvent({
                idParts: ["tool-call", solverId, toolCall.id ?? entry.id ?? `${timestamp}`, `${timestamp}`, toolName],
                timestamp,
                challengeId,
                solverId,
                lane: observer ? "observer" : "solver",
                kind: "tool_call",
                title: `Call ${toolName}`,
                summary: safeJson(toolCall.arguments),
                payload: { toolCall, entry },
            }),
        )
    }

    if (role !== "toolResult") return events

    const toolName = typeof message.toolName === "string" ? message.toolName : "tool"
    if (!isImportantTool(toolName)) return events
    const details = message.details
    const isError = message.isError === true
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : entry.id ?? `${timestamp}`
    const textSummary = contentText(message.content) || safeJson(message.content)

    if (toolName.startsWith("memory_") && BOARD_MUTATION_TOOL_NAMES.has(toolName)) {
        const entryPayload = extractMemoryEntry(details)
        events.push(
            createEvent({
                idParts: [toolName, solverId, toolCallId, `${timestamp}`, entryPayload?.id ?? "memory"],
                timestamp,
                challengeId,
                solverId,
                lane: "board",
                kind: toolName === "memory_add" ? "memory_added" : "memory_updated",
                title: toolName === "memory_add" ? "Memory added" : "Memory updated",
                summary: entryPayload ? clipText(entryPayload.content, 280) : clipText(textSummary, 280),
                payload: { entry: entryPayload, toolResult: message },
            }),
        )
        return events
    }

    if (toolName.startsWith("idea_") && BOARD_MUTATION_TOOL_NAMES.has(toolName)) {
        const item = extractIdeaRecord(details)
        events.push(
            createEvent({
                idParts: [toolName, solverId, toolCallId, `${timestamp}`, item?.id ?? "idea"],
                timestamp,
                challengeId,
                solverId,
                lane: "board",
                kind: toolName === "idea_add" ? "idea_added" : "idea_updated",
                title: toolName === "idea_add" ? "Idea added" : "Idea updated",
                summary: item ? clipText(item.content, 280) : clipText(textSummary, 280),
                payload: { item, toolResult: message },
            }),
        )
        return events
    }

    events.push(
            createEvent({
            idParts: ["tool-result", solverId, toolCallId, `${timestamp}`, toolName],
            timestamp,
            challengeId,
            solverId,
            lane: toolName === "challenge_submit_report" ? "submission" : observer ? "observer" : "solver",
            kind: toolName === "send_efficiency_reminder" ? "observer_reminder" : "tool_result",
            title: `${toolName} ${isError ? "failed" : "finished"}`,
            summary: clipText(textSummary, 280),
            payload: { toolResult: message },
        }),
    )
    return events
}

async function buildSolverRuntimeEvents(challengeId: string, solverId: string): Promise<AttackTimelineEvent[]> {
    const sessionDir = await resolveSolverSessionDir(solverId)
    if (!sessionDir) return []
    const [mainEntries, observerEntries] = await Promise.all([
        readJsonlEntries(sessionDir),
        readJsonlEntries(join(sessionDir, ".observer")),
    ])
    const events: AttackTimelineEvent[] = []
    for (const entry of mainEntries) events.push(...buildMessageEvents(challengeId, solverId, entry, false))
    for (const entry of observerEntries) events.push(...buildMessageEvents(challengeId, solverId, entry, true))
    return events
}

export async function buildChallengeAttackTimeline(input: BuildAttackTimelineInput): Promise<AttackTimelineSnapshot> {
    const events: AttackTimelineEvent[] = []
    const seenMemoryIds = new Set<string>()
    const seenIdeaIds = new Set<string>()
    const attemptSolverIds = new Set(input.attempts.map((attempt) => attempt.solver_id).filter(Boolean))

    for (const attempt of input.attempts) {
        const timestamp = parseIsoTimestamp(attempt.created_at)
        if (!timestamp) continue
        events.push(
            createEvent({
                idParts: ["attempt", attempt.id],
                timestamp,
                challengeId: input.challengeId,
                solverId: attempt.solver_id,
                lane: "challenge",
                kind: "solver_started",
                title: "Solver started",
                summary: `${attempt.prompt_name} · ${attempt.solver_id}`,
                payload: { attempt },
            }),
        )
    }

    for (const submission of input.submissions) {
        const timestamp = parseIsoTimestamp(submission.created_at)
        if (!timestamp) continue
        events.push(
            createEvent({
                idParts: ["submission", submission.id],
                timestamp,
                challengeId: input.challengeId,
                solverId: submission.solver_id,
                lane: "submission",
                kind: "report_submitted",
                title: "Report submitted",
                summary: submissionTimelineSummary(submission),
                payload: { submission },
            }),
        )
    }

    for (const stat of input.solverStats) {
        if (!attemptSolverIds.has(stat.solver_id)) continue
        const timestamp = parseIsoTimestamp(stat.ended_at)
        if (!timestamp) continue
        events.push(
            createEvent({
                idParts: ["solver-ended", stat.solver_id],
                timestamp,
                challengeId: input.challengeId,
                solverId: stat.solver_id,
                lane: "solver",
                kind: "solver_ended",
                title: "Solver ended",
                summary: `${stat.prompt_name ?? stat.solver_id} · ${Math.round(stat.duration_ms / 60000)} min`,
                payload: { solverStat: stat },
            }),
        )
    }

    const solverIds = [...attemptSolverIds]
    const solverEvents = await Promise.all(solverIds.map((solverId) => buildSolverRuntimeEvents(input.challengeId, solverId)))
    for (const items of solverEvents) {
        for (const event of items) {
            const payload = resolveObject(event.payload)
            const memoryEntry = extractMemoryEntry(payload?.toolResult ? resolveObject(payload.toolResult)?.details : payload)
            const ideaItem = extractIdeaRecord(payload?.toolResult ? resolveObject(payload.toolResult)?.details : payload)
            if (memoryEntry) seenMemoryIds.add(memoryEntry.id)
            if (ideaItem) seenIdeaIds.add(ideaItem.id)
            events.push(event)
        }
    }

    for (const entry of input.memory) {
        if (seenMemoryIds.has(entry.id)) continue
        const timestamp = parseIsoTimestamp(entry.created_at) ?? parseIsoTimestamp(entry.updated_at)
        if (!timestamp) continue
        events.push(
            createEvent({
                idParts: ["memory-static", entry.id],
                timestamp,
                challengeId: input.challengeId,
                lane: "board",
                kind: "memory_added",
                title: "Memory added",
                summary: clipText(entry.content, 280),
                payload: { entry },
            }),
        )
    }

    for (const item of input.ideas) {
        if (seenIdeaIds.has(item.id)) continue
        const timestamp = parseIsoTimestamp(item.created_at) ?? parseIsoTimestamp(item.updated_at)
        if (!timestamp) continue
        events.push(
            createEvent({
                idParts: ["idea-static", item.id],
                timestamp,
                challengeId: input.challengeId,
                lane: "board",
                kind: "idea_added",
                title: "Idea added",
                summary: clipText(item.content, 280),
                payload: { item },
            }),
        )
    }

    events.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    const idCounts = new Map<string, number>()
    const uniqueEvents = events.map((event) => {
        const count = idCounts.get(event.id) ?? 0
        idCounts.set(event.id, count + 1)
        if (count === 0) return event
        return { ...event, id: `${event.id}:${count + 1}` }
    })
    return {
        challengeId: input.challengeId,
        updatedAt: new Date().toISOString(),
        events: uniqueEvents,
    }
}
