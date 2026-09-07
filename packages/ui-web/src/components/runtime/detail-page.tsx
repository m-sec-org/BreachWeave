import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react"
import { eventSourceUrl, runtime } from "../../lib/api"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { RuntimeMessageList } from "./message-list"
import { applyAgentEvent, formatDateTime, isLiveStatus, mergeSubagentThreads, type RuntimeAgentEvent, type RuntimeDetailsView, type RuntimeThreadView } from "./types"

interface RuntimeDetailPageProps {
    solverId: string
    returnTo?: string
}

const RUNTIME_REPLAY_STEP_MS = 700
const PLAYBACK_SPEED_OPTIONS = ["0.5", "1", "2", "4"] as const
type PlaybackSpeed = (typeof PLAYBACK_SPEED_OPTIONS)[number]

function getUserMessageText(message: Record<string, unknown>) {
    if (message.role !== "user") return ""
    const content = message.content
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && "type" in part)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
}

function trimThreadTaskMessage(thread: RuntimeThreadView) {
    if (!thread.task) return thread
    const task = thread.task.trim()
    const firstIndex = thread.messages.findIndex((message) => {
        const text = getUserMessageText(message)
        return text === task || text === `Task: ${task}`
    })
    if (firstIndex < 0) return thread
    return {
        ...thread,
        messages: thread.messages.filter((_, index) => index !== firstIndex),
    }
}

function threadAnchorTime(thread: RuntimeThreadView): number | undefined {
    if (typeof thread.createdAt === "number") return thread.createdAt
    const firstTimestamp = thread.messages.find((message) => typeof message.timestamp === "number")?.timestamp
    return typeof firstTimestamp === "number" ? firstTimestamp : undefined
}

function formatBoardDateTime(value?: string) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function BoardSection(props: {
    title: string
    count: number
    empty: string
    children: ReactNode
}) {
    const { title, count, empty, children } = props

    return (
        <section className="min-w-0 rounded-lg border">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="text-sm font-medium">{title}</div>
                <Badge variant="outline">{count}</Badge>
            </div>
            <div className="max-h-72 overflow-y-auto px-4 py-3">
                {count === 0 ? <div className="text-sm text-muted-foreground">{empty}</div> : <div className="space-y-3">{children}</div>}
            </div>
        </section>
    )
}

function MemoryBoardSection(props: {
    title: string
    items: RuntimeDetailsView["memory"]
}) {
    const { title, items } = props

    return (
        <BoardSection title={title} count={items.length} empty="暂无 Memory">
            {items.map((entry) => (
                <div key={entry.id} className="min-w-0 rounded-lg border px-3 py-2">
                    <div className="flex items-center gap-2">
                        <Badge variant="outline">{entry.kind}</Badge>
                        <code className="text-xs text-muted-foreground">{entry.id}</code>
                    </div>
                    <div className="mt-2 break-words text-sm">{entry.content}</div>
                    {entry.refs.length > 0 ? <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{entry.refs.join("\n")}</div> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
                        <span>{entry.source}</span>
                        <span>{formatBoardDateTime(entry.updated_at)}</span>
                    </div>
                </div>
            ))}
        </BoardSection>
    )
}

function IdeaBoardSection(props: {
    title: string
    items: RuntimeDetailsView["ideas"]
}) {
    const { title, items } = props

    return (
        <BoardSection title={title} count={items.length} empty="暂无 Idea">
            {items.map((idea) => (
                <div key={idea.id} className="min-w-0 rounded-lg border px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="break-words text-sm font-medium">{idea.content}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{idea.id}</div>
                        </div>
                        <Badge variant="outline">{idea.status}</Badge>
                    </div>
                    {idea.result ? <div className="mt-2 break-words text-xs text-muted-foreground">{idea.result}</div> : null}
                </div>
            ))}
        </BoardSection>
    )
}

function MainThreadBlock(props: {
    thread: RuntimeThreadView
    isStreaming: boolean
    subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]>
}) {
    const { thread, isStreaming, subagentThreadsByToolCallId } = props

    return (
        <section className="min-w-0 overflow-x-hidden">
            <RuntimeMessageList thread={thread} isStreaming={isStreaming} subagentThreadsByToolCallId={subagentThreadsByToolCallId} />
        </section>
    )
}

