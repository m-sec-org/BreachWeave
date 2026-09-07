import type { TFunction } from "i18next"
import type { AttackTimelineEvent } from "./api"

function parseMessageRole(title: string, prefix: "Observer" | "Solver"): string | undefined {
    const match = title.match(new RegExp(`^${prefix} (.+)$`))
    return match?.[1]
}

function parseToolCallName(title: string): string | undefined {
    const match = title.match(/^Call (.+)$/)
    return match?.[1]
}

function parseToolResult(title: string): { tool: string; status: "failed" | "finished" } | undefined {
    const match = title.match(/^(.+) (failed|finished)$/)
    if (!match) return
    return { tool: match[1], status: match[2] as "failed" | "finished" }
}

export function timelineEventTitle(event: AttackTimelineEvent, t: TFunction): string {
    switch (event.kind) {
        case "memory_added":
            return t("flow.item.memory.added")
        case "memory_updated":
            return t("flow.item.memory.updated")
        case "idea_added":
            return t("flow.item.idea.added")
        case "idea_updated":
            return t("flow.item.idea.updated")
        case "solver_started":
            return t("flow.timeline.solver.started")
        case "solver_ended":
            return "智能体结束"
        case "observer_reminder":
            return t("flow.timeline.observer.reminder")
        case "report_submitted":
            return "测试报告已提交"
        case "message": {
            if (event.lane === "observer") {
                const role = parseMessageRole(event.title, "Observer") ?? "message"
                return t("flow.timeline.observer.message", { role })
            }
            const role = parseMessageRole(event.title, "Solver") ?? "message"
            return t("flow.timeline.solver.message", { role })
        }
        case "tool_call": {
            const tool = parseToolCallName(event.title) ?? "tool"
            return t("flow.timeline.tool.call", { tool })
        }
        case "tool_result": {
            const parsed = parseToolResult(event.title)
            if (!parsed) return event.title
            return t(`flow.timeline.tool.${parsed.status}`, { tool: parsed.tool })
        }
        default:
            return event.title
    }
}
