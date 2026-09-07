import type { TFunction } from "i18next"
import { SOLVER_AGENT_EVENT_LIMIT } from "../components/challenge/solver-agent-card.constants"
import type { AttackTimelineEvent, AttackTimelineEventKind } from "./api"
import type { SolverMeta } from "./timeline-key-events"
import { shortTimelineTime } from "./timeline-key-events"
import { timelineEventTitle } from "./timeline-event-title"

export interface AgentEventCardEvent {
    time: string
    kind: AttackTimelineEventKind
    title: string
    desc: string
}

export interface SolverCardData {
    promptName: string
    eventCount: number
    recentEvents: AgentEventCardEvent[]
    kindCounts: Partial<Record<AttackTimelineEventKind, number>>
    activityBuckets: number[]
}

const ACTIVITY_BUCKET_COUNT = 70
const MIN_BUCKET_HEIGHT = 8
const MAX_BUCKET_HEIGHT = 40

function solverEvents(events: AttackTimelineEvent[], solverId: string) {
    return events.filter((event) => event.solverId === solverId && event.kind !== "tool_result")
}

function buildActivityBuckets(items: AttackTimelineEvent[]): number[] {
    if (items.length === 0) {
        return Array.from({ length: ACTIVITY_BUCKET_COUNT }, () => MIN_BUCKET_HEIGHT)
    }

    const sorted = [...items].sort((left, right) => left.timestamp - right.timestamp)
    const start = sorted[0].timestamp
    const end = sorted[sorted.length - 1].timestamp
    const span = Math.max(end - start, 1)
    const counts = Array.from({ length: ACTIVITY_BUCKET_COUNT }, () => 0)

    for (const event of sorted) {
        const ratio = (event.timestamp - start) / span
        const index = Math.min(ACTIVITY_BUCKET_COUNT - 1, Math.floor(ratio * ACTIVITY_BUCKET_COUNT))
        counts[index] += 1
    }

    const maxCount = Math.max(...counts, 1)
    return counts.map((count) => {
        if (count === 0) return MIN_BUCKET_HEIGHT
        const normalized = MIN_BUCKET_HEIGHT + ((count / maxCount) * (MAX_BUCKET_HEIGHT - MIN_BUCKET_HEIGHT))
        return Math.round(normalized)
    })
}

function buildKindCounts(items: AttackTimelineEvent[]): Partial<Record<AttackTimelineEventKind, number>> {
    const counts: Partial<Record<AttackTimelineEventKind, number>> = {}
    for (const event of items) {
        counts[event.kind] = (counts[event.kind] ?? 0) + 1
    }
    return counts
}

function buildRecentEvents(items: AttackTimelineEvent[], t: TFunction): AgentEventCardEvent[] {
    return [...items]
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, SOLVER_AGENT_EVENT_LIMIT)
        .map((event) => ({
            time: shortTimelineTime(event.timestamp),
            kind: event.kind,
            title: timelineEventTitle(event, t),
            desc: event.summary,
        }))
}

export function buildSolverCardData(meta: SolverMeta, events: AttackTimelineEvent[], t: TFunction): SolverCardData {
    const items = solverEvents(events, meta.id)
    const promptName = meta.promptName ?? meta.id
    return {
        promptName,
        eventCount: items.length,
        recentEvents: buildRecentEvents(items, t),
        kindCounts: buildKindCounts(items),
        activityBuckets: buildActivityBuckets(items),
    }
}

export function topKindCounts(kindCounts: Partial<Record<AttackTimelineEventKind, number>>, limit = 3) {
    return Object.entries(kindCounts)
        .sort((left, right) => right[1] - left[1])
        .slice(0, limit) as Array<[AttackTimelineEventKind, number]>
}
