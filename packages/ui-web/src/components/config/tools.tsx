import { useState, useMemo } from "react"
import { tools, type ToolEntry } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Badge } from "../ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"
import { Separator } from "../ui/separator"
import { Button } from "../ui/button"

function ParamList({ parameters }: { parameters?: Record<string, unknown> }) {
    const props = (parameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>
    const required = (parameters?.required ?? []) as string[]
    const entries = Object.entries(props)
    if (entries.length === 0) return <p className="text-sm text-muted-foreground">无参数</p>

    return (
        <div className="rounded-md border divide-y">
            {entries.map(([name, schema]) => (
                <div key={name} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-center gap-2">
                        <code className="font-mono text-sm font-medium">{name}</code>
                        {schema.type && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {schema.type}
                            </Badge>
                        )}
                        {required.includes(name) && (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                                required
                            </Badge>
                        )}
                    </div>
                    {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
                </div>
            ))}
        </div>
    )
}

export function ToolsPage() {
    const { data: list, loading } = useFetch(tools.list)
    const [selected, setSelected] = useState<ToolEntry | null>(null)
    const [filter, setFilter] = useState<string>("all")

    // 提取分类：all, builtin, custom, mcp, mcp:server-name
    const categories = useMemo(() => {
        if (!list) return []
        const cats: Array<{ value: string; label: string; count: number }> = []
        const counts: Record<string, number> = {}
        const mcpServers = new Set<string>()

        for (const t of list) {
            counts[t.source] = (counts[t.source] ?? 0) + 1
            if (t.source === "mcp" && t.server) mcpServers.add(t.server)
        }

        cats.push({ value: "all", label: "全部", count: list.length })
        if (counts.builtin) cats.push({ value: "builtin", label: "内置", count: counts.builtin })
        if (counts.custom) cats.push({ value: "custom", label: "自定义", count: counts.custom })
        if (counts.mcp) cats.push({ value: "mcp", label: "MCP", count: counts.mcp })

        for (const s of [...mcpServers].sort()) {
            const c = list.filter((t) => t.server === s).length
            cats.push({ value: `mcp:${s}`, label: s, count: c })
        }

        return cats
    }, [list])

    const filtered = useMemo(() => {
        if (!list) return []
        if (filter === "all") return list
        if (filter.startsWith("mcp:")) {
            const server = filter.slice(4)
            return list.filter((t) => t.server === server)
        }
        return list.filter((t) => t.source === filter)
    }, [list, filter])

    if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>
    if (!list || list.length === 0) return <p className="text-sm text-muted-foreground">暂无可用工具。</p>

    return (
        <>
            {/* Filter */}
            <div className="flex flex-wrap gap-1.5 mb-1">
                {categories.map((cat) => (
                    <Button key={cat.value} variant={filter === cat.value ? "default" : "outline"} size="sm" className="h-7 text-xs" onClick={() => setFilter(cat.value)}>
                        {cat.label}
                        <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                            {cat.count}
                        </Badge>
                    </Button>
                ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((t) => (
                    <button key={t.name} type="button" className="rounded-lg border p-4 space-y-1.5 text-left hover:bg-accent/50 transition-colors cursor-pointer" onClick={() => setSelected(t)}>
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-medium truncate">{t.name}</span>
                            <div className="flex items-center gap-1 shrink-0">
                                {t.source === "mcp" && (
                                    <Badge variant={t.direct ? "default" : "outline"} className="text-[10px]">
                                        {t.direct ? "direct" : "proxy"}
                                    </Badge>
                                )}
                                <Badge variant={t.source === "builtin" ? "secondary" : t.source === "mcp" ? "outline" : "default"} className="shrink-0">
                                    {t.source === "mcp" ? t.server : t.source}
                                </Badge>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
                    </button>
                ))}
            </div>

            <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
                <DialogContent className="sm:max-w-md">
                    {selected && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    <code className="font-mono">{selected.name}</code>
                                    <Badge variant={selected.source === "builtin" ? "secondary" : selected.source === "mcp" ? "outline" : "default"} className="ml-2 align-middle">
                                        {selected.source === "mcp" ? selected.server : selected.source}
                                    </Badge>
                                    {selected.source === "mcp" && (
                                        <Badge variant={selected.direct ? "default" : "outline"} className="ml-1 align-middle text-[10px]">
                                            {selected.direct ? "direct" : "proxy"}
                                        </Badge>
                                    )}
                                </DialogTitle>
                                <DialogDescription>{selected.description}</DialogDescription>
                            </DialogHeader>
                            <Separator />
                            <div>
                                <h4 className="text-sm font-medium mb-2">Parameters</h4>
                                <ParamList parameters={selected.parameters} />
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    )
}
