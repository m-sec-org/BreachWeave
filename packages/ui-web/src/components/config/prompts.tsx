import { useEffect, useState, useMemo } from "react"
import { prompts, tools, skills, modelPrefs, mcpServers } from "../../lib/api"
import type { PromptFile, ToolEntry, ModelConfigEntry, Skill } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { Badge } from "../ui/badge"
import { ScrollArea } from "../ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Switch } from "../ui/switch"
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs"
import { Trash2Icon, PlusIcon, ChevronLeftIcon, CopyIcon } from "lucide-react"

interface FormState {
    name: string
    description: string
    model: string
    observerEnabled: boolean
    observerModel: string
    mcps?: string[]
    tools: string[]
    skills: string[]
    subagents: string[]
    isSubagent: boolean
    disabled: boolean
    content: string
}

const emptyForm: FormState = {
    name: "",
    description: "",
    model: "",
    observerEnabled: false,
    observerModel: "",
    tools: [],
    skills: [],
    subagents: [],
    isSubagent: false,
    disabled: false,
    content: "",
}
const NONE_MODEL_VALUE = "__none__"

function formatModelProviderLabel(model: { provider: string; providerId?: string; modelId: string; name?: string }) {
    const provider = model.providerId ? `${model.provider} (${model.providerId})` : model.provider
    return `${provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}`
}

function ensureReadTool(tools: string[], skills: string[]) {
    return skills.length > 0 && !tools.includes("read") ? ["read", ...tools] : tools
}

function normalizeModelPrefId(value: unknown) {
    return value == null ? "" : String(value)
}

function sortPrompts(items: PromptFile[]): PromptFile[] {
    return [...items].sort((left, right) => {
        const leftDisabled = left.meta.disabled === true
        const rightDisabled = right.meta.disabled === true
        if (leftDisabled !== rightDisabled) return leftDisabled ? 1 : -1
        return left.name.localeCompare(right.name)
    })
}

function fromPrompt(p: PromptFile): FormState {
    const skills = p.meta.skills ?? []
    const tools = ensureReadTool(p.meta.tools ?? [], skills)
    return {
        name: p.name,
        description: String(p.meta.description ?? ""),
        model: normalizeModelPrefId(p.meta.model),
        observerEnabled: p.meta.observerEnabled === true,
        observerModel: normalizeModelPrefId(p.meta.observerModel),
        mcps: p.meta.mcps,
        tools,
        skills,
        subagents: p.meta.subagents ?? [],
        isSubagent: p.meta.isSubagent === true,
        disabled: p.meta.disabled === true,
        content: p.content,
    }
}

function toPrompt(f: FormState): PromptFile {
    const tools = ensureReadTool(f.tools, f.skills)
    return {
        name: f.name,
        meta: {
            ...(f.description && { description: f.description }),
            ...(f.model && { model: f.model }),
            ...(f.observerEnabled ? { observerEnabled: true } : {}),
            ...(f.observerEnabled && f.observerModel ? { observerModel: f.observerModel } : {}),
            ...(f.mcps !== undefined && { mcps: f.mcps }),
            ...(tools.length > 0 && { tools }),
            ...(f.skills.length > 0 && { skills: f.skills }),
            ...(!f.isSubagent && f.subagents.length > 0 && { subagents: f.subagents }),
            ...(f.isSubagent ? { isSubagent: true } : {}),
            ...(f.disabled ? { disabled: true } : {}),
        },
        content: f.content,
    }
}

