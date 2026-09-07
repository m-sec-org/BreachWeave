import type { AgentTimeline, ExecutionOverviewData, Segment } from "../data/executionOverview"
import type { AttackTimelineEvent } from "./api"
import { eventToSegmentType, keyTimelineEvents, shortTimelineTime, solverMetasFromEvents, timelineLaneId } from "./timeline-key-events"

function buildAgentSegments(solverId: string, items: AttackTimelineEvent[]): Segment[] {
    const segments: Segment[] = []
    let current: Segment | undefined
    let lastEventIndex: number | undefined

    for (let index = 0; index < items.length; index++) {
        const event = items[index]
        if (timelineLaneId(event) !== solverId) continue

        const type = eventToSegmentType(event)
        if (current && current.type === type && current.end === index) {
            current.end = index + 1
        } else {
            if (current) {
                segments.push(current)
                current = undefined
            }
            if (lastEventIndex !== undefined && index > lastEventIndex + 1) {
                segments.push({ type: "empty", start: lastEventIndex + 1, end: index })
            }
            current = { type, start: index, end: index + 1 }
        }
        lastEventIndex = index
    }

    if (current) segments.push(current)
    return segments
}

function buildTimeLabels(items: AttackTimelineEvent[]): string[] {
    if (items.length === 0) return []
    const tickCount = Math.min(10, items.length)
    if (tickCount === 1) return [shortTimelineTime(items[0].timestamp)]

    const start = items[0].timestamp
    const end = items[items.length - 1].timestamp
    const labels: string[] = []

    for (let index = 0; index < tickCount; index++) {
        const ratio = tickCount === 1 ? 0 : index / (tickCount - 1)
        const timestamp = Math.round(start + (end - start) * ratio)
        labels.push(shortTimelineTime(timestamp))
    }

    return labels
}

function buildStats(items: AttackTimelineEvent[]): ExecutionOverviewData["stats"] {
    const stats = { normal: 0, spawn: 0, memory: 0, idea: 0, flag: 0, total: 0 }
    for (const event of items) {
        if (!event.solverId) continue
        const type = eventToSegmentType(event)
        if (type === "normal") stats.normal += 1
        if (type === "spawn") stats.spawn += 1
        if (type === "memory") stats.memory += 1
        if (type === "idea") stats.idea += 1
        if (type === "flag") stats.flag += 1
        stats.total += 1
    }
    return stats
}

export function buildExecutionOverviewFromTimeline(events: AttackTimelineEvent[]): ExecutionOverviewData {
    const items = keyTimelineEvents(events)
    if (items.length === 0) {
        return {
            columnCount: 0,
            times: [],
            agents: [],
            stats: { normal: 0, spawn: 0, memory: 0, idea: 0, flag: 0, total: 0 },
        }
    }

    const times = buildTimeLabels(items)
    const agents: AgentTimeline[] = solverMetasFromEvents(events).map((meta) => ({
        name: meta.promptName ?? meta.id,
        segments: buildAgentSegments(meta.id, items),
    }))

    return {
        startTime: shortTimelineTime(items[0].timestamp),
        endTime: shortTimelineTime(items[items.length - 1].timestamp),
        columnCount: items.length,
        times,
        agents,
        stats: buildStats(items),
    }
}
