import type { AttackTimelineEvent } from "./api"
import type { SegmentType } from "../data/executionOverview"

function payloadObject(event: AttackTimelineEvent): Record<string, unknown> | undefined {
    return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : undefined
}

export function promptNameFromEvent(event: AttackTimelineEvent) {
    const payload = payloadObject(event)
    const attempt = payload?.attempt
    if (attempt && typeof attempt === "object" && typeof (attempt as { prompt_name?: unknown }).prompt_name === "string") {
        return (attempt as { prompt_name: string }).prompt_name
    }
    const solverStat = payload?.solverStat
    if (solverStat && typeof solverStat === "object" && typeof (solverStat as { prompt_name?: unknown }).prompt_name === "string") {
        return (solverStat as { prompt_name: string }).prompt_name
    }
    return
}

export interface SolverMeta {
    id: string
    promptName?: string
    firstSeen: number
    lastSeen: number
    eventCount: number
    observerEventCount: number
    latestTitle?: string
}

export function solverMetasFromEvents(events: AttackTimelineEvent[]): SolverMeta[] {
    const metas = new Map<string, SolverMeta>()
    for (const event of events) {
        if (!event.solverId) continue
        const current = metas.get(event.solverId) ?? {
            id: event.solverId,
            firstSeen: event.timestamp,
            lastSeen: event.timestamp,
            eventCount: 0,
            observerEventCount: 0,
        }
        current.firstSeen = Math.min(current.firstSeen, event.timestamp)
        current.lastSeen = Math.max(current.lastSeen, event.timestamp)
        current.eventCount += 1
        if (event.lane === "observer") current.observerEventCount += 1
        current.latestTitle = event.title
        current.promptName ??= promptNameFromEvent(event)
        metas.set(event.solverId, current)
    }
    return [...metas.values()].sort((left, right) => left.firstSeen - right.firstSeen || left.id.localeCompare(right.id))
}

export function keyTimelineEvents(events: AttackTimelineEvent[]) {
    return events.filter((event) => {
        if (event.kind === "message" || event.kind === "tool_call") return false
        if (event.kind === "tool_result" && !event.title.startsWith("challenge_submit_report")) return false
        if ((event.kind === "memory_updated" || event.kind === "idea_updated") && event.summary.trim().startsWith("|")) return false
        if ((event.kind === "memory_updated" || event.kind === "idea_updated") && event.summary.length < 24) return false
        if ((event.kind === "memory_added" || event.kind === "memory_updated" || event.kind === "idea_added" || event.kind === "idea_updated") && event.summary.startsWith("Validation failed for tool")) return false
        if ((event.kind === "memory_updated" || event.kind === "idea_updated") && /^(memory|idea) ".+" not found/.test(event.summary)) return false
        return true
    })
}

export function timelineLaneId(event: AttackTimelineEvent) {
    return event.solverId ?? "hub"
}

export function eventToSegmentType(event: AttackTimelineEvent): SegmentType {
    if (event.kind === "solver_started" || event.kind === "solver_ended") return "spawn"
    if (event.kind === "report_submitted") return "flag"
    if (event.kind === "tool_result" && event.title.startsWith("challenge_submit_report")) return "flag"
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "memory"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "idea"
    return "normal"
}

export function shortTimelineTime(value: number) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
