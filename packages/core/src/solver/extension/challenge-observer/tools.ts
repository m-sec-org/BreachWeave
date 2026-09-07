import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import type { IdeaRecord, IdeaStatus, MemoryEntry, MemoryKind } from "../../../challenge/memory"
import { requestHostBridge } from "../../../challenge/host-bridge-client"
import {
    addSolverBoardIdea,
    appendSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    listSolverBoardMemory,
    searchSolverBoardIdeas,
    updateSolverBoardIdea,
    updateSolverBoardMemory,
} from "../../board-store"
import { formatIdeaTable, formatMemoryTable } from "./board-format"

const EmptyParams = Type.Object({})
const memoryKindToolParam = Type.Union([Type.Literal("fact"), Type.Literal("evidence"), Type.Literal("failure"), Type.Literal("note"), Type.Literal("hint")])
const ideaStatusToolParam = Type.Union([Type.Literal("pending"), Type.Literal("testing"), Type.Literal("verified"), Type.Literal("failed"), Type.Literal("skipped")])

const memoryAddToolParams = Type.Object({
    kind: memoryKindToolParam,
    content: Type.String(),
    refs: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.String()),
    publish_to_challenge: Type.Optional(
        Type.Boolean({
            description:
                "Set true when this memory is a challenge-level fact, evidence, hint, key constraint, or clear failure boundary worth sharing with same-challenge solvers. Omit or false only for solver-local context.",
        }),
    ),
})

const memoryUpdateToolParams = Type.Object({
    entry_id: Type.String(),
    kind: Type.Optional(memoryKindToolParam),
    content: Type.Optional(Type.String()),
    refs: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.String()),
})

const memoryDeleteToolParams = Type.Object({
    entry_id: Type.String(),
})

const ideaAddToolParams = Type.Object({
    content: Type.String({ minLength: 1 }),
    status: Type.Optional(ideaStatusToolParam),
    result: Type.Optional(Type.String()),
    publish_to_challenge: Type.Optional(
        Type.Boolean({
            description:
                "Set true when this idea is a reusable challenge-level attack direction, key hint, or clear failure boundary worth sharing with same-challenge solvers. Omit or false only for solver-local hypotheses.",
        }),
    ),
})

const ideaSearchToolParams = Type.Object({
    query: Type.String(),
})

const querySolverHistoryToolParams = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
})

const steerToolParams = Type.Object({
    message: Type.String({ minLength: 1 }),
})

const ideaUpdateToolParams = Type.Object({
    idea_id: Type.String(),
    status: ideaStatusToolParam,
    result: Type.Optional(Type.String()),
})

type MemoryAddToolInput = Static<typeof memoryAddToolParams> & { kind: MemoryKind }
type MemoryUpdateToolInput = Static<typeof memoryUpdateToolParams> & { kind?: MemoryKind }
type MemoryDeleteToolInput = Static<typeof memoryDeleteToolParams>
type IdeaSearchToolInput = Static<typeof ideaSearchToolParams>
type QuerySolverHistoryToolInput = Static<typeof querySolverHistoryToolParams>
type IdeaAddToolInput = Static<typeof ideaAddToolParams>
type SteerToolInput = Static<typeof steerToolParams>
type IdeaUpdateToolInput = Static<typeof ideaUpdateToolParams> & { status: IdeaStatus }

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function formatMemoryMutation(action: "added" | "updated" | "deleted", entry: MemoryEntry): string {
    return `${action} memory [${entry.kind}] ${entry.id}: ${clipText(entry.content, 160)}`
}

function formatIdeaMutation(action: "added" | "updated", item: IdeaRecord): string {
    const result = item.result.trim()
    return `${action} idea [${item.status}] ${item.id}: ${clipText(item.content, 140)}${result ? ` -> ${clipText(result, 160)}` : ""}`
}

