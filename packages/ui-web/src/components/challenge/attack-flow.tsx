import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react"
import { createElement, startTransition, useEffect, useMemo, useRef, useState } from "react"
import type { Edge, EdgeProps, Node, NodeMouseHandler, NodeTypes } from "@xyflow/react"
import { Background, BaseEdge, Controls, EdgeLabelRenderer, MarkerType, MiniMap, Position, ReactFlow, applyNodeChanges, getBezierPath, useReactFlow } from "@xyflow/react"
import { BellIcon, BotIcon, DatabaseIcon, FlagIcon, LightbulbIcon, Maximize2Icon, Minimize2Icon, PauseIcon, PlayIcon, RotateCcwIcon, SendIcon, TargetIcon } from "lucide-react"
import { challenges, eventSourceUrl, runtime } from "../../lib/api"
import type { AttackTimelineEvent, AttackTimelineSnapshot, ChallengeInfoRecord, IdeaRecord, MemoryEntry } from "../../lib/api"
import type { ElkDirection } from "../../lib/elk-layout"
import { layoutFlowElements } from "../../lib/elk-layout"
import type { RuntimeDetailsView, RuntimeThreadView } from "../runtime/types"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent } from "../ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { cn } from "../../lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import i18n from "../../i18n"
import { Checkbox } from "../ui/checkbox"
import { useSidebar } from "../ui/sidebar"
import type { ExecutionOverviewData } from "../../data/executionOverview"
import { ExecutionOverview } from "../ui/execution-overview"
import { buildExecutionOverviewFromTimeline } from "../../lib/execution-overview-from-timeline"
import { timelineEventTitle } from "../../lib/timeline-event-title"
import { keyTimelineEvents, promptNameFromEvent, solverMetasFromEvents } from "../../lib/timeline-key-events"
import { buildSolverCardData } from "../../lib/solver-event-card-data"
import { COMMUNICATION_NODE_TYPES } from "./communication-flow-nodes"
import { SOLVER_AGENT_NODE_HEIGHT, SOLVER_AGENT_NODE_WIDTH, type SolverAgentNodeData } from "./solver-agent-node"
import goalAchievedMatrixBg from "../../assets/goal-achieved-matrix-bg.png"

type AttackFlowTab = "attack-path" | "memory-path" | "solver-agent-collaboration" | "aggregate-view"

type KnowledgeGroup = "task" | "memory-failure" | "memory-evidence" | "memory-fact" | "memory-hint" | "memory-note" | "idea-active"
type FlowNode = Node<
    {
        label?: ReactNode
        solverId?: string
        eventId?: string
        rawId?: string
        graphRole?: "task" | "memory" | "idea"
        knowledgeGroup?: KnowledgeGroup
        knowledgeRecord?: MemoryEntry | IdeaRecord
    } & Partial<SolverAgentNodeData>
>
type FlowLayoutMode = "elk" | "mindmap" | "collaboration"
type FlowGraph = { nodes: FlowNode[]; edges: Edge[]; layoutEdges?: Edge[] }

export function layoutCollaborationFlowElements(
    nodes: FlowNode[],
    edges: Edge[],
    options: { spacing: number; layerSpacing: number; nodeWidth: number; nodeHeight: number },
): { nodes: FlowNode[]; edges: Edge[] } {
    const visibleNodes = nodes.filter((node) => !node.hidden)
    const rootNode = visibleNodes.find((node) => node.id === "topology:task") ?? visibleNodes[0]
    const childNodes = visibleNodes.filter((node) => node.id !== rootNode?.id)
    const rootHeight = rootNode?.height ?? CHALLENGE_NODE_HEIGHT
    const rootWidth = rootNode?.width ?? CHALLENGE_NODE_WIDTH
    const midpoint = Math.ceil(childNodes.length / 2)
    const aboveNodes = childNodes.slice(0, midpoint)
    const belowNodes = childNodes.slice(midpoint)
    const positioned = new Map<string, FlowNode>()

    function placeRow(items: FlowNode[], y: number, side: "above" | "below") {
        if (items.length === 0) return

        const gap = options.spacing
        const widths = items.map((node) => node.width ?? options.nodeWidth)
        const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, items.length - 1)
        let x = -totalWidth / 2

        items.forEach((node, index) => {
            positioned.set(node.id, {
                ...node,
                position: { x, y },
                sourcePosition: side === "above" ? Position.Top : Position.Bottom,
                targetPosition: side === "above" ? Position.Bottom : Position.Top,
            })
            x += widths[index] + gap
        })
    }

    if (rootNode) {
        positioned.set(rootNode.id, {
            ...rootNode,
            position: { x: -rootWidth / 2, y: 0 },
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
        })
    }

    const childHeight = options.nodeHeight
    placeRow(aboveNodes, -(options.layerSpacing + childHeight), "above")
    placeRow(belowNodes, rootHeight + options.layerSpacing, "below")

    const rootY = positioned.get("topology:task")?.position.y ?? 0
    const layoutedEdges = edges.map((edge) => {
        if (edge.source !== "topology:task") return edge
        const targetNode = positioned.get(edge.target)
        if (!targetNode) return edge
        const isAbove = targetNode.position.y < rootY
        return {
            ...edge,
            sourceHandle: isAbove ? "top" : "bottom",
            targetHandle: isAbove ? "bottom" : "top",
        }
    })

    return {
        nodes: nodes.map((node) => positioned.get(node.id) ?? { ...node, position: { x: 0, y: 0 } }),
        edges: layoutedEdges,
    }
}

