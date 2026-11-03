import { type MouseEvent, useEffect, useState } from "react"
import { challenges, runtime } from "../../lib/api"
import type { ChallengeAssetRecord, ChallengeDetails, ChallengeInfoRecord, ChallengeStatsOverview, ChallengeStatsOverviewBucket, IdeaRecord, MemoryEntry, SolverInstance } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { BarChart3Icon, ChevronDownIcon, ChevronUpIcon, DownloadIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Badge } from "../ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Skeleton } from "../ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Switch } from "../ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs"
import { Textarea } from "../ui/textarea"
import { toast } from "sonner"
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

function cssColor(varName: string) {
    if (typeof document === "undefined") return ""
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
}

function formatTime(value?: string) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function formatSolverTime(value?: number) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function formatMinutes(value?: number) {
    if (!value || value <= 0) return "0 min"
    return `${Math.round(value / 60000)} min`
}

function formatTokenCount(value?: number) {
    if (!value || value <= 0) return "0"
    if (value < 1000) return `${value}`
    if (value < 10000) return `${(value / 1000).toFixed(1)}k`
    return `${Math.round(value / 1000)}k`
}

function challengeDisplayName(challenge: Pick<ChallengeInfoRecord, "id" | "name" | "title">) {
    return challenge.name?.trim() || challenge.title?.trim() || challenge.id
}

function assetTextList(value: string | string[] | null | undefined): string[] {
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
    return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

function challengeStatus(challenge: ChallengeInfoRecord) {
    if (challenge.mode === "authorized_pentest" || challenge.project?.mode === "authorized_pentest") {
        return challenge.authority_projection?.closed ? "completed" : challenge.instance_status || "unknown"
    }
    if (isChallengeAssetsCompleted(challenge)) return "completed"
    return challenge.instance_status || "unknown"
}

function challengeStatusBadgeClass(status: string) {
    if (status === "completed") {
        return "border-green-600/30 bg-green-500/15 text-green-700"
    }
    return ""
}

function challengeAssetItems(challenge: Pick<ChallengeInfoRecord, "assets">): ChallengeAssetRecord[] {
    return [...(challenge.assets?.urls ?? []), ...(challenge.assets?.ips ?? [])]
}

function challengeAssetProgress(challenge: Pick<ChallengeInfoRecord, "assets">) {
    const items = challengeAssetItems(challenge)
    const scanned = items.filter((item) => item.scanned).length
    return { total: items.length, scanned, pending: Math.max(items.length - scanned, 0) }
}

function challengeCoverageProgress(challenge: ChallengeInfoRecord) {
    return {
        total: challenge.authority_projection?.coverage_total ?? 0,
        resolved: challenge.authority_projection?.coverage_resolved ?? 0,
    }
}

function authorizedCoverageProgress(details: Pick<ChallengeDetails, "authority_coverage">) {
    const cells = details.authority_coverage ?? []
    const pendingStatuses = new Set(["not_tested", "queued", "in_progress", "tested_no_observation", "blocked", "blocked_by_control", "inconclusive"])
    const resolved = cells.filter((cell) => !pendingStatuses.has(cell.status)).length
    return { total: cells.length, resolved, pending: Math.max(cells.length - resolved, 0) }
}

function isChallengeAssetsCompleted(challenge: Pick<ChallengeInfoRecord, "assets">) {
    const progress = challengeAssetProgress(challenge)
    return progress.total > 0 && progress.pending === 0
}

function challengePlannerStatus(challenge: ChallengeInfoRecord) {
    return challenge.planner_status ?? "stop"
}

function plannerStatusBadgeClass(status: NonNullable<ChallengeInfoRecord["planner_status"]>) {
    if (status === "running") return "border-blue-600/30 bg-blue-500/15 text-blue-700"
    if (status === "starting") return "border-amber-600/30 bg-amber-500/15 text-amber-700"
    if (status === "disabled") return "border-muted-foreground/20 bg-muted text-muted-foreground"
    return ""
}

function activeSolvers(solvers: SolverInstance[]) {
    return solvers.filter((solver) => solver.status === "starting" || solver.status === "running" || solver.status === "stopping")
}

function sortSolverStatsByNewestFirst(
    items: ChallengeDetails["solver_stats"],
    solvers: SolverInstance[],
): ChallengeDetails["solver_stats"] {
    return [...items].sort((left, right) => {
        const leftLiveSolver = solvers.find((item) => item.id === left.solver_id)
        const rightLiveSolver = solvers.find((item) => item.id === right.solver_id)
        const leftTime = left.started_at ? Date.parse(left.started_at) : leftLiveSolver?.createdAt ?? 0
        const rightTime = right.started_at ? Date.parse(right.started_at) : rightLiveSolver?.createdAt ?? 0
        return rightTime - leftTime
    })
}

function filterLabel(value: string, fallback: string) {
    return value === "all" ? fallback : value
}

function formatPercent(value?: number) {
    if (!value || value <= 0) return "0%"
    return `${Math.round(value * 100)}%`
}

function formatCount(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function truncateLabel(value: string, maxChars = 16): string {
    const text = value.trim()
    if (!text) return text
    const chars = Array.from(text)
    if (chars.length <= maxChars) return text
    return `${chars.slice(0, maxChars).join("")}…`
}

const REPORT_PREVIEW_MAX_CHARS = 1200
const REPORT_PREVIEW_MAX_LINES = 18

function isLongReport(value: string) {
    return value.length > REPORT_PREVIEW_MAX_CHARS || value.split(/\r?\n/).length > REPORT_PREVIEW_MAX_LINES
}

function safeDownloadNamePart(value: string, fallback: string) {
    const text = value
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64)
    return text || fallback
}

function downloadMarkdownFile(fileName: string, content: string) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
    const downloadUrl = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = downloadUrl
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0)
}