function formatLayeredMemoryTable(localItems: MemoryEntry[], challengeItems: MemoryEntry[]): string {
    return [
        "## Solver Local Memory",
        formatMemoryTable(localItems),
        "",
        "## Challenge Memory",
        formatMemoryTable(challengeItems, { updatedAtFallback: true }),
    ].join("\n")
}

function formatLayeredIdeaTable(localItems: IdeaRecord[], challengeItems: IdeaRecord[]): string {
    return [
        "## Solver Local Ideas",
        formatIdeaTable(localItems),
        "",
        "## Challenge Ideas",
        formatIdeaTable(challengeItems, { updatedAtFallback: true }),
    ].join("\n")
}

async function listChallengeMemoryLayer(): Promise<MemoryEntry[]> {
    try {
        const result = await requestHostBridge<{ items: MemoryEntry[] }>("challenge_memory_list", {})
        return Array.isArray(result.items) ? result.items : []
    } catch {
        return []
    }
}

async function listChallengeIdeaLayer(): Promise<IdeaRecord[]> {
    try {
        const result = await requestHostBridge<{ items: IdeaRecord[] }>("challenge_idea_list", {})
        return Array.isArray(result.items) ? result.items : []
    } catch {
        return []
    }
}

async function searchChallengeIdeaLayer(query: string): Promise<IdeaRecord[]> {
    try {
        const result = await requestHostBridge<{ items: IdeaRecord[] }>("challenge_idea_search", { query })
        return Array.isArray(result.items) ? result.items : []
    } catch {
        return []
    }
}

interface SolverHistoryRecord {
    kind: "user" | "assistant" | "tool"
    entry_id: string
    timestamp: string
    summary: string
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function extractTextBlocks(content: unknown): string[] {
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content
        .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text.trim())
        .filter((item) => item.length > 0)
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: string }> {
    if (!Array.isArray(content)) return []
    return content
        .filter((item): item is { type?: unknown; name?: unknown; arguments?: unknown } => !!item && typeof item === "object")
        .filter((item): item is { type: "toolCall"; name: string; arguments?: unknown } => item.type === "toolCall" && typeof item.name === "string")
        .map((item) => ({
            name: item.name,
            arguments: clipText(safeJsonStringify(item.arguments ?? {}), 160),
        }))
}

function extractToolResultSummary(message: Record<string, unknown>): string {
    const text = extractTextBlocks(message.content).join("\n").trim()
    if (text) return clipText(text, 240)
    return clipText(safeJsonStringify(message.content ?? ""), 240)
}

function buildSolverHistoryRecords(entries: unknown[]): SolverHistoryRecord[] {
    const records: SolverHistoryRecord[] = []

    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        if ((entry as { type?: unknown }).type !== "message") continue

        const message = (entry as { message?: unknown }).message
        if (!message || typeof message !== "object") continue

        const entryId = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : "-"
        const timestamp =
            typeof (entry as { timestamp?: unknown }).timestamp === "string" ? (entry as { timestamp: string }).timestamp : "-"
        const role = (message as { role?: unknown }).role

        if (role === "assistant") {
            const assistantText = extractTextBlocks((message as { content?: unknown }).content).join("\n").trim()
            const toolCalls = extractToolCalls((message as { content?: unknown }).content)
            const summaryLines: string[] = []
            if (assistantText) {
                summaryLines.push(`assistant: ${clipText(assistantText, 240)}`)
            }
            for (const toolCall of toolCalls) {
                summaryLines.push(`tool_call: ${toolCall.name} ${toolCall.arguments}`)
            }
            if (summaryLines.length > 0) {
                records.push({
                    kind: "assistant",
                    entry_id: entryId,
                    timestamp,
                    summary: summaryLines.join("\n"),
                })
            }
            continue
        }

        if (role === "user") {
            const userText = extractTextBlocks((message as { content?: unknown }).content).join("\n").trim()
            if (!userText) continue
            records.push({
                kind: "user",
                entry_id: entryId,
                timestamp,
                summary: `user: ${clipText(userText, 240)}`,
            })
            continue
        }

        if (role === "toolResult") {
            const toolName = typeof (message as { toolName?: unknown }).toolName === "string" ? (message as { toolName: string }).toolName : "tool"
            const resultSummary = extractToolResultSummary(message as Record<string, unknown>)
            records.push({
                kind: "tool",
                entry_id: entryId,
                timestamp,
                summary: `tool_result: ${toolName}\nresult: ${resultSummary}`,
            })
        }
    }

    return records
}

