import type { AttackTimelineEventKind } from "../../lib/api"
import type { AgentEventCardEvent } from "../../lib/solver-event-card-data"
import { topKindCounts } from "../../lib/solver-event-card-data"
import { cn } from "../../lib/utils"
import { BotIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { SOLVER_AGENT_CARD_HEIGHT, SOLVER_AGENT_CARD_WIDTH } from "./solver-agent-card.constants"

const kindStyle: Record<AttackTimelineEventKind, string> = {
    message: "border-flow-memory/40 bg-flow-memory/15 text-flow-memory-fg",
    tool_call: "border-flow-idea/40 bg-flow-idea/15 text-flow-idea-fg",
    tool_result: "border-flow-success/40 bg-flow-success/15 text-flow-success-fg",
    observer_reminder: "border-flow-observer/40 bg-flow-observer/15 text-flow-observer-fg",
    solver_started: "border-flow-default/40 bg-flow-default/15 text-flow-default-muted",
    solver_ended: "border-flow-default/40 bg-flow-default/15 text-flow-default-muted",
    memory_added: "border-flow-memory/40 bg-flow-memory/15 text-flow-memory-fg",
    memory_updated: "border-flow-memory/40 bg-flow-memory/15 text-flow-memory-fg",
    idea_added: "border-flow-idea/40 bg-flow-idea/15 text-flow-idea-fg",
    idea_updated: "border-flow-idea/40 bg-flow-idea/15 text-flow-idea-fg",
    report_submitted: "border-flow-flag/40 bg-flow-flag/15 text-flow-flag-fg",
}

const kindDotStyle: Record<AttackTimelineEventKind, string> = {
    message: "bg-flow-memory",
    tool_call: "bg-flow-idea",
    tool_result: "bg-flow-success",
    observer_reminder: "bg-flow-observer",
    solver_started: "bg-flow-default-muted",
    solver_ended: "bg-flow-default-muted",
    memory_added: "bg-flow-memory",
    memory_updated: "bg-flow-memory",
    idea_added: "bg-flow-idea",
    idea_updated: "bg-flow-idea",
    report_submitted: "bg-flow-flag",
}

function kindLabel(kind: AttackTimelineEventKind) {
    switch (kind) {
        case "memory_added":
            return "情报"
        case "memory_updated":
            return "情报更新"
        case "idea_added":
            return "战术"
        case "idea_updated":
            return "战术更新"
        case "solver_started":
            return "介入"
        case "solver_ended":
            return "结束"
        case "report_submitted":
            return "报告"
        case "observer_reminder":
            return "提醒"
        case "tool_call":
            return "调用"
        case "tool_result":
            return "结果"
        case "message":
            return "消息"
    }
}

export function AgentEventCard(props: {
    promptName: string
    eventCount: number
    recentEvents: readonly AgentEventCardEvent[]
    kindCounts: Partial<Record<AttackTimelineEventKind, number>>
    activityBuckets: readonly number[]
    selected?: boolean
    onViewAll?: () => void
}) {
    const { promptName, eventCount, recentEvents, kindCounts, activityBuckets, selected = false, onViewAll } = props
    const { t } = useTranslation()
    const footerKinds = topKindCounts(kindCounts, 3)
    const waveform = activityBuckets.length > 36 ? activityBuckets.filter((_, index) => index % 2 === 0) : activityBuckets

    return (
        <div
            className={cn(
                "flex flex-col gap-1.5 rounded-lg border border-flow-default bg-flow-default-bg px-3 py-2 text-flow-default-fg shadow-[0_8px_20px_rgba(15,23,42,0.08)]",
                selected && "ring-2 ring-flow-selected-ring/70 shadow-[0_0_0_4px_rgba(56,189,248,0.14)]",
            )}
            style={{ width: SOLVER_AGENT_CARD_WIDTH, height: SOLVER_AGENT_CARD_HEIGHT }}
        >
            <div className="flex shrink-0 min-w-0 items-start gap-2">
                <span
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-flow-default bg-flow-default-bg text-flow-default-muted"
                >
                    <BotIcon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-xs font-semibold tracking-wide text-flow-default-fg">{promptName}</div>
                    </div>
                </div>
            </div>

            <div
                className="flex h-5 shrink-0 items-end gap-px overflow-hidden border-b border-flow-default/30 pb-1"
            >
                {waveform.map((height, index) => (
                    <div
                        key={index}
                        className="w-1 rounded-t bg-flow-memory/60"
                        style={{ height: `${Math.max(3, Math.round(height * 0.45))}px` }}
                    />
                ))}
            </div>

            <div className="flex shrink-0 items-center justify-between">
                <div className="text-[10px] font-semibold text-flow-default-fg">{t("flow.agentCard.latestEvents")}</div>
                <button
                    type="button"
                    className="text-[10px] text-flow-memory hover:text-flow-memory-fg"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation()
                        onViewAll?.()
                    }}
                >
                    {t("flow.agentCard.viewAll", { count: eventCount })}
                </button>
            </div>

            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-1 pr-1 nodrag nowheel">
                {recentEvents.length === 0 ? (
                    <div className="rounded border border-flow-default/40 bg-flow-default-bg/60 px-2 py-2 text-[10px] text-flow-default-muted">
                        {t("replay.waiting")}
                    </div>
                ) : (
                    recentEvents.map((event, index) => (
                        <div
                            key={`${event.time}-${event.kind}-${index}`}
                            className="grid grid-cols-[52px_62px_1fr] gap-1.5 rounded border border-flow-default/40 bg-flow-default-bg/60 px-2 py-1 text-[10px]"
                        >
                            <div className="font-mono text-flow-default-muted">{event.time}</div>
                            <div className={cn("truncate rounded border px-1 py-px text-[9px]", kindStyle[event.kind])}>{kindLabel(event.kind)}</div>
                            <div className="min-w-0">
                                <div className="truncate font-medium text-flow-default-fg">{event.title}</div>
                                <div className="truncate text-[9px] text-flow-default-muted">{event.desc}</div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {footerKinds.length > 0 ? (
                <div
                    className="flex shrink-0 flex-wrap items-center gap-2 border-t border-flow-default/30 pt-1 text-[10px] text-flow-default-muted"
                >
                    {footerKinds.map(([kind, count]) => (
                        <span key={kind} className="inline-flex items-center gap-1">
                            <i className={cn("inline-block h-1.5 w-1.5 rounded-full", kindDotStyle[kind])} />
                            {kindLabel(kind)} {count}
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
