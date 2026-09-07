import type { Usage } from "@mariozechner/pi-ai"

function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`
}

function formatTokenCount(count: number): string {
    if (count < 1000) return count.toString()
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    return `${Math.round(count / 1000)}k`
}

export function formatUsage(usage: Usage) {
    if (!usage) return ""

    const parts: string[] = []
    if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`)
    if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`)
    if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`)
    if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`)
    if (usage.cost?.total) parts.push(formatCost(usage.cost.total))

    return parts.join(" ")
}