function ObserverMarkerBlock(props: {
    thread: RuntimeThreadView
    onOpen: () => void
}) {
    const { thread, onOpen } = props

    return (
        <section className="min-w-0">
            <button
                type="button"
                onClick={onOpen}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-muted/40"
            >
                <div className="h-px flex-1 bg-border" />
                <div className="shrink-0 text-xs font-medium text-muted-foreground">
                    {thread.label}
                    {thread.createdAt ? ` · ${formatDateTime(thread.createdAt)}` : ""}
                    {" · 点击查看"}
                </div>
                <div className="h-px flex-1 bg-border" />
            </button>
        </section>
    )
}

function resolveReturnTarget(returnTo?: string): string {
    return returnTo?.startsWith("#/") ? returnTo : "#/runtime"
}

export function RuntimeDetailPage({ solverId, returnTo }: RuntimeDetailPageProps) {
    const [details, setDetails] = useState<RuntimeDetailsView | null>(null)
    const [detailsLoading, setDetailsLoading] = useState(false)
    const [replayIndex, setReplayIndex] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>("1")
    const [taskDialogOpen, setTaskDialogOpen] = useState(false)
    const [boardDialogOpen, setBoardDialogOpen] = useState(false)
    const [observerDialogThread, setObserverDialogThread] = useState<RuntimeThreadView | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const shouldAutoFollowRef = useRef(true)
    const followTimerRef = useRef<number | null>(null)

    const loadDetails = useCallback(async () => {
        setDetailsLoading(true)
        try {
            const next = (await runtime.get(solverId)) as unknown as RuntimeDetailsView
            setDetails(next)
        } catch {
            setDetails(null)
        } finally {
            setDetailsLoading(false)
        }
    }, [solverId])

    useEffect(() => {
        void loadDetails()
    }, [loadDetails])

    useEffect(() => {
        const source = new EventSource(eventSourceUrl(`/api/runtime/solvers/${encodeURIComponent(solverId)}/stream`))
        source.addEventListener("details", (event) => {
            const payload = JSON.parse((event as MessageEvent).data) as RuntimeDetailsView | { notFound?: boolean }
            setDetails(payload && "solver" in payload ? payload : null)
            setDetailsLoading(false)
        })
        source.addEventListener("agent_event", (event) => {
            const nextEvent = JSON.parse((event as MessageEvent).data) as RuntimeAgentEvent
            setDetails((current) => {
                if (!current) return current
                const withMessages = applyAgentEvent(current, nextEvent)
                return mergeSubagentThreads(withMessages, nextEvent)
            })
        })
        return () => source.close()
    }, [solverId])

    const timelineTimestamps = useMemo(() => {
        const timestamps: number[] = []
        for (const thread of details?.threads ?? []) {
            for (const message of thread.messages) {
                if (typeof message.timestamp === "number") timestamps.push(message.timestamp)
            }
        }
        timestamps.sort((a, b) => a - b)
        return timestamps
    }, [details?.threads])

    const replayTimestamp = replayIndex > 0 ? timelineTimestamps[Math.min(replayIndex - 1, timelineTimestamps.length - 1)] : undefined
    const itemCount = timelineTimestamps.length

    useEffect(() => {
        if (!details?.solver || !isLiveStatus(details.solver.status)) return
        if (isPlaying) return
        if (replayIndex < itemCount) return
        const timer = window.setInterval(() => {
            void loadDetails()
        }, 3000)
        return () => window.clearInterval(timer)
    }, [details?.solver, isPlaying, replayIndex, itemCount, loadDetails])

    useEffect(() => {
        setReplayIndex(itemCount)
    }, [itemCount])

    useEffect(() => {
        const container = scrollRef.current
        if (!container) return
        if (isPlaying) return
        if (!details?.solver || !isLiveStatus(details.solver.status)) return
        if (!shouldAutoFollowRef.current) return

        if (followTimerRef.current !== null) window.clearTimeout(followTimerRef.current)
        followTimerRef.current = window.setTimeout(() => {
            const next = scrollRef.current
            if (!next) return
            next.scrollTo({ top: next.scrollHeight, behavior: "smooth" })
            followTimerRef.current = null
        }, 120)

        return () => {
            if (followTimerRef.current !== null) {
                window.clearTimeout(followTimerRef.current)
                followTimerRef.current = null
            }
        }
    }, [details?.solver, isPlaying, itemCount])

    useEffect(
        () => () => {
            if (followTimerRef.current !== null) {
                window.clearTimeout(followTimerRef.current)
                followTimerRef.current = null
            }
        },
        [],
    )

    useEffect(() => {
        if (!isPlaying) return
        if (itemCount === 0) return
        if (replayIndex >= itemCount) {
            setIsPlaying(false)
            return
        }

        const timer = window.setTimeout(() => {
            setReplayIndex((current) => {
                const next = current + 1
                if (next >= itemCount) {
                    setIsPlaying(false)
                    return itemCount
                }
                return next
            })
        }, Math.max(80, RUNTIME_REPLAY_STEP_MS / Number(playbackSpeed)))

        return () => window.clearTimeout(timer)
    }, [isPlaying, itemCount, playbackSpeed, replayIndex])

    const mainVisibleThread = useMemo(() => {
        if (replayTimestamp === undefined) return undefined
        const mainThread = details?.threads.find((thread) => thread.kind === "main")
        if (!mainThread) return undefined
        const filteredThread = trimThreadTaskMessage({
            ...mainThread,
            messages: mainThread.messages.filter((message) => typeof message.timestamp === "number" && message.timestamp <= replayTimestamp),
        })
        return filteredThread.messages.length > 0 ? filteredThread : undefined
    }, [details?.threads, replayTimestamp])

    const visibleSubagentThreads = useMemo(() => {
        if (replayTimestamp === undefined) return []
        return (details?.threads ?? [])
            .filter((thread) => thread.kind === "subagent")
            .map((thread) =>
                trimThreadTaskMessage({
                    ...thread,
                    messages: thread.messages.filter((message) => typeof message.timestamp === "number" && message.timestamp <= replayTimestamp),
                }),
            )
            .filter((thread) => thread.messages.length > 0)
            .sort((a, b) => (threadAnchorTime(a) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(b) ?? Number.MAX_SAFE_INTEGER))
    }, [details?.threads, replayTimestamp])

    const visibleObserverThreads = useMemo(() => {
        if (replayTimestamp === undefined) return []
        return (details?.threads ?? [])
            .filter((thread) => thread.kind === "observer")
            .map((thread) => ({
                ...thread,
                messages: thread.messages.filter((message) => typeof message.timestamp === "number" && message.timestamp <= replayTimestamp),
            }))
            .filter((thread) => thread.messages.length > 0)
            .sort((a, b) => (threadAnchorTime(a) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(b) ?? Number.MAX_SAFE_INTEGER))
    }, [details?.threads, replayTimestamp])

    const subagentThreadsByToolCallId = useMemo(() => {
        const grouped: Record<string, RuntimeThreadView[]> = {}
        for (const thread of visibleSubagentThreads) {
            if (!thread.parentToolCallId) continue
            if (!grouped[thread.parentToolCallId]) grouped[thread.parentToolCallId] = []
            grouped[thread.parentToolCallId].push(thread)
        }
        for (const key of Object.keys(grouped)) {
            grouped[key].sort((a, b) => (threadAnchorTime(a) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(b) ?? Number.MAX_SAFE_INTEGER))
        }
        return grouped
    }, [visibleSubagentThreads])

    const timelineBlocks = useMemo(() => {
        const mainThread = mainVisibleThread
        const observerThreads = visibleObserverThreads
        if (!mainThread && observerThreads.length === 0) return []

        const blocks: Array<{ type: "main"; thread: RuntimeThreadView } | { type: "observer"; thread: RuntimeThreadView }> = []
        const mainMessages = mainThread?.messages ?? []
        let cursor = 0

        for (const observerThread of observerThreads) {
            const observerTime = threadAnchorTime(observerThread) ?? Number.MAX_SAFE_INTEGER
            let splitIndex = cursor
            while (splitIndex < mainMessages.length) {
                const timestamp = typeof mainMessages[splitIndex]?.timestamp === "number" ? (mainMessages[splitIndex].timestamp as number) : Number.MAX_SAFE_INTEGER
                if (timestamp > observerTime) break
                splitIndex += 1
            }

            const segmentMessages = mainMessages.slice(cursor, splitIndex)
            if (segmentMessages.length > 0 && mainThread) {
                blocks.push({
                    type: "main",
                    thread: { ...mainThread, id: `${mainThread.id}:segment:${blocks.length}`, messages: segmentMessages },
                })
            }
            blocks.push({ type: "observer", thread: observerThread })
            cursor = splitIndex
        }

        const trailingMessages = mainMessages.slice(cursor)
        if (trailingMessages.length > 0 && mainThread) {
            blocks.push({
                type: "main",
                thread: { ...mainThread, id: `${mainThread.id}:segment:${blocks.length}`, messages: trailingMessages },
            })
        }

        return blocks
    }, [mainVisibleThread, visibleObserverThreads])
    const liveStreaming = !!details?.solver && isLiveStatus(details.solver.status)

    async function handleStop() {
        await runtime.stop(solverId)
        await loadDetails()
    }

    const returnTarget = resolveReturnTarget(returnTo)

    if (!details?.solver) {
        return (
            <div className="flex h-[calc(100vh-3rem)] flex-1 flex-col overflow-hidden">
                <div className="border-b px-6 py-5">
                    <a href={returnTarget} className="-ml-2 inline-flex w-fit items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-accent">
                        <ArrowLeftIcon className="size-4" />
                        返回
                    </a>
                </div>
                <div className="flex flex-1 items-center justify-center px-6">
                    <div className="text-sm text-muted-foreground">{detailsLoading ? "加载中..." : "Solver 不存在或已被清理。"}</div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex h-[calc(100vh-3rem)] flex-1 flex-col overflow-hidden">
            <div className="border-b px-4 py-3 md:px-6">
                <div className="flex items-start gap-3">
                    <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2.5" onClick={() => (location.hash = returnTarget)}>
                        <ArrowLeftIcon className="size-4" />
                        返回
                    </Button>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="truncate text-lg font-semibold tracking-tight">{details.solver.name}</h1>
                            {details.solver.promptName ? <Badge variant="outline">{details.solver.promptName}</Badge> : null}
                            <Badge variant={details.solver.status === "error" ? "destructive" : "outline"}>{details.solver.status}</Badge>
                            {details.solver.createdAt ? <span className="text-xs text-muted-foreground">{formatDateTime(details.solver.createdAt)}</span> : null}
                        </div>
                        {details.solver.task ? (
                            <div className="mt-1">
                                <div className="line-clamp-2 text-sm text-muted-foreground">{details.solver.task}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setTaskDialogOpen(true)}
                                        className="text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
                                    >
                                        查看详情
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setBoardDialogOpen(true)}
                                        className="text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
                                    >
                                        查看 Memory / Ideas
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="mt-2">
                                <button
                                    type="button"
                                    onClick={() => setBoardDialogOpen(true)}
                                    className="text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
                                >
                                    查看 Memory / Ideas
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div
                ref={scrollRef}
                className="runtime-detail-content min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-24 pt-3 md:px-6"
                onScroll={(event) => {
                    const target = event.currentTarget
                    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
                    shouldAutoFollowRef.current = distanceFromBottom < 80
                }}
            >
                {detailsLoading && !details ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载消息流中...</div>
                ) : itemCount > 0 ? (
                    <div className="space-y-4">
                        {timelineBlocks.map((block) =>
                            block.type === "main" ? (
                                <div key={block.thread.id}>
                                    <MainThreadBlock
                                        thread={block.thread}
                                        isStreaming={isPlaying || liveStreaming}
                                        subagentThreadsByToolCallId={subagentThreadsByToolCallId}
                                    />
                                </div>
                            ) : (
                                <ObserverMarkerBlock
                                    key={block.thread.id}
                                    thread={block.thread}
                                    onOpen={() => setObserverDialogThread(block.thread)}
                                />
                            ),
                        )}
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">当前 Solver 还没有可展示的消息流。</div>
                )}
            </div>

            <div className="fixed right-0 bottom-0 left-0 z-20 border-t bg-background/96 backdrop-blur md:left-[var(--sidebar-width)]">
                <div className="flex items-center gap-3 px-4 py-2 md:px-6">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            if (replayIndex >= itemCount) setReplayIndex(0)
                            setIsPlaying((current) => !current)
                        }}
                        disabled={itemCount === 0}
                    >
                        {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
                        {isPlaying ? "暂停" : "播放"}
                    </Button>
                    {isLiveStatus(details.solver.status) ? (
                        <Button variant="destructive" size="sm" onClick={handleStop}>
                            <SquareIcon className="size-4" />
                            取消
                        </Button>
                    ) : null}
                    <Select value={playbackSpeed} onValueChange={(value) => setPlaybackSpeed((value as PlaybackSpeed | undefined) ?? "1")}>
                        <SelectTrigger size="sm" className="w-20">
                            <SelectValue>{playbackSpeed}x</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {PLAYBACK_SPEED_OPTIONS.map((speed) => (
                                <SelectItem key={speed} value={speed}>
                                    {speed}x
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Slider
                        className="min-w-0 flex-1"
                        value={[Math.min(replayIndex, Math.max(itemCount, 0))]}
                        min={0}
                        max={Math.max(itemCount, 1)}
                        step={1}
                        onValueChange={(value) => {
                            setIsPlaying(false)
                            setReplayIndex(Array.isArray(value) ? (value[0] ?? 0) : value)
                        }}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {replayIndex} / {itemCount}
                    </span>
                </div>
            </div>

            <Dialog open={observerDialogThread !== null} onOpenChange={(open) => !open && setObserverDialogThread(null)}>
                <DialogContent className="flex max-h-[80vh] max-w-4xl flex-col overflow-hidden">
                    <DialogHeader>
                        <DialogTitle>
                            {observerDialogThread?.label ?? "Observer hint"}
                            {observerDialogThread?.createdAt ? ` · ${formatDateTime(observerDialogThread.createdAt)}` : ""}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border bg-muted/20 px-2 py-3">
                        {observerDialogThread ? <RuntimeMessageList thread={observerDialogThread} isStreaming={false} /> : null}
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
                <DialogContent className="max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>任务描述</DialogTitle>
                    </DialogHeader>
                    <div className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/20 px-4 py-3 text-sm">
                        {details.solver.task}
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={boardDialogOpen} onOpenChange={setBoardDialogOpen}>
                <DialogContent className="flex max-h-[85vh] max-w-5xl flex-col overflow-hidden">
                    <DialogHeader>
                        <DialogTitle>Memory / Ideas</DialogTitle>
                    </DialogHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="mb-4 text-sm text-muted-foreground">
                            这里展示的是当前 solver 持有的 memory / ideas，包含启动时带入的题目背景以及后续 observer 维护的内容。
                        </div>
                        <div className="grid gap-4 lg:grid-cols-2">
                            <MemoryBoardSection title="Memory" items={details.memory} />
                            <IdeaBoardSection title="Ideas" items={details.ideas} />
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