function formatShortDuration(value?: number) {
    if (!value || value <= 0) return "0m"
    const totalMinutes = Math.round(value / 60000)
    if (totalMinutes < 60) return `${totalMinutes}m`
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}h ${minutes}m`
}

const MEMORY_KIND_OPTIONS: MemoryEntry["kind"][] = ["fact", "evidence", "failure", "note", "hint"]
const IDEA_STATUS_OPTIONS: IdeaRecord["status"][] = ["pending", "testing", "verified", "failed", "skipped"]
const CHALLENGE_ATTACK_FLOW_SHORTCUT_TABS: Record<string, string> = {
    "1": "attack-path",
    "2": "memory-path",
    "3": "solver-agent-collaboration",
    "4": "aggregate-view",
}

function shouldIgnoreChallengeShortcut(event: globalThis.KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return true
    const target = event.target
    if (!(target instanceof HTMLElement)) return false
    return Boolean(
        target.closest(
            "input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='checkbox'], [role='menuitem'], [role='option'], [role='slider'], [role='tab'], [role='textbox']",
        ),
    )
}

interface MemoryFormState {
    kind: MemoryEntry["kind"]
    content: string
    refsText: string
    source: string
}

interface IdeaFormState {
    content: string
    status: IdeaRecord["status"]
    result: string
}

function createMemoryFormState(challengeId: string, entry?: MemoryEntry): MemoryFormState {
    if (!entry) {
        return {
            kind: "note",
            content: "",
            refsText: "",
            source: `challenge-ui:${challengeId}`,
        }
    }
    return {
        kind: entry.kind,
        content: entry.content,
        refsText: entry.refs.join("\n"),
        source: entry.source,
    }
}

function createIdeaFormState(entry?: IdeaRecord): IdeaFormState {
    if (!entry) {
        return {
            content: "",
            status: "pending",
            result: "",
        }
    }
    return {
        content: entry.content,
        status: entry.status,
        result: entry.result,
    }
}

function parseRefs(refsText: string): string[] {
    return refsText
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

function parseAssetDraft(value: string): string[] {
    const items: string[] = []
    const seen = new Set<string>()
    for (const line of value.split("\n")) {
        const text = line.trim()
        if (!text || seen.has(text)) continue
        seen.add(text)
        items.push(text)
    }
    return items
}

function AssetGroup(props: { title: string; items: ChallengeAssetRecord[] }) {
    const { title, items } = props

    return (
        <section className="min-w-0 space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{title}</div>
                <Badge variant="outline">{items.length}</Badge>
            </div>
            {items.length === 0 ? <div className="text-sm text-muted-foreground">No assets.</div> : null}
            {items.map((item) => (
                <div key={item.asset} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition hover:bg-muted/50">
                    <div className="min-w-0 break-all font-medium">{item.asset}</div>
                    <Badge variant="outline" className={item.scanned ? "border-green-600/30 bg-green-500/15 text-green-700" : ""}>
                        {item.scanned ? "scanned" : "pending"}
                    </Badge>
                </div>
            ))}
        </section>
    )
}

function StatsRankingTable(props: { items: ChallengeStatsOverviewBucket[]; empty: string }) {
    const { items, empty } = props

    if (items.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>

    return (
        <div className="max-h-72 overflow-auto rounded-lg border">
            <Table>
                <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>项目</TableHead>
                        <TableHead>Assets</TableHead>
                        <TableHead>Reports</TableHead>
                        <TableHead>Scan Rate</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Tokens</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => (
                        <TableRow key={item.key}>
                            <TableCell className="font-medium">{item.label}</TableCell>
                            <TableCell>{item.challenge_count}</TableCell>
                            <TableCell>{item.assets_scanned}/{item.assets_total}</TableCell>
                            <TableCell>{item.submission_count}</TableCell>
                            <TableCell>{formatPercent(item.completion_rate)}</TableCell>
                            <TableCell>{formatMinutes(item.total_duration_ms)}</TableCell>
                            <TableCell>{formatTokenCount(item.total_tokens)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

function statsChartHeight(count: number) {
    return Math.max(180, count * 36)
}

function StatsBucketCharts(props: { title: string; items: ChallengeStatsOverviewBucket[] }) {
    const { title, items } = props
    const [tab, setTab] = useState("success")

    if (items.length === 0) return null

    const data = items.map((item) => ({
        name: item.label,
        assetCount: item.assets_scanned,
        completionRate: Math.round(item.completion_rate * 100),
        totalMinutes: Math.round(item.total_duration_ms / 60000),
        totalTokens: Math.round(item.total_tokens / 1000),
        reports: item.submission_count,
        completed: item.assets_total > 0 && item.assets_scanned >= item.assets_total,
    }))
    const height = statsChartHeight(data.length)

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-dashed p-4">
                <div className="mb-3 text-sm font-medium text-muted-foreground">{title} · Summary</div>
                <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-4">
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Items</div>
                        <div className="mt-1 text-base font-medium text-foreground">{items.length}</div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Scan Rate</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatPercent(items.reduce((sum, item) => sum + item.completion_rate, 0) / items.length)}
                        </div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Time</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatMinutes(items.reduce((sum, item) => sum + item.total_duration_ms, 0) / items.length)}
                        </div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Tokens</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatTokenCount(Math.round(items.reduce((sum, item) => sum + item.total_tokens, 0) / items.length))}
                        </div>
                    </div>
                </div>
            </div>

            <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                <TabsList>
                    <TabsTrigger value="success">Assets</TabsTrigger>
                    <TabsTrigger value="time">Time</TabsTrigger>
                    <TabsTrigger value="tokens">Tokens</TabsTrigger>
                    <TabsTrigger value="reports">Reports</TabsTrigger>
                </TabsList>

                <TabsContent value="success" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Scanned Assets</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" allowDecimals={false} />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Legend />
                                <Bar dataKey="assetCount" name="Scanned Assets" fill={cssColor("--flow-chart-primary")} radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="time" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Time</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="totalMinutes" name="Time (min)" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-time`} fill={entry.completed ? cssColor("--flow-chart-success") : cssColor("--flow-chart-pending")} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="tokens" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Tokens</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="totalTokens" name="Tokens (k)" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-tokens`} fill={entry.completed ? cssColor("--flow-chart-success") : cssColor("--flow-chart-warning")} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="reports" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Reports</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="reports" name="Reports" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-reports`} fill={entry.completed ? cssColor("--flow-chart-success") : cssColor("--flow-chart-teal")} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    )
}

function StatsOverviewDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    statsOverview?: ChallengeStatsOverview
    loading: boolean
}) {
    const { open, onOpenChange, statsOverview, loading } = props
    const [tab, setTab] = useState("overview")
    const [challengeMetric, setChallengeMetric] = useState("time")

    const pieData = statsOverview
        ? [
              { name: "Scanned Assets", value: statsOverview.assets_scanned, color: cssColor("--flow-chart-success") },
              { name: "Pending Assets", value: statsOverview.assets_pending, color: cssColor("--flow-chart-neutral") },
          ]
        : []
    const challengeMetricData = (statsOverview?.challenge_series ?? []).map((item) => ({
        name: item.title || item.challenge_id,
        axisLabel: truncateLabel(item.title || item.challenge_id, 14),
        durationMinutes: Math.round(item.report_duration_ms / 60000),
        tokensK: Math.round(item.total_tokens / 1000),
        reports: item.assets_scanned,
        completed: item.completed,
    }))
    challengeMetricData.sort((left, right) => {
        const valueDiff =
            challengeMetric === "tokens"
                ? right.tokensK - left.tokensK
                : challengeMetric === "reports"
                  ? right.reports - left.reports
                  : right.durationMinutes - left.durationMinutes
        if (valueDiff !== 0) return valueDiff
        if (left.completed !== right.completed) return Number(right.completed) - Number(left.completed)
        return left.name.localeCompare(right.name)
    })
    const challengeMetricHeight = statsChartHeight(challengeMetricData.length)
    const challengeMetricKey = challengeMetric === "tokens" ? "tokensK" : challengeMetric === "reports" ? "reports" : "durationMinutes"
    const challengeMetricLabel = challengeMetric === "tokens" ? "Tokens (k)" : challengeMetric === "reports" ? "Scanned Assets" : "Report Time (min)"
    const challengeMetricColor = challengeMetric === "tokens" ? cssColor("--flow-chart-warning") : challengeMetric === "reports" ? cssColor("--flow-chart-teal") : cssColor("--flow-chart-primary")

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-6xl overflow-y-auto">
                {loading || !statsOverview ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>项目统计</DialogTitle>
                            <DialogDescription>图表化展示题目完成情况，以及模型 / Prompt 维度统计。</DialogDescription>
                        </DialogHeader>
                        <div className="text-sm text-muted-foreground">Loading stats...</div>
                    </>
                ) : (
                    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                        <DialogHeader>
                            <DialogTitle>项目统计</DialogTitle>
                            <DialogDescription>图表化展示题目完成情况，以及模型 / Prompt 维度统计。</DialogDescription>
                        </DialogHeader>
                        <TabsList>
                            <TabsTrigger value="overview">Overview</TabsTrigger>
                            <TabsTrigger value="models">Models</TabsTrigger>
                            <TabsTrigger value="prompts">Prompts</TabsTrigger>
                        </TabsList>

                        <TabsContent value="overview" className="space-y-4">
                            {statsOverview.authorized_governance.projects > 0 ? (
                                <div className="rounded-md border px-4 py-3">
                                    <div className="text-sm font-medium">Authorized engagements · Taric</div>
                                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                                        <span>{statsOverview.authorized_governance.projects} projects</span>
                                        <span>Work {statsOverview.authorized_governance.work_completed}/{statsOverview.authorized_governance.work_total}</span>
                                        <span>Coverage {statsOverview.authorized_governance.coverage_total}</span>
                                        <span>Evidence {statsOverview.authorized_governance.evidence_total}</span>
                                        <span>Reports {statsOverview.authorized_governance.reports_total}</span>
                                        <span>Gaps {statsOverview.authorized_governance.gaps_total}</span>
                                        <span>Closed {statsOverview.authorized_governance.closed}</span>
                                        <span>Solver duration and tokens unavailable</span>
                                    </div>
                                </div>
                            ) : null}
                            <div className="grid gap-4 md:grid-cols-7">
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Completion</div>
                                    <div className="mt-1 text-lg font-semibold">{formatPercent(statsOverview.asset_completion_rate)}</div>
                                    <div className="text-xs text-muted-foreground">{statsOverview.assets_scanned}/{statsOverview.assets_total} assets</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Reports</div>
                                    <div className="mt-1 text-lg font-semibold">{statsOverview.reports_total}</div>
                                    <div className="text-xs text-muted-foreground">{statsOverview.assets_pending} assets pending</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Total Solver Time</div>
                                    <div className="mt-1 text-lg font-semibold">{formatMinutes(statsOverview.solver_active_duration_ms_total)}</div>
                                    <div className="text-xs text-muted-foreground">wall {formatMinutes(statsOverview.wall_time_ms_total)}</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Average Report Time</div>
                                    <div className="mt-1 text-lg font-semibold">
                                        {formatMinutes(
                                            statsOverview.challenges_completed > 0
                                                ? Math.round(statsOverview.wall_time_ms_total / statsOverview.challenges_completed)
                                                : 0,
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">completed only</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Total Tokens</div>
                                    <div className="mt-1 text-lg font-semibold">{formatTokenCount(statsOverview.total_tokens)}</div>
                                    <div className="text-xs text-muted-foreground">all solvers</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Average Tokens</div>
                                    <div className="mt-1 text-lg font-semibold">
                                        {formatTokenCount(
                                            statsOverview.solver_count > 0 ? Math.round(statsOverview.total_tokens / statsOverview.solver_count) : 0,
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">per solver</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Completed</div>
                                    <div className="mt-1 text-lg font-semibold">{statsOverview.challenges_completed}/{statsOverview.challenges_total}</div>
                                    <div className="text-xs text-muted-foreground">all assets scanned</div>
                                </div>
                            </div>
                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="rounded-lg border p-4">
                                    <div className="mb-3 text-sm font-medium">Asset Completion</div>
                                    <div className="h-72">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={96} label>
                                                    {pieData.map((item) => (
                                                        <Cell key={item.name} fill={item.color} />
                                                    ))}
                                                </Pie>
                                                <Tooltip />
                                                <Legend />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                                <div className="rounded-lg border p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium">项目指标</div>
                                        <Tabs value={challengeMetric} onValueChange={setChallengeMetric}>
                                            <TabsList>
                                                <TabsTrigger value="time">Time</TabsTrigger>
                                                <TabsTrigger value="tokens">Tokens</TabsTrigger>
                                                <TabsTrigger value="reports">Assets</TabsTrigger>
                                            </TabsList>
                                        </Tabs>
                                    </div>
                                    <div className="max-h-96 overflow-y-auto pr-1">
                                        <div style={{ height: challengeMetricHeight }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={challengeMetricData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                                    <CartesianGrid strokeDasharray="3 3" />
                                                    <XAxis type="number" allowDecimals={false} />
                                                    <YAxis type="category" dataKey="axisLabel" width={150} tick={{ fontSize: 12 }} />
                                                    <Tooltip
                                                        labelFormatter={(label, payload) => {
                                                            const first = payload?.[0] as { payload?: { name?: string } } | undefined
                                                            if (first?.payload?.name) return first.payload.name
                                                            if (typeof label === "string" || typeof label === "number") return String(label)
                                                            return ""
                                                        }}
                                                    />
                                                    <Legend />
                                                    <Bar dataKey={challengeMetricKey} name={challengeMetricLabel} radius={[0, 4, 4, 0]}>
                                                        {challengeMetricData.map((entry) => (
                                                            <Cell
                                                                key={`${entry.name}-${challengeMetric}`}
                                                                fill={entry.completed ? cssColor("--flow-chart-success") : challengeMetricColor}
                                                            />
                                                        ))}
                                                    </Bar>
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="models" className="space-y-4">
                            <StatsBucketCharts title="Model Performance" items={statsOverview.models} />
                            <StatsRankingTable items={statsOverview.models} empty="No model stats yet." />
                        </TabsContent>

                        <TabsContent value="prompts" className="space-y-4">
                            <StatsBucketCharts title="Prompt Performance" items={statsOverview.prompts} />
                            <StatsRankingTable items={statsOverview.prompts} empty="No prompt stats yet." />
                        </TabsContent>
                    </Tabs>
                )}
            </DialogContent>
        </Dialog>
    )
}

export function ChallengePage({ challengeId }: { challengeId?: string }) {
    const { data: challengeList, loading, reload } = useFetch(challenges.list)
    const { data: statsOverview, loading: statsOverviewLoading } = useFetch(challenges.statsOverview)
    const [details, setDetails] = useState<ChallengeDetails | null>(null)
    const [detailsLoading, setDetailsLoading] = useState(false)
    const [detailsError, setDetailsError] = useState("")
    const [search, setSearch] = useState("")
    const [statusFilter, setStatusFilter] = useState("all")
    const [dialogOpen, setDialogOpen] = useState(false)
    const [statsDialogOpen, setStatsDialogOpen] = useState(false)
    const [detailTab, setDetailTab] = useState("solvers")
    const [plannerSaving, setPlannerSaving] = useState(false)
    const [exportingSessions, setExportingSessions] = useState(false)
    const [stoppingSolverId, setStoppingSolverId] = useState("")
    const [boardError, setBoardError] = useState("")
    const [boardBusyKey, setBoardBusyKey] = useState("")
    const [memoryDialogOpen, setMemoryDialogOpen] = useState(false)
    const [editingMemory, setEditingMemory] = useState<MemoryEntry | null>(null)
    const [memoryForm, setMemoryForm] = useState<MemoryFormState>(() => createMemoryFormState(challengeId || "challenge"))
    const [ideaDialogOpen, setIdeaDialogOpen] = useState(false)
    const [editingIdea, setEditingIdea] = useState<IdeaRecord | null>(null)
    const [ideaForm, setIdeaForm] = useState<IdeaFormState>(() => createIdeaFormState())
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState("")
    const [startSolverError, setStartSolverError] = useState("")
    const [sessionExportError, setSessionExportError] = useState("")
    const [deleteError, setDeleteError] = useState("")
    const [deletingChallengeId, setDeletingChallengeId] = useState("")
    const [draftName, setDraftName] = useState("")
    const [draftDescription, setDraftDescription] = useState("")
    const [draftAssetsUrl, setDraftAssetsUrl] = useState("")
    const [draftAssetsIp, setDraftAssetsIp] = useState("")
    const [draftPlannerPrompt, setDraftPlannerPrompt] = useState("")
    const [draftPlannerEnabled, setDraftPlannerEnabled] = useState(true)
    const [plannerPromptDraft, setPlannerPromptDraft] = useState("")
    const [plannerPromptSaving, setPlannerPromptSaving] = useState(false)
    const [plannerPromptError, setPlannerPromptError] = useState("")
    const [expandedReportIds, setExpandedReportIds] = useState<Set<string>>(() => new Set())

    const challengeItems = challengeList ?? []

    useEffect(() => {
        if (!challengeId) return
        const activeChallengeId = challengeId
        const hasOpenDialog = dialogOpen || statsDialogOpen || memoryDialogOpen || ideaDialogOpen
        if (hasOpenDialog) return

        function handleChallengeShortcut(event: globalThis.KeyboardEvent) {
            if (shouldIgnoreChallengeShortcut(event)) return
            const shortcutTab = CHALLENGE_ATTACK_FLOW_SHORTCUT_TABS[event.key]
            if (typeof shortcutTab !== "string") return

            event.preventDefault()
            if (!document.fullscreenElement) {
                const fullscreenTarget = document.querySelector<HTMLElement>("[data-app-content-fullscreen-root]") ?? document.documentElement
                void fullscreenTarget.requestFullscreen().catch(() => {
                    // Navigation still works if the browser denies fullscreen.
                })
            }
            location.hash = `#/challenge/${encodeURIComponent(activeChallengeId)}/attack-flow?tab=${encodeURIComponent(shortcutTab)}&presentation=fullscreen`
        }

        window.addEventListener("keydown", handleChallengeShortcut, { capture: true })
        return () => window.removeEventListener("keydown", handleChallengeShortcut, { capture: true })
    }, [challengeId, dialogOpen, ideaDialogOpen, memoryDialogOpen, statsDialogOpen])

    const statusOptions = [...new Set(challengeItems.map((challenge) => challengeStatus(challenge)).filter(Boolean))].sort()

    const filteredChallenges = challengeItems.filter((challenge) => {
        const keyword = search.trim().toLowerCase()
        if (
            keyword &&
            ![
                challenge.id,
                challengeDisplayName(challenge),
                challenge.description,
                challenge.instance_status,
            ]
                .join(" ")
                .toLowerCase()
                .includes(keyword)
        ) {
            return false
        }
        if (statusFilter !== "all" && challengeStatus(challenge) !== statusFilter) return false
        return true
    })

    useEffect(() => {
        if (!challengeId) {
            setDetails(null)
            setDetailsError("")
            setPlannerPromptDraft("")
            setPlannerPromptError("")
            setExpandedReportIds(new Set())
            return
        }
        let active = true
        setDetailsLoading(true)
        setDetailsError("")
        setDetailTab("solvers")
        setSessionExportError("")
        setExpandedReportIds(new Set())
        void challenges
            .get(challengeId)
            .then((next) => {
                if (active) {
                    setDetails(next)
                    setPlannerPromptDraft(next.challenge.planner_prompt ?? "")
                    setPlannerPromptError("")
                }
            })
            .catch((error) => {
                if (active) setDetailsError(error instanceof Error ? error.message : String(error))
            })
            .finally(() => {
                if (active) setDetailsLoading(false)
            })
        return () => {
            active = false
        }
    }, [challengeId])

    function openRuntimeDetailInNewTab(solverId: string) {
        const url = new URL(location.href)
        const returnTo = location.hash || "#/"
        url.hash = `#/runtime/${encodeURIComponent(solverId)}?from=${encodeURIComponent(returnTo)}`
        window.open(url.toString(), "_blank", "noopener,noreferrer")
    }

    function toggleReportExpanded(reportId: string) {
        setExpandedReportIds((current) => {
            const next = new Set(current)
            if (next.has(reportId)) {
                next.delete(reportId)
            } else {
                next.add(reportId)
            }
            return next
        })
    }

    function handleDownloadReport(event: MouseEvent<HTMLButtonElement>, submission: ChallengeDetails["submissions"][number]) {
        event.stopPropagation()
        const assetPart = safeDownloadNamePart(submission.asset, challengeId || "asset")
        const reportPart = safeDownloadNamePart(submission.id, "report")
        downloadMarkdownFile(`report-${assetPart}-${reportPart}.md`, submission.report)
    }

    async function handleExportSolverSessions() {
        if (!challengeId) return
        setExportingSessions(true)
        setSessionExportError("")
        try {
            const result = await challenges.exportSolverSessions(challengeId)
            const downloadUrl = URL.createObjectURL(result.blob)
            const anchor = document.createElement("a")
            anchor.href = downloadUrl
            anchor.download = result.fileName
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0)
        } catch (error) {
            setSessionExportError(error instanceof Error ? error.message : String(error))
        } finally {
            setExportingSessions(false)
        }
    }

    async function handleToggleProjectPlanner(targetChallengeId: string, enabled: boolean) {
        setPlannerSaving(true)
        try {
            const result = await challenges.updatePlannerEnabled(targetChallengeId, enabled)
            setDetails((current) => (current && current.challenge.id === targetChallengeId ? { ...current, challenge: result.challenge } : current))
            reload()
            toast.success(enabled ? "Project planner enabled" : "Project planner disabled")
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
        } finally {
            setPlannerSaving(false)
        }
    }

    async function handleStopSolver(solverId: string) {
        setStoppingSolverId(solverId)
        setStartSolverError("")
        try {
            await runtime.stop(solverId)
            if (challengeId) {
                const next = await challenges.get(challengeId)
                setDetails(next)
            }
            reload()
        } catch (error) {
            setStartSolverError(error instanceof Error ? error.message : String(error))
        } finally {
            setStoppingSolverId("")
        }
    }

    async function handleDeleteChallenge(targetChallengeId: string, options?: { navigateBack?: boolean }) {
        const target = challengeItems.find((item) => item.id === targetChallengeId)
        const displayName = target ? challengeDisplayName(target) : targetChallengeId
        if (
            !window.confirm(
                `确认删除项目 ${displayName}？这会归档 challenge 文件并归档关联 solver，此操作不可恢复。`,
            )
        ) {
            return
        }

        setDeletingChallengeId(targetChallengeId)
        setDeleteError("")
        try {
            await challenges.remove(targetChallengeId)
            if (options?.navigateBack) {
                location.hash = "#/"
            }
            reload()
        } catch (error) {
            setDeleteError(error instanceof Error ? error.message : String(error))
        } finally {
            setDeletingChallengeId("")
        }
    }

    async function reloadChallengeDetails() {
        if (!challengeId) return
        const next = await challenges.get(challengeId)
        setDetails(next)
        setPlannerPromptDraft(next.challenge.planner_prompt ?? "")
    }

    async function handleSavePlannerPrompt() {
        if (!challengeId) return
        setPlannerPromptSaving(true)
        setPlannerPromptError("")
        try {
            const result = await challenges.updatePlannerPrompt(challengeId, plannerPromptDraft.trim() || null)
            setPlannerPromptDraft(result.content)
            await reloadChallengeDetails()
            toast.success("Planner prompt saved")
            reload()
        } catch (error) {
            setPlannerPromptError(error instanceof Error ? error.message : String(error))
        } finally {
            setPlannerPromptSaving(false)
        }
    }

    function openCreateMemoryDialog() {
        if (!challengeId) return
        setEditingMemory(null)
        setMemoryForm(createMemoryFormState(challengeId))
        setMemoryDialogOpen(true)
    }

    function openEditMemoryDialog(entry: MemoryEntry) {
        if (!challengeId) return
        setEditingMemory(entry)
        setMemoryForm(createMemoryFormState(challengeId, entry))
        setMemoryDialogOpen(true)
    }

    function openCreateIdeaDialog() {
        setEditingIdea(null)
        setIdeaForm(createIdeaFormState())
        setIdeaDialogOpen(true)
    }

    function openEditIdeaDialog(entry: IdeaRecord) {
        setEditingIdea(entry)
        setIdeaForm(createIdeaFormState(entry))
        setIdeaDialogOpen(true)
    }

    async function handleSaveMemory() {
        if (!challengeId) return
        setBoardBusyKey(editingMemory ? `memory-save:${editingMemory.id}` : "memory-create")
        setBoardError("")
        try {
            if (editingMemory) {
                await challenges.updateMemory(challengeId, editingMemory.id, {
                    kind: memoryForm.kind,
                    content: memoryForm.content,
                    refs: parseRefs(memoryForm.refsText),
                    source: memoryForm.source,
                })
            } else {
                await challenges.addMemory(challengeId, {
                    kind: memoryForm.kind,
                    content: memoryForm.content,
                    refs: parseRefs(memoryForm.refsText),
                    source: memoryForm.source,
                })
            }
            setMemoryDialogOpen(false)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleDeleteMemory(entry: MemoryEntry) {
        if (!challengeId) return
        if (!window.confirm(`删除 memory ${entry.id}？`)) return
        setBoardBusyKey(`memory-delete:${entry.id}`)
        setBoardError("")
        try {
            await challenges.deleteMemory(challengeId, entry.id)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleSaveIdea() {
        if (!challengeId) return
        setBoardBusyKey(editingIdea ? `idea-save:${editingIdea.id}` : "idea-create")
        setBoardError("")
        try {
            if (editingIdea) {
                await challenges.updateIdea(challengeId, editingIdea.id, {
                    content: ideaForm.content,
                    status: ideaForm.status,
                    result: ideaForm.result,
                })
            } else {
                await challenges.addIdea(challengeId, {
                    content: ideaForm.content,
                    status: ideaForm.status,
                    result: ideaForm.result,
                })
            }
            setIdeaDialogOpen(false)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleDeleteIdea(entry: IdeaRecord) {
        if (!challengeId) return
        if (!window.confirm(`删除 idea ${entry.id}？`)) return
        setBoardBusyKey(`idea-delete:${entry.id}`)
        setBoardError("")
        try {
            await challenges.deleteIdea(challengeId, entry.id)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    if (!challengeId) {
        async function handleCreateChallenge() {
            setCreating(true)
            setCreateError("")
            try {
                await challenges.create({
                    name: draftName.trim(),
                    description: draftDescription.trim(),
                    assetsUrl: parseAssetDraft(draftAssetsUrl),
                    assetsIp: parseAssetDraft(draftAssetsIp),
                    plannerPrompt: draftPlannerPrompt.trim() || null,
                    plannerEnabled: draftPlannerEnabled,
                })
                setDialogOpen(false)
                setDraftName("")
                setDraftDescription("")
                setDraftAssetsUrl("")
                setDraftAssetsIp("")
                setDraftPlannerPrompt("")
                setDraftPlannerEnabled(true)
                reload()
            } catch (error) {
                setCreateError(error instanceof Error ? error.message : String(error))
            } finally {
                setCreating(false)
            }
        }

        return (
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                            <CardTitle>项目</CardTitle>
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" onClick={() => setStatsDialogOpen(true)}>
                                    <BarChart3Icon className="size-4" />
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                                    添加项目
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => reload()}>
                                    Refresh
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="mb-4 flex flex-wrap items-center gap-3">
                            <Input className="w-64" placeholder="搜索项目" value={search} onChange={(event) => setSearch(event.target.value)} />
                            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? "all")}>
                                <SelectTrigger className="w-40">
                                    <SelectValue>{filterLabel(statusFilter, "All Status")}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Status</SelectItem>
                                    {statusOptions.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            {option}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setSearch("")
                                    setStatusFilter("all")
                                }}
                            >
                                Reset
                            </Button>
                        </div>
                        {(loading || filteredChallenges.length > 0) && (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>ID</TableHead>
                                        <TableHead>任务名</TableHead>
                                        <TableHead>Assets</TableHead>
                                        <TableHead>Reports</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Planner</TableHead>
                                        <TableHead>Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {loading &&
                                        Array.from({ length: 6 }).map((_, index) => (
                                            <TableRow key={`skeleton-${index}`}>
                                                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-full max-w-[22rem]" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-full max-w-[14rem]" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                                                <TableCell><Skeleton className="h-5 w-9 rounded-full" /></TableCell>
                                                <TableCell><Skeleton className="h-8 w-24" /></TableCell>
                                            </TableRow>
                                        ))}
                                    {!loading &&
                                        filteredChallenges.map((challenge) => (
                                            <TableRow
                                                key={challenge.id}
                                                className="cursor-pointer"
                                                onClick={() => {
                                                    location.hash = `#/challenge/${challenge.id}`
                                                }}
                                            >
                                                <TableCell className="font-mono text-xs">{challenge.id}</TableCell>
                                                <TableCell className="max-w-[32rem]">
                                                    <div className="truncate font-medium">{challengeDisplayName(challenge)}</div>
                                                    <div className="truncate text-xs text-muted-foreground">{challenge.description || "No description."}</div>
                                                </TableCell>
                                                <TableCell>
                                                    {challenge.mode === "authorized_pentest"
                                                        ? `${challengeCoverageProgress(challenge).resolved}/${challengeCoverageProgress(challenge).total}`
                                                        : `${challengeAssetProgress(challenge).scanned}/${challengeAssetProgress(challenge).total}`}
                                                </TableCell>
                                                <TableCell>
                                                    {formatCount(challenge.submission_count)}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className={challengeStatusBadgeClass(challengeStatus(challenge))}>
                                                        {challengeStatus(challenge)}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center" onClick={(event) => event.stopPropagation()}>
                                                        <Switch
                                                            checked={challenge.planner_enabled !== false}
                                                            onCheckedChange={(checked) => void handleToggleProjectPlanner(challenge.id, checked)}
                                                            disabled={plannerSaving}
                                                        />
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={deletingChallengeId === challenge.id}
                                                            onClick={(event) => {
                                                                event.stopPropagation()
                                                                void handleDeleteChallenge(challenge.id)
                                                            }}
                                                        >
                                                            <Trash2Icon className="size-4" />
                                                            {deletingChallengeId === challenge.id ? "Deleting..." : "Delete"}
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                </TableBody>
                            </Table>
                        )}
                        {startSolverError && <div className="mt-4 text-sm text-destructive">{startSolverError}</div>}
                        {deleteError && <div className="mt-4 text-sm text-destructive">{deleteError}</div>}
                        {!loading && challengeItems.length === 0 && <div className="text-sm text-muted-foreground">暂无项目。</div>}
                        {!loading && challengeItems.length > 0 && filteredChallenges.length === 0 && <div className="text-sm text-muted-foreground">没有匹配的项目。</div>}
                    </CardContent>
                </Card>

                <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>添加项目</DialogTitle>
                            <DialogDescription>一个任务会创建一个包含 `challenge.json`、情报、战术、尝试记录和提交记录的目录。</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-3">
                            <div className="space-y-2">
                                <Label htmlFor="challenge-name">任务名</Label>
                                <Input id="challenge-name" placeholder="任务名" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-description">任务描述</Label>
                                <Textarea id="challenge-description" placeholder="任务描述" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-assets-url">资产信息-URL</Label>
                                <Textarea
                                    id="challenge-assets-url"
                                    placeholder={"https://example.com/login\nhttps://api.example.com"}
                                    value={draftAssetsUrl}
                                    onChange={(event) => setDraftAssetsUrl(event.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-assets-ip">资产信息-IP</Label>
                                <Textarea
                                    id="challenge-assets-ip"
                                    placeholder={"127.0.0.1:8080\n10.0.0.8"}
                                    value={draftAssetsIp}
                                    onChange={(event) => setDraftAssetsIp(event.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-planner-prompt">PlannerPrompt</Label>
                                <Textarea
                                    id="challenge-planner-prompt"
                                    placeholder="任务级 planner 启动补充说明"
                                    value={draftPlannerPrompt}
                                    onChange={(event) => setDraftPlannerPrompt(event.target.value)}
                                />
                            </div>
                            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                                <div className="space-y-0.5">
                                    <Label htmlFor="challenge-planner-enabled">Planner Enabled</Label>
                                    <div className="text-xs text-muted-foreground">关闭后项目状态为 disabled，不会自动或手动启动 planner。</div>
                                </div>
                                <Switch id="challenge-planner-enabled" checked={draftPlannerEnabled} onCheckedChange={setDraftPlannerEnabled} />
                            </div>
                        </div>
                        {createError && <div className="text-sm text-destructive">{createError}</div>}
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setDialogOpen(false)}>
                                Cancel
                            </Button>
                            <Button
                                onClick={() => void handleCreateChallenge()}
                                disabled={creating || !draftName.trim()}
                            >
                                {creating ? "Creating..." : "Create"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <StatsOverviewDialog
                    open={statsDialogOpen}
                    onOpenChange={setStatsDialogOpen}
                    statsOverview={statsOverview ?? undefined}
                    loading={statsOverviewLoading}
                />
            </div>
        )
    }

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
            <div>
                <Button variant="outline" size="sm" onClick={() => (location.hash = "#/")}>
                    Back
                </Button>
            </div>

            {detailsLoading && (
                <Card>
                    <CardContent className="p-6 text-sm text-muted-foreground">正在加载项目详情...</CardContent>
                </Card>
            )}

            {detailsError && (
                <Card>
                    <CardContent className="p-6 text-sm text-destructive">{detailsError}</CardContent>
                </Card>
            )}

            {details && (
                <div className="min-w-0 space-y-6">
                    <div className="min-w-0 space-y-3 border-b pb-6">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 space-y-2">
                                <div className="break-words text-2xl font-semibold">{challengeDisplayName(details.challenge)}</div>
                                <div className="flex flex-wrap gap-2">
                                    <Badge variant="outline">{details.challenge.id}</Badge>
                                    <Badge variant="outline" className={challengeStatusBadgeClass(challengeStatus(details.challenge))}>
                                        {challengeStatus(details.challenge)}
                                    </Badge>
                                    <Badge variant="outline" className={plannerStatusBadgeClass(challengePlannerStatus(details.challenge))}>
                                        planner {challengePlannerStatus(details.challenge)}
                                    </Badge>
                                </div>
                            </div>
                            <div className="shrink-0 space-y-3 text-right text-sm text-muted-foreground">
                                <div>
                                    {details.challenge.mode === "authorized_pentest" ? (
                                        <div>coverage {authorizedCoverageProgress(details).resolved}/{authorizedCoverageProgress(details).total}</div>
                                    ) : <div>assets {challengeAssetProgress(details.challenge).scanned}/{challengeAssetProgress(details.challenge).total}</div>}
                                    <div>attempts {details.stats.authority?.unavailable_metrics.includes("attempt_count") ? "—" : details.attempts.length}</div>
                                    <div>reports {details.submissions.length}</div>
                                </div>
                                <div className="flex justify-end gap-2">
                                    <Button variant="outline" size="sm" onClick={() => void handleExportSolverSessions()} disabled={exportingSessions || details.solver_stats.length === 0}>
                                        {exportingSessions ? "Exporting..." : "Export Sessions"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            location.hash = `#/challenge/${encodeURIComponent(details.challenge.id)}/attack-flow`
                                        }}
                                    >
                                        Attack Flow
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={deletingChallengeId === details.challenge.id}
                                        onClick={() => void handleDeleteChallenge(details.challenge.id, { navigateBack: true })}
                                    >
                                        <Trash2Icon className="size-4" />
                                        {deletingChallengeId === details.challenge.id ? "Deleting..." : "Delete"}
                                    </Button>
                                </div>
                            </div>
                        </div>
                        {startSolverError && <div className="text-sm text-destructive">{startSolverError}</div>}
                        {deleteError && <div className="text-sm text-destructive">{deleteError}</div>}
                        {sessionExportError && <div className="text-sm text-destructive">{sessionExportError}</div>}
                        <div className="grid gap-6 md:grid-cols-2">
                            <section className="min-w-0 space-y-2">
                                <div className="text-sm font-medium">任务描述</div>
                                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{details.challenge.description || "No description."}</div>
                            </section>
                            <section className="min-w-0 space-y-2">
                                <div className="text-sm font-medium">资产信息</div>
                                <div className="space-y-1 text-sm text-muted-foreground">
                                    <div className="break-all">URL: {assetTextList(details.challenge.assets_url).join(", ") || "—"}</div>
                                    <div className="break-all">IP: {assetTextList(details.challenge.assets_ip).join(", ") || "—"}</div>
                                    {assetTextList(details.challenge.assets_url).length === 0 && assetTextList(details.challenge.assets_ip).length === 0 && details.challenge.entrypoint?.length ? (
                                        <div className="break-all">Entrypoint: {details.challenge.entrypoint.join(", ")}</div>
                                    ) : null}
                                </div>
                            </section>
                        </div>
                        {details.challenge.mode !== "authorized_pentest" && <>
                        <section className="min-w-0 space-y-3 rounded-lg border p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <Label htmlFor="project-planner-prompt">Project Planner Prompt</Label>
                                    <div className="text-sm text-muted-foreground">
                                        该内容保存到当前 project 的 challenge.json，planner 和 solver 启动时会作为项目级追加要求加载。
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setPlannerPromptDraft(details.challenge.planner_prompt ?? "")}
                                        disabled={plannerPromptSaving}
                                    >
                                        Reset
                                    </Button>
                                    <Button size="sm" onClick={() => void handleSavePlannerPrompt()} disabled={plannerPromptSaving}>
                                        {plannerPromptSaving ? "Saving..." : "Save Prompt"}
                                    </Button>
                                </div>
                            </div>
                            <Textarea
                                id="project-planner-prompt"
                                value={plannerPromptDraft}
                                onChange={(event) => setPlannerPromptDraft(event.target.value)}
                                placeholder="为当前项目追加 planner/solver 启动要求，例如优先关注某条攻击链、避免误测范围、报告提交要求等。"
                                rows={6}
                                disabled={plannerPromptSaving}
                            />
                            {plannerPromptError && <div className="text-sm text-destructive">{plannerPromptError}</div>}
                        </section>
                        <section className="flex items-center justify-between gap-3 rounded-lg border p-4">
                            <div className="space-y-1">
                                <Label htmlFor="project-planner-enabled">Project Planner</Label>
                                <div className="text-sm text-muted-foreground">关闭后该项目 planner status 会变为 disabled，自动循环不会启动 planner。</div>
                            </div>
                            <Switch
                                id="project-planner-enabled"
                                checked={details.challenge.planner_enabled !== false}
                                onCheckedChange={(checked) => void handleToggleProjectPlanner(details.challenge.id, checked)}
                                disabled={plannerSaving}
                            />
                        </section>
                        </>}
                        <div className="grid gap-3 md:grid-cols-4">
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Wall Time</div>
                                <div className="mt-1 text-sm font-medium">{details.stats.authority?.unavailable_metrics.includes("report_duration_ms") ? "—" : formatMinutes(details.stats.report_duration_ms)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Total Solver Time</div>
                                <div className="mt-1 text-sm font-medium">{details.stats.authority?.unavailable_metrics.includes("solver_active_duration_ms_total") ? "—" : formatMinutes(details.stats.solver_active_duration_ms_total)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Total Tokens</div>
                                <div className="mt-1 text-sm font-medium">{details.stats.authority?.unavailable_metrics.includes("usage") ? "—" : formatTokenCount(details.stats.usage.total)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">
                                    {details.challenge.mode === "authorized_pentest" ? "Work Items" : "Solvers"}
                                </div>
                                <div className="mt-1 text-sm font-medium">
                                    {details.challenge.mode === "authorized_pentest" ? details.authority_work?.length ?? 0 : details.stats.solver_count}
                                </div>
                            </div>
                        </div>
                        {details.stats.authority ? (
                            <div className="text-xs text-muted-foreground">
                                Taric read_seq {details.stats.authority.read_seq} · Coverage {details.stats.authority.coverage_total} · Evidence {details.stats.authority.evidence_total} · Close {details.stats.authority.closed ? "closed" : "open"} · Gaps {details.challenge.authority_projection?.gaps.length ?? 0}
                            </div>
                        ) : null}
                    </div>

                    <Tabs value={detailTab} onValueChange={setDetailTab} className="min-w-0 space-y-4">
                        <TabsList>
                            <TabsTrigger value="solvers">{details.challenge.mode === "authorized_pentest" ? "Work" : "Solvers"}</TabsTrigger>
                            <TabsTrigger value="assets">Assets</TabsTrigger>
                            <TabsTrigger value="memory">Memory</TabsTrigger>
                            <TabsTrigger value="ideas">Ideas</TabsTrigger>
                            <TabsTrigger value="reports">Reports</TabsTrigger>
                        </TabsList>

                        <TabsContent value="solvers" className="min-w-0 space-y-3">
                            {details.challenge.mode === "authorized_pentest" ? (
                                details.authority_work && details.authority_work.length > 0 ? (
                                    <div className="divide-y rounded-md border">
                                        {details.authority_work.map((item) => (
                                            <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                                                <div className="min-w-0">
                                                    <div className="break-all text-sm font-medium">{item.id}</div>
                                                    <div className="mt-1 break-all text-xs text-muted-foreground">
                                                        Resources: {item.resourceRefs.length > 0 ? item.resourceRefs.join(", ") : "none"}
                                                    </div>
                                                </div>
                                                <div className="shrink-0 text-right text-xs text-muted-foreground">
                                                    <Badge variant="outline">{item.status}</Badge>
                                                    {item.updatedAt ? <div className="mt-1">updated {formatTime(item.updatedAt)}</div> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : <div className="text-sm text-muted-foreground">No Work items.</div>
                            ) : details.solver_stats.length > 0 && (
                                <div className="min-w-0 space-y-3">
                                    {sortSolverStatsByNewestFirst(details.solver_stats, details.solvers).map((solverStat) => {
                                        const liveSolver = details.solvers.find((item) => item.id === solverStat.solver_id)
                                        const clickable = Boolean(liveSolver) || solverStat.solver_id.trim().length > 0
                                        const stoppable = liveSolver && activeSolvers([liveSolver]).length > 0
                                        return (
                                            <div
                                                key={solverStat.solver_id}
                                                role={clickable ? "button" : undefined}
                                                tabIndex={clickable ? 0 : undefined}
                                                onClick={() => {
                                                    if (!clickable) return
                                                    openRuntimeDetailInNewTab(solverStat.solver_id)
                                                }}
                                                onKeyDown={(event) => {
                                                    if (!clickable) return
                                                    if (event.key !== "Enter" && event.key !== " ") return
                                                    event.preventDefault()
                                                    openRuntimeDetailInNewTab(solverStat.solver_id)
                                                }}
                                                className={`w-full min-w-0 rounded-lg border px-4 py-3 text-left transition ${
                                                    clickable ? "cursor-pointer hover:bg-muted/50" : ""
                                                }`}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="break-all font-medium">{solverStat.solver_id}</div>
                                                            {liveSolver && <Badge variant="outline">{liveSolver.status}</Badge>}
                                                        </div>
                                                        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                                                            {solverStat.prompt_name && <span>prompt {solverStat.prompt_name}</span>}
                                                            {solverStat.model_name && <span>model {solverStat.model_name}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                                                        <div>
                                                            started{" "}
                                                            {solverStat.started_at
                                                                ? formatTime(solverStat.started_at)
                                                                : liveSolver
                                                                  ? formatSolverTime(liveSolver.createdAt)
                                                                  : "unknown"}
                                                        </div>
                                                        <div>duration {formatMinutes(solverStat.duration_ms)}</div>
                                                        <div>tokens {formatTokenCount(solverStat.usage.total)}</div>
                                                        {stoppable && (
                                                            <div className="mt-2">
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    disabled={stoppingSolverId === solverStat.solver_id}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation()
                                                                        void handleStopSolver(solverStat.solver_id)
                                                                    }}
                                                                >
                                                                    {stoppingSolverId === solverStat.solver_id ? "Stopping..." : "Stop"}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                            {details.challenge.mode !== "authorized_pentest" && details.solver_stats.length === 0 && <div className="text-sm text-muted-foreground">No solvers.</div>}
                        </TabsContent>

                        <TabsContent value="assets" className="min-w-0 space-y-3">
                            {details.challenge.mode === "authorized_pentest" ? (
                                <div className="divide-y rounded-md border">
                                    {(details.authority_coverage ?? []).map((cell) => (
                                        <div key={cell.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                                            <div className="min-w-0">
                                                <div className="break-all text-sm font-medium">{cell.category}</div>
                                                <div className="mt-1 break-all text-xs text-muted-foreground">Resource {cell.resourceRef} · Revision {cell.resourceRevisionRef}</div>
                                                <div className="mt-1 break-all text-xs text-muted-foreground">Evidence {cell.evidenceRefs.length > 0 ? cell.evidenceRefs.join(", ") : "none"}</div>
                                                {cell.limitations.length > 0 ? <div className="mt-1 text-xs text-muted-foreground">{cell.limitations.join(" · ")}</div> : null}
                                            </div>
                                            <Badge variant="outline">{cell.status}</Badge>
                                        </div>
                                    ))}
                                    {(details.authority_coverage ?? []).length === 0 ? <div className="px-4 py-3 text-sm text-muted-foreground">No canonical Coverage cells.</div> : null}
                                </div>
                            ) : (
                                <>
                                    {!details.challenge.assets || (details.challenge.assets.urls.length === 0 && details.challenge.assets.ips.length === 0) ? (
                                        <div className="text-sm text-muted-foreground">No assets yet.</div>
                                    ) : null}
                                    <div className="grid gap-3 lg:grid-cols-2">
                                        <AssetGroup title="URLs" items={details.challenge.assets?.urls ?? []} />
                                        <AssetGroup title="IPs" items={details.challenge.assets?.ips ?? []} />
                                    </div>
                                </>
                            )}
                        </TabsContent>

                        <TabsContent value="memory" className="min-w-0 space-y-3">
                            <div className="flex justify-end">
                                <Button size="sm" onClick={openCreateMemoryDialog}>
                                    <PlusIcon className="size-4" />
                                    新增 Memory
                                </Button>
                            </div>
                            {boardError ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{boardError}</div> : null}
                            {details.memory.length === 0 && <div className="text-sm text-muted-foreground">No memory entries yet.</div>}
                            {details.memory.map((entry) => (
                                <div key={entry.id} className="min-w-0 rounded-lg border px-4 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <Badge variant="outline">{entry.kind}</Badge>
                                            <code className="text-xs text-muted-foreground">{entry.id}</code>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="icon-sm" disabled={boardBusyKey.length > 0} onClick={() => openEditMemoryDialog(entry)}>
                                                <PencilIcon className="size-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={boardBusyKey.length > 0}
                                                onClick={() => {
                                                    void handleDeleteMemory(entry)
                                                }}
                                            >
                                                <Trash2Icon className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="mt-2 break-words text-sm">{entry.content}</div>
                                    {entry.refs.length > 0 ? <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{entry.refs.join("\n")}</div> : null}
                                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
                                        <span>{entry.source}</span>
                                        <span>{formatTime(entry.updated_at)}</span>
                                    </div>
                                </div>
                            ))}
                        </TabsContent>

                        <TabsContent value="ideas" className="min-w-0 space-y-3">
                            <div className="flex justify-end">
                                <Button size="sm" onClick={openCreateIdeaDialog}>
                                    <PlusIcon className="size-4" />
                                    新增 Idea
                                </Button>
                            </div>
                            {boardError ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{boardError}</div> : null}
                            {details.ideas.length === 0 && <div className="text-sm text-muted-foreground">No ideas yet.</div>}
                            {details.ideas.map((idea) => (
                                <div key={idea.id} className="min-w-0 rounded-lg border px-4 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="min-w-0 break-words text-sm font-medium">{idea.content}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{idea.id}</div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Badge variant="outline">{idea.status}</Badge>
                                            <Button variant="ghost" size="icon-sm" disabled={boardBusyKey.length > 0} onClick={() => openEditIdeaDialog(idea)}>
                                                <PencilIcon className="size-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={boardBusyKey.length > 0}
                                                onClick={() => {
                                                    void handleDeleteIdea(idea)
                                                }}
                                            >
                                                <Trash2Icon className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    {idea.result && <div className="mt-2 break-words text-xs text-muted-foreground">{idea.result}</div>}
                                </div>
                            ))}
                        </TabsContent>

                        <TabsContent value="reports" className="min-w-0 space-y-3">
                            {details.challenge.mode === "authorized_pentest" ? <>
                                {(details.authority_reports ?? []).map((report) => (
                                    <div key={report.id} className="min-w-0 space-y-2 rounded-lg border px-4 py-3 text-sm">
                                        <div className="flex items-center justify-between gap-3">
                                            <Badge variant="outline">Report snapshot</Badge>
                                            {report.committedAt && <span className="text-xs text-muted-foreground">{formatTime(report.committedAt)}</span>}
                                        </div>
                                        <div className="break-all">Snapshot: {report.id}</div>
                                        <div className="break-all">Artifact: {report.artifactRef}</div>
                                        <div className="break-all text-xs text-muted-foreground">Digest: {report.artifactDigest}</div>
                                        <div className="break-all text-xs text-muted-foreground">Evidence: {report.evidenceRefs.join(", ") || "—"}</div>
                                    </div>
                                ))}
                                {(details.authority_reports ?? []).length === 0 && <div className="text-sm text-muted-foreground">No report snapshots yet.</div>}
                            </> : <>
                            {details.submissions.length === 0 && <div className="text-sm text-muted-foreground">No reports yet.</div>}
                            {details.submissions.map((submission) => {
                                const solverId = submission.solver_id?.trim() || ""
                                const clickable = solverId.length > 0
                                const reportLong = isLongReport(submission.report)
                                const reportExpanded = expandedReportIds.has(submission.id)
                                return (
                                    <div
                                        key={submission.id}
                                        role={clickable ? "button" : undefined}
                                        tabIndex={clickable ? 0 : undefined}
                                        onClick={() => {
                                            if (!clickable) return
                                            openRuntimeDetailInNewTab(solverId)
                                        }}
                                        onKeyDown={(event) => {
                                            if (!clickable) return
                                            if (event.key !== "Enter" && event.key !== " ") return
                                            event.preventDefault()
                                            openRuntimeDetailInNewTab(solverId)
                                        }}
                                        className={`min-w-0 rounded-lg border px-4 py-3 transition ${
                                            clickable ? "cursor-pointer hover:bg-muted/50" : ""
                                        }`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0 flex items-center gap-2">
                                                <Badge variant="outline" className="border-green-600/30 bg-green-500/15 text-green-700">
                                                    report
                                                </Badge>
                                                <code className="min-w-0 break-all text-xs">{submission.asset}</code>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2">
                                                <div className="text-xs text-muted-foreground">{formatTime(submission.created_at)}</div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label="Download report"
                                                    title="Download report"
                                                    onClick={(event) => handleDownloadReport(event, submission)}
                                                    onKeyDown={(event) => event.stopPropagation()}
                                                >
                                                    <DownloadIcon className="size-4" />
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                                            {submission.solver_id && <span>solver {submission.solver_id}</span>}
                                            {submission.prompt_name && <span>prompt {submission.prompt_name}</span>}
                                            {submission.model_name && <span>model {submission.model_name}</span>}
                                        </div>
                                        <div className="mt-2 space-y-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="text-xs font-medium text-foreground">Report</div>
                                                {reportLong && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 px-2 text-xs"
                                                        onClick={(event) => {
                                                            event.stopPropagation()
                                                            toggleReportExpanded(submission.id)
                                                        }}
                                                        onKeyDown={(event) => event.stopPropagation()}
                                                    >
                                                        {reportExpanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
                                                        {reportExpanded ? "Collapse" : "Show full"}
                                                    </Button>
                                                )}
                                            </div>
                                            <div className={reportLong && !reportExpanded ? "relative max-h-64 overflow-hidden" : ""}>
                                                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{submission.report}</div>
                                                {reportLong && !reportExpanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-background" />}
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                            </>}
                        </TabsContent>
                    </Tabs>
                </div>
            )}
            <Dialog open={memoryDialogOpen} onOpenChange={setMemoryDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingMemory ? "编辑 Memory" : "新增 Memory"}</DialogTitle>
                        <DialogDescription>用于维护 durable facts、evidence、failure boundaries 或 hint。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Kind</Label>
                            <Select value={memoryForm.kind} onValueChange={(value) => setMemoryForm((current) => ({ ...current, kind: value as MemoryEntry["kind"] }))}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择 kind" />
                                </SelectTrigger>
                                <SelectContent>
                                    {MEMORY_KIND_OPTIONS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {item}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Content</Label>
                            <Textarea rows={4} value={memoryForm.content} onChange={(event) => setMemoryForm((current) => ({ ...current, content: event.target.value }))} />
                        </div>
                        <div className="space-y-2">
                            <Label>Refs</Label>
                            <Textarea
                                rows={3}
                                placeholder="每行一个引用路径或说明"
                                value={memoryForm.refsText}
                                onChange={(event) => setMemoryForm((current) => ({ ...current, refsText: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Source</Label>
                            <Textarea rows={2} value={memoryForm.source} onChange={(event) => setMemoryForm((current) => ({ ...current, source: event.target.value }))} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMemoryDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSaveMemory()} disabled={boardBusyKey.length > 0 || !memoryForm.content.trim() || !memoryForm.source.trim()}>
                            保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <Dialog open={ideaDialogOpen} onOpenChange={setIdeaDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingIdea ? "编辑 Idea" : "新增 Idea"}</DialogTitle>
                        <DialogDescription>idea 是待验证假设。新增和编辑都支持调整内容、状态和结果。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Content</Label>
                            <Textarea
                                rows={3}
                                placeholder="输入待验证假设"
                                value={ideaForm.content}
                                onChange={(event) => setIdeaForm((current) => ({ ...current, content: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Status</Label>
                            <Select value={ideaForm.status} onValueChange={(value) => setIdeaForm((current) => ({ ...current, status: value as IdeaRecord["status"] }))}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择 status" />
                                </SelectTrigger>
                                <SelectContent>
                                    {IDEA_STATUS_OPTIONS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {item}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Result</Label>
                            <Textarea rows={4} value={ideaForm.result} onChange={(event) => setIdeaForm((current) => ({ ...current, result: event.target.value }))} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIdeaDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSaveIdea()} disabled={boardBusyKey.length > 0 || !ideaForm.content.trim()}>
                            保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
