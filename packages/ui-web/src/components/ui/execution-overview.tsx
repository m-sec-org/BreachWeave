import { useState } from "react"
import type { ExecutionOverviewData, SegmentType } from "../../data/executionOverview"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { cn } from "../../lib/utils"

const typeStyle: Record<SegmentType, string> = {
    normal: "bg-flow-chart-primary shadow-flow-chart-primary/30",
    spawn: "bg-flow-success shadow-flow-success/30",
    memory: "bg-flow-memory shadow-flow-memory/30",
    idea: "bg-flow-idea shadow-flow-idea/30",
    flag: "bg-flow-success shadow-flow-success/30",
    empty: "bg-muted shadow-none",
}

const legends = [
    { label: "正常流程", type: "normal" as SegmentType },
    { label: "智能体介入", type: "spawn" as SegmentType },
    { label: "情报", type: "memory" as SegmentType },
    { label: "战术", type: "idea" as SegmentType },
    { label: "攻击成功", type: "flag" as SegmentType },
]

export function ExecutionOverview(props: {
    data: ExecutionOverviewData
    variant?: "default" | "overlay"
    collapsible?: boolean
    defaultCollapsed?: boolean
    compact?: boolean
}) {
    const { data, variant = "default", collapsible = false, defaultCollapsed = false, compact = false } = props
    const [collapsed, setCollapsed] = useState(defaultCollapsed)
    const isOverlay = variant === "overlay"
    const isCompact = isOverlay && compact
    const { times, agents, stats, columnCount = 0 } = data
    const max = Math.max(columnCount - 1, 1)
    const timeGridStyle = times.length > 0 ? { gridTemplateColumns: `repeat(${times.length}, minmax(0, 1fr))` } : undefined
    const rowGap = isCompact ? "space-y-2" : isOverlay ? "space-y-4" : "space-y-8"

    return (
        <div
            className={cn(
                "flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card/85 shadow-sm backdrop-blur-md supports-[backdrop-filter]:bg-card/70",
                isOverlay && !collapsed && (isCompact ? "max-h-[min(22vh,140px)]" : "max-h-[min(40vh,280px)]"),
            )}
        >
            <div
                className={cn(
                    "flex shrink-0 items-center justify-between border-b border-border/60 bg-card/85",
                    isCompact ? "px-2.5 py-1.5" : isOverlay ? "px-4 py-3" : "px-6 py-4",
                    collapsed && "border-b-0",
                )}
            >
                <div className="flex min-w-0 items-center gap-1.5">
                    <h2 className={cn("font-semibold text-foreground", isCompact ? "text-xs" : isOverlay ? "text-base" : "text-xl")}>执行概览</h2>
                    {collapsible ? (
                        <button
                            type="button"
                            className={cn(
                                "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                                isCompact ? "size-5" : "size-7",
                            )}
                            aria-expanded={!collapsed}
                            aria-label={collapsed ? "展开执行概览" : "收起执行概览"}
                            title={collapsed ? "展开" : "收起"}
                            onClick={() => setCollapsed((current) => !current)}
                        >
                            {collapsed ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
                        </button>
                    ) : null}
                </div>

                {!collapsed ? (
                    <div className={cn("flex items-center font-medium text-muted-foreground", isCompact ? "gap-2 text-[10px]" : isOverlay ? "gap-4 text-xs" : "gap-10 text-sm")}>
                        {legends.map((item) => (
                            <div key={item.type} className="flex items-center gap-2">
                                <span className={`h-3 w-3 rounded-full ${typeStyle[item.type]}`} />
                                <span>{item.label}</span>
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>

            {!collapsed && agents.length > 0 && times.length > 0 ? (
                <div className={cn("grid shrink-0 grid-cols-[180px_1fr] gap-4 bg-card/85", isCompact ? "px-2.5 pb-1" : isOverlay ? "px-4 pb-2" : "px-6 pb-3")}>
                    <div />
                    <div className={cn("grid font-semibold text-foreground", isOverlay ? "text-xs" : "text-sm")} style={timeGridStyle}>
                        {times.map((time, index) => (
                            <div key={`${time}-${index}`}>{time}</div>
                        ))}
                    </div>
                </div>
            ) : null}

            {!collapsed ? (
            <div className={cn("no-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto", isCompact ? "px-2.5" : isOverlay ? "px-4" : "px-6")}>
                {agents.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">暂无时间线事件</div>
                ) : (
                    <div className="grid grid-cols-[180px_1fr] gap-4 pb-4">
                        <div className={rowGap}>
                            {agents.map((agent, index) => (
                                <div key={`ov-${agent.name}-${index}`} className={cn("flex h-6 items-center font-semibold text-foreground", isOverlay ? "text-xs" : "text-sm")}>
                                    {agent.name}
                                </div>
                            ))}
                        </div>

                        <div className="relative">
                            <div className="absolute inset-0 grid" style={timeGridStyle}>
                                {times.map((time, index) => (
                                    <div key={`grid-${time}-${index}`} className="border-l border-border/60" />
                                ))}
                            </div>

                            <div className={cn("relative", rowGap)}>
                                {agents.map((agent, index) => (
                                    <div key={`o-${agent.name}-${index}`} className="relative h-6">
                                        {agent.segments.map((segment, index) => {
                                            const left = (segment.start / max) * 100
                                            const width = ((segment.end - segment.start) / max) * 100

                                            return (
                                                <div
                                                    key={`ov-${agent.name}-${index}-${segment.type}-${index}`}
                                                    className={`absolute top-1/2 h-2.5 min-w-1 -translate-y-1/2 rounded-full shadow-md ${typeStyle[segment.type]}`}
                                                    style={{
                                                        left: `${left}%`,
                                                        width: `max(${width}%, 4px)`,
                                                    }}
                                                />
                                            )
                                        })}
                                    </div>
                                ))}
                            </div>

                            <div className="absolute inset-y-0 -right-8 w-0.5 bg-flow-chart-primary">
                                <div className="absolute -left-1.5 -top-1.5 h-3.5 w-3.5 rounded-full bg-flow-chart-primary" />
                            </div>
                        </div>
                    </div>
                )}
            </div>
            ) : null}

            {!collapsed ? (
            <div
                className={cn(
                    "flex shrink-0 items-center justify-between border-t border-border/60 bg-card/85 text-sm",
                    isCompact ? "gap-2 px-2.5 py-2" : isOverlay ? "gap-4 px-4 py-3" : "px-6 py-4",
                )}
            >
                <div className={cn("flex items-center", isCompact ? "gap-3" : isOverlay ? "gap-6" : "gap-14")}>
                    <Stat type="normal" label="正常流程" value={stats.normal} compact={isOverlay} dense={isCompact} />
                    <Stat type="spawn" label="智能体介入" value={stats.spawn} compact={isOverlay} dense={isCompact} />
                    <Stat type="memory" label="情报节点" value={stats.memory} compact={isOverlay} dense={isCompact} />
                    <Stat type="idea" label="战术节点" value={stats.idea} compact={isOverlay} dense={isCompact} />
                    <Stat type="flag" label="报告提交" value={stats.flag} compact={isOverlay} dense={isCompact} />
                </div>

                <div className={cn("font-semibold text-muted-foreground", isCompact && "text-xs")}>
                    总节点数：<span className="text-flow-chart-primary">{stats.total}</span>
                </div>
            </div>
            ) : null}
        </div>
    )
}

function Stat({ type, label, value, compact, dense }: { type: SegmentType; label: string; value: number; compact?: boolean; dense?: boolean }) {
    return (
        <div className={cn("flex items-center", dense ? "gap-1" : compact ? "gap-2" : "gap-3")}>
            <span className={cn("rounded-full", dense ? "h-2 w-2" : "h-3 w-3", typeStyle[type])} />
            <span className={cn("font-medium text-muted-foreground", dense ? "text-[10px]" : compact && "text-xs")}>{label}</span>
            <span className={cn("rounded-md bg-flow-chart-primary/15 font-semibold text-flow-chart-primary", dense ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5")}>{value}</span>
        </div>
    )
}
