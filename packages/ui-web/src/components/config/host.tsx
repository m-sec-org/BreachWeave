import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { hostPlannerPrompt, hostSettings, modelPrefs } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Textarea } from "../ui/textarea"

const DEFAULT_MAX_SOLVERS = 7
const DEFAULT_PLANNER_TICK_SECONDS = 30
const DEFAULT_STALE_TIMEOUT_MINUTES = 60
const DEFAULT_PLANNER_DECISION_TIMEOUT_MINUTES = 5
const DEFAULT_RUNTIME_NETWORK_MODE = "host"
const NONE_MODEL_VALUE = "__none__"

function formatPlannerModelLabel(model: { provider: string; providerId?: string; modelId: string; name?: string }) {
    const provider = model.providerId ? `${model.provider} (${model.providerId})` : model.provider
    return `${provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}`
}

function normalizeModelPrefId(value: unknown) {
    return value == null ? "" : String(value)
}

export function HostPage() {
    return (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            挑战源已固定为本地模式，Host Challenge 配置已移除。请在项目页面管理挑战，在 Planner 页面配置调度参数。
        </div>
    )
}

export function PlannerPage() {
    const { data, loading, error, reload } = useFetch(hostSettings.get)
    const { data: plannerPromptData, reload: reloadPlannerPrompt } = useFetch(hostPlannerPrompt.get)
    const { data: models } = useFetch(modelPrefs.list)
    const [maxSolvers, setMaxSolvers] = useState(String(DEFAULT_MAX_SOLVERS))
    const [networkMode, setNetworkMode] = useState(DEFAULT_RUNTIME_NETWORK_MODE)
    const [plannerPromptContent, setPlannerPromptContent] = useState("")
    const [plannerModelId, setPlannerModelId] = useState("")
    const [plannerTickSeconds, setPlannerTickSeconds] = useState(String(DEFAULT_PLANNER_TICK_SECONDS))
    const [staleTimeoutMinutes, setStaleTimeoutMinutes] = useState(String(DEFAULT_STALE_TIMEOUT_MINUTES))
    const [decisionTimeoutMinutes, setDecisionTimeoutMinutes] = useState(String(DEFAULT_PLANNER_DECISION_TIMEOUT_MINUTES))
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState("")

    useEffect(() => {
        setMaxSolvers(String(data?.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS))
        setNetworkMode(data?.runtime.networkMode === "bridge" ? "bridge" : DEFAULT_RUNTIME_NETWORK_MODE)
        setPlannerTickSeconds(String(Math.max(5, Math.round((data?.planner.tickIntervalMs ?? DEFAULT_PLANNER_TICK_SECONDS * 1000) / 1000))))
        setStaleTimeoutMinutes(String(Math.max(1, Math.round((data?.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MINUTES * 60 * 1000) / 60000))))
        setDecisionTimeoutMinutes(String(Math.max(1, Math.round((data?.planner.decisionTimeoutMs ?? DEFAULT_PLANNER_DECISION_TIMEOUT_MINUTES * 60 * 1000) / 60000))))
    }, [data])

    useEffect(() => {
        setPlannerPromptContent(plannerPromptData?.content ?? "")
        setPlannerModelId(normalizeModelPrefId(plannerPromptData?.meta.model))
    }, [plannerPromptData])

    async function handleSave(event: FormEvent) {
        event.preventDefault()
        setSaving(true)
        setMessage("")
        try {
            await hostPlannerPrompt.set(plannerPromptContent, plannerModelId || undefined)
            await hostSettings.set({
                runtime: {
                    maxSolvers: Math.max(0, Number(maxSolvers) || DEFAULT_MAX_SOLVERS),
                    networkMode: networkMode === "bridge" ? "bridge" : "host",
                },
                planner: {
                    tickIntervalMs: Math.max(5, Number(plannerTickSeconds) || DEFAULT_PLANNER_TICK_SECONDS) * 1000,
                    staleTimeoutMs: Math.max(1, Number(staleTimeoutMinutes) || DEFAULT_STALE_TIMEOUT_MINUTES) * 60 * 1000,
                    decisionTimeoutMs: Math.max(1, Number(decisionTimeoutMinutes) || DEFAULT_PLANNER_DECISION_TIMEOUT_MINUTES) * 60 * 1000,
                },
            })
            setMessage("Saved")
            reload()
            reloadPlannerPrompt()
        } finally {
            setSaving(false)
        }
    }

    return (
        <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-1">
                    <div className="text-sm font-medium">Planner Runtime</div>
                    <div className="text-sm text-muted-foreground">这里控制自动调度的频率、超时和并发上限。启停配置放在项目页面操作。</div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="runtime-max-solvers">Max Solvers</Label>
                    <Input
                        id="runtime-max-solvers"
                        type="number"
                        min="0"
                        value={maxSolvers}
                        onChange={(event) => setMaxSolvers(event.target.value)}
                    />
                    <div className="text-sm text-muted-foreground">调度器最多同时保留多少个 solver。`0` 等价于暂停自动调度。</div>
                </div>
                <div className="space-y-2">
                    <Label>Docker Network Mode</Label>
                    <Select value={networkMode} onValueChange={(value) => setNetworkMode(value === "bridge" ? "bridge" : "host")}>
                        <SelectTrigger>
                            <SelectValue placeholder="选择容器网络模式" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="host">host</SelectItem>
                            <SelectItem value="bridge">bridge</SelectItem>
                        </SelectContent>
                    </Select>
                    <div className="text-sm text-muted-foreground">solver 容器启动时使用的 Docker 网络模式。</div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="planner-tick-seconds">Planner Tick Interval Seconds</Label>
                        <Input
                            id="planner-tick-seconds"
                            type="number"
                            min="5"
                            value={plannerTickSeconds}
                            onChange={(event) => setPlannerTickSeconds(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">challenge 同步完成后，按这个间隔进入下一轮规划。最小 5 秒。</div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="planner-stale-timeout">Stale Timeout Minutes</Label>
                        <Input
                            id="planner-stale-timeout"
                            type="number"
                            min="1"
                            value={staleTimeoutMinutes}
                            onChange={(event) => setStaleTimeoutMinutes(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">某题占用 solver 超过这个时长后，会被视为 stale，调度器可把窗口让给别的题。</div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="planner-decision-timeout">Planner Decision Timeout Minutes</Label>
                        <Input
                            id="planner-decision-timeout"
                            type="number"
                            min="1"
                            value={decisionTimeoutMinutes}
                            onChange={(event) => setDecisionTimeoutMinutes(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">单轮 planner 调度（含模型推理与工具调用）的硬性时限。慢模型或大状态请调大。最小 1 分钟。</div>
                    </div>
                </div>
            </div>

            <div className="space-y-2 rounded-lg border p-4">
                <div className="space-y-1">
                    <Label htmlFor="planner-prompt-content">Planner System Prompt</Label>
                    <div className="text-sm text-muted-foreground">配置比赛规划 agent 的系统提示词和默认模型。</div>
                </div>
                <div className="space-y-2">
                    <Label>Planner Model</Label>
                    <Select value={plannerModelId || NONE_MODEL_VALUE} onValueChange={(value) => setPlannerModelId(value === NONE_MODEL_VALUE ? "" : (value ?? ""))}>
                        <SelectTrigger>
                            <SelectValue placeholder="选择 Planner 模型">
                                {(() => {
                                    const model = models?.find((item) => item.id === plannerModelId)
                                    if (!plannerModelId) return "不指定"
                                    if (!model) return plannerModelId
                                    return formatPlannerModelLabel(model)
                                })()}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NONE_MODEL_VALUE}>不指定</SelectItem>
                            {(models ?? []).map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                    {formatPlannerModelLabel(model)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Textarea
                    id="planner-prompt-content"
                    value={plannerPromptContent}
                    onChange={(event) => setPlannerPromptContent(event.target.value)}
                    rows={14}
                />
            </div>

            <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                </Button>
                {loading && <span className="text-sm text-muted-foreground">Loading...</span>}
                {!loading && message && <span className="text-sm text-muted-foreground">{message}</span>}
                {!loading && error && <span className="text-sm text-red-500">{error}</span>}
            </div>
        </form>
    )
}