function GoalAchievedEdgeLabel(props: { text: string; left: number; top: number }) {
    const { text, left, top } = props

    return (
        <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${left}px`, top: `${top}px` }}
        >
            <div
                className="
                    relative inline-flex h-11 max-w-[360px] items-center rounded-xl
                    border border-amber-500/70
                    bg-amber-50/95 px-5
                    text-sm font-semibold text-amber-950
                    shadow-[0_0_18px_rgba(251,191,36,0.45),inset_0_0_12px_rgba(251,191,36,0.12)]
                    dark:border-amber-400/90 dark:bg-[#071624]/95 dark:text-white
                "
            >
                <div className="pointer-events-none absolute inset-0 rounded-xl bg-amber-400/5" />
                <div className="absolute left-3 right-3 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/80 to-transparent" />
                <div className="absolute bottom-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-amber-500/70 to-transparent" />
                <span className="relative z-10 truncate drop-shadow-[0_0_6px_rgba(255,255,255,0.25)]">{text}</span>
            </div>
        </div>
    )
}

function GoalAchievedTaskMatrixBackground() {
    return (
        <img
            src={goalAchievedMatrixBg}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right opacity-10 dark:opacity-100"
        />
    )
}

function GoalAchievedTaskLabel(props: { title: string; summary: string }) {
    const { title, summary } = props

    return (
        <div className="relative h-full w-full overflow-hidden rounded-2xl border border-red-500/70 bg-red-50 px-3 py-2 shadow-[0_0_28px_rgba(239,68,68,0.18)] dark:bg-[#071624] dark:shadow-[0_0_28px_rgba(239,68,68,0.28)]">
            <div className="absolute inset-0 bg-gradient-to-br from-red-50 via-white to-slate-50 dark:from-[#071624] dark:via-[#081827] dark:to-[#0a101a]" />
            <GoalAchievedTaskMatrixBackground />

            <div className="absolute inset-0 opacity-30">
                <div className="absolute left-0 top-1/3 h-px w-full bg-red-400/60" />
                <div className="absolute left-0 top-2/3 h-px w-full bg-red-500/30" />
            </div>

            <div className="relative z-10 flex items-start gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-red-400/50 bg-red-500/10 text-red-300 shadow-[0_0_16px_rgba(239,68,68,0.35)]">
                    <TargetIcon className="size-3.5" />
                </div>

                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-xs font-bold tracking-wide text-slate-950 dark:text-white dark:drop-shadow-[0_0_8px_rgba(255,255,255,0.25)]">
                        {title}
                    </h3>
                    <p className="mt-1 truncate text-[11px] font-medium leading-snug text-slate-700 dark:text-slate-100">{summary}</p>
                </div>
            </div>

            <div className="pointer-events-none absolute inset-0 rounded-2xl shadow-[inset_0_0_28px_rgba(239,68,68,0.16)]" />
        </div>
    )
}

function EventFlowEdge(props: EdgeProps) {
    const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label } = props
    const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    const pathId = `${id}-path`
    const data = (props.data as { particleColor?: string; active?: boolean; direction?: "forward" | "reverse" } | undefined) ?? {}
    const particleColor = data.particleColor ?? "var(--flow-selected-ring)"
    const active = data.active === true
    const reverse = data.direction === "reverse"

    const rawLabel = label ? String(label) : ""
    const labelText = rawLabel ? clip(rawLabel, 72) : ""
    const goalAchievedLabel = isGoalAchievedText(rawLabel)

    return (
        <g>
            <path
                id={pathId}
                d={edgePath}
                fill="none"
                style={{
                    stroke: style?.stroke ?? "var(--flow-edge-default)",
                    strokeWidth: active ? 2.2 : 1.3,
                    strokeOpacity: active ? 0.95 : 0.55,
                    strokeDasharray: active ? "10 8" : style?.strokeDasharray,
                }}
                markerEnd={active && !reverse ? markerEnd : undefined}
                markerStart={active && reverse ? markerEnd : undefined}
            >
                {active ? <animate attributeName="stroke-dashoffset" dur="1.4s" repeatCount="indefinite" values={reverse ? "0;18" : "0;-18"} /> : null}
            </path>
            <BaseEdge id={id} path={edgePath} style={{ stroke: "transparent", strokeWidth: 10 }} />
            {labelText ? (
                <EdgeLabelRenderer>
                    {goalAchievedLabel ? (
                        <GoalAchievedEdgeLabel text={labelText} left={labelX} top={labelY - 12} />
                    ) : (
                        <div
                            className="pointer-events-none absolute max-w-[240px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-flow-default/80 bg-flow-default-bg/95 px-2 py-1 text-[11px] font-semibold leading-snug text-flow-default-muted shadow-sm"
                            style={{
                                left: `${labelX}px`,
                                top: `${labelY - 12}px`,
                                display: "-webkit-box",
                                WebkitBoxOrient: "vertical",
                                WebkitLineClamp: 2,
                                overflow: "hidden",
                            }}
                        >
                            {labelText}
                        </div>
                    )}
                </EdgeLabelRenderer>
            ) : null}
        </g>
    )
}

const EDGE_TYPES = { "event-flow": EventFlowEdge }

interface RuntimeOfficialMessageListElement extends HTMLElement {
    messages: Record<string, unknown>[]
    tools: unknown[]
    pendingToolCalls?: ReadonlySet<string>
    isStreaming: boolean
    subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]>
}

interface AttackFlowProps {
    challengeId: string
    initialTab?: AttackFlowTab
    presentationFullscreen?: boolean
}

const DEFAULT_PANEL_WIDTHS = [50, 50]
const DEFAULT_GRAPH_HEIGHTS = [50, 50]
const AGGREGATE_COLUMN_GUTTER = "10px"
const AGGREGATE_ROW_GUTTER = "10px"
const MIN_PANEL_WIDTH_PERCENT = 28
const MIN_GRAPH_HEIGHT_PERCENT = 24
const PANEL_KEYBOARD_STEP = 3
const GRAPH_KEYBOARD_STEP = 3
const TIMELINE_LANE_LABEL_WIDTH = 150
const TIMELINE_EVENT_COLUMN_WIDTH = 168
const TIMELINE_TIME_ROW_HEIGHT = 52
const TIMELINE_LANE_ROW_MIN_HEIGHT = 56
const TIMELINE_COLUMN_GAP = 8
const TIMELINE_ROW_GAP = 6
const LayerSpacing = 112
const REPLAY_STEP_MS = 220
const REPLAY_LOOP_PAUSE_MS = 5000
const CHALLENGE_NODE_WIDTH = 360
const CHALLENGE_NODE_HEIGHT = 132
const GOAL_ACHIEVED_MARKER = "目标已达成"
const PLAYBACK_SPEED_OPTIONS = ["0.1", "0.2", "0.25", "0.33", "0.5", "1", "2", "4"] as const
const COLLABORATION_FOCUS_FREEZE_REMAINING = 20
const FLOW_VIEWPORT_THROTTLE_MS = 120
const ATTACK_FLOW_SHORTCUT_TABS: Record<string, AttackFlowTab> = {
    "1": "attack-path",
    "2": "memory-path",
    "3": "solver-agent-collaboration",
    "4": "aggregate-view",
}
type PlaybackSpeed = (typeof PLAYBACK_SPEED_OPTIONS)[number]

interface AttackFlowSyncState {
    cursorIndex: number
    isPlaying: boolean
    playbackSpeed: PlaybackSpeed
    needLoop: boolean
    selectedSolverId?: string
}

interface AttackFlowSyncMessage extends AttackFlowSyncState {
    type: "attack-flow-state"
    challengeId: string
    sourceTabId: string
    updatedAt: number
}

function isAttackFlowTab(value: unknown): value is AttackFlowTab {
    return value === "attack-path" || value === "memory-path" || value === "solver-agent-collaboration" || value === "aggregate-view"
}

function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
    return PLAYBACK_SPEED_OPTIONS.includes(value as PlaybackSpeed)
}

function shouldIgnoreAttackFlowShortcut(event: globalThis.KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return true
    const target = event.target
    if (!(target instanceof HTMLElement)) return false
    if (target.closest("[role='tab']")) return false
    return Boolean(
        target.closest(
            "input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='checkbox'], [role='menuitem'], [role='option'], [role='slider'], [role='textbox']",
        ),
    )
}

function isAttackFlowSyncMessage(value: unknown): value is AttackFlowSyncMessage {
    if (!value || typeof value !== "object") return false
    const message = value as Record<string, unknown>
    return (
        message.type === "attack-flow-state" &&
        typeof message.challengeId === "string" &&
        typeof message.sourceTabId === "string" &&
        typeof message.updatedAt === "number" &&
        typeof message.cursorIndex === "number" &&
        typeof message.isPlaying === "boolean" &&
        typeof message.needLoop === "boolean" &&
        isPlaybackSpeed(message.playbackSpeed) &&
        (message.selectedSolverId === undefined || typeof message.selectedSolverId === "string")
    )
}

function resizePanelWidths(widths: number[], deltaPercent: number) {
    const next = [...widths]
    const pairTotal = next[0] + next[1]
    const minWidth = Math.min(MIN_PANEL_WIDTH_PERCENT, pairTotal / 2)
    const left = Math.min(Math.max(next[0] + deltaPercent, minWidth), pairTotal - minWidth)
    next[0] = Number(left.toFixed(2))
    next[1] = Number((pairTotal - left).toFixed(2))
    return next
}

function resizeGraphHeights(heights: number[], deltaPercent: number) {
    const next = [...heights]
    const pairTotal = next[0] + next[1]
    const minHeight = Math.min(MIN_GRAPH_HEIGHT_PERCENT, pairTotal / 2)
    const top = Math.min(Math.max(next[0] + deltaPercent, minHeight), pairTotal - minHeight)
    next[0] = Number(top.toFixed(2))
    next[1] = Number((pairTotal - top).toFixed(2))
    return next
}

function resizeObserverLoopErrorMessages(value: unknown, seen = new Set<unknown>()): string[] {
    if (value === undefined || value === null) return []
    if (seen.has(value)) return []
    seen.add(value)

    if (value instanceof Error) return [value.message, value.name]
    if (typeof value === "string") return [value]
    if (typeof value !== "object") return [String(value)]

    const record = value as Record<string, unknown>
    return [
        typeof record.error === "string" ? record.error : undefined,
        typeof record.message === "string" ? record.message : undefined,
        ...resizeObserverLoopErrorMessages(record.error, seen),
        ...resizeObserverLoopErrorMessages(record.message, seen),
        ...resizeObserverLoopErrorMessages(record.reason, seen),
    ].filter((message): message is string => Boolean(message))
}

function isResizeObserverLoopError(value: unknown) {
    return resizeObserverLoopErrorMessages(value).some((message) =>
        message.includes("ResizeObserver loop completed with undelivered notifications") ||
        message.includes("ResizeObserver loop limit exceeded"),
    )
}

function installResizeObserverLoopErrorGuard() {
    if (typeof window === "undefined") return
    const key = "__tchAttackFlowResizeObserverGuard"
    const guardedWindow = window as Window & { [key]?: boolean }
    if (guardedWindow[key]) return
    guardedWindow[key] = true

    window.addEventListener("error", (event) => {
        if (!isResizeObserverLoopError(event.error ?? event.message) && !isResizeObserverLoopError(event)) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }, true)
    window.addEventListener("unhandledrejection", (event) => {
        if (!isResizeObserverLoopError(event.reason)) return
        event.preventDefault()
    }, true)
}

installResizeObserverLoopErrorGuard()

function formatTimelineTime(value?: number) {
    if (!value) return "start"
    return new Date(value).toLocaleString()
}

function formatCompactDuration(start: number, end: number) {
    const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
}

function clip(value: unknown, maxChars = 96) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function payloadObject(event: AttackTimelineEvent): Record<string, unknown> | undefined {
    return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : undefined
}

function memoryFromEvent(event: AttackTimelineEvent): MemoryEntry | undefined {
    const entry = payloadObject(event)?.entry
    if (!entry || typeof entry !== "object") return
    if (typeof (entry as { id?: unknown }).id !== "string") return
    const value = entry as Partial<MemoryEntry> & { id: string }
    if (!isMemoryKind(value.kind)) return
    if (typeof value.content !== "string" || value.content.trim() === "") return
    if (typeof value.source !== "string" || value.source.trim() === "") return
    return {
        id: value.id,
        challengeId: value.challengeId ?? event.challengeId,
        kind: value.kind,
        content: value.content,
        refs: Array.isArray(value.refs) ? value.refs.filter((item): item is string => typeof item === "string") : [],
        source: value.source,
        created_at: value.created_at ?? new Date(event.timestamp).toISOString(),
        updated_at: value.updated_at ?? value.created_at ?? new Date(event.timestamp).toISOString(),
    }
}

function isMemoryKind(value: unknown): value is MemoryEntry["kind"] {
    return value === "fact" || value === "evidence" || value === "failure" || value === "note" || value === "hint"
}

function ideaFromEvent(event: AttackTimelineEvent): IdeaRecord | undefined {
    const item = payloadObject(event)?.item
    if (!item || typeof item !== "object") return
    if (typeof (item as { id?: unknown }).id !== "string") return
    const value = item as Partial<IdeaRecord> & { id: string }
    if (typeof value.content !== "string" || value.content.trim() === "") return
    return {
        id: value.id,
        content: value.content,
        normalized: value.normalized ?? value.content.toLowerCase(),
        status: isIdeaStatus(value.status) ? value.status : "pending",
        result: value.result ?? "",
        created_at: value.created_at ?? new Date(event.timestamp).toISOString(),
        updated_at: value.updated_at ?? value.created_at ?? new Date(event.timestamp).toISOString(),
    }
}

function isIdeaStatus(value: unknown): value is IdeaRecord["status"] {
    return value === "pending" || value === "testing" || value === "verified" || value === "failed" || value === "skipped"
}

function submissionFromEvent(event: AttackTimelineEvent) {
    const submission = payloadObject(event)?.submission
    if (!submission || typeof submission !== "object") return
    return submission as { asset?: string; report?: string }
}

function submissionSummary(event: AttackTimelineEvent) {
    const submission = submissionFromEvent(event)
    const asset = typeof submission?.asset === "string" ? submission.asset.trim() : ""
    const report = typeof submission?.report === "string" ? submission.report.replace(/\s+/g, " ").trim() : ""
    if (asset && report) return `${asset} · ${report}`
    if (report) return report
    if (asset) return asset
    return event.summary
}

function isGoalAchievedText(text: string) {
    return text.includes(GOAL_ACHIEVED_MARKER)
}

function goalAchievedTextFromEvent(event: AttackTimelineEvent) {
    const memory = memoryFromEvent(event)
    if (memory && isGoalAchievedText(memory.content)) return memory.content
    if (isGoalAchievedText(event.summary)) return event.summary
    return ""
}

function firstGoalAchievedEvent(events: AttackTimelineEvent[]) {
    return events.find((event) => Boolean(goalAchievedTextFromEvent(event)))
}

function eventIsoTime(event: AttackTimelineEvent) {
    return new Date(event.timestamp).toISOString()
}

export function knowledgeDisplayLabel(value: string) {
    switch (value.toLowerCase()) {
        case "task":
        case "goal":
            return "任务"
        case "memory":
            return "情报"
        case "idea":
            return "战术"
        case "fact":
            return "发现"
        case "evidence":
            return "证据"
        case "failure":
            return "失败边界"
        case "hint":
            return "提示"
        case "note":
            return "记录"
        case "pending":
            return "待验证"
        case "testing":
            return "验证中"
        case "verified":
            return "已验证"
        case "failed":
            return "已失败"
        case "skipped":
            return "已跳过"
        case "flag":
            return "攻击结果"
        default:
            return value
    }
}

function memoryKindLabel(kind: MemoryEntry["kind"]) {
    switch (kind) {
        case "evidence":
            return "证据"
        case "failure":
            return "失败边界"
        case "hint":
            return "提示"
        case "note":
            return "记录"
        case "fact":
            return "发现"
    }
}

function nodeLabel(title: string, badge: string, summary: string, meta?: string[]) {
    function badgeGlyph(kind: string) {
        switch (kind) {
            case "task":
            case "goal":
                return <TargetIcon className="size-3.5" />
            case "solver":
                return <BotIcon className="size-3.5" />
            case "memory":
                return <DatabaseIcon className="size-3.5" />
            case "idea":
                return <LightbulbIcon className="size-3.5" />
            case "flag":
                return <FlagIcon className="size-3.5" />
            case "broadcast":
            case "observe":
                return <BellIcon className="size-3.5" />
            default:
                return <SendIcon className="size-3.5" />
        }
    }

    return (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 overflow-hidden text-left">
            <div className="flex min-w-0 items-start gap-2">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-flow-default bg-flow-default-bg text-flow-default-muted">{badgeGlyph(badge)}</span>
                <span className="min-w-0 break-words text-xs font-semibold tracking-wide text-flow-default-fg">{clip(title, 72)}</span>
            </div>
            {summary ? (
                <div
                    className="min-w-0 break-words text-[11px] leading-snug text-flow-default-muted"
                    style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                        overflow: "hidden",
                    }}
                >
                    {clip(summary, 220)}
                </div>
            ) : null}
            {meta && meta.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                    {meta.slice(0, 3).map((item) => (
                        <span key={item} className="max-w-full truncate rounded border border-current/15 bg-flow-default-bg/55 px-1.5 py-0.5 text-[10px] font-medium text-flow-default-muted">
                            {item}
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function knowledgeNodeLabel(type: "TASK" | "MEMORY" | "IDEA", kind: string, title: string, body: string, meta: string[]) {
    const updates = meta.find((item) => item.endsWith("updates"))
    const TypeIcon = type === "MEMORY" ? DatabaseIcon : type === "IDEA" ? LightbulbIcon : TargetIcon
    return (
        <div className="flex w-full min-w-0 flex-col gap-1.5 overflow-hidden text-left">
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-flow-default-faint">
                <TypeIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{knowledgeDisplayLabel(kind)}</span>
            </div>
            <div
                className="min-w-0 break-words text-xs font-semibold leading-snug text-flow-default-fg"
                style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
            >
                {clip(title, 80)}
            </div>
            <div
                className="min-w-0 break-words text-[11px] leading-snug text-flow-default-muted"
                style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
            >
                {clip(body, 140)}
            </div>
            {updates ? <div className="truncate text-[10px] font-medium text-flow-default-faint">{updates}</div> : null}
        </div>
    )
}

function challengeNodeTitle(challenge?: ChallengeInfoRecord) {
    return challenge?.title ? clip(challenge.title, 72) : "Task"
}

function challengeNodeSummary(challenge: ChallengeInfoRecord | undefined, fallbackId: string) {
    if (!challenge) return clip(fallbackId, 96)
    return clip(challenge.description, 150)
}

type CommunicationFlowItem = {
    id: string
    event: AttackTimelineEvent
    badge: string
    title: string
    summary: string
    edgeLabel: string
    className: string
}

function communicationFlowItemFromEvent(event: AttackTimelineEvent): CommunicationFlowItem | undefined {
    if (event.kind === "observer_reminder" && !event.solverId) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "broadcast",
            title: "Broadcast to solvers",
            summary: event.summary,
            edgeLabel: "broadcast",
            className: "border-flow-observer bg-flow-observer-bg text-flow-observer-fg",
        }
    }

    if (event.kind === "solver_started") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "spawn",
            title: promptNameFromEvent(event) ?? "Solver joined",
            summary: event.solverId ?? event.summary,
            edgeLabel: "assign",
            className: "border-flow-success bg-flow-success-bg text-flow-success-fg",
        }
    }

    const memory = memoryFromEvent(event)
    if (memory) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "memory",
            title: memory.kind === "failure" ? "Failure boundary uploaded" : "Evidence uploaded",
            summary: memory.content,
            edgeLabel: "upload",
            className: memory.kind === "failure" ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg" : "border-flow-memory bg-flow-memory-bg text-flow-memory-fg",
        }
    }

    const idea = ideaFromEvent(event)
    if (idea) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "idea",
            title: idea.status === "failed" ? "Route rejected" : "Route proposed",
            summary: idea.content,
            edgeLabel: "upload",
            className: idea.status === "failed" ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg" : "border-flow-idea bg-flow-idea-bg text-flow-idea-fg",
        }
    }

    const submission = submissionFromEvent(event)
    if (event.kind === "report_submitted") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "report",
            title: "测试报告提交",
            summary: submissionSummary(event),
            edgeLabel: "submit",
            className: "border-flow-flag bg-flow-flag-bg text-flow-flag-fg",
        }
    }

    if (event.kind === "tool_result" && event.title.startsWith("challenge_submit_report")) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "result",
            title: "攻击结果提交返回",
            summary: event.summary,
            edgeLabel: "result",
            className: "border-flow-flag bg-flow-flag-bg text-flow-flag-fg",
        }
    }

    if (event.lane === "observer") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "observe",
            title: "Observer steers solver",
            summary: event.summary,
            edgeLabel: "observe",
            className: "border-flow-observer bg-flow-observer-bg text-flow-observer-fg",
        }
    }

    return
}

type KnowledgeTreeItem = {
    nodeId: string
    rawId: string
    refs: string[]
    timestamp: number
    firstTimestamp: number
    lastTimestamp: number
    solverId?: string
    solverIds: string[]
    badge: string
    title: string
    summary: string
    detail?: string
    className: string
    lane: "idea" | "fact" | "failure" | "hint" | "flag"
    entity: "idea" | "memory" | "flag"
    status?: string
    statusTrail: string[]
    updateCount: number
    record?: MemoryEntry | IdeaRecord
    deleted?: boolean
    lifecycle?: "current" | "historical"
}

function boardToolName(event: AttackTimelineEvent) {
    const toolResult = payloadObject(event)?.toolResult
    if (!toolResult || typeof toolResult !== "object") return
    const toolName = (toolResult as { toolName?: unknown }).toolName
    return typeof toolName === "string" ? toolName : undefined
}

function isDeletedBoardEvent(event: AttackTimelineEvent, entity: "memory" | "idea") {
    const prefix = `${entity}_delete`
    return event.id.startsWith(prefix) || boardToolName(event) === prefix || event.title.toLowerCase().includes(`${entity} deleted`)
}

function boardMutationEventItem(event: AttackTimelineEvent): KnowledgeTreeItem | undefined {
    const memory = memoryFromEvent(event)
    if (memory) {
        const lane = memory.kind === "failure" ? "failure" : memory.kind === "hint" ? "hint" : "fact"
        return {
            nodeId: `memory:${memory.id}`,
            rawId: memory.id,
            refs: memory.refs,
            timestamp: event.timestamp,
            firstTimestamp: event.timestamp,
            lastTimestamp: event.timestamp,
            solverId: event.solverId,
            solverIds: event.solverId ? [event.solverId] : [],
            badge: memory.kind,
            title: memory.content,
            summary: memoryKindLabel(memory.kind),
            detail: memory.source,
            className:
                lane === "failure"
                    ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg"
                    : lane === "hint"
                      ? "border-flow-hint bg-flow-hint-bg text-flow-hint-fg"
                      : "border-flow-success bg-flow-success-bg text-flow-success-fg",
            lane,
            entity: "memory",
            status: memory.kind,
            statusTrail: [memory.kind],
            updateCount: 1,
            record: memory,
            deleted: isDeletedBoardEvent(event, "memory"),
        }
    }

    const idea = ideaFromEvent(event)
    if (idea) {
        const lane = idea.status === "failed" || idea.status === "skipped" ? "failure" : "idea"
        return {
            nodeId: `idea:${idea.id}`,
            rawId: idea.id,
            refs: [],
            timestamp: event.timestamp,
            firstTimestamp: event.timestamp,
            lastTimestamp: event.timestamp,
            solverId: event.solverId,
            solverIds: event.solverId ? [event.solverId] : [],
            badge: idea.status,
            title: idea.content,
            summary:
                idea.status === "verified"
                    ? "Verified route"
                    : idea.status === "failed"
                      ? "Rejected route"
                      : idea.status === "skipped"
                        ? "Skipped route"
                        : idea.status === "testing"
                          ? "Testing route"
                          : "Proposed route",
            detail: idea.result,
            className:
                idea.status === "verified"
                    ? "border-flow-success bg-flow-success-bg text-flow-success-fg"
                    : lane === "failure"
                      ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg"
                      : idea.status === "testing"
                        ? "border-flow-idea bg-flow-idea-bg text-flow-idea-fg"
                        : "border-flow-memory bg-flow-memory-bg text-flow-memory-fg",
            lane,
            entity: "idea",
            status: idea.status,
            statusTrail: [idea.status],
            updateCount: 1,
            record: idea,
            deleted: isDeletedBoardEvent(event, "idea"),
        }
    }

    return
}

function knowledgeEdgeStyle(item: KnowledgeTreeItem) {
    if (item.lane === "failure") return { stroke: "var(--flow-edge-failure)" }
    if (item.lane === "idea") return { stroke: "var(--flow-edge-memory)" }
    if (item.lane === "hint") return { stroke: "var(--flow-edge-hint)" }
    if (item.lane === "flag") return { stroke: "var(--flow-edge-success)" }
    return { stroke: "var(--flow-edge-success)" }
}

function boardRelationshipLabel(from: KnowledgeTreeItem, to: KnowledgeTreeItem) {
    if (to.refs.includes(from.rawId)) {
        if (to.entity === "idea" && from.entity === "memory") return "context"
        if (to.entity === "memory" && from.entity === "idea") return "distilled"
        if (to.entity === "memory" && from.entity === "memory") return "refines"
        return "references"
    }
    if (to.entity === "idea") return "branch idea"
    if (to.entity === "memory") return "stored memory"
    return "board"
}

function eventNodeId(item: KnowledgeTreeItem) {
    return `knowledge:${item.nodeId}`
}

function itemMeta(item: KnowledgeTreeItem) {
    const meta = [item.rawId]
    if (item.statusTrail.length > 1) meta.push(item.statusTrail.join(" -> "))
    else if (item.status) meta.push(item.status)
    if (item.updateCount > 1) meta.push(`${item.updateCount} updates`)
    if (item.solverIds.length > 0) meta.push(item.solverIds.slice(0, 2).join(", "))
    return meta
}

function knowledgeFocusNodeId(event?: AttackTimelineEvent) {
    if (!event) return
    const memory = memoryFromEvent(event)
    if (memory) return `knowledge:memory:${memory.id}`
    const idea = ideaFromEvent(event)
    if (idea && (idea.status === "pending" || idea.status === "testing")) return `knowledge:idea:${idea.id}`
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "knowledge:memory-root"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "knowledge:ideas-root"
    return
}

function knowledgeGroupForItem(item: KnowledgeTreeItem): KnowledgeGroup {
    if (item.entity === "idea") return "idea-active"
    if (item.status === "failure") return "memory-failure"
    if (item.status === "evidence") return "memory-evidence"
    if (item.status === "hint") return "memory-hint"
    if (item.status === "note") return "memory-note"
    return "memory-fact"
}

export function knowledgeNodeTextParts(input: { entity: "idea" | "memory" | "flag"; title: string; summary: string; detail?: string }) {
    if (input.entity === "idea") {
        return {
            heading: input.title,
            body: input.detail ?? "",
        }
    }
    return {
        heading: input.title,
        body: input.detail ?? "",
    }
}

function isHistoricalKnowledgeItem(item: KnowledgeTreeItem) {
    return item.lifecycle === "historical" || item.deleted === true
}

function historicalKnowledgeClassName() {
    return "border-flow-default/55 bg-flow-default-bg/55 text-flow-default-muted opacity-60 saturate-50"
}

function knowledgeEdgeVisual(parent: KnowledgeTreeItem | undefined, item: KnowledgeTreeItem) {
    const historical = isHistoricalKnowledgeItem(item) || (parent ? isHistoricalKnowledgeItem(parent) : false)
    const context = Boolean(parent && item.entity === "idea" && parent.entity === "memory" && item.refs.includes(parent.rawId))
    return {
        context,
        historical,
        strokeDasharray: historical ? "6 6" : context ? "6 5" : undefined,
        strokeOpacity: historical ? 0.46 : undefined,
        strokeWidth: historical ? 1.4 : context ? 1.8 : 2.2,
    }
}

function parsedTimestamp(value: string | undefined, fallback: number) {
    if (!value) return fallback
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : fallback
}

function memoryTreeItem(memory: MemoryEntry, timestamp: number): KnowledgeTreeItem {
    const lane = memory.kind === "failure" ? "failure" : memory.kind === "hint" ? "hint" : "fact"
    return {
        nodeId: `memory:${memory.id}`,
        rawId: memory.id,
        refs: memory.refs,
        timestamp,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        solverIds: [],
        badge: memory.kind,
        title: memory.content,
        summary: memoryKindLabel(memory.kind),
        detail: memory.source,
        className:
            lane === "failure"
                ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg"
                : lane === "hint"
                  ? "border-flow-hint bg-flow-hint-bg text-flow-hint-fg"
                  : "border-flow-success bg-flow-success-bg text-flow-success-fg",
        lane,
        entity: "memory",
        status: memory.kind,
        statusTrail: [memory.kind],
        updateCount: 1,
        record: memory,
    }
}

function ideaTreeItem(idea: IdeaRecord, timestamp: number): KnowledgeTreeItem {
    const lane = idea.status === "failed" || idea.status === "skipped" ? "failure" : "idea"
    return {
        nodeId: `idea:${idea.id}`,
        rawId: idea.id,
        refs: [],
        timestamp,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        solverIds: [],
        badge: idea.status,
        title: idea.content,
        summary:
            idea.status === "verified"
                ? "Verified route"
                : idea.status === "failed"
                  ? "Rejected route"
                  : idea.status === "skipped"
                    ? "Skipped route"
                    : idea.status === "testing"
                      ? "Testing route"
                      : "Proposed route",
        detail: idea.result,
        className:
            idea.status === "verified"
                ? "border-flow-success bg-flow-success-bg text-flow-success-fg"
                : lane === "failure"
                  ? "border-flow-failure bg-flow-failure-bg text-flow-failure-fg"
                  : idea.status === "testing"
                    ? "border-dashed border-flow-idea bg-flow-idea-bg/70 text-flow-idea-fg"
                    : "border-dashed border-flow-memory bg-flow-memory-bg/70 text-flow-memory-fg",
        lane,
        entity: "idea",
        status: idea.status,
        statusTrail: [idea.status],
        updateCount: 1,
        record: idea,
    }
}

function isMemoryEntryRecord(value: MemoryEntry | IdeaRecord | undefined): value is MemoryEntry {
    return Boolean(value && "challengeId" in value && "kind" in value)
}

function isIdeaRecord(value: MemoryEntry | IdeaRecord | undefined): value is IdeaRecord {
    return Boolean(value && "normalized" in value && "status" in value)
}

export function buildKnowledgeGraphFromBoard(
    memoryItems: MemoryEntry[],
    ideaItems: IdeaRecord[],
    events: AttackTimelineEvent[],
    currentTimestamp: number | undefined,
    challenge?: ChallengeInfoRecord,
): FlowGraph {
    if (currentTimestamp === undefined) return buildKnowledgeGraphFromItems([], challenge)
    const replayTimestamp = currentTimestamp

    const currentMemoryById = new Map(
        memoryItems
            .filter((memory) => parsedTimestamp(memory.created_at, Number.MAX_SAFE_INTEGER) <= replayTimestamp)
            .map((memory) => [memory.id, memory] as const),
    )
    const currentIdeaById = new Map(
        ideaItems
            .filter((idea) => parsedTimestamp(idea.created_at, Number.MAX_SAFE_INTEGER) <= replayTimestamp)
            .map((idea) => [idea.id, idea] as const),
    )
    const sources: KnowledgeTreeItem[] = []
    const eventSources = events
        .filter((event) => event.timestamp <= replayTimestamp)
        .map(boardMutationEventItem)
        .filter((item): item is KnowledgeTreeItem => Boolean(item))
    const eventSourceIds = new Set(eventSources.map((item) => item.rawId))

    for (const memory of currentMemoryById.values()) {
        if (eventSourceIds.has(memory.id)) continue
        sources.push(memoryTreeItem(memory, parsedTimestamp(memory.created_at, parsedTimestamp(memory.updated_at, 0))))
    }
    for (const idea of currentIdeaById.values()) {
        if (eventSourceIds.has(idea.id)) continue
        sources.push(ideaTreeItem(idea, parsedTimestamp(idea.created_at, parsedTimestamp(idea.updated_at, 0))))
    }
    sources.push(...eventSources)

    sources.sort((left, right) => left.timestamp - right.timestamp || left.rawId.localeCompare(right.rawId) || left.nodeId.localeCompare(right.nodeId))

    const itemsById = new Map<string, KnowledgeTreeItem>()
    const layersById = new Map<string, number>()
    let memoryFrontier = new Set<string>()

    function recomputeMemoryFrontier() {
        let maxLayer = 0
        const next: string[] = []
        for (const item of itemsById.values()) {
            if (item.entity !== "memory" || item.deleted) continue
            const layer = layersById.get(item.rawId) ?? 1
            if (layer > maxLayer) {
                maxLayer = layer
                next.length = 0
            }
            if (layer === maxLayer) next.push(item.rawId)
        }
        memoryFrontier = new Set(next)
    }

    function currentMaxMemoryLayer() {
        let maxLayer = 0
        for (const item of itemsById.values()) {
            if (item.entity !== "memory" || item.deleted) continue
            maxLayer = Math.max(maxLayer, layersById.get(item.rawId) ?? 1)
        }
        return maxLayer
    }

    function parentLayer(ref: string) {
        return layersById.get(ref)
    }

    function resolveLayer(item: KnowledgeTreeItem, existing?: KnowledgeTreeItem) {
        if (item.entity === "idea") {
            const refs = existing?.refs ?? [...memoryFrontier]
            if (refs.length === 0) return { refs, layer: 1 }
            const layer = Math.max(...refs.map((ref) => parentLayer(ref) ?? 1)) + 1
            return { refs, layer }
        }

        const parentLayers = item.refs.map(parentLayer).filter((layer): layer is number => typeof layer === "number")
        if (parentLayers.length > 0) return { refs: item.refs, layer: Math.max(...parentLayers) + 1 }
        return { refs: item.refs, layer: existing ? (layersById.get(item.rawId) ?? 1) : Math.max(1, currentMaxMemoryLayer()) }
    }

    for (const source of sources) {
        const existing = itemsById.get(source.rawId)
        const resolved = resolveLayer(source, existing)
        const nextStatusTrail = [...(existing?.statusTrail ?? [])]
        if (source.status && nextStatusTrail.at(-1) !== source.status) nextStatusTrail.push(source.status)
        const nextSolverIds = [...new Set([...(existing?.solverIds ?? []), ...source.solverIds])]
        const next: KnowledgeTreeItem = {
            ...source,
            refs: resolved.refs,
            firstTimestamp: existing?.firstTimestamp ?? source.firstTimestamp,
            lastTimestamp: source.lastTimestamp,
            solverIds: nextSolverIds,
            statusTrail: nextStatusTrail.length > 0 ? nextStatusTrail : source.statusTrail,
            updateCount: (existing?.updateCount ?? 0) + 1,
            deleted: source.deleted === true,
        }
        itemsById.set(source.rawId, next)
        layersById.set(source.rawId, resolved.layer)
        if (next.entity === "memory") recomputeMemoryFrontier()
    }

    const items = [...itemsById.values()].map((item) => {
        const currentRecord = item.entity === "memory" ? currentMemoryById.get(item.rawId) : item.entity === "idea" ? currentIdeaById.get(item.rawId) : undefined
        const current = Boolean(currentRecord && !item.deleted)
        const closedIdea = item.entity === "idea" && (item.status === "failed" || item.status === "skipped")
        return {
            ...item,
            record: item.record ?? currentRecord,
            lifecycle: current && !closedIdea ? "current" : "historical",
            className: current && !closedIdea ? item.className : historicalKnowledgeClassName(),
        } satisfies KnowledgeTreeItem
    })

    return buildKnowledgeGraphFromItems(items, challenge)
}

function buildKnowledgeGraphFromItems(items: KnowledgeTreeItem[], challenge?: ChallengeInfoRecord): FlowGraph {
    const sorted = [...items].sort((left, right) => left.firstTimestamp - right.firstTimestamp || left.rawId.localeCompare(right.rawId))
    const itemMap = new Map(sorted.map((item) => [item.rawId, item]))
    const distilledPairs = new Set(
        sorted
            .filter((item) => item.entity === "memory")
            .flatMap((memory) =>
                memory.refs
                    .filter((ref) => itemMap.get(ref)?.entity === "idea")
                    .map((ideaId) => `${memory.rawId}->${ideaId}`),
            ),
    )
    const taskTitle = challengeNodeTitle(challenge)
    const taskSummary = challengeNodeSummary(challenge, "项目任务上下文")
    const nodes: FlowNode[] = [
        {
            id: "knowledge:task-core",
            position: { x: 0, y: 0 },
            width: CHALLENGE_NODE_WIDTH,
            height: CHALLENGE_NODE_HEIGHT,
            data: {
                label: nodeLabel(taskTitle, "goal", taskSummary),
                graphRole: "task",
                knowledgeGroup: "task",
            },
            className: "rounded-lg border border-flow-default bg-flow-default-bg px-3 py-2 text-flow-default-fg shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
        },
    ]
    const edges: Edge[] = []
    const layoutEdges: Edge[] = []

    for (const item of sorted) {
        const nodeId = eventNodeId(item)
        const knowledgeGroup = knowledgeGroupForItem(item)
        const parents = item.refs
            .map((ref) => itemMap.get(ref))
            .filter((parent): parent is KnowledgeTreeItem => Boolean(parent))
            .filter((parent) => !(item.entity === "idea" && parent.entity === "memory" && distilledPairs.has(`${parent.rawId}->${item.rawId}`)))
        const textParts = knowledgeNodeTextParts({
            entity: item.entity,
            title: item.title,
            summary: item.summary,
            detail: item.detail,
        })
        nodes.push({
            id: nodeId,
            position: { x: 0, y: 0 },
            data: {
                label: knowledgeNodeLabel(
                    item.entity === "idea" ? "IDEA" : "MEMORY",
                    item.status ?? item.badge,
                    textParts.heading,
                    textParts.body,
                    itemMeta(item),
                ),
                graphRole: item.entity === "idea" ? "idea" : "memory",
                knowledgeGroup,
                rawId: item.rawId,
                knowledgeRecord: item.record,
            },
            className: cn("rounded-lg border px-3 py-2 shadow-[0_8px_20px_rgba(15,23,42,0.08)]", item.className),
        })

        if (parents.length === 0) {
            const edgeVisual = knowledgeEdgeVisual(undefined, item)
            layoutEdges.push({
                id: `layout:knowledge:task-core->${nodeId}`,
                source: "knowledge:task-core",
                target: nodeId,
            })
            edges.push({
                id: `knowledge:task-core->${nodeId}`,
                source: "knowledge:task-core",
                target: nodeId,
                label: "",
                style: {
                    stroke: item.entity === "idea" ? "var(--flow-edge-memory)" : "var(--flow-edge-soft)",
                    strokeWidth: edgeVisual.strokeWidth,
                    strokeDasharray: edgeVisual.strokeDasharray ?? (item.entity === "idea" ? "6 5" : "4 6"),
                    strokeOpacity: edgeVisual.strokeOpacity,
                },
            })
            continue
        }

        for (const parent of parents) {
            const edgeStyle = knowledgeEdgeStyle(item)
            const edgeVisual = knowledgeEdgeVisual(parent, item)
            edges.push({
                id: `${parent.nodeId}->${item.nodeId}`,
                source: eventNodeId(parent),
                target: nodeId,
                label: boardRelationshipLabel(parent, item),
                labelShowBg: true,
                labelStyle: { fontSize: 10, fontWeight: 600, fill: edgeVisual.historical ? "var(--flow-default-muted)" : "var(--flow-default-fg)" },
                labelBgStyle: {
                    fill: "var(--flow-default-bg)",
                    fillOpacity: edgeVisual.historical ? 0.72 : 0.92,
                    stroke: edgeStyle.stroke,
                    strokeWidth: 1,
                },
                labelBgPadding: [8, 4],
                labelBgBorderRadius: 6,
                style: { ...edgeStyle, strokeWidth: edgeVisual.strokeWidth, strokeDasharray: edgeVisual.strokeDasharray, strokeOpacity: edgeVisual.strokeOpacity },
            })
            layoutEdges.push({
                id: `layout:${parent.nodeId}->${item.nodeId}`,
                source: eventNodeId(parent),
                target: nodeId,
            })
        }
    }

    return { nodes, edges, layoutEdges }
}

function knowledgeRecordContentSignature(record: MemoryEntry | IdeaRecord | undefined) {
    if (!record) return ""
    if (isMemoryEntryRecord(record)) {
        return `${record.id}:${record.kind}:${record.content}:${record.updated_at}:${record.refs.join(",")}`
    }
    return `${record.id}:${record.status}:${record.content}:${record.result ?? ""}:${record.updated_at}`
}

export function buildKnowledgeGraphLayoutKey(graph: FlowGraph) {
    const nodePart = graph.nodes
        .map((node) => `${node.id}:${node.width ?? 0}:${node.height ?? 0}`)
        .sort()
        .join("|")
    const layoutEdges = graph.layoutEdges ?? graph.edges
    const edgePart = layoutEdges
        .map((edge) => `${edge.source}->${edge.target}`)
        .sort()
        .join("|")
    return `${nodePart}::${edgePart}`
}

export function buildKnowledgeGraphContentKey(graph: FlowGraph) {
    const nodePart = graph.nodes
        .map((node) =>
            `${node.id}:${node.className ?? ""}:${node.data.rawId ?? ""}:${node.data.knowledgeGroup ?? ""}:${knowledgeRecordContentSignature(node.data.knowledgeRecord)}`,
        )
        .sort()
        .join("|")
    const edgePart = graph.edges
        .map((edge) =>
            `${edge.id}:${edge.style?.stroke ?? ""}:${edge.style?.strokeOpacity ?? ""}:${edge.style?.strokeDasharray ?? ""}:${edge.style?.strokeWidth ?? ""}`,
        )
        .sort()
        .join("|")
    return `${nodePart}::${edgePart}`
}

function mergeFlowNodesWithLayout(currentNodes: FlowNode[], incomingNodes: FlowNode[]) {
    const positioned = new Map(currentNodes.map((node) => [node.id, node]))
    return incomingNodes.map((node) => {
        const placed = positioned.get(node.id)
        if (!placed) return node
        return {
            ...node,
            position: placed.position,
            sourcePosition: placed.sourcePosition,
            targetPosition: placed.targetPosition,
        }
    })
}

function solverIdsFromEvents(events: AttackTimelineEvent[]): string[] {
    return solverMetasFromEvents(events).map((meta) => meta.id)
}

export function buildCommunicationGraph(
    challengeId: string,
    events: AttackTimelineEvent[],
    t: TFunction,
    currentEvent?: AttackTimelineEvent,
    challenge?: ChallengeInfoRecord,
    selectedSolverId?: string,
    onViewAllSolver?: (solverId: string) => void,
    goalAchievedEventId?: string,
): { nodes: FlowNode[]; edges: Edge[] } {
    const item = currentEvent ? communicationFlowItemFromEvent(currentEvent) : undefined
    const nodes: FlowNode[] = []
    const edges: Edge[] = []

    function addNode(
        id: string,
        title: string,
        badge: string,
        summary: string,
        className: string,
        solverId?: string,
        customLabel?: ReactNode,
        customSize?: { width: number; height: number },
        wrapperClassName?: string,
    ) {
        const widthScore = title.length * 4 + summary.length * 1.35
        const adaptiveWidth = customSize?.width ?? (id === "topology:task" ? CHALLENGE_NODE_WIDTH : Math.max(240, Math.min(520, Math.round(widthScore))))
        const summaryLines = summary ? Math.min(3, Math.max(1, Math.ceil(summary.length / 68))) : 0
        const adaptiveHeight = customSize?.height ?? (id === "topology:task" ? CHALLENGE_NODE_HEIGHT : 76 + summaryLines * 16)
        nodes.push({
            id,
            type: id === "topology:task" ? "communication-task" : undefined,
            position: { x: 0, y: 0 },
            width: adaptiveWidth,
            height: adaptiveHeight,
            data: { label: customLabel ?? nodeLabel(title, badge, summary), solverId },
            className: cn(
                wrapperClassName ?? "rounded-xl border px-3 py-2 shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition-all",
                className,
                solverId && solverId === selectedSolverId ? "ring-2 ring-flow-selected-ring/70 shadow-[0_0_0_4px_rgba(56,189,248,0.14)]" : "",
            ),
        })
    }

    function addEdge(id: string, source: string, target: string, label = "", stroke = "var(--flow-edge-soft)", active = false, dashed = false, direction: "forward" | "reverse" = "forward") {
        edges.push({
            id,
            source,
            target,
            label,
            animated: false,
            type: "event-flow",
            data: { particleColor: stroke, active, direction },
            labelStyle: { fontSize: 10, fill: "var(--flow-edge-default)", fontWeight: 600 },
            style: { stroke, strokeWidth: active ? 2.2 : 1.3, strokeOpacity: active ? 0.95 : 0.55, strokeDasharray: dashed ? "6 5" : undefined },
        })
    }

    const goalAchieved = Boolean(goalAchievedEventId && events.some((event) => event.id === goalAchievedEventId))
    const taskTitle = challengeNodeTitle(challenge)
    const taskSummary = challengeNodeSummary(challenge, challengeId)
    if (goalAchieved) {
        addNode(
            "topology:task",
            taskTitle,
            "goal",
            taskSummary,
            "",
            undefined,
            <GoalAchievedTaskLabel title={taskTitle} summary={taskSummary} />,
            undefined,
            "!border-none !bg-transparent !p-0 !shadow-none",
        )
    } else {
        addNode("topology:task", taskTitle, "goal", taskSummary, "border-flow-default bg-flow-default-bg text-flow-default-fg")
    }

    const solverMetas = solverMetasFromEvents(events)
    for (const meta of solverMetas) {
        const solverNodeId = `topology:solver:${meta.id}`
        const cardData = buildSolverCardData(meta, events, t)
        nodes.push({
            id: solverNodeId,
            type: "solver-agent",
            position: { x: 0, y: 0 },
            width: SOLVER_AGENT_NODE_WIDTH,
            height: SOLVER_AGENT_NODE_HEIGHT,
            data: {
                solverId: meta.id,
                ...cardData,
                selected: meta.id === selectedSolverId,
                onViewAll: onViewAllSolver ? () => onViewAllSolver(meta.id) : undefined,
            },
        })
        addEdge(
            `base:${meta.id}`,
            "topology:task",
            solverNodeId,
            "",
            "var(--flow-edge-soft)",
            false,
            true,
        )
    }

    const solverNodeId = currentEvent?.solverId ? `topology:solver:${currentEvent.solverId}` : undefined

    function activateEdges(ids: string[], label: string, color: string, direction: "forward" | "reverse") {
        ids.forEach((id, index) => {
            const edge = edges.find((item) => item.id === id)
            if (!edge) return
            edge.label = index === 0 ? label : ""
            edge.style = { ...(edge.style ?? {}), stroke: color, strokeWidth: 2.2, strokeOpacity: 0.95 }
            edge.data = { ...(edge.data ?? {}), particleColor: color, active: true, direction }
        })
    }

    function applyGoalAchievedEdge() {
        if (!goalAchieved || !goalAchievedEventId) return
        const goalEvent = events.find((event) => event.id === goalAchievedEventId)
        const goalItem = goalEvent ? communicationFlowItemFromEvent(goalEvent) : undefined
        if (goalEvent?.solverId && goalItem) {
            activateEdges([`base:${goalEvent.solverId}`], flowEventLabel(goalItem), "var(--flow-edge-success)", "reverse")
        }
    }

    function finishGraph() {
        applyGoalAchievedEdge()
        return { nodes, edges }
    }

    if (!item || !currentEvent) return finishGraph()

    if (item.badge === "broadcast") {
        activateEdges(solverMetas.map((meta) => `base:${meta.id}`), flowEventLabel(item), "var(--flow-edge-observer)", "forward")
        return finishGraph()
    }

    if (item.edgeLabel === "upload") {
        if (!solverNodeId) return finishGraph()
        const stroke = item.badge === "idea" ? "var(--flow-edge-idea)" : "var(--flow-edge-success)"
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), stroke, "reverse")
        return finishGraph()
    }

    if (item.badge === "spawn") {
        if (!solverNodeId) return finishGraph()
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "var(--flow-edge-spawn)", "forward")
        return finishGraph()
    }

    if (item.badge === "flag" || item.badge === "result") {
        if (!solverNodeId) return finishGraph()
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "var(--flow-edge-flag)", "reverse")
        return finishGraph()
    }

    if (item.badge === "observe") {
        if (!solverNodeId) return finishGraph()
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "var(--flow-edge-observer)", "forward")
        return finishGraph()
    }

    if (!solverNodeId) return finishGraph()
    activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "var(--flow-edge-memory)", "reverse")

    return finishGraph()
}

function FitViewOnGraphChange(props: { version: number }) {
    const { version } = props
    const { fitView } = useReactFlow()
    const lastRunRef = useRef(0)

    useEffect(() => {
        let timeout = 0
        let outerFrame = 0
        let innerFrame = 0

        function runFitView() {
            lastRunRef.current = performance.now()
            outerFrame = window.requestAnimationFrame(() => {
                innerFrame = window.requestAnimationFrame(() => {
                    void fitView({ padding: 0.12, duration: 120 })
                })
            })
        }

        const elapsed = performance.now() - lastRunRef.current
        timeout = window.setTimeout(runFitView, Math.max(0, FLOW_VIEWPORT_THROTTLE_MS - elapsed))

        return () => {
            window.clearTimeout(timeout)
            window.cancelAnimationFrame(outerFrame)
            window.cancelAnimationFrame(innerFrame)
        }
    }, [fitView, version])

    return null
}

function FitViewBeforeFreeze(props: { fitKey?: number }) {
    const { fitKey } = props
    const { fitView } = useReactFlow()

    useEffect(() => {
        if (fitKey === undefined) return
        let outerFrame = 0
        let innerFrame = 0
        outerFrame = window.requestAnimationFrame(() => {
            innerFrame = window.requestAnimationFrame(() => {
                void fitView({ padding: 0.12, duration: 120 })
            })
        })
        return () => {
            window.cancelAnimationFrame(outerFrame)
            window.cancelAnimationFrame(innerFrame)
        }
    }, [fitKey, fitView])

    return null
}

function FocusFlowNode(props: { nodeId?: string; version: number }) {
    const { nodeId, version } = props
    const { getNode, setCenter } = useReactFlow()
    const lastRunRef = useRef(0)
    const lastFocusedRef = useRef<{ nodeId?: string; version: number }>({ version: -1 })

    useEffect(() => {
        if (!nodeId) return
        if (lastFocusedRef.current.nodeId === nodeId && lastFocusedRef.current.version === version) return
        const targetNodeId = nodeId
        let timeout = 0
        let frame = 0

        function runFocusNode() {
            lastRunRef.current = performance.now()
            frame = window.requestAnimationFrame(() => {
                const node = getNode(targetNodeId)
                if (!node) return
                lastFocusedRef.current = { nodeId: targetNodeId, version }
                const width = node.width ?? 220
                const height = node.height ?? 96
                const centerX = node.position.x + width / 2
                const centerY = node.position.y + height / 2
                void setCenter(centerX, centerY, { duration: 180, zoom: 1.03 })
            })
        }

        const elapsed = performance.now() - lastRunRef.current
        timeout = window.setTimeout(runFocusNode, Math.max(0, FLOW_VIEWPORT_THROTTLE_MS - elapsed))

        return () => {
            window.clearTimeout(timeout)
            window.cancelAnimationFrame(frame)
        }
    }, [getNode, nodeId, setCenter, version])

    return null
}

function flowMinimapNodeColor(node: FlowNode): string {
    if (node.data.knowledgeGroup === "memory-failure") return "var(--flow-failure)"
    return "var(--flow-edge-default)"
}

function FlowCanvas(props: {
    nodes: FlowNode[]
    edges: Edge[]
    layoutEdges?: Edge[]
    layoutMode?: FlowLayoutMode
    layoutKey?: string
    contentKey?: string
    empty: string
    suspended?: boolean
    direction?: ElkDirection
    nodeWidth?: number
    nodeHeight?: number
    spacing?: number
    layerSpacing?: number
    nodeTypes?: NodeTypes
    nodesDraggable?: boolean
    onNodeClick?: NodeMouseHandler<FlowNode>
    focusNodeId?: string
    autoFocus?: boolean
    fitViewOnLayout?: boolean
    fitBeforeFreezeKey?: number
    showMinimap?: boolean
    children?: ReactNode
}) {
    const { nodes, edges, layoutEdges, layoutMode = "elk", layoutKey, contentKey, empty, suspended = false, direction = "DOWN", nodeWidth = 260, nodeHeight = 112, spacing = 72, layerSpacing = LayerSpacing, nodeTypes, nodesDraggable = false, onNodeClick, focusNodeId, autoFocus = true, fitViewOnLayout = false, fitBeforeFreezeKey, showMinimap = false, children } = props
    const [layouted, setLayouted] = useState<{ nodes: FlowNode[]; edges: Edge[] }>({ nodes, edges })
    const [layoutVersion, setLayoutVersion] = useState(0)
    const nodesRef = useRef(nodes)
    const edgesRef = useRef(edges)
    const layoutEdgesRef = useRef(layoutEdges ?? edges)
    nodesRef.current = nodes
    edgesRef.current = edges
    layoutEdgesRef.current = layoutEdges ?? edges

    const resolvedLayoutKey = layoutKey ?? buildKnowledgeGraphLayoutKey({ nodes, edges, layoutEdges })

    useEffect(() => {
        if (suspended || contentKey === undefined) return
        setLayouted((current) => ({
            nodes: mergeFlowNodesWithLayout(current.nodes, nodesRef.current),
            edges: edgesRef.current,
        }))
    }, [contentKey, suspended])

    useEffect(() => {
        if (suspended) return
        const currentNodes = nodesRef.current
        const currentEdges = edgesRef.current
        const currentLayoutEdges = layoutEdgesRef.current
        if (layoutMode === "mindmap") {
            const visibleNodes = currentNodes.filter((node) => !node.hidden)
            const taskNode = visibleNodes.find((node) => node.data.graphRole === "task") ?? visibleNodes[0]
            const children = visibleNodes.filter((node) => node.id !== taskNode?.id)
            const groups: Record<KnowledgeGroup, FlowNode[]> = {
                task: [],
                "memory-failure": [],
                "memory-evidence": [],
                "memory-fact": [],
                "memory-hint": [],
                "memory-note": [],
                "idea-active": [],
            }
            for (const node of children) {
                groups[node.data.knowledgeGroup ?? "memory-fact"].push(node)
            }

            function placeColumn(items: FlowNode[], x: number, yCenter: number, side: "left" | "right") {
                const yStep = Math.max(190, nodeHeight + 84)
                return items.map((node, index) => {
                    const y = yCenter + (index - (items.length - 1) / 2) * yStep
                    return {
                    ...node,
                        position: { x, y },
                        sourcePosition: side === "right" ? Position.Right : Position.Left,
                        targetPosition: side === "right" ? Position.Left : Position.Right,
                    }
                })
            }

            const positioned = new Map<string, FlowNode>()
            if (taskNode) {
                positioned.set(taskNode.id, {
                    ...taskNode,
                    position: { x: 0, y: 0 },
                    sourcePosition: Position.Right,
                    targetPosition: Position.Left,
                })
            }
            for (const node of placeColumn(groups["memory-failure"], -540, -130, "left")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-hint"].concat(groups["memory-note"]), -540, 220, "left")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-evidence"], 540, -180, "right")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-fact"], 540, 180, "right")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["idea-active"], 820, 0, "right")) positioned.set(node.id, node)

            setLayouted({
                nodes: currentNodes.map((node) => positioned.get(node.id) ?? { ...node, position: { x: 0, y: 0 } }),
                edges: currentEdges,
            })
            setLayoutVersion((current) => current + 1)
            return
        }
        if (layoutMode === "collaboration") {
            const next = layoutCollaborationFlowElements(currentNodes, currentEdges, { spacing, layerSpacing, nodeWidth, nodeHeight })
            setLayouted(next)
            setLayoutVersion((current) => current + 1)
            return
        }
        let active = true
        void layoutFlowElements(currentNodes, currentLayoutEdges, { direction, nodeWidth, nodeHeight, spacing, layerSpacing }).then((next) => {
            if (!active) return
            const positioned = new Map(next.nodes.map((node) => [node.id, node]))
            setLayouted({
                nodes: currentNodes.map((node) => {
                    const placed = positioned.get(node.id)
                    if (!placed) return node
                    return { ...node, position: placed.position, sourcePosition: placed.sourcePosition, targetPosition: placed.targetPosition }
                }),
                edges: currentEdges,
            })
            setLayoutVersion((current) => current + 1)
        })
        return () => {
            active = false
        }
    }, [
        direction,
        layoutKey === undefined ? edges : undefined,
        layerSpacing,
        layoutMode,
        nodeHeight,
        layoutKey === undefined ? nodes : undefined,
        nodeWidth,
        resolvedLayoutKey,
        spacing,
        suspended,
    ])

    if (suspended) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Release to redraw graph</div>
    if (nodes.length === 0) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{empty}</div>
    return (
        <ReactFlow
            nodes={layouted.nodes}
            edges={layouted.edges}
            edgeTypes={EDGE_TYPES}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            className="flow-canvas-bg"
            defaultEdgeOptions={{
                type: "bezier",
                markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--flow-edge-default)" },
                style: { strokeWidth: 1.8, stroke: "var(--flow-edge-default)" },
            }}
            nodesDraggable={nodesDraggable}
            nodesConnectable={false}
            onNodesChange={(changes) => {
                if (!nodesDraggable) return
                setLayouted((current) => ({
                    ...current,
                    nodes: applyNodeChanges(changes, current.nodes) as FlowNode[],
                }))
            }}
            minZoom={0.2}
            maxZoom={1.5}
            panOnScroll
            zoomOnScroll={false}
            onNodeClick={onNodeClick}
            proOptions={{ hideAttribution: true }}
        >
            {autoFocus ? (focusNodeId ? <FocusFlowNode nodeId={focusNodeId} version={layoutVersion} /> : <FitViewOnGraphChange version={layoutVersion} />) : fitViewOnLayout ? <FitViewOnGraphChange version={layoutVersion} /> : null}
            {fitBeforeFreezeKey !== undefined ? <FitViewBeforeFreeze fitKey={fitBeforeFreezeKey} /> : null}
            {showMinimap ? (
                <MiniMap
                    position="bottom-left"
                    className="rounded-md border border-flow-default/70 bg-flow-default-bg/95 shadow-sm"
                    bgColor="var(--flow-canvas-bg)"
                    maskColor="color-mix(in oklch, var(--flow-canvas-bg) 45%, transparent)"
                    maskStrokeColor="var(--flow-selected-ring)"
                    maskStrokeWidth={1.5}
                    nodeColor={flowMinimapNodeColor}
                    nodeStrokeColor="var(--flow-edge-default)"
                    nodeStrokeWidth={1.5}
                    pannable
                    zoomable
                />
            ) : null}
            <Controls position="bottom-right" showInteractive={false} className="rounded-md border border-flow-default/70 bg-flow-default-bg/95 shadow-sm" />
            <Background color="var(--flow-grid)" gap={24} />
            {children}
        </ReactFlow>
    )
}

function AttackRuntimeMessageList(props: { thread: RuntimeThreadView; subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]> }) {
    const { thread, subagentThreadsByToolCallId } = props
    const ref = useRef<RuntimeOfficialMessageListElement | null>(null)
    const [elementReady, setElementReady] = useState(false)

    useEffect(() => {
        let active = true
        void import("../runtime/official/message-list-element").then(() => {
            if (active) setElementReady(true)
        })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        if (!elementReady) return
        if (!ref.current) return
        ref.current.messages = thread.messages
        ref.current.tools = []
        ref.current.pendingToolCalls = undefined
        ref.current.isStreaming = false
        ref.current.subagentThreadsByToolCallId = subagentThreadsByToolCallId
    }, [elementReady, subagentThreadsByToolCallId, thread.messages])

    return createElement("runtime-official-message-list", { ref, className: "runtime-official-message-list-host" })
}

function getUserMessageText(message: Record<string, unknown>) {
    if (message.role !== "user") return ""
    const content = message.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
}

function trimThreadTaskMessage(thread: RuntimeThreadView) {
    if (!thread.task) return thread
    const task = thread.task.trim()
    const firstIndex = thread.messages.findIndex((message) => {
        const text = getUserMessageText(message)
        return text && text.trim() === task
    })
    if (firstIndex < 0) return thread
    return {
        ...thread,
        messages: thread.messages.filter((_, index) => index !== firstIndex),
    }
}

function threadAnchorTime(thread: RuntimeThreadView): number | undefined {
    if (typeof thread.createdAt === "number") return thread.createdAt
    return thread.messages.find((message) => typeof message.timestamp === "number")?.timestamp as number | undefined
}

function messagesUntil(thread: RuntimeThreadView, timestamp?: number) {
    if (timestamp === undefined) return []
    return thread.messages.filter((message) => typeof message.timestamp === "number" && message.timestamp <= timestamp)
}

function buildRuntimeTimeline(details: RuntimeDetailsView | null, timestamp?: number) {
    const mainThread = details?.threads.find((thread) => thread.kind === "main")
    const mainVisibleThread = mainThread
        ? trimThreadTaskMessage({
              ...mainThread,
              messages: messagesUntil(mainThread, timestamp),
          })
        : undefined
    const visibleMainThread = mainVisibleThread && mainVisibleThread.messages.length > 0 ? mainVisibleThread : undefined
    const visibleSubagentThreads = (details?.threads ?? [])
        .filter((thread) => thread.kind === "subagent")
        .map((thread) =>
            trimThreadTaskMessage({
                ...thread,
                messages: messagesUntil(thread, timestamp),
            }),
        )
        .filter((thread) => thread.messages.length > 0)
        .sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    const visibleObserverThreads = (details?.threads ?? [])
        .filter((thread) => thread.kind === "observer")
        .map((thread) => ({
            ...thread,
            messages: messagesUntil(thread, timestamp),
        }))
        .filter((thread) => thread.messages.length > 0)
        .sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    const subagentThreadsByToolCallId: Record<string, RuntimeThreadView[]> = {}

    for (const thread of visibleSubagentThreads) {
        if (!thread.parentToolCallId) continue
        if (!subagentThreadsByToolCallId[thread.parentToolCallId]) subagentThreadsByToolCallId[thread.parentToolCallId] = []
        subagentThreadsByToolCallId[thread.parentToolCallId].push(thread)
    }
    for (const key of Object.keys(subagentThreadsByToolCallId)) {
        subagentThreadsByToolCallId[key].sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    }

    const blocks: Array<{ type: "main"; thread: RuntimeThreadView } | { type: "observer"; thread: RuntimeThreadView }> = []
    const mainMessages = visibleMainThread?.messages ?? []
    let cursor = 0

    for (const observerThread of visibleObserverThreads) {
        const observerTime = threadAnchorTime(observerThread) ?? Number.MAX_SAFE_INTEGER
        let splitIndex = cursor
        while (splitIndex < mainMessages.length) {
            const messageTimestamp = typeof mainMessages[splitIndex]?.timestamp === "number" ? (mainMessages[splitIndex].timestamp as number) : Number.MAX_SAFE_INTEGER
            if (messageTimestamp > observerTime) break
            splitIndex += 1
        }

        const segmentMessages = mainMessages.slice(cursor, splitIndex)
        if (segmentMessages.length > 0 && visibleMainThread) {
            blocks.push({
                type: "main",
                thread: { ...visibleMainThread, id: `${visibleMainThread.id}:segment:${blocks.length}`, messages: segmentMessages },
            })
        }
        blocks.push({ type: "observer", thread: observerThread })
        cursor = splitIndex
    }

    const trailingMessages = mainMessages.slice(cursor)
    if (trailingMessages.length > 0 && visibleMainThread) {
        blocks.push({
            type: "main",
            thread: { ...visibleMainThread, id: `${visibleMainThread.id}:segment:${blocks.length}`, messages: trailingMessages },
        })
    }

    return { blocks, subagentThreadsByToolCallId }
}

function ObserverMarkerBlock(props: { thread: RuntimeThreadView }) {
    const { thread } = props
    return (
        <section className="min-w-0">
            <div className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left">
                <div className="h-px flex-1 bg-border" />
                <div className="shrink-0 text-xs font-medium text-muted-foreground">
                    {thread.label}
                    {thread.createdAt ? ` · ${formatTimelineTime(thread.createdAt)}` : ""}
                </div>
                <div className="h-px flex-1 bg-border" />
            </div>
        </section>
    )
}

function SolverRuntimeTimeline(props: { solverId: string; timestamp?: number }) {
    const { solverId, timestamp } = props
    const [details, setDetails] = useState<RuntimeDetailsView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [challengeInfo, setChallengeInfo] = useState<ChallengeInfoRecord | undefined>()

    useEffect(() => {
        let active = true
        setLoading(true)
        setError("")
        void runtime
            .get(solverId)
            .then((next) => {
                if (active) setDetails(next as unknown as RuntimeDetailsView)
            })
            .catch((nextError) => {
                if (active) setError(nextError instanceof Error ? nextError.message : String(nextError))
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [solverId])

    const timeline = useMemo(() => buildRuntimeTimeline(details, timestamp), [details, timestamp])

    if (loading && !details) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading runtime timeline...</div>
    if (error) return <div className="rounded-lg border p-3 text-sm text-destructive">{error}</div>
    if (timeline.blocks.length === 0) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No runtime messages at this time.</div>

    return (
        <div className="runtime-detail-content h-full overflow-y-auto overflow-x-hidden px-2 py-3">
            <div className="space-y-4">
                {timeline.blocks.map((block) =>
                    block.type === "main" ? (
                        <section key={block.thread.id} className="min-w-0 overflow-x-hidden">
                            <AttackRuntimeMessageList thread={block.thread} subagentThreadsByToolCallId={timeline.subagentThreadsByToolCallId} />
                        </section>
                    ) : (
                        <ObserverMarkerBlock key={block.thread.id} thread={block.thread} />
                    ),
                )}
            </div>
        </div>
    )
}

function timelineAccent(event: AttackTimelineEvent) {
    if (event.kind === "report_submitted") return "border-flow-flag/60 bg-flow-flag-bg text-flow-flag-fg"
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "border-flow-memory/60 bg-flow-memory-bg text-flow-memory-fg"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "border-flow-idea/60 bg-flow-idea-bg text-flow-idea-fg"
    if (event.lane === "observer" || event.kind === "observer_reminder") return "border-flow-observer/60 bg-flow-observer-bg text-flow-observer-fg"
    if (event.kind === "solver_started" || event.kind === "solver_ended") return "border-flow-success/60 bg-flow-success-bg text-flow-success-fg"
    return "border-flow-default/60 bg-flow-default-bg/70 text-flow-default-fg"
}

function timelineDot(event: AttackTimelineEvent) {
    if (event.kind === "report_submitted") return "bg-flow-flag"
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "bg-flow-memory"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "bg-flow-idea"
    if (event.lane === "observer" || event.kind === "observer_reminder") return "bg-flow-observer"
    if (event.kind === "solver_started" || event.kind === "solver_ended") return "bg-flow-success"
    return "bg-flow-default-faint"
}

function timelineLaneId(event: AttackTimelineEvent) {
    return event.solverId ?? "hub"
}

function isBroadcastEvent(event: AttackTimelineEvent) {
    return !event.solverId && event.kind === "observer_reminder"
}

function shortTime(value: number) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function isBoardUpdateEvent(event: AttackTimelineEvent) {
    return event.kind === "memory_added" || event.kind === "memory_updated" || event.kind === "idea_added" || event.kind === "idea_updated"
}

function flowEventLabel(item: CommunicationFlowItem) {
    if (item.badge === "broadcast") return clip(item.summary, 46)
    if (item.badge === "observe") return clip(item.summary, 42)
    if (item.badge === "memory" || item.badge === "idea") return clip(item.summary, 42)
    if (item.badge === "flag" || item.badge === "result") return clip(item.summary, 36)
    if (item.badge === "spawn") return clip(item.summary, 32)
    return clip(item.summary, 40)
}

function TimelineExecutionOverview(props: {
    data: ExecutionOverviewData
    overviewDefaultCollapsed?: boolean
    compact?: boolean
}) {
    const { data, overviewDefaultCollapsed = false, compact = false } = props
    return (
        <div className="shrink-0 border-t border-flow-timeline-border/80 bg-flow-timeline-bg/95 px-2 pb-2 pt-1.5">
            <ExecutionOverview
                variant="overlay"
                data={data}
                collapsible
                defaultCollapsed={overviewDefaultCollapsed}
                compact={compact}
            />
        </div>
    )
}

function TimelineGridCell(props: { style: CSSProperties; variant?: "corner" | "header" | "lane" | "body" }) {
    const { style, variant = "body" } = props
    return (
        <div
            aria-hidden="true"
            className={cn(
                "pointer-events-none rounded-md border border-flow-timeline-cell-border",
                variant === "body" ? "bg-flow-timeline-cell-bg" : "bg-flow-timeline-cell-header-bg",
            )}
            style={style}
        />
    )
}

function TimelineAxisCorner(props: { className?: string }) {
    const { t } = useTranslation()
    return (
        <div className={cn("relative overflow-hidden rounded-tl-lg", props.className)}>
            <svg className="pointer-events-none absolute inset-0 h-full w-full text-border" aria-hidden="true">
                <line x1="0" y1="0" x2="100%" y2="100%" stroke="currentColor" strokeOpacity="0.8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="absolute right-[14%] top-[18%] text-[11px] font-semibold text-foreground">{t("flow.time")}</div>
            <div className="absolute bottom-[18%] left-[14%] text-[11px] font-semibold tracking-wide text-foreground uppercase">{t("flow.agents")}</div>
        </div>
    )
}

function TimelinePanel(props: {
    events: AttackTimelineEvent[]
    selectedSolverId?: string
    onSelectSolver: (solverId: string) => void
    onSelectEvent: (event: AttackTimelineEvent) => void
    activeEventId?: string
    autoFollow: boolean
    overviewDefaultCollapsed?: boolean
    compactOverview?: boolean
}) {
    const { events, selectedSolverId, onSelectSolver, onSelectEvent, activeEventId, autoFollow, overviewDefaultCollapsed = false, compactOverview = false } = props
    const items = keyTimelineEvents(events).filter((event) => timelineLaneId(event) !== "hub")
    const solverMetas = solverMetasFromEvents(events)
    const lanes: Array<{ id: string; label: string; description?: string; className: string }> = solverMetas.map((meta, index) => {
        const styles = [
            "border-flow-memory bg-flow-memory-bg text-flow-memory-fg",
            "border-flow-success bg-flow-success-bg text-flow-success-fg",
            "border-flow-idea bg-flow-idea-bg text-flow-idea-fg",
            "border-flow-failure bg-flow-failure-bg text-flow-failure-fg",
            "border-flow-observer bg-flow-observer-bg text-flow-observer-fg",
        ]
        const label = meta.promptName ?? meta.id
        return {
            id: meta.id,
            label,
            description: meta.id,
            className: styles[index % styles.length] ?? styles[0],
        }
    })
    const gridTemplateColumns = `${TIMELINE_LANE_LABEL_WIDTH}px repeat(${items.length}, ${TIMELINE_EVENT_COLUMN_WIDTH}px)`
    const gridTemplateRows = `${TIMELINE_TIME_ROW_HEIGHT}px repeat(${lanes.length}, minmax(${TIMELINE_LANE_ROW_MIN_HEIGHT}px, auto))`
    const timelineWidth = TIMELINE_LANE_LABEL_WIDTH + items.length * (TIMELINE_EVENT_COLUMN_WIDTH + TIMELINE_COLUMN_GAP)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const { t } = useTranslation()
    const overviewData = useMemo(() => buildExecutionOverviewFromTimeline(events), [events])

    useEffect(() => {
        if (!autoFollow) return
        if (!activeEventId) return
        const container = scrollRef.current
        if (!container) return
        const target = container.querySelector<HTMLElement>(`[data-timeline-event-id="${activeEventId}"]`)
        if (!target) return
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" })
    }, [activeEventId, autoFollow])

    if (items.length === 0) {
        return (
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-flow-timeline-border flow-timeline-bg">
                <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
                    <div className="max-w-[260px] rounded-lg border border-dashed border-flow-default/50 bg-flow-default-bg/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground shadow-sm">
                        {t("replay.waiting")}
                    </div>
                </div>
                <TimelineExecutionOverview data={overviewData} overviewDefaultCollapsed={overviewDefaultCollapsed} compact={compactOverview} />
            </div>
        )
    }

    const headerBg = "bg-gradient-to-br from-flow-default-bg to-flow-memory-bg/80"
    const timelinePanelBg = "bg-gradient-to-br from-flow-default-bg to-flow-memory-bg/40"

    return (
        <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-flow-timeline-border", timelinePanelBg)}>
            <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-auto p-2">
                <div
                    className="relative grid"
                    style={{
                        width: timelineWidth,
                        gridTemplateColumns,
                        gridTemplateRows,
                        columnGap: TIMELINE_COLUMN_GAP,
                        rowGap: TIMELINE_ROW_GAP,
                    }}
                >
                    <TimelineGridCell variant="corner" style={{ gridColumn: 1, gridRow: 1 }} />

                    {items.map((event, eventIdx) => (
                        <TimelineGridCell key={`bg-t-${event.id}`} variant="header" style={{ gridColumn: eventIdx + 2, gridRow: 1 }} />
                    ))}

                    {lanes.map((lane, laneIdx) => (
                        <TimelineGridCell key={`bg-l-${lane.id}`} variant="lane" style={{ gridColumn: 1, gridRow: laneIdx + 2 }} />
                    ))}

                    {lanes.map((lane, laneIdx) =>
                        items.map((event, eventIdx) => (
                            <TimelineGridCell
                                key={`bg-${lane.id}-${event.id}`}
                                variant="body"
                                style={{ gridColumn: eventIdx + 2, gridRow: laneIdx + 2 }}
                            />
                        )),
                    )}

                    <div className={cn("sticky left-0 top-0 z-30", timelinePanelBg)} style={{ gridColumn: 1, gridRow: 1 }}>
                        <TimelineAxisCorner className="h-full w-full" />
                    </div>

                    {items.map((event, eventIdx) => (
                        <div
                            key={`t-${event.id}-${eventIdx}`}
                            className={cn("sticky top-0 z-20 flex min-w-0 items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground", headerBg)}
                            style={{ gridColumn: eventIdx + 2, gridRow: 1 }}
                        >
                            <span className={cn("size-2 shrink-0 rounded-full", timelineDot(event))} />
                            <span className="truncate">{shortTime(event.timestamp)}</span>
                        </div>
                    ))}

                    {lanes.map((lane, laneIdx) => (
                        <button
                            type="button"
                            key={`l-${lane.id}`}
                            onClick={() => lane.id !== "hub" && onSelectSolver(lane.id)}
                            className={cn(
                                "sticky left-0 z-10 flex h-full w-full min-w-0 flex-col rounded-lg border px-1.5 py-1 text-left text-[10px] font-semibold shadow-sm transition hover:shadow-md",
                                lane.className,
                                lane.id === selectedSolverId ? "ring-2 ring-primary/40" : "",
                                lane.id === "hub" ? "cursor-default" : "cursor-pointer",
                            )}
                            style={{ gridColumn: 1, gridRow: laneIdx + 2 }}
                        >
                            <div className="flex min-w-0 items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate">{lane.label}</span>
                            </div>
                            {"description" in lane && lane.description ? (
                                <div className="mt-0.5 truncate text-[10px] font-normal opacity-70">{lane.description}</div>
                            ) : null}
                        </button>
                    ))}

                    {items.map((event, eventIdx) =>
                        isBroadcastEvent(event) ? (
                            <div
                                key={`b-${event.id}`}
                                className="pointer-events-none mx-auto h-full border-l border-dashed border-flow-observer"
                                style={{ gridColumn: eventIdx + 2, gridRow: `2 / span ${lanes.length}` }}
                            />
                        ) : null,
                    )}

                    {items.map((event, eventIdx) => {
                        const laneIdx = lanes.findIndex((lane) => lane.id === timelineLaneId(event))
                        if (laneIdx < 0) return null
                        const summaryLimit = event.kind === "report_submitted" ? 96 : 36
                        return (
                            <div
                                key={event.id}
                                data-timeline-event-id={event.id}
                                className="relative z-[1] flex min-w-0 self-stretch"
                                style={{ gridColumn: eventIdx + 2, gridRow: laneIdx + 2 }}
                            >
                                <button
                                    type="button"
                                    onClick={() => (isBoardUpdateEvent(event) ? onSelectEvent(event) : event.solverId ? onSelectSolver(event.solverId) : onSelectEvent(event))}
                                    className={cn(
                                        "flex h-full w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md border px-1.5 py-1 text-left text-[10px] shadow-sm transition hover:shadow-md",
                                        timelineAccent(event),
                                    )}
                                >
                                    <div className="flex min-w-0 items-center justify-between gap-1">
                                        <span className="min-w-0 flex-1 truncate font-semibold">{timelineEventTitle(event, t)}</span>
                                    </div>
                                    <div className="min-w-0 break-words opacity-75 line-clamp-2">{clip(event.summary, summaryLimit)}</div>
                                </button>
                            </div>
                        )
                    })}
                </div>
            </div>
            <TimelineExecutionOverview data={overviewData} overviewDefaultCollapsed={overviewDefaultCollapsed} compact={compactOverview} />
        </div>
    )
}

function PanelResizeHandle(props: { onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; onReset: () => void; alwaysVisible?: boolean }) {
    const { onPointerDown, onKeyDown, onReset, alwaysVisible = false } = props
    return (
        <button
            type="button"
            aria-label="Resize timeline and graph panels"
            title="Drag to resize panels. Double-click to reset."
            className={cn("group cursor-col-resize items-stretch justify-center px-1 outline-none", alwaysVisible ? "flex" : "hidden xl:flex")}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={onReset}
        >
            <span className="my-1 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary/50" />
        </button>
    )
}

function StackResizeHandle(props: { onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; onReset: () => void; alwaysVisible?: boolean }) {
    const { onPointerDown, onKeyDown, onReset, alwaysVisible = false } = props
    return (
        <button
            type="button"
            aria-label="Resize knowledge and topology panels"
            title="Drag to resize graph panels. Double-click to reset."
            className={cn("group cursor-row-resize items-center justify-stretch py-1 outline-none", alwaysVisible ? "flex" : "hidden xl:flex")}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={onReset}
        >
            <span className="mx-1 h-1 flex-1 rounded-full bg-border transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary/50" />
        </button>
    )
}

function AggregatePanelCell(props: { title: string; children: ReactNode }) {
    const { title, children } = props
    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border/80 bg-background shadow-sm">
            <div className="shrink-0 border-b bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">{title}</div>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
    )
}

function AggregateGridPanel(props: {
    gridRef: RefObject<HTMLDivElement | null>
    widths: number[]
    heights: number[]
    titles: { attackPath: string; memoryPath: string; collaboration: string }
    attackPath: ReactNode
    memoryPath: ReactNode
    collaboration: ReactNode
    onColumnResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onColumnResizeKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
    onResetColumnWidths: () => void
    onRowResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onRowResizeKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
    onResetRowHeights: () => void
}) {
    const {
        gridRef,
        widths,
        heights,
        titles,
        attackPath,
        memoryPath,
        collaboration,
        onColumnResizeStart,
        onColumnResizeKeyDown,
        onResetColumnWidths,
        onRowResizeStart,
        onRowResizeKeyDown,
        onResetRowHeights,
    } = props

    const columnGutter = AGGREGATE_COLUMN_GUTTER
    const rowGutter = AGGREGATE_ROW_GUTTER

    return (
        <div
            ref={gridRef}
            className="grid h-full min-h-0 min-w-0 overflow-hidden gap-0 p-1"
            style={{
                gridTemplateColumns: `minmax(0, ${widths[0]}fr) ${columnGutter} minmax(0, ${widths[1]}fr)`,
                gridTemplateRows: `minmax(0, ${heights[0]}fr) ${rowGutter} minmax(0, ${heights[1]}fr)`,
            }}
        >
            <div className="min-h-0 min-w-0" style={{ gridColumn: "1 / 4", gridRow: 1 }}>
                <AggregatePanelCell title={titles.attackPath}>{attackPath}</AggregatePanelCell>
            </div>
            <div className="min-h-0 min-w-0" style={{ gridColumn: 1, gridRow: 3 }}>
                <AggregatePanelCell title={titles.collaboration}>{collaboration}</AggregatePanelCell>
            </div>
            <div className="min-h-0 min-w-0" style={{ gridColumn: 3, gridRow: 3 }}>
                <AggregatePanelCell title={titles.memoryPath}>{memoryPath}</AggregatePanelCell>
            </div>
            <button
                type="button"
                aria-label="Resize left and right panels"
                title="Drag to resize left/right panels. Double-click to reset."
                className="group relative z-20 min-h-0 w-full cursor-col-resize touch-none border-0 bg-border/30 p-0 outline-none transition-colors hover:bg-primary/25 focus-visible:bg-primary/30"
                style={{ gridColumn: 2, gridRow: 3 }}
                onPointerDown={onColumnResizeStart}
                onKeyDown={onColumnResizeKeyDown}
                onDoubleClick={onResetColumnWidths}
            >
                <span className="pointer-events-none absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-border group-hover:bg-primary/70 group-focus-visible:bg-primary/70" />
            </button>
            <button
                type="button"
                aria-label="Resize top and bottom panels"
                title="Drag to resize top/bottom panels. Double-click to reset."
                className="group relative z-10 min-w-0 h-full w-full cursor-row-resize touch-none border-0 bg-border/30 p-0 outline-none transition-colors hover:bg-primary/25 focus-visible:bg-primary/30"
                style={{ gridColumn: "1 / 4", gridRow: 2 }}
                onPointerDown={onRowResizeStart}
                onKeyDown={onRowResizeKeyDown}
                onDoubleClick={onResetRowHeights}
            >
                <span className="pointer-events-none absolute inset-x-3 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border group-hover:bg-primary/70 group-focus-visible:bg-primary/70" />
            </button>
        </div>
    )
}

function CollaborationFlowPanel(props: {
    graph: FlowGraph
    suspended: boolean
    focusNodeId?: string
    autoFocus?: boolean
    fitViewOnLayout?: boolean
    fitBeforeFreezeKey?: number
    showMinimap?: boolean
    onNodeClick: NodeMouseHandler<FlowNode>
}) {
    const { graph, suspended, focusNodeId, autoFocus = true, fitViewOnLayout = false, fitBeforeFreezeKey, showMinimap = true, onNodeClick } = props
    return (
        <FlowCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            layoutMode="collaboration"
            nodeTypes={COMMUNICATION_NODE_TYPES}
            empty="No runtime events at this time."
            suspended={suspended}
            nodeWidth={SOLVER_AGENT_NODE_WIDTH}
            nodeHeight={SOLVER_AGENT_NODE_HEIGHT}
            spacing={44}
            layerSpacing={128}
            onNodeClick={onNodeClick}
            focusNodeId={focusNodeId}
            autoFocus={autoFocus}
            fitViewOnLayout={fitViewOnLayout}
            fitBeforeFreezeKey={fitBeforeFreezeKey}
            showMinimap={showMinimap}
        />
    )
}

function TimelineEventDetailDialog(props: { event?: AttackTimelineEvent; onOpenChange: (open: boolean) => void }) {
    const { event, onOpenChange } = props
    const { t } = useTranslation()
    const memory = event ? memoryFromEvent(event) : undefined
    const idea = event ? ideaFromEvent(event) : undefined
    const hasStructuredDetail = Boolean(memory || idea)

    return (
        <Dialog open={Boolean(event)} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[82vh] max-w-2xl overflow-y-auto overflow-x-hidden">
                {event ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>{timelineEventTitle(event, t)}</DialogTitle>
                            <DialogDescription>
                                {event.kind} · {shortTime(event.timestamp)}{event.solverId ? ` · ${event.solverId}` : ""}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="min-w-0 space-y-4 text-sm">
                            {!hasStructuredDetail ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</div>
                                    <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3">{event.summary || "No summary."}</div>
                                </section>
                            ) : null}
                            {memory ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">情报</div>
                                    <div className="min-w-0 rounded-lg border bg-flow-memory-bg/60 p-3 text-flow-memory-fg">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="outline">{memory.kind}</Badge>
                                            <span className="text-xs opacity-70">{memory.source}</span>
                                        </div>
                                        <div className="mt-3 whitespace-pre-wrap break-words text-base leading-relaxed">{memory.content}</div>
                                        {memory.refs.length > 0 ? <div className="mt-3 break-words text-xs opacity-70">refs: {memory.refs.join(", ")}</div> : null}
                                        <div className="mt-3 grid gap-1 text-xs opacity-70 sm:grid-cols-2">
                                            <div>Created: {memory.created_at}</div>
                                            <div>Updated: {memory.updated_at}</div>
                                        </div>
                                    </div>
                                </section>
                            ) : null}
                            {idea ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">战术</div>
                                    <div className="min-w-0 rounded-lg border bg-flow-idea-bg/70 p-3 text-flow-idea-fg">
                                        <Badge variant="outline">{idea.status}</Badge>
                                        <div className="mt-3 whitespace-pre-wrap break-words text-base leading-relaxed">{idea.content}</div>
                                        {idea.result ? (
                                            <div className="mt-3 rounded-md border border-flow-idea/30 bg-flow-default-bg/60 p-3">
                                                <div className="mb-1 text-xs font-medium uppercase tracking-wide opacity-70">Result</div>
                                                <div className="whitespace-pre-wrap break-words leading-relaxed">{idea.result}</div>
                                            </div>
                                        ) : null}
                                        <div className="mt-3 grid gap-1 text-xs opacity-70 sm:grid-cols-2">
                                            <div>Created: {idea.created_at}</div>
                                            <div>Updated: {idea.updated_at}</div>
                                        </div>
                                    </div>
                                </section>
                            ) : null}
                        </div>
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

type KnowledgeDetail =
    | { kind: "task"; challenge?: ChallengeInfoRecord; memoryCount: number; ideaCount: number }
    | { kind: "memory"; item: MemoryEntry }
    | { kind: "idea"; item: IdeaRecord }

function KnowledgeDetailDialog(props: { detail?: KnowledgeDetail; onOpenChange: (open: boolean) => void }) {
    const { detail, onOpenChange } = props
    return (
        <Dialog open={Boolean(detail)} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[82vh] max-w-2xl overflow-y-auto overflow-x-hidden">
                {detail ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>
                                {detail.kind === "task" ? detail.challenge?.title ?? "Task" : detail.kind === "memory" ? "情报" : "战术"}
                            </DialogTitle>
                            <DialogDescription>
                                {detail.kind === "task"
                                    ? `${detail.memoryCount} 条情报 · ${detail.ideaCount} 个活跃战术`
                                    : detail.kind === "memory"
                                      ? `${detail.item.id} · ${detail.item.kind}`
                                      : `${detail.item.id} · ${detail.item.status}`}
                            </DialogDescription>
                        </DialogHeader>
                        {detail.kind === "task" ? (
                            <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
                                {detail.challenge?.description || "No task description."}
                            </div>
                        ) : detail.kind === "memory" ? (
                            <div className="space-y-3 text-sm">
                                <div className="flex flex-wrap gap-2">
                                    <Badge variant="outline">{detail.item.kind}</Badge>
                                    <Badge variant="outline">{detail.item.source}</Badge>
                                </div>
                                <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 leading-relaxed">{detail.item.content}</div>
                                {detail.item.refs.length > 0 ? <div className="break-words text-xs text-muted-foreground">refs: {detail.item.refs.join(", ")}</div> : null}
                                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>Created: {detail.item.created_at}</div>
                                    <div>Updated: {detail.item.updated_at}</div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3 text-sm">
                                <Badge variant="outline">{detail.item.status}</Badge>
                                <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 leading-relaxed">{detail.item.content}</div>
                                {detail.item.result ? (
                                    <div className="rounded-lg border bg-flow-idea-bg/50 p-3">
                                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Result</div>
                                        <div className="whitespace-pre-wrap break-words leading-relaxed">{detail.item.result}</div>
                                    </div>
                                ) : null}
                                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>Created: {detail.item.created_at}</div>
                                    <div>Updated: {detail.item.updated_at}</div>
                                </div>
                            </div>
                        )}
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

export function AttackFlow({ challengeId, initialTab, presentationFullscreen = false }: AttackFlowProps) {
    const [snapshot, setSnapshot] = useState<AttackTimelineSnapshot | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [challengeInfo, setChallengeInfo] = useState<ChallengeInfoRecord | undefined>()
    const [boardMemory, setBoardMemory] = useState<MemoryEntry[]>([])
    const [boardIdeas, setBoardIdeas] = useState<IdeaRecord[]>([])
    const [cursorIndex, setCursorIndex] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>("1")
    const [selectedSolverId, setSelectedSolverId] = useState<string | undefined>()
    const [selectedEvent, setSelectedEvent] = useState<AttackTimelineEvent | undefined>()
    const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeDetail | undefined>()
    const [panelWidths, setPanelWidths] = useState(DEFAULT_PANEL_WIDTHS)
    const [graphHeights, setGraphHeights] = useState(DEFAULT_GRAPH_HEIGHTS)
    const [aggregateWidths, setAggregateWidths] = useState(DEFAULT_PANEL_WIDTHS)
    const [aggregateHeights, setAggregateHeights] = useState(DEFAULT_GRAPH_HEIGHTS)
    const [isResizingLayout, setIsResizingLayout] = useState(false)
    const panelGridRef = useRef<HTMLDivElement | null>(null)
    const graphGridRef = useRef<HTMLDivElement | null>(null)
    const aggregateGridRef = useRef<HTMLDivElement | null>(null)
    const tabsContentFullscreenRef = useRef<HTMLDivElement | null>(null)
    const [isTabsContentFullscreen, setIsTabsContentFullscreen] = useState(false)
    const [collaborationFitBeforeFreezeKey, setCollaborationFitBeforeFreezeKey] = useState<number | undefined>()
    const wasCollaborationFrozenRef = useRef(false)

    const events = snapshot?.events ?? []
    const visibleEvents = events.slice(0, cursorIndex)
    const currentEvent = cursorIndex > 0 ? events[Math.min(cursorIndex - 1, events.length - 1)] : undefined
    const solverIds = useMemo(() => solverIdsFromEvents(events.slice(0, cursorIndex)), [snapshot?.events, cursorIndex])
    const { t } = useTranslation()

    const [ currentAttackFlowTab, setCurrentAttackFlowTab ] = useState<AttackFlowTab>(initialTab ?? "attack-path")
    const [finished, setFinished] = useState(false)
    const [ needLoop, setNeedLoop ] = useState<boolean>(true)
    const { open, isMobile } = useSidebar()
    const tabIdRef = useRef("")
    const broadcastChannelRef = useRef<BroadcastChannel | null>(null)
    const latestSyncVersionRef = useRef(0)
    const eventsLengthRef = useRef(0)
    const didHandleFullscreenRef = useRef(false)
    const syncStateRef = useRef<AttackFlowSyncState>({
        cursorIndex,
        isPlaying,
        playbackSpeed,
        needLoop,
        selectedSolverId,
    })
    if (!tabIdRef.current) {
        tabIdRef.current =
            typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    useEffect(() => {
        if (initialTab) setCurrentAttackFlowTab(initialTab)
    }, [initialTab])

    useEffect(() => {
        eventsLengthRef.current = events.length
    }, [events.length])

    useEffect(() => {
        syncStateRef.current = {
            cursorIndex,
            isPlaying,
            playbackSpeed,
            needLoop,
            selectedSolverId,
        }
    }, [cursorIndex, isPlaying, needLoop, playbackSpeed, selectedSolverId])

    function boundedCursorIndex(value: number, length = events.length) {
        if (!Number.isFinite(value)) return 0
        return Math.min(Math.max(0, Math.round(value)), length)
    }

    function publishSyncState(state: AttackFlowSyncState) {
        const channel = broadcastChannelRef.current
        if (!channel) return
        const updatedAt = Math.max(Date.now(), latestSyncVersionRef.current + 1)
        latestSyncVersionRef.current = updatedAt
        channel.postMessage({
            type: "attack-flow-state",
            challengeId,
            sourceTabId: tabIdRef.current,
            updatedAt,
            ...state,
        } satisfies AttackFlowSyncMessage)
    }

    function applyLocalSyncState(patch: Partial<AttackFlowSyncState>) {
        const current = syncStateRef.current
        const next: AttackFlowSyncState = {
            cursorIndex: boundedCursorIndex(patch.cursorIndex ?? current.cursorIndex),
            isPlaying: patch.isPlaying ?? current.isPlaying,
            playbackSpeed: patch.playbackSpeed ?? current.playbackSpeed,
            needLoop: patch.needLoop ?? current.needLoop,
            selectedSolverId: "selectedSolverId" in patch ? patch.selectedSolverId : current.selectedSolverId,
        }
        syncStateRef.current = next
        setCursorIndex(next.cursorIndex)
        setIsPlaying(next.isPlaying)
        setPlaybackSpeed(next.playbackSpeed)
        setNeedLoop(next.needLoop)
        setSelectedSolverId(next.selectedSolverId)
        publishSyncState(next)
    }

    useEffect(() => {
        if (typeof BroadcastChannel === "undefined") return
        latestSyncVersionRef.current = 0
        const channel = new BroadcastChannel(`attack-flow:${challengeId}`)
        broadcastChannelRef.current = channel
        channel.onmessage = (event) => {
            if (!isAttackFlowSyncMessage(event.data)) return
            const message = event.data
            if (message.challengeId !== challengeId) return
            if (message.sourceTabId === tabIdRef.current) return
            if (message.updatedAt <= latestSyncVersionRef.current) return
            latestSyncVersionRef.current = message.updatedAt
            const next: AttackFlowSyncState = {
                cursorIndex: boundedCursorIndex(message.cursorIndex, eventsLengthRef.current),
                isPlaying: message.isPlaying,
                playbackSpeed: message.playbackSpeed,
                needLoop: message.needLoop,
                selectedSolverId: message.selectedSolverId,
            }
            syncStateRef.current = next
            setCursorIndex(next.cursorIndex)
            setIsPlaying(message.isPlaying)
            setPlaybackSpeed(message.playbackSpeed)
            setNeedLoop(message.needLoop)
            setSelectedSolverId(message.selectedSolverId)
        }
        return () => {
            channel.close()
            if (broadcastChannelRef.current === channel) broadcastChannelRef.current = null
        }
    }, [challengeId])

    useEffect(() => {
        if (!didHandleFullscreenRef.current) {
            didHandleFullscreenRef.current = true
            return
        }
        applyLocalSyncState({ isPlaying: isTabsContentFullscreen })
    }, [isTabsContentFullscreen])

    useEffect(() => {
        function handleFullscreenChange() {
            const isFullscreen = document.fullscreenElement === tabsContentFullscreenRef.current
            setIsTabsContentFullscreen(isFullscreen)
            window.dispatchEvent(new Event("resize"))
        }
        document.addEventListener("fullscreenchange", handleFullscreenChange)
        return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
    }, [])

    async function toggleTabsContentFullscreen() {
        if (document.fullscreenElement === tabsContentFullscreenRef.current) {
            await document.exitFullscreen()
            return
        }
        await tabsContentFullscreenRef.current?.requestFullscreen()
    }

    function leavePresentationMode() {
        location.hash = `#/challenge/${encodeURIComponent(challengeId)}/attack-flow?tab=${encodeURIComponent(currentAttackFlowTab)}`
    }

    async function exitPresentationFullscreen() {
        if (document.fullscreenElement) await document.exitFullscreen()
        leavePresentationMode()
    }

    async function enterTabsContentFullscreen() {
        if (document.fullscreenElement === tabsContentFullscreenRef.current) return
        if (document.fullscreenElement) await document.exitFullscreen()
        await tabsContentFullscreenRef.current?.requestFullscreen()
    }

    function toggleReplayPlayback() {
        if (events.length === 0) return
        if (isPlaying) {
            applyLocalSyncState({ isPlaying: false })
            return
        }
        applyLocalSyncState({ cursorIndex: cursorIndex >= events.length ? 0 : cursorIndex, isPlaying: true })
    }

    function nudgeReplayCursor(delta: number) {
        if (events.length === 0) return
        applyLocalSyncState({ isPlaying: false, cursorIndex: boundedCursorIndex(cursorIndex + delta) })
    }

    useEffect(() => {
        function handleAttackFlowShortcut(event: globalThis.KeyboardEvent) {
            if (shouldIgnoreAttackFlowShortcut(event)) return

            const tab = ATTACK_FLOW_SHORTCUT_TABS[event.key]
            if (tab) {
                event.preventDefault()
                setCurrentAttackFlowTab(tab)
                void enterTabsContentFullscreen()
                return
            }

            if (event.key === " " || event.code === "Space") {
                event.preventDefault()
                toggleReplayPlayback()
                return
            }

            if (event.key === "ArrowLeft") {
                event.preventDefault()
                nudgeReplayCursor(-1)
                return
            }

            if (event.key === "ArrowRight") {
                event.preventDefault()
                nudgeReplayCursor(1)
            }
        }

        window.addEventListener("keydown", handleAttackFlowShortcut, { capture: true })
        return () => window.removeEventListener("keydown", handleAttackFlowShortcut, { capture: true })
    }, [cursorIndex, events.length, isPlaying])

    useEffect(() => {
        if (!presentationFullscreen) return

        function handlePresentationFullscreenChange() {
            if (!document.fullscreenElement) leavePresentationMode()
        }

        document.addEventListener("fullscreenchange", handlePresentationFullscreenChange)
        return () => document.removeEventListener("fullscreenchange", handlePresentationFullscreenChange)
    }, [challengeId, currentAttackFlowTab, presentationFullscreen])

    useEffect(() => {
        let active = true
        setLoading(true)
        setError("")
        void Promise.all([challenges.attackTimeline(challengeId), challenges.get(challengeId)])
            .then(([next, details]) => {
                if (!active) return
                setSnapshot(next)
                setChallengeInfo(details.challenge)
                setBoardMemory(details.memory)
                setBoardIdeas(details.ideas)
                setCursorIndex(0)
            })
            .catch((nextError) => {
                if (active) setError(nextError instanceof Error ? nextError.message : String(nextError))
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [challengeId])

    useEffect(() => {
        const source = new EventSource(eventSourceUrl(`/api/challenges/${encodeURIComponent(challengeId)}/attack-timeline/stream`))
        source.addEventListener("snapshot", (event) => {
            const next = JSON.parse((event as MessageEvent).data) as AttackTimelineSnapshot
            startTransition(() => {
                setSnapshot(next)
                setCursorIndex((current) => Math.min(current, next.events.length))
            })
            void challenges.get(challengeId).then((details) => {
                startTransition(() => {
                    setChallengeInfo(details.challenge)
                    setBoardMemory(details.memory)
                    setBoardIdeas(details.ideas)
                })
            }).catch(() => {
                // The stream snapshot remains usable if a board refresh races a write.
            })
        })
        source.onerror = () => {
            source.close()
        }
        return () => source.close()
    }, [challengeId])

    useEffect(() => {
        if (!finished || !needLoop) return
        const timer = window.setTimeout(() => {
            setCursorIndex(1)
            setIsPlaying(true)
        }, REPLAY_LOOP_PAUSE_MS)
        return () => window.clearTimeout(timer)
    }, [finished, needLoop])

    useEffect(() => {
        setFinished(cursorIndex >= events.length)

        if (!isPlaying) return
        if (cursorIndex >= events.length) {
            setIsPlaying(false)
            return
        }
        const timer = window.setTimeout(() => {
            setCursorIndex((current) => Math.min(current + 1, events.length))
        }, Math.max(40, REPLAY_STEP_MS / Number(playbackSpeed)))
        return () => window.clearTimeout(timer)
    }, [cursorIndex, events.length, isPlaying, playbackSpeed])

    useEffect(() => {
        if (selectedSolverId && solverIds.includes(selectedSolverId)) return
        if (selectedSolverId) setSelectedSolverId(undefined)
    }, [selectedSolverId, solverIds])

    function handleSelectSolver(solverId: string | undefined) {
        applyLocalSyncState({ selectedSolverId: solverId })
    }

    const knowledgeGraph = useMemo(
        () => buildKnowledgeGraphFromBoard(boardMemory, boardIdeas, events, currentEvent?.timestamp, challengeInfo),
        [boardIdeas, boardMemory, challengeInfo, currentEvent?.timestamp, events],
    )
    const currentProcessEvent = useMemo(() => keyTimelineEvents(visibleEvents).at(-1), [visibleEvents])
    const goalAchievedEvent = useMemo(() => firstGoalAchievedEvent(keyTimelineEvents(events)), [events])
    const communicationGraph = useMemo(
        () => buildCommunicationGraph(challengeId, visibleEvents, t, currentProcessEvent, challengeInfo, selectedSolverId, handleSelectSolver, goalAchievedEvent?.id),
        [challengeId, challengeInfo, currentProcessEvent, goalAchievedEvent?.id, selectedSolverId, t, visibleEvents],
    )
    const knowledgeFocusNodeIdValue = knowledgeFocusNodeId(currentProcessEvent)
    const playbackCommunicationFocusNodeId = currentProcessEvent?.solverId ? `topology:solver:${currentProcessEvent.solverId}` : currentProcessEvent ? "topology:task" : undefined
    const communicationFocusNodeId = selectedSolverId ? `topology:solver:${selectedSolverId}` : playbackCommunicationFocusNodeId
    const collaborationRemaining = events.length - cursorIndex
    const collaborationVisible = currentAttackFlowTab === "solver-agent-collaboration" || currentAttackFlowTab === "aggregate-view"
    const collaborationFocusDisabled = isTabsContentFullscreen || presentationFullscreen
    const collaborationFocusFrozen = !collaborationFocusDisabled && collaborationVisible && collaborationRemaining <= COLLABORATION_FOCUS_FREEZE_REMAINING

    useEffect(() => {
        if (!collaborationVisible || collaborationFocusDisabled) {
            wasCollaborationFrozenRef.current = false
            setCollaborationFitBeforeFreezeKey(undefined)
            return
        }

        if (collaborationFocusFrozen && !wasCollaborationFrozenRef.current) {
            setCollaborationFitBeforeFreezeKey(cursorIndex)
            wasCollaborationFrozenRef.current = true
            return
        }

        if (!collaborationFocusFrozen) {
            wasCollaborationFrozenRef.current = false
            setCollaborationFitBeforeFreezeKey(undefined)
        }
    }, [collaborationFocusDisabled, collaborationFocusFrozen, collaborationVisible, cursorIndex])

    function handleNodeClick(_event: React.MouseEvent, node: FlowNode) {
        if (node.data.graphRole === "task") {
            setSelectedKnowledge({ kind: "task", challenge: challengeInfo, memoryCount: boardMemory.length, ideaCount: boardIdeas.filter((idea) => idea.status === "pending" || idea.status === "testing").length })
            return
        }
        if (node.data.graphRole === "memory" && node.data.rawId) {
            const item = isMemoryEntryRecord(node.data.knowledgeRecord) ? node.data.knowledgeRecord : boardMemory.find((memory) => memory.id === node.data.rawId)
            if (item) setSelectedKnowledge({ kind: "memory", item })
            return
        }
        if (node.data.graphRole === "idea" && node.data.rawId) {
            const item = isIdeaRecord(node.data.knowledgeRecord) ? node.data.knowledgeRecord : boardIdeas.find((idea) => idea.id === node.data.rawId)
            if (item) setSelectedKnowledge({ kind: "idea", item })
            return
        }
        const solverId = node.data.solverId
        if (!solverId) return
        handleSelectSolver(solverId)
    }

    function handlePanelResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = panelGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const width = grid.getBoundingClientRect().width
        if (width <= 0) return

        event.preventDefault()
        const startX = event.clientX
        const startWidths = [...panelWidths]
        let nextWidths = startWidths
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientX - startX) / width) * 100
            nextWidths = resizePanelWidths(startWidths, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.setProperty("--attack-flow-panels", `minmax(300px, ${nextWidths[0]}fr) 12px minmax(360px, ${nextWidths[1]}fr)`)
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.setProperty("--attack-flow-panels", `minmax(300px, ${nextWidths[0]}fr) 12px minmax(360px, ${nextWidths[1]}fr)`)
            setPanelWidths(nextWidths)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handlePanelResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const delta = event.key === "ArrowRight" ? PANEL_KEYBOARD_STEP : -PANEL_KEYBOARD_STEP
        setPanelWidths((current) => resizePanelWidths(current, delta))
    }

    function handleResetPanelWidths() {
        setPanelWidths(DEFAULT_PANEL_WIDTHS)
    }

    function handleGraphResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = graphGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const height = grid.getBoundingClientRect().height
        if (height <= 0) return

        event.preventDefault()
        const startY = event.clientY
        const startHeights = [...graphHeights]
        let nextHeights = startHeights
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "row-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientY - startY) / height) * 100
            nextHeights = resizeGraphHeights(startHeights, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.setProperty("--attack-flow-graphs", `minmax(0, ${nextHeights[0]}fr) 12px minmax(0, ${nextHeights[1]}fr)`)
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.setProperty("--attack-flow-graphs", `minmax(0, ${nextHeights[0]}fr) 12px minmax(0, ${nextHeights[1]}fr)`)
            setGraphHeights(nextHeights)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handleGraphResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? GRAPH_KEYBOARD_STEP : -GRAPH_KEYBOARD_STEP
        setGraphHeights((current) => resizeGraphHeights(current, delta))
    }

    function handleResetGraphHeights() {
        setGraphHeights(DEFAULT_GRAPH_HEIGHTS)
    }

    function handleAggregateColumnResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = aggregateGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const width = grid.getBoundingClientRect().width
        if (width <= 0) return

        event.preventDefault()
        const startX = event.clientX
        const startWidths = [...aggregateWidths]
        let nextWidths = startWidths
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientX - startX) / width) * 100
            nextWidths = resizePanelWidths(startWidths, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.gridTemplateColumns = `minmax(0, ${nextWidths[0]}fr) ${AGGREGATE_COLUMN_GUTTER} minmax(0, ${nextWidths[1]}fr)`
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.gridTemplateColumns = `minmax(0, ${nextWidths[0]}fr) ${AGGREGATE_COLUMN_GUTTER} minmax(0, ${nextWidths[1]}fr)`
            setAggregateWidths(nextWidths)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handleAggregateColumnResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const delta = event.key === "ArrowRight" ? PANEL_KEYBOARD_STEP : -PANEL_KEYBOARD_STEP
        setAggregateWidths((current) => resizePanelWidths(current, delta))
    }

    function handleResetAggregateColumnWidths() {
        setAggregateWidths(DEFAULT_PANEL_WIDTHS)
    }

    function handleAggregateRowResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = aggregateGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const height = grid.getBoundingClientRect().height
        if (height <= 0) return

        event.preventDefault()
        const startY = event.clientY
        const startHeights = [...aggregateHeights]
        let nextHeights = startHeights
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "row-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientY - startY) / height) * 100
            nextHeights = resizeGraphHeights(startHeights, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.gridTemplateRows = `minmax(0, ${nextHeights[0]}fr) ${AGGREGATE_ROW_GUTTER} minmax(0, ${nextHeights[1]}fr)`
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.gridTemplateRows = `minmax(0, ${nextHeights[0]}fr) ${AGGREGATE_ROW_GUTTER} minmax(0, ${nextHeights[1]}fr)`
            setAggregateHeights(nextHeights)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handleAggregateRowResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? GRAPH_KEYBOARD_STEP : -GRAPH_KEYBOARD_STEP
        setAggregateHeights((current) => resizeGraphHeights(current, delta))
    }

    function handleResetAggregateRowHeights() {
        setAggregateHeights(DEFAULT_GRAPH_HEIGHTS)
    }

    const panelGridStyle = {
        "--attack-flow-panels": `minmax(300px, ${panelWidths[0]}fr) 12px minmax(360px, ${panelWidths[1]}fr)`,
        "--attack-flow-graphs": `minmax(0, ${graphHeights[0]}fr) 12px minmax(0, ${graphHeights[1]}fr)`,
    } as CSSProperties

    const attackPathView = (overviewDefaultCollapsed = false) => (
        <TimelinePanel
            events={visibleEvents}
            selectedSolverId={selectedSolverId}
            onSelectSolver={handleSelectSolver}
            onSelectEvent={setSelectedEvent}
            activeEventId={currentProcessEvent?.id}
            autoFollow={Boolean(currentProcessEvent)}
            overviewDefaultCollapsed={overviewDefaultCollapsed}
            compactOverview={overviewDefaultCollapsed}
        />
    )

    const memoryPathView = (showMinimap = true) => (
        <div className="h-full min-h-0 min-w-0 overflow-hidden border border-flow-knowledge-border bg-gradient-to-br from-flow-default-bg to-flow-hint-bg/40">
            <div className="h-full min-h-0 overflow-hidden">
                <FlowCanvas
                    nodes={knowledgeGraph.nodes}
                    edges={knowledgeGraph.edges}
                    layoutEdges={knowledgeGraph.layoutEdges}
                    layoutKey={buildKnowledgeGraphLayoutKey(knowledgeGraph)}
                    contentKey={buildKnowledgeGraphContentKey(knowledgeGraph)}
                    layoutMode="elk"
                    empty="No memory or ideas at this time."
                    suspended={isResizingLayout}
                    direction="DOWN"
                    nodeWidth={240}
                    nodeHeight={92}
                    spacing={54}
                    layerSpacing={96}
                    nodesDraggable
                    focusNodeId={knowledgeFocusNodeIdValue}
                    onNodeClick={handleNodeClick}
                    showMinimap={showMinimap}
                />
            </div>
        </div>
    )

    const collaborationView = (showMinimap = true) => (
        <CollaborationFlowPanel
            graph={communicationGraph}
            suspended={isResizingLayout}
            focusNodeId={collaborationFocusDisabled || collaborationFocusFrozen ? undefined : communicationFocusNodeId}
            autoFocus={!collaborationFocusDisabled && !collaborationFocusFrozen}
            fitViewOnLayout={collaborationFocusDisabled}
            fitBeforeFreezeKey={!collaborationFocusDisabled && collaborationFocusFrozen ? collaborationFitBeforeFreezeKey : undefined}
            onNodeClick={handleNodeClick}
            showMinimap={showMinimap}
        />
    )

    const aggregateTitles = {
        attackPath: t("flow.attack-path"),
        memoryPath: t("flow.memory-path"),
        collaboration: t("flow.solver-agent-collaboration"),
    }

    if (loading && !snapshot) return <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading attack timeline...</CardContent></Card>
    if (error) return <Card><CardContent className="p-6 text-sm text-destructive">{error}</CardContent></Card>

    return (
        <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <Tabs 
                value={currentAttackFlowTab}
                className={"h-full flex flex-col min-h-0"}
                onValueChange={(value) => setCurrentAttackFlowTab(isAttackFlowTab(value) ? value : "attack-path")}>
                {!presentationFullscreen ? (
                    <TabsList>
                        <TabsTrigger value="attack-path">{t("flow.attack-path")}</TabsTrigger>
                        <TabsTrigger value="memory-path">{t("flow.memory-path")}</TabsTrigger>
                        <TabsTrigger value="solver-agent-collaboration">{t("flow.solver-agent-collaboration")}</TabsTrigger>
                        <TabsTrigger value="aggregate-view">{t("flow.aggregate-view")}</TabsTrigger>
                    </TabsList>
                ) : null}
                <div
                    ref={tabsContentFullscreenRef}
                    className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
                >
                    {isTabsContentFullscreen || presentationFullscreen ? (
                        <Button
                            variant="outline"
                            size="sm"
                            className="absolute top-3 right-3 z-10 bg-background/90 shadow-sm backdrop-blur"
                            onClick={() => void (presentationFullscreen ? exitPresentationFullscreen() : toggleTabsContentFullscreen())}
                            aria-label={t("flow.exitFullscreen")}
                        >
                            <Minimize2Icon className="size-4" />
                            {t("flow.exitFullscreen")}
                        </Button>
                    ) : null}
                    <TabsContent value="attack-path" className={"flex-1 min-h-0 overflow-hidden mt-0"}>
                        {attackPathView()}
                    </TabsContent>
                    <TabsContent value="memory-path" className="flex-1 min-h-0 overflow-hidden mt-0">
                        {memoryPathView()}
                    </TabsContent>
                    <TabsContent value="solver-agent-collaboration" className="flex-1 min-h-0 overflow-hidden mt-0">
                        {collaborationView()}
                    </TabsContent>
                    <TabsContent value="aggregate-view" className="flex-1 min-h-0 overflow-hidden mt-0">
                        <AggregateGridPanel
                            gridRef={aggregateGridRef}
                            widths={aggregateWidths}
                            heights={aggregateHeights}
                            titles={aggregateTitles}
                            attackPath={attackPathView(true)}
                            memoryPath={memoryPathView(false)}
                            collaboration={collaborationView(false)}
                            onColumnResizeStart={handleAggregateColumnResizeStart}
                            onColumnResizeKeyDown={handleAggregateColumnResizeKeyDown}
                            onResetColumnWidths={handleResetAggregateColumnWidths}
                            onRowResizeStart={handleAggregateRowResizeStart}
                            onRowResizeKeyDown={handleAggregateRowResizeKeyDown}
                            onResetRowHeights={handleResetAggregateRowHeights}
                        />
                    </TabsContent>
                </div>
            </Tabs>

            <Dialog open={Boolean(selectedSolverId)} onOpenChange={(open) => !open && handleSelectSolver(undefined)}>
                <DialogContent className="max-h-[82vh] max-w-5xl overflow-hidden p-0">
                    {selectedSolverId ? (
                        <div className="flex max-h-[82vh] min-h-0 flex-col">
                            <DialogHeader className="border-b p-4 pr-12">
                                <DialogTitle>Solver Timeline</DialogTitle>
                                <DialogDescription>Runtime message stream · {selectedSolverId}</DialogDescription>
                            </DialogHeader>
                            <div className="h-[62vh] min-h-0 overflow-hidden">
                                <SolverRuntimeTimeline solverId={selectedSolverId} timestamp={currentEvent?.timestamp} />
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>

            <TimelineEventDetailDialog event={selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(undefined)} />
            <KnowledgeDetailDialog detail={selectedKnowledge} onOpenChange={(open) => !open && setSelectedKnowledge(undefined)} />

            {!presentationFullscreen ? <div className={
                cn(
                    "fixed right-0 bottom-0 left-0 z-20 border-t bg-background/96 shadow-lg backdrop-blur",
                    !isMobile && open && "md:left-[var(--sidebar-width)]"
                  )
            }>
                <div className="flex flex-wrap items-center gap-3 px-4 py-2 md:px-6">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={toggleReplayPlayback}
                        disabled={events.length === 0}
                    >
                        {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
                        {isPlaying ? t("replay.pause") : t("replay.start")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            applyLocalSyncState({ isPlaying: false, cursorIndex: 0 })
                        }}
                        disabled={events.length === 0}
                    >
                        <RotateCcwIcon className="size-4" />
                        重置
                    </Button>
                    <Checkbox id="loop" checked={needLoop} onCheckedChange={(checked) => applyLocalSyncState({ needLoop: checked === "indeterminate" ? false : checked })} className="w-4 h-4" /> <span>循环播放</span>
                    <Select value={playbackSpeed} onValueChange={(value) => applyLocalSyncState({ playbackSpeed: isPlaybackSpeed(value) ? value : "1" })}>
                        <SelectTrigger size="sm" className="w-20">
                            <SelectValue>{playbackSpeed}x</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {PLAYBACK_SPEED_OPTIONS.map((speed) => (
                                <SelectItem key={speed} value={speed}>
                                    {speed}x
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Slider
                        className="min-w-0 flex-1 basis-64"
                        value={[Math.min(cursorIndex, events.length)]}
                        min={0}
                        max={Math.max(events.length, 1)}
                        step={1}
                        onValueChange={(value) => {
                            applyLocalSyncState({ isPlaying: false, cursorIndex: Array.isArray(value) ? (value[0] ?? 0) : value })
                        }}
                    />
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void toggleTabsContentFullscreen()}
                        aria-label={isTabsContentFullscreen ? t("flow.exitFullscreen") : t("flow.fullscreen")}
                    >
                        {isTabsContentFullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
                    </Button>
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {cursorIndex} / {events.length}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatTimelineTime(currentEvent?.timestamp)}</span>
                </div>
            </div> : null}
        </div>
    )
}

export function AttackFlowPage({ challengeId, initialSearch = "" }: AttackFlowProps & { initialSearch?: string }) {
    const { t } = useTranslation()
    const [challengeTitle, setChallengeTitle] = useState("")
    const initialParams = useMemo(() => new URLSearchParams(initialSearch), [initialSearch])
    const initialTab = useMemo(() => {
        const tab = initialParams.get("tab")
        return isAttackFlowTab(tab) ? tab : undefined
    }, [initialParams])
    const presentationFullscreen = initialParams.get("presentation") === "fullscreen"

    useEffect(() => {
        let active = true
        void challenges
            .get(challengeId)
            .then((details) => {
                if (active) setChallengeTitle(details.challenge.title)
            })
            .catch(() => {
                if (active) setChallengeTitle("")
            })
        return () => {
            active = false
        }
    }, [challengeId])

    return (
        <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden", presentationFullscreen ? "p-0" : "gap-3 p-4 pb-16")}>
            {!presentationFullscreen ? (
                <div className="flex shrink-0 items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="text-xl font-semibold">{t("flow.attack-path")}</div>
                        {challengeTitle ? <div className="truncate text-xs text-muted-foreground">{challengeTitle}</div> : null}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => (location.hash = `#/challenge/${encodeURIComponent(challengeId)}`)}>
                        {t("challenge.back")}
                    </Button>
                </div>
            ) : null}
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <AttackFlow challengeId={challengeId} initialTab={initialTab} presentationFullscreen={presentationFullscreen} />
            </div>
        </div>
    )
}