export function PromptsPage() {
    const { data: agentList, loading: agentLoading, reload: reloadAgents } = useFetch(prompts.listAgents)
    const { data: subagentList, loading: subagentLoading, reload: reloadSubagents } = useFetch(prompts.listSubagents)
    const { data: toolList } = useFetch(tools.list)
    const { data: skillList } = useFetch(skills.list)
    const { data: modelList } = useFetch(modelPrefs.list)
    const { data: mcpServerList } = useFetch(mcpServers.list)

    const [form, setForm] = useState<FormState | null>(null)
    const [editing, setEditing] = useState(false)
    const [editingBuiltin, setEditingBuiltin] = useState(false)
    const [sourceName, setSourceName] = useState<string | null>(null)
    const [saveError, setSaveError] = useState("")
    const [promptTab, setPromptTab] = useState<"agent" | "subagent">("agent")
    const defaultModelId = useMemo(() => modelList?.find((model) => model.id.trim())?.id ?? "", [modelList])

    function openNew() {
        setForm({ ...emptyForm, isSubagent: promptTab === "subagent", model: defaultModelId })
        setEditing(false)
        setEditingBuiltin(false)
        setSourceName(null)
        setSaveError("")
    }

    function openEdit(p: PromptFile) {
        setForm(fromPrompt(p))
        setEditing(true)
        setEditingBuiltin(!!p.builtin)
        setSourceName(p.name)
        setSaveError("")
    }

    function buildCopyName(name: string) {
        const allNames = new Set([...(agentList ?? []).map((prompt) => prompt.name), ...(subagentList ?? []).map((prompt) => prompt.name)])
        let nextName = `${name}-copy`
        let index = 2
        while (allNames.has(nextName)) {
            nextName = `${name}-copy-${index}`
            index += 1
        }
        return nextName
    }

    function openCopy(p: PromptFile) {
        setForm({ ...fromPrompt(p), name: buildCopyName(p.name) })
        setEditing(false)
        setEditingBuiltin(false)
        setSourceName(null)
        setSaveError("")
    }

    function closeEditor() {
        setForm(null)
        setEditing(false)
        setEditingBuiltin(false)
        setSourceName(null)
        setSaveError("")
    }

    async function handleSave() {
        if (!form || !form.name.trim() || !form.content.trim()) return
        if (!form.model.trim()) {
            setSaveError("请选择一个模型")
            return
        }
        if (nameConflict) {
            setSaveError(`Prompt 名称 "${form.name.trim()}" 已存在`)
            return
        }
        const prompt = toPrompt(form)
        await prompts.set(prompt)
        if (editing && sourceName && sourceName !== prompt.name) {
            await prompts.remove(sourceName)
        }
        closeEditor()
        reloadAgents()
        reloadSubagents()
    }

    async function handleRemove(name: string) {
        await prompts.remove(name)
        if (form?.name === name || sourceName === name) closeEditor()
        reloadAgents()
        reloadSubagents()
    }

    async function handleToggleDisabled(prompt: PromptFile, disabled: boolean) {
        await prompts.set({
            ...prompt,
            meta: {
                ...prompt.meta,
                ...(disabled ? { disabled: true } : { disabled: undefined }),
            },
        })
        if (form?.name === prompt.name) {
            setForm((current) => (current ? { ...current, disabled } : current))
        }
        reloadAgents()
        reloadSubagents()
    }

    const [toolFilter, setToolFilter] = useState("all")
    const visiblePrompts = useMemo(() => sortPrompts(promptTab === "subagent" ? (subagentList ?? []) : (agentList ?? [])), [promptTab, agentList, subagentList])
    const subagentPrompts = useMemo(() => sortPrompts((subagentList ?? []).filter((prompt) => prompt.meta.disabled !== true)), [subagentList])
    const allPromptNames = useMemo(() => new Set([...(agentList ?? []).map((prompt) => prompt.name), ...(subagentList ?? []).map((prompt) => prompt.name)]), [agentList, subagentList])
    const trimmedFormName = form?.name.trim() ?? ""
    const nameConflict = trimmedFormName.length > 0 && trimmedFormName !== sourceName && allPromptNames.has(trimmedFormName)

    const availableMcpServers = useMemo(() => (mcpServerList ?? []).map((item) => item.name), [mcpServerList])
    const enabledMcpServers = useMemo(() => {
        if (!form) return new Set<string>()
        return new Set(form.mcps ?? [])
    }, [availableMcpServers, form])

    useEffect(() => {
        if (!form || form.model || !defaultModelId) return
        setForm((current) => {
            if (!current || current.model) return current
            return { ...current, model: defaultModelId }
        })
    }, [defaultModelId, form])

    const toolCategories = useMemo(() => {
        if (!toolList) return []
        const visibleTools = toolList.filter((t) => t.source !== "mcp" || (t.server && enabledMcpServers.has(t.server)))
        const counts: Record<string, number> = {}
        const mcpServers = new Set<string>()
        for (const t of visibleTools) {
            counts[t.source] = (counts[t.source] ?? 0) + 1
            if (t.source === "mcp" && t.server) mcpServers.add(t.server)
        }
        const cats: Array<{ value: string; label: string; count: number }> = []
        cats.push({ value: "all", label: "全部", count: visibleTools.length })
        if (counts.builtin) cats.push({ value: "builtin", label: "内置", count: counts.builtin })
        if (counts.custom) cats.push({ value: "custom", label: "自定义", count: counts.custom })
        if (counts.mcp) cats.push({ value: "mcp", label: "MCP", count: counts.mcp })
        for (const s of [...mcpServers].sort()) {
            cats.push({ value: `mcp:${s}`, label: s, count: visibleTools.filter((t) => t.server === s).length })
        }
        return cats
    }, [enabledMcpServers, form?.mcps, toolList])

    const filteredTools = useMemo(() => {
        if (!toolList) return []
        const visibleTools = toolList.filter((t) => t.source !== "mcp" || (t.server && enabledMcpServers.has(t.server)))
        if (toolFilter === "all") return visibleTools
        if (toolFilter.startsWith("mcp:")) return visibleTools.filter((t) => t.server === toolFilter.slice(4))
        return visibleTools.filter((t) => t.source === toolFilter)
    }, [enabledMcpServers, form?.mcps, toolList, toolFilter])

    function selectAllFiltered() {
        const names = filteredTools.map((t) => t.name)
        setForm((f) => f && { ...f, tools: [...new Set([...f.tools, ...names])] })
    }

    function deselectAllFiltered() {
        const names = new Set(filteredTools.map((t) => t.name))
        setForm((f) => f && { ...f, tools: f.tools.filter((t) => !names.has(t)) })
    }

    function toggleTool(name: string) {
        setForm((f) => {
            if (!f) return f
            if (name === "read" && f.skills.length > 0) return f
            const nextTools = f.tools.includes(name) ? f.tools.filter((t) => t !== name) : [...f.tools, name]
            return { ...f, tools: ensureReadTool(nextTools, f.skills) }
        })
    }

    function toggleMcpServer(name: string) {
        setForm((f) => {
            if (!f) return f

            const current = f.mcps ?? []
            const next = current.includes(name) ? current.filter((server) => server !== name) : [...current, name]
            const nextMcps = next
            const nextEnabled = new Set(nextMcps)
            const nextTools = f.tools.filter((toolName) => {
                const tool = toolList?.find((entry) => entry.name === toolName)
                return tool?.source !== "mcp" || (tool.server && nextEnabled.has(tool.server))
            })

            return { ...f, mcps: nextMcps, tools: nextTools }
        })
    }

    function toggleSkill(name: string) {
        setForm((f) => {
            if (!f) return f
            const nextSkills = f.skills.includes(name) ? f.skills.filter((s) => s !== name) : [...f.skills, name]
            return { ...f, skills: nextSkills, tools: ensureReadTool(f.tools, nextSkills) }
        })
    }

    function toggleSubagent(name: string) {
        setForm((f) => f && { ...f, subagents: f.subagents.includes(name) ? f.subagents.filter((s) => s !== name) : [...f.subagents, name] })
    }

    const patch = (key: keyof FormState, value: string) => setForm((f) => f && { ...f, [key]: value })

    // ── List view ──
    if (!form) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                    <Tabs value={promptTab} onValueChange={(value) => setPromptTab((value as "agent" | "subagent") ?? "agent")}>
                        <TabsList>
                            <TabsTrigger value="agent">Agent</TabsTrigger>
                            <TabsTrigger value="subagent">Subagent</TabsTrigger>
                        </TabsList>
                    </Tabs>
                    <Button size="sm" onClick={openNew}>
                        <PlusIcon className="size-4 mr-1" />
                        新建
                    </Button>
                </div>

                {agentLoading || subagentLoading ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                ) : visiblePrompts.length > 0 ? (
                    <div className="space-y-2">
                        {visiblePrompts.map((p) => (
                            <div
                                key={p.name}
                                className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
                                onClick={() => openEdit(p)}
                            >
                                <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium">{p.name}</span>
                                        {p.meta.isSubagent && (
                                            <Badge variant="outline" className="text-[10px]">
                                                Subagent
                                            </Badge>
                                        )}
                                        {p.meta.disabled === true && (
                                            <Badge variant="destructive" className="text-[10px]">
                                                Disabled
                                            </Badge>
                                        )}
                                        {p.meta.observerEnabled === true && (
                                            <Badge variant="outline" className="text-[10px]">
                                                Observer
                                            </Badge>
                                        )}
                                        {p.builtin && (
                                            <Badge variant="secondary" className="text-[10px]">
                                                内置
                                            </Badge>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                        {p.meta.model &&
                                            (() => {
                                                const m = modelList?.find((mp) => mp.id === p.meta.model)
                                                return (
                                                    <Badge variant="outline" className="font-mono text-[10px]">
                                                        {m ? formatModelProviderLabel(m) : p.meta.model}
                                                    </Badge>
                                                )
                                            })()}
                                        <span>{p.meta.tools?.length ?? 0} tools</span>
                                        <span>{p.meta.skills?.length ?? 0} skills</span>
                                        <span>{p.meta.subagents?.length ?? 0} subagents</span>
                                    </div>
                                </div>
                                <div className="ml-6 grid w-52 shrink-0 grid-cols-[1fr_2rem_2rem] items-center gap-2">
                                    <div
                                        className="flex items-center justify-end"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                        }}
                                    >
                                        <Switch
                                            checked={p.meta.disabled !== true}
                                            onCheckedChange={(checked) => void handleToggleDisabled(p, !checked)}
                                        />
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            openCopy(p)
                                        }}
                                    >
                                        <CopyIcon className="size-4" />
                                    </Button>
                                    {!p.builtin && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                void handleRemove(p.name)
                                            }}
                                        >
                                            <Trash2Icon className="size-4 text-destructive" />
                                        </Button>
                                    )}
                                    {p.builtin && (
                                        <Button variant="ghost" size="icon" className="h-8 w-8" disabled>
                                            <Trash2Icon className="size-4 text-muted-foreground" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">暂无{promptTab === "subagent" ? " Subagent " : " "}Prompt。</p>
                )}
            </div>
        )
    }

    // ── Editor view (left config + right prompt) ──
    return (
        <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={closeEditor}>
                    <ChevronLeftIcon className="size-4 mr-1" />
                    返回列表
                </Button>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Enabled</span>
                        <Switch checked={!form.disabled} onCheckedChange={(checked) => setForm((f) => (f ? { ...f, disabled: !checked } : f))} />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => openCopy(toPrompt(form))}>
                        <CopyIcon className="size-4 mr-1" />
                        复制
                    </Button>
                    <Button variant="outline" size="sm" onClick={closeEditor}>
                        取消
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={!form.name.trim() || !form.content.trim() || !form.model.trim() || nameConflict}>
                        保存
                    </Button>
                </div>
            </div>

            {/* Two-column layout */}
            <div className="grid grid-cols-[340px_1fr] gap-4 h-[calc(100vh-14rem)]">
                {/* Left: Config */}
                <ScrollArea className="pr-3">
                    <div className="space-y-4">
                        {/* Name */}
                        <div className="space-y-1.5">
                            <Label>Name</Label>
                            <Input
                                value={form.name}
                                onChange={(e) => {
                                    setSaveError("")
                                    patch("name", e.target.value)
                                }}
                            />
                            {nameConflict ? <p className="text-[10px] text-destructive">Prompt 名称已存在，请换一个名称。</p> : null}
                            {!nameConflict && saveError ? <p className="text-[10px] text-destructive">{saveError}</p> : null}
                        </div>

                        {/* Description */}
                        <div className="space-y-1.5">
                            <Label>Description</Label>
                            <Input value={form.description} onChange={(e) => patch("description", e.target.value)} />
                        </div>

                        {/* Model */}
                        <div className="space-y-1.5">
                            <Label>Model</Label>
                            <Select value={form.model} onValueChange={(val) => patch("model", val ?? "")} disabled={(modelList?.length ?? 0) === 0}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择模型">
                                        {(() => {
                                            const m = modelList?.find((mp) => mp.id === form.model)
                                            if (!form.model) return "选择模型"
                                            if (!m) return form.model
                                            return formatModelProviderLabel(m)
                                        })()}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="w-auto min-w-96" alignItemWithTrigger={false}>
                                    {modelList?.map((m) => (
                                        <SelectItem key={m.id} value={m.id!}>
                                            <span className="font-mono text-xs">{formatModelProviderLabel(m)}</span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {!form.isSubagent && (
                            <>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <Label>Observer</Label>
                                        <Switch
                                            checked={form.observerEnabled}
                                            onCheckedChange={(checked) =>
                                                setForm((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              observerEnabled: checked,
                                                              observerModel: checked ? current.observerModel : "",
                                                          }
                                                        : current,
                                                )
                                            }
                                        />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">启用后，challenge solver 会附加 observer sidecar。</p>
                                </div>

                                {form.observerEnabled && (
                                    <div className="space-y-1.5">
                                        <Label>Observer Model</Label>
                                        <Select
                                            value={form.observerModel || NONE_MODEL_VALUE}
                                            onValueChange={(val) =>
                                                setForm((current) =>
                                                    current
                                                        ? {
                                                              ...current,
                                                              observerModel: val === NONE_MODEL_VALUE ? "" : (val ?? ""),
                                                          }
                                                        : current,
                                                )
                                            }
                                        >
                                            <SelectTrigger>
                                                <SelectValue placeholder="跟随主模型">
                                                    {(() => {
                                                        const m = modelList?.find((mp) => mp.id === form.observerModel)
                                                        if (!form.observerModel) return "跟随主模型"
                                                        if (!m) return form.observerModel
                                                        return formatModelProviderLabel(m)
                                                    })()}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent className="w-auto min-w-96" alignItemWithTrigger={false}>
                                                <SelectItem value={NONE_MODEL_VALUE}>跟随主模型</SelectItem>
                                                {modelList?.map((m) => (
                                                    <SelectItem key={m.id} value={m.id!}>
                                                        <span className="font-mono text-xs">{formatModelProviderLabel(m)}</span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Tools */}
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <Label>MCP Servers</Label>
                                <span className="text-[10px] text-muted-foreground">{enabledMcpServers.size} 已启用</span>
                            </div>
                            <div className="rounded-md border p-2 max-h-32 overflow-y-auto space-y-0.5">
                                {availableMcpServers.map((server) => (
                                    <label key={server} className="flex items-start gap-2 text-sm cursor-pointer hover:bg-accent rounded px-1 py-0.5">
                                        <input type="checkbox" checked={enabledMcpServers.has(server)} onChange={() => toggleMcpServer(server)} className="rounded mt-0.5" />
                                        <div className="min-w-0">
                                            <span className="font-mono text-xs">{server}</span>
                                        </div>
                                    </label>
                                ))}
                                {availableMcpServers.length === 0 && <p className="text-xs text-muted-foreground">暂无 MCP Server</p>}
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <Label>Tools ({form.tools.length} 已选)</Label>
                                <div className="flex gap-1">
                                    <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={selectAllFiltered}>
                                        全选
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={deselectAllFiltered}>
                                        取消
                                    </Button>
                                </div>
                            </div>
                            {/* Category filter */}
                            <div className="flex flex-wrap gap-1">
                                {toolCategories.map((cat) => (
                                    <Button
                                        key={cat.value}
                                        variant={toolFilter === cat.value ? "default" : "outline"}
                                        size="sm"
                                        className="h-5 text-[10px] px-1.5"
                                        onClick={() => setToolFilter(cat.value)}
                                    >
                                        {cat.label}
                                        <span className="ml-0.5 opacity-60">{cat.count}</span>
                                    </Button>
                                ))}
                            </div>
                            <div className="rounded-md border p-2 max-h-48 overflow-y-auto space-y-0.5">
                                {filteredTools.map((t) => (
                                    <label key={t.name} className="flex items-start gap-2 text-sm cursor-pointer hover:bg-accent rounded px-1 py-0.5">
                                        <input type="checkbox" checked={form.tools.includes(t.name)} onChange={() => toggleTool(t.name)} className="rounded mt-0.5" />
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="font-mono text-xs">{t.name}</span>
                                                {t.source !== "builtin" && (
                                                    <Badge variant="outline" className="text-[10px] py-0 shrink-0">
                                                        {t.source === "mcp" ? t.server : t.source}
                                                    </Badge>
                                                )}
                                            </div>
                                            {t.description && <p className="text-[10px] text-muted-foreground line-clamp-1">{t.description}</p>}
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>

                        {/* Skills */}
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <Label>Skills ({form.skills.length} 已选)</Label>
                                <div className="flex gap-1">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 text-[10px] px-1.5"
                                        onClick={() => {
                                            const names = (skillList ?? []).map((s) => s.name)
                                            setForm((f) => f && { ...f, skills: [...new Set([...f.skills, ...names])] })
                                        }}
                                    >
                                        全选
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={() => setForm((f) => f && { ...f, skills: [] })}>
                                        取消
                                    </Button>
                                </div>
                            </div>
                            <div className="rounded-md border p-2 max-h-40 overflow-y-auto space-y-0.5">
                                {(skillList ?? []).map((s) => (
                                    <label key={s.name} className="flex items-start gap-2 text-sm cursor-pointer hover:bg-accent rounded px-1 py-0.5">
                                        <input type="checkbox" checked={form.skills.includes(s.name)} onChange={() => toggleSkill(s.name)} className="rounded mt-0.5" />
                                        <div className="min-w-0">
                                            <span className="font-mono text-xs">{s.name}</span>
                                            {s.description && <p className="text-[10px] text-muted-foreground line-clamp-1">{s.description}</p>}
                                        </div>
                                    </label>
                                ))}
                                {(!skillList || skillList.length === 0) && <p className="text-xs text-muted-foreground">暂无 Skill</p>}
                            </div>
                        </div>

                        {!form.isSubagent && (
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <Label>Subagents ({form.subagents.length} 已选)</Label>
                                    <div className="flex gap-1">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-5 text-[10px] px-1.5"
                                            onClick={() => setForm((f) => (f ? { ...f, subagents: subagentPrompts.filter((p) => p.name !== f.name).map((p) => p.name) } : f))}
                                        >
                                            全选
                                        </Button>
                                        <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={() => setForm((f) => (f ? { ...f, subagents: [] } : f))}>
                                            取消
                                        </Button>
                                    </div>
                                </div>
                                <div className="rounded-md border p-2 max-h-40 overflow-y-auto space-y-0.5">
                                    {subagentPrompts
                                        .filter((p) => p.name !== form.name)
                                        .map((p) => (
                                            <label key={p.name} className="flex items-start gap-2 text-sm cursor-pointer hover:bg-accent rounded px-1 py-0.5">
                                                <input type="checkbox" checked={form.subagents.includes(p.name)} onChange={() => toggleSubagent(p.name)} className="rounded mt-0.5" />
                                                <div className="min-w-0">
                                                    <span className="font-mono text-xs">{p.name}</span>
                                                    {p.meta.description && <p className="text-[10px] text-muted-foreground line-clamp-1">{String(p.meta.description)}</p>}
                                                </div>
                                            </label>
                                        ))}
                                    {subagentPrompts.filter((p) => p.name !== form.name).length === 0 && <p className="text-xs text-muted-foreground">暂无 Subagent Prompt</p>}
                                </div>
                            </div>
                        )}
                    </div>
                </ScrollArea>

                {/* Right: System Prompt */}
                <div className="flex flex-col gap-1.5 min-h-0">
                    <Label>System Prompt</Label>
                    <Textarea value={form.content} onChange={(e) => patch("content", e.target.value)} className="flex-1 font-mono text-xs resize-none" />
                </div>
            </div>
        </div>
    )
}
