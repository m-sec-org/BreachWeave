import { useEffect, useMemo, useState } from "react"
import { CircleIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react"
import { eventSourceUrl, runtime } from "../../lib/api"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import type { RuntimeSolverView, RuntimeStatusView } from "./types"
import { formatDateTime, isLiveStatus, statusColors } from "./types"

const PAGE_SIZE = 20
const STATUS_FILTER_OPTIONS = ["all", "starting", "running", "stopping", "stopped", "error"] as const
type StatusFilterValue = (typeof STATUS_FILTER_OPTIONS)[number]

function clampPage(page: number, totalItems: number): number {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE))
    return Math.min(Math.max(1, page), totalPages)
}

function paginate<T>(items: T[], page: number): T[] {
    const start = (page - 1) * PAGE_SIZE
    return items.slice(start, start + PAGE_SIZE)
}

export function RuntimeListPage() {
    const [status, setStatus] = useState<RuntimeStatusView | null>(null)
    const [solverList, setSolverList] = useState<RuntimeSolverView[]>([])
    const [actionError, setActionError] = useState("")
    const [filter, setFilter] = useState("")
    const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all")
    const [busySolverId, setBusySolverId] = useState("")
    const [batchBusy, setBatchBusy] = useState("")
    const [page, setPage] = useState(1)
    const [selectedSolverIds, setSelectedSolverIds] = useState<string[]>([])

    const filteredSolvers = useMemo(() => {
        const statusMatched = statusFilter === "all" ? solverList : solverList.filter((solver) => solver.status === statusFilter)
        if (!filter.trim()) return statusMatched
        const keyword = filter.trim().toLowerCase()
        return statusMatched.filter((solver) => `${solver.name} ${solver.promptName} ${solver.task}`.toLowerCase().includes(keyword))
    }, [filter, solverList, statusFilter])
    const pagedSolvers = useMemo(() => paginate(filteredSolvers, page), [filteredSolvers, page])
    const selectedSolvers = useMemo(() => solverList.filter((solver) => selectedSolverIds.includes(solver.id)), [selectedSolverIds, solverList])
    const selectedLiveSolvers = useMemo(() => selectedSolvers.filter((solver) => isLiveStatus(solver.status)), [selectedSolvers])
    const selectedInactiveSolvers = useMemo(() => selectedSolvers.filter((solver) => !isLiveStatus(solver.status)), [selectedSolvers])
    const allPageSelected = pagedSolvers.length > 0 && pagedSolvers.every((solver) => selectedSolverIds.includes(solver.id))
    const totalPages = Math.max(1, Math.ceil(filteredSolvers.length / PAGE_SIZE))

    useEffect(() => {
        setPage((current) => clampPage(current, filteredSolvers.length))
    }, [filteredSolvers.length])

    useEffect(() => {
        setPage(1)
    }, [filter, statusFilter])

    useEffect(() => {
        setSelectedSolverIds((current) => current.filter((id) => solverList.some((solver) => solver.id === id)))
    }, [solverList])

    useEffect(() => {
        let active = true
        void runtime.status().then((next) => {
            if (active) setStatus(next)
        })
        void runtime.list().then((next) => {
            if (active) setSolverList(next as RuntimeSolverView[])
        })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        const source = new EventSource(eventSourceUrl("/api/runtime/stream"))
        source.addEventListener("status", (event) => {
            setStatus(JSON.parse((event as MessageEvent).data) as RuntimeStatusView)
        })
        source.addEventListener("solvers", (event) => {
            setSolverList(JSON.parse((event as MessageEvent).data) as RuntimeSolverView[])
        })
        return () => source.close()
    }, [])

    function handleRefresh() {
        void runtime.status().then((next) => setStatus(next))
        void runtime.list().then((next) => setSolverList(next as RuntimeSolverView[]))
    }

    async function handleStop(solverId: string) {
        const solver = solverList.find((item) => item.id === solverId)
        if (!window.confirm(`停止 Solver ${solver?.name ?? solverId}？`)) return
        setBusySolverId(solverId)
        setActionError("")
        try {
            await runtime.stop(solverId)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusySolverId("")
        }
    }

    async function handleRemove(solverId: string) {
        const solver = solverList.find((item) => item.id === solverId)
        if (!window.confirm(`删除 Solver ${solver?.name ?? solverId}？`)) return
        setBusySolverId(solverId)
        setActionError("")
        try {
            await runtime.stop(solverId)
            if (location.hash === `#/runtime/${solverId}`) location.hash = "#/runtime"
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusySolverId("")
        }
    }

    function toggleSolverSelection(solverId: string) {
        setSelectedSolverIds((current) => (current.includes(solverId) ? current.filter((id) => id !== solverId) : [...current, solverId]))
    }

    function toggleCurrentPageSelection() {
        if (allPageSelected) {
            const pageIds = new Set(pagedSolvers.map((solver) => solver.id))
            setSelectedSolverIds((current) => current.filter((id) => !pageIds.has(id)))
            return
        }
        setSelectedSolverIds((current) => [...new Set([...current, ...pagedSolvers.map((solver) => solver.id)])])
    }

    async function handleBatchStop() {
        if (selectedLiveSolvers.length === 0) return
        if (!window.confirm(`停止选中的 ${selectedLiveSolvers.length} 个运行中 Solver？`)) return
        setBatchBusy("stop")
        setActionError("")
        try {
            await Promise.all(selectedLiveSolvers.map((solver) => runtime.stop(solver.id)))
            const handled = new Set(selectedLiveSolvers.map((solver) => solver.id))
            setSelectedSolverIds((current) => current.filter((id) => !handled.has(id)))
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBatchBusy("")
        }
    }

    async function handleBatchDelete() {
        if (selectedInactiveSolvers.length === 0) return
        if (!window.confirm(`删除选中的 ${selectedInactiveSolvers.length} 个已停止 Solver？`)) return
        setBatchBusy("delete")
        setActionError("")
        try {
            await Promise.all(selectedInactiveSolvers.map((solver) => runtime.stop(solver.id)))
            const handled = new Set(selectedInactiveSolvers.map((solver) => solver.id))
            setSelectedSolverIds((current) => current.filter((id) => !handled.has(id)))
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setBatchBusy("")
        }
    }

    return (
        <div className="flex flex-1 flex-col gap-4 p-6">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 whitespace-nowrap">
                    <CircleIcon className={`size-3 fill-current ${(status?.docker ?? false) ? "text-emerald-500" : "text-red-500"}`} />
                    <span className="text-sm text-muted-foreground">Docker {(status?.docker ?? false) ? "已连接" : "未连接"}</span>
                </div>
                <Input className="min-w-72 flex-1" placeholder="按名称、Prompt、任务过滤" value={filter} onChange={(event) => setFilter(event.target.value)} />
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter((value as StatusFilterValue) ?? "all")}>
                    <SelectTrigger className="w-40">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">全部状态</SelectItem>
                        <SelectItem value="starting">starting</SelectItem>
                        <SelectItem value="running">running</SelectItem>
                        <SelectItem value="stopping">stopping</SelectItem>
                        <SelectItem value="stopped">stopped</SelectItem>
                        <SelectItem value="error">error</SelectItem>
                    </SelectContent>
                </Select>
                <Button
                    variant="outline"
                    size="icon-sm"
                    title="批量停止"
                    aria-label="批量停止"
                    onClick={() => void handleBatchStop()}
                    disabled={selectedLiveSolvers.length === 0 || batchBusy.length > 0}
                >
                    <XIcon className="size-4" />
                </Button>
                <Button
                    variant="outline"
                    size="icon-sm"
                    title="批量删除"
                    aria-label="批量删除"
                    onClick={() => void handleBatchDelete()}
                    disabled={selectedInactiveSolvers.length === 0 || batchBusy.length > 0}
                >
                    <Trash2Icon className="size-4" />
                </Button>
                <Button variant="outline" size="icon-sm" onClick={handleRefresh} title="刷新" aria-label="刷新">
                    <RefreshCwIcon className="size-4" />
                </Button>
            </div>

            {actionError && <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-500">{actionError}</div>}

            <div className="rounded-lg border">
                <div className="divide-y">
                    <div className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="flex items-center gap-3">
                            <input
                                type="checkbox"
                                checked={allPageSelected}
                                aria-label="选择当前页"
                                disabled={pagedSolvers.length === 0}
                                onChange={toggleCurrentPageSelection}
                                className="rounded"
                            />
                            <div className="text-sm text-muted-foreground">
                                共 {filteredSolvers.length} 条
                                {selectedSolverIds.length > 0 ? `，已选择 ${selectedSolverIds.length} 条` : ""}
                                {filteredSolvers.length > 0 ? `，当前第 ${page}/${totalPages} 页` : ""}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                                上一页
                            </Button>
                            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                                下一页
                            </Button>
                        </div>
                    </div>

                    {pagedSolvers.map((solver) => (
                        <div
                            key={solver.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => (location.hash = `#/runtime/${solver.id}`)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") location.hash = `#/runtime/${solver.id}`
                            }}
                            className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/50"
                        >
                            <div className="flex min-w-0 items-start gap-3">
                                <input
                                    type="checkbox"
                                    checked={selectedSolverIds.includes(solver.id)}
                                    onChange={(event) => {
                                        event.stopPropagation()
                                        toggleSolverSelection(solver.id)
                                    }}
                                    onClick={(event) => event.stopPropagation()}
                                    className="mt-1 rounded"
                                />
                                <div className="min-w-0 space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">{solver.name}</span>
                                        <Badge variant="outline">{solver.promptName}</Badge>
                                    </div>
                                    <div className="line-clamp-2 text-sm text-muted-foreground">{solver.task}</div>
                                    {solver.error ? <div className="line-clamp-2 text-xs text-red-500">{solver.error}</div> : null}
                                    <div className="text-xs text-muted-foreground">{formatDateTime(solver.createdAt)}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <CircleIcon className={`size-3 fill-current ${statusColors[solver.status] ?? "text-zinc-400"}`} />
                                <Badge variant={solver.status === "error" ? "destructive" : "outline"}>{solver.status}</Badge>
                                {isLiveStatus(solver.status) ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busySolverId === solver.id}
                                        onClick={(event) => {
                                            event.stopPropagation()
                                            void handleStop(solver.id)
                                        }}
                                    >
                                        <XIcon className="size-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busySolverId === solver.id}
                                        onClick={(event) => {
                                            event.stopPropagation()
                                            void handleRemove(solver.id)
                                        }}
                                    >
                                        <Trash2Icon className="size-4" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}

                    {filteredSolvers.length === 0 ? <div className="px-5 py-16 text-center text-sm text-muted-foreground">暂无可展示的 Solver。</div> : null}
                </div>
            </div>
        </div>
    )
}