function formatSolverHistory(records: SolverHistoryRecord[], totalEntries: number, offset: number): string {
    if (records.length === 0) {
        return ["## Solver History", `- total: ${totalEntries}`, "- showing: none"].join("\n")
    }

    return [
        "## Solver History",
        `- total: ${totalEntries}`,
        `- showing: ${offset + 1}-${offset + records.length}`,
        "",
        ...records.map((record, index) =>
            [`### ${offset + index + 1}. ${record.kind}`, `- entry_id: ${record.entry_id}`, `- timestamp: ${record.timestamp}`, record.summary].join("\n"),
        ),
    ].join("\n")
}

const observerSidecarBoardTools = [
    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "List current durable memory entries. Use first, and re-check before deleting or merging entries.",
        promptSnippet: "memory_list: inspect current durable memory before curating it",
        parameters: EmptyParams,
        async execute() {
            const [items, challengeItems] = await Promise.all([listSolverBoardMemory(), listChallengeMemoryLayer()])
            return {
                content: [{ type: "text", text: formatLayeredMemoryTable(items, challengeItems) }],
                details: { items, challenge_items: challengeItems },
            }
        },
    }),
    defineTool({
        name: "memory_add",
        label: "Memory Add",
        description: "Add one durable memory entry. Use only for facts, evidence, failure boundaries, hints, or important constraints worth keeping.",
        promptSnippet: "memory_add: add durable fact/evidence/failure/hint/constraint",
        parameters: memoryAddToolParams,
        async execute(_toolCallId, params: MemoryAddToolInput) {
            const source = params.source?.trim() || "observer"
            const entry = await appendSolverBoardMemory({
                kind: params.kind,
                content: params.content,
                refs: params.refs ?? [],
                source,
            })
            const challengeEntry =
                params.publish_to_challenge === true
                    ? (
                          await requestHostBridge<{ entry: MemoryEntry }>("challenge_memory_add", {
                              kind: params.kind,
                              content: params.content,
                              refs: params.refs ?? [],
                              ...(params.source?.trim() ? { source } : {}),
                          })
                      ).entry
                    : undefined
            return {
                content: [
                    {
                        type: "text",
                        text: challengeEntry
                            ? `${formatMemoryMutation("added", entry)}\npublished challenge memory ${challengeEntry.id}`
                            : formatMemoryMutation("added", entry),
                    },
                ],
                details: { entry, ...(challengeEntry ? { challenge_entry: challengeEntry } : {}) },
            }
        },
    }),
    defineTool({
        name: "memory_update",
        label: "Memory Update",
        description: "Update one memory entry by id or id prefix. Use when a memory entry should be tightened, merged, or rewritten into a stronger durable conclusion.",
        promptSnippet: "memory_update: tighten or merge an existing memory entry",
        parameters: memoryUpdateToolParams,
        async execute(_toolCallId, params: MemoryUpdateToolInput) {
            const entry = await updateSolverBoardMemory(params.entry_id, {
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.refs !== undefined ? { refs: params.refs } : {}),
                ...(params.source !== undefined ? { source: params.source } : {}),
            })
            return {
                content: [{ type: "text", text: formatMemoryMutation("updated", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "memory_delete",
        label: "Memory Delete",
        description: "Delete one memory entry by id or id prefix. Use for duplicates, low-value action logs, stale entries, or memory superseded by a stronger record.",
        promptSnippet: "memory_delete: remove duplicate, noisy, stale, or superseded memory",
        parameters: memoryDeleteToolParams,
        async execute(_toolCallId, params: MemoryDeleteToolInput) {
            const entry = await deleteSolverBoardMemory(params.entry_id)
            return {
                content: [{ type: "text", text: formatMemoryMutation("deleted", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "List current strategy ideas. Use first to inspect the existing attack hypothesis board.",
        promptSnippet: "idea_list: inspect current attack hypotheses before curation",
        parameters: EmptyParams,
        async execute() {
            const [items, challengeItems] = await Promise.all([listSolverBoardIdeas(), listChallengeIdeaLayer()])
            return {
                content: [{ type: "text", text: formatLayeredIdeaTable(items, challengeItems) }],
                details: { items, challenge_items: challengeItems },
            }
        },
    }),
    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "Search strategy ideas by keyword. Use before adding a new idea to avoid near-duplicate attack hypotheses.",
        promptSnippet: "idea_search: check whether a similar attack hypothesis already exists",
        parameters: ideaSearchToolParams,
        async execute(_toolCallId, params: IdeaSearchToolInput) {
            const [items, challengeItems] = await Promise.all([searchSolverBoardIdeas(params.query), searchChallengeIdeaLayer(params.query)])
            return {
                content: [{ type: "text", text: formatLayeredIdeaTable(items, challengeItems) }],
                details: { query: params.query, items, challenge_items: challengeItems },
            }
        },
    }),
    defineTool({
        name: "idea_add",
        label: "Idea Add",
        description: "Add one strategy idea. You can set status/result at creation time. Use only for concrete attack hypotheses, not for observations or completed actions.",
        promptSnippet: "idea_add: add one concrete attack hypothesis with optional status/result",
        parameters: ideaAddToolParams,
        async execute(_toolCallId, params: IdeaAddToolInput) {
            const result = await addSolverBoardIdea({
                content: params.content,
                status: params.status,
                result: params.result ?? "",
            })
            const challengeResult =
                params.publish_to_challenge === true
                    ? await requestHostBridge<{ created: boolean; item: IdeaRecord }>("challenge_idea_add", {
                          content: params.content,
                          ...(params.status ? { status: params.status } : {}),
                          result: params.result ?? "",
                      })
                    : undefined
            return {
                content: [
                    {
                        type: "text",
                        text: challengeResult
                            ? `${formatIdeaMutation("added", result.item)}\npublished challenge idea ${challengeResult.item.id}`
                            : formatIdeaMutation("added", result.item),
                    },
                ],
                details: {
                    ...result,
                    ...(challengeResult ? { challenge_created: challengeResult.created, challenge_item: challengeResult.item } : {}),
                },
            }
        },
    }),
    defineTool({
        name: "idea_update",
        label: "Idea Update",
        description: "Update one strategy idea status and result by id or id prefix. Use when a hypothesis starts testing or reaches verified/failed/skipped.",
        promptSnippet: "idea_update: advance hypothesis lifecycle and record result",
        parameters: ideaUpdateToolParams,
        async execute(_toolCallId, params: IdeaUpdateToolInput) {
            const item = await updateSolverBoardIdea(params.idea_id, {
                status: params.status,
                result: params.result ?? "",
            })
            return {
                content: [{ type: "text", text: formatIdeaMutation("updated", item) }],
                details: { item },
            }
        },
    }),
]

export function createObserverSidecarTools(sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean) {
    return createObserverSidecarToolsWithOptions({ sendCorrectionNotice })
}

export function createObserverSidecarToolsWithOptions(options?: {
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
    getSolverEntries?: () => Promise<unknown[]> | unknown[]
}) {
    const sendCorrectionNotice = options?.sendCorrectionNotice
    const getSolverEntries = options?.getSolverEntries
    return [
        ...observerSidecarBoardTools,
        defineTool({
            name: "query_solver_history",
            label: "Query Solver History",
            description:
                "Inspect recent solver history when compressed context is insufficient. Pages through user instructions, assistant outputs, tool calls, and tool results.",
            promptSnippet:
                "query_solver_history: page through recent user instructions, assistant outputs, and tool activity when compressed context is insufficient",
            parameters: querySolverHistoryToolParams,
            async execute(_toolCallId, params: QuerySolverHistoryToolInput, _signal, _onUpdate, ctx) {
                const baseEntries = (await getSolverEntries?.()) ?? ctx.sessionManager.getEntries()
                const records = buildSolverHistoryRecords(baseEntries).reverse()
                const offset = params.offset ?? 0
                const limit = params.limit ?? 8
                const slice = records.slice(offset, offset + limit)
                return {
                    content: [{ type: "text", text: formatSolverHistory(slice, records.length, offset) }],
                    details: {
                        total_entries: records.length,
                        returned_count: slice.length,
                    },
                }
            },
        }),
        defineTool({
            name: "send_efficiency_reminder",
            label: "Efficiency Reminder",
            description:
                "Send one short efficiency reminder only when the solver is clearly and persistently stuck in a low-efficiency mode. If the solver cannot make further breakthrough and already has reportable evidence, verified findings, or clear failure boundaries, you may remind it to consider submitting a report. Do not interrupt healthy ongoing work, and do not use this as a substitute for ideas or memory.",
            promptSnippet:
                "send_efficiency_reminder: use sparingly for persistent low-efficiency behavior; if no further breakthrough is likely, remind the solver it may submit a report with current evidence/failure boundaries",
            parameters: steerToolParams,
            async execute(_toolCallId, params: SteerToolInput) {
                const delivered = (await sendCorrectionNotice?.(params.message)) !== false
                return {
                    content: [
                        {
                            type: "text",
                            text: delivered
                                ? `sent efficiency reminder: ${clipText(params.message, 200)}`
                                : `suppressed efficiency reminder: ${clipText(params.message, 200)}`,
                        },
                    ],
                    details: { delivered, message: params.message },
                }
            },
        }),
    ]
}

export const challengeObserverAgentTools = [
    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "List durable memory. Use at the start, after compaction, or before retrying a line of attack when context may be stale.",
        promptSnippet: "memory_list: review durable facts/evidence/failures before choosing next step",
        parameters: EmptyParams,
        async execute() {
            const [items, challengeItems] = await Promise.all([listSolverBoardMemory(), listChallengeMemoryLayer()])
            return {
                content: [{ type: "text", text: formatLayeredMemoryTable(items, challengeItems) }],
                details: { items, challenge_items: challengeItems },
            }
        },
    }),
    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "List current attack hypotheses. Use it as read-only input before choosing or switching direction.",
        promptSnippet: "idea_list: review current attack hypotheses before choosing direction",
        parameters: EmptyParams,
        async execute() {
            const [items, challengeItems] = await Promise.all([listSolverBoardIdeas(), listChallengeIdeaLayer()])
            return {
                content: [{ type: "text", text: formatLayeredIdeaTable(items, challengeItems) }],
                details: { items, challenge_items: challengeItems },
            }
        },
    }),
    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "Search current attack hypotheses by keyword before retrying a specific vector such as SQLi, upload, SSRF, RCE, format string, or overflow.",
        promptSnippet: "idea_search: check whether this vector is already on the current board",
        parameters: ideaSearchToolParams,
        async execute(_toolCallId, params: IdeaSearchToolInput) {
            const [items, challengeItems] = await Promise.all([searchSolverBoardIdeas(params.query), searchChallengeIdeaLayer(params.query)])
            return {
                content: [{ type: "text", text: formatLayeredIdeaTable(items, challengeItems) }],
                details: { query: params.query, items, challenge_items: challengeItems },
            }
        },
    }),
]
