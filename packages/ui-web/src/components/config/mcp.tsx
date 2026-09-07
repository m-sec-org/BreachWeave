import { useEffect, useMemo, useState } from "react"
import { Trash2, RefreshCw, ChevronDown, Pencil, Plus } from "lucide-react"
import { mcpServers, tools } from "../../lib/api"
import type { McpServerEntry, ProbeResult, ToolEntry } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Badge } from "../ui/badge"
import { Switch } from "../ui/switch"
import { Textarea } from "../ui/textarea"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"

interface DraftToolItem {
    name: string
    description?: string
    inputSchema?: unknown
}

function normalizeTransport(value?: string | null): "stdio" | "http" {
    return value === "http" ? "http" : "stdio"
}

function normalizeAuth(value?: string | null): "none" | "bearer" | "oauth" {
    if (value === "bearer" || value === "oauth") return value
    return "none"
}

function normalizeLifecycle(value?: string | null): "lazy" | "eager" | "keep-alive" {
    if (value === "eager" || value === "keep-alive") return value
    return "lazy"
}

function TransportBadge({ server }: { server: McpServerEntry }) {
    if (server.url) return <Badge variant="outline">HTTP</Badge>
    if (server.command) return <Badge variant="outline">stdio</Badge>
    return <Badge variant="outline">unknown</Badge>
}

function LifecycleBadge({ lifecycle }: { lifecycle?: string }) {
    const variant = lifecycle === "eager" ? "default" : lifecycle === "keep-alive" ? "secondary" : "outline"
    return <Badge variant={variant}>{lifecycle || "lazy"}</Badge>
}

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

export function McpPage() {
    const { data: list, loading, reload } = useFetch(mcpServers.list)
    const { data: allTools, reload: reloadTools } = useFetch(tools.list)

    // 按 server 名分组的 MCP 工具
    const toolsByServer = new Map<string, ToolEntry[]>()
    if (allTools) {
        for (const t of allTools) {
            if (t.source === "mcp" && t.server) {
                const arr = toolsByServer.get(t.server) ?? []
                arr.push(t)
                toolsByServer.set(t.server, arr)
            }
        }
    }

    // Add form state
    const [name, setName] = useState("")
    const [transport, setTransport] = useState<"stdio" | "http">("stdio")
    const [command, setCommand] = useState("")
    const [args, setArgs] = useState("")
    const [url, setUrl] = useState("")
    const [lifecycle, setLifecycle] = useState<"lazy" | "eager" | "keep-alive">("lazy")
    const [directTools, setDirectTools] = useState<string[]>([])
    const [env, setEnv] = useState("")
    const [auth, setAuth] = useState<"none" | "bearer" | "oauth">("none")
    const [bearerToken, setBearerToken] = useState("")
    const [bearerTokenEnv, setBearerTokenEnv] = useState("")
    const [exposeResources, setExposeResources] = useState(true)
    const [debug, setDebug] = useState(false)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [editing, setEditing] = useState<string | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)
    const [draftTools, setDraftTools] = useState<DraftToolItem[] | null>(null)
    const [selectedTool, setSelectedTool] = useState<DraftToolItem | null>(null)
    const [draftProbeStatus, setDraftProbeStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null)
    const [draftProbing, setDraftProbing] = useState(false)

    function resetForm() {
        setName("")
        setCommand("")
        setArgs("")
        setUrl("")
        setLifecycle("lazy")
        setDirectTools([])
        setEnv("")
        setAuth("none")
        setBearerToken("")
        setBearerTokenEnv("")
        setExposeResources(true)
        setDebug(false)
        setShowAdvanced(false)
        setEditing(null)
        setEditorOpen(false)
        setDraftTools(null)
        setSelectedTool(null)
        setDraftProbeStatus(null)
        setDraftProbing(false)
    }

    function formatEnv(envObj?: Record<string, string>): string {
        if (!envObj) return ""
        return Object.entries(envObj)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
    }

    function startEdit(item: { name: string; server: McpServerEntry }) {
        const s = item.server
        setEditing(item.name)
        setEditorOpen(true)
        setName(item.name)
        setTransport(normalizeTransport(s.url ? "http" : "stdio"))
        setCommand(s.command ?? "")
        setArgs((s.args ?? []).join(" "))
        setUrl(s.url ?? "")
        setLifecycle(normalizeLifecycle(s.lifecycle))
        const existingTools = (toolsByServer.get(item.name) ?? []).map((tool) => ({
            name: tool.label,
            description: tool.description,
            inputSchema: tool.parameters,
        }))
        setDirectTools(Array.isArray(s.directTools) ? s.directTools : existingTools.map((tool) => tool.name))
        setEnv(formatEnv(s.env))
        setAuth(normalizeAuth(s.auth))
        setBearerToken(s.bearerToken ?? "")
        setBearerTokenEnv(s.bearerTokenEnv ?? "")
        setExposeResources(s.exposeResources !== false)
        setDebug(s.debug ?? false)
        setShowAdvanced(!!(s.env || s.exposeResources === false || s.debug))
        setDraftTools(existingTools)
    }

    function parseEnv(text: string): Record<string, string> | undefined {
        if (!text.trim()) return undefined
        const result: Record<string, string> = {}
        for (const line of text.trim().split("\n")) {
            const eq = line.indexOf("=")
            if (eq > 0) result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
        }
        return Object.keys(result).length > 0 ? result : undefined
    }

    function buildProbeServer(): McpServerEntry | null {
        const server: McpServerEntry = { lifecycle }
        if (transport === "stdio") {
            if (!command.trim()) return null
            server.command = command.trim()
            if (args.trim()) server.args = args.trim().split(/\s+/)
        } else {
            if (!url.trim()) return null
            server.url = url.trim()
            if (auth === "bearer") {
                server.auth = "bearer"
                if (bearerToken.trim()) server.bearerToken = bearerToken.trim()
                if (bearerTokenEnv.trim()) server.bearerTokenEnv = bearerTokenEnv.trim()
            } else if (auth === "oauth") {
                server.auth = "oauth"
            }
        }
        const envObj = parseEnv(env)
        if (envObj) server.env = envObj
        if (!exposeResources) server.exposeResources = false
        if (debug) server.debug = true
        return server
    }

    function buildServer(): McpServerEntry | null {
        const server = buildProbeServer()
        if (!server) return null
        const availableDirectTools = draftTools?.map((tool) => tool.name) ?? []
        if (directTools.length > 0) {
            server.directTools = availableDirectTools.length > 0 && directTools.length === availableDirectTools.length ? true : directTools
        }
        return server
    }

    async function handleAdd(e: React.FormEvent) {
        e.preventDefault()
        if (!name.trim()) return
        const server = buildServer()
        if (!server) return
        await mcpServers.add(name.trim(), server)
        resetForm()
        reload()
    }

    async function handleSave(e: React.FormEvent) {
        e.preventDefault()
        if (!editing || !name.trim()) return
        const server = buildServer()
        if (!server) return
        const newName = name.trim() !== editing ? name.trim() : undefined
        await mcpServers.update(editing, server, newName)
        resetForm()
        reload()
    }

    function openNew() {
        resetForm()
        setEditorOpen(true)
    }

    const normalizedDraftToolNames = useMemo(() => new Set((draftTools ?? []).map((tool) => tool.name)), [draftTools])

    function toggleDirectTool(toolName: string) {
        setDirectTools((current) => (current.includes(toolName) ? current.filter((name) => name !== toolName) : [...current, toolName]))
    }

    function syncDirectSelection(result: ProbeResult) {
        const toolNames = result.tools.map((tool) => tool.name)
        if (directTools.length === 0) return
        setDirectTools(directTools.filter((name) => toolNames.includes(name)))
    }

    async function handleProbeDraft() {
        const server = buildProbeServer()
        if (!server || !name.trim()) {
            setDraftProbeStatus({ type: "error", message: "请先填写名称和连接配置" })
            return
        }

        setDraftProbing(true)
        setDraftProbeStatus(null)
        try {
            const result = await mcpServers.probeDraft(name.trim(), server)
            setDraftTools(result.tools)
            syncDirectSelection(result)
            setDraftProbeStatus({ type: "ok", message: `${result.server}: 发现 ${result.tools.length} 个工具, ${result.resources.length} 个资源` })
        } catch (e: any) {
            setDraftProbeStatus({ type: "error", message: e.message || "探测失败" })
        } finally {
            setDraftProbing(false)
        }
    }

    useEffect(() => {
        if (!editorOpen) return
        const server = buildProbeServer()
        if (!server || !name.trim()) {
            setDraftTools(null)
            setDraftProbeStatus(null)
            return
        }

        const timer = setTimeout(async () => {
            setDraftProbing(true)
            setDraftProbeStatus(null)
            try {
                const result = await mcpServers.probeDraft(name.trim(), server)
                setDraftTools(result.tools)
                syncDirectSelection(result)
            } catch {
                setDraftTools(null)
            } finally {
                setDraftProbing(false)
            }
        }, 400)

        return () => clearTimeout(timer)
    }, [editorOpen, name, transport, command, args, url, auth, bearerToken, bearerTokenEnv, lifecycle, env, exposeResources, debug])

    async function handleRemove(serverName: string) {
        await mcpServers.remove(serverName)
        reload()
    }

    const [probing, setProbing] = useState<string | true | false>(false)
    const [probeStatus, setProbeStatus] = useState<{ type: "ok" | "error"; message: string } | null>(null)

    async function handleProbe(serverName?: string) {
        setProbing(serverName ?? true)
        setProbeStatus(null)
        try {
            const result = await mcpServers.probe(serverName)
            if (Array.isArray(result)) {
                const total = result.reduce((n, r) => n + r.tools.length, 0)
                setProbeStatus({ type: "ok", message: `发现 ${total} 个工具 (${result.length} 个服务)` })
            } else {
                setProbeStatus({ type: "ok", message: `${result.server}: 发现 ${result.tools.length} 个工具, ${result.resources.length} 个资源` })
            }
        } catch (e: any) {
            setProbeStatus({ type: "error", message: e.message || "连接失败" })
        } finally {
            setProbing(false)
            reload()
            reloadTools()
        }
    }

    if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>

    return (
        <>
            <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">MCP 服务</h3>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={!!probing} onClick={() => handleProbe()}>
                        <RefreshCw className={`size-4 mr-1.5 ${probing === true ? "animate-spin" : ""}`} />
                        刷新全部
                    </Button>
                    <Button size="sm" onClick={openNew}>
                        <Plus className="size-4 mr-1.5" />
                        添加服务
                    </Button>
                </div>
            </div>

            <Dialog open={editorOpen} onOpenChange={(open) => (!open ? resetForm() : setEditorOpen(true))}>
                <DialogContent className="max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>{editing ? `编辑 ${editing}` : "添加 MCP 服务"}</DialogTitle>
                        <DialogDescription>支持 stdio 和 HTTP 两种方式。</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={editing ? handleSave : handleAdd} className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <div className="space-y-1.5">
                                <Label>名称</Label>
                                <Input placeholder="server-name" value={name} onChange={(e) => setName(e.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                                <Label>传输方式</Label>
                                <Select value={normalizeTransport(transport)} onValueChange={(v) => setTransport(normalizeTransport(v))}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="stdio">stdio (command)</SelectItem>
                                        <SelectItem value="http">HTTP (url)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            {transport === "stdio" ? (
                                <>
                                    <div className="space-y-1.5">
                                        <Label>Command</Label>
                                        <Input placeholder="npx -y @mcp/server" value={command} onChange={(e) => setCommand(e.target.value)} />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label>Args (空格分隔)</Label>
                                        <Input placeholder="--port 3000" value={args} onChange={(e) => setArgs(e.target.value)} />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="space-y-1.5">
                                        <Label>URL</Label>
                                        <Input placeholder="http://localhost:3000/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label>认证</Label>
                                        <Select value={normalizeAuth(auth)} onValueChange={(v) => setAuth(normalizeAuth(v))}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">无</SelectItem>
                                                <SelectItem value="bearer">Bearer Token</SelectItem>
                                                <SelectItem value="oauth">OAuth</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {auth === "bearer" && (
                                        <>
                                            <div className="space-y-1.5">
                                                <Label>Bearer Token</Label>
                                                <Input type="password" placeholder="token 值" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} />
                                            </div>
                                            <div className="space-y-1.5">
                                                <Label>或 Token 环境变量</Label>
                                                <Input placeholder="MCP_TOKEN" value={bearerTokenEnv} onChange={(e) => setBearerTokenEnv(e.target.value)} />
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                            <div className="space-y-1.5">
                                <Label>Lifecycle</Label>
                                <Select value={normalizeLifecycle(lifecycle)} onValueChange={(v) => setLifecycle(normalizeLifecycle(v))}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="lazy">lazy</SelectItem>
                                        <SelectItem value="eager">eager</SelectItem>
                                        <SelectItem value="keep-alive">keep-alive</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <Label>工具</Label>
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={!draftTools || draftTools.length === 0}
                                        onClick={() => setDirectTools((draftTools ?? []).map((tool) => tool.name))}
                                    >
                                        全选
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={directTools.length === 0}
                                        onClick={() => setDirectTools([])}
                                    >
                                        清空
                                    </Button>
                                    <Button type="button" variant="outline" size="sm" disabled={draftProbing} onClick={handleProbeDraft}>
                                        <RefreshCw className={`size-4 mr-1.5 ${draftProbing ? "animate-spin" : ""}`} />
                                        刷新
                                    </Button>
                                </div>
                            </div>
                            {draftProbeStatus && (
                                <div
                                    className={`rounded-md border px-3 py-2 text-xs ${draftProbeStatus.type === "error" ? "border-destructive bg-destructive/10 text-destructive" : "border-green-600 bg-green-600/10 text-green-700 dark:text-green-400"}`}
                                >
                                    {draftProbeStatus.message}
                                </div>
                            )}
                            {draftTools && draftTools.length > 0 ? (
                                <div className="rounded-md border divide-y max-h-72 overflow-auto">
                                    {draftTools.map((tool) => {
                                        const checked = directTools.includes(tool.name)
                                        return (
                                            <div key={tool.name} className="flex items-start justify-between gap-3 px-3 py-2">
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                                                    onClick={() => toggleDirectTool(tool.name)}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => toggleDirectTool(tool.name)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="mt-0.5 rounded"
                                                    />
                                                    <div className="min-w-0">
                                                        <span
                                                            className="font-mono text-sm font-medium hover:underline"
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                setSelectedTool(tool)
                                                            }}
                                                        >
                                                            {tool.name}
                                                        </span>
                                                        {tool.description && <p className="text-xs text-muted-foreground line-clamp-2">{tool.description}</p>}
                                                    </div>
                                                </button>
                                                <Badge variant={checked ? "default" : "outline"} className="text-[10px] shrink-0">
                                                    {checked ? "direct" : "proxy"}
                                                </Badge>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground">工具列表会根据当前配置自动刷新。</div>
                            )}
                        </div>

                        {/* Advanced options */}
                        <Collapsible open={showAdvanced} onOpenChange={(v: boolean) => setShowAdvanced(v)}>
                            <CollapsibleTrigger className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
                                <ChevronDown className={`size-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
                                高级选项
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-3">
                                    <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
                                        <Label>环境变量 (每行 KEY=VALUE)</Label>
                                        <Textarea placeholder={"PATH=/usr/bin\nMY_VAR=hello"} value={env} onChange={(e) => setEnv(e.target.value)} className="font-mono text-xs min-h-[60px]" />
                                    </div>
                                    <div className="flex items-center gap-4 pt-4">
                                        <div className="flex items-center gap-2">
                                            <Switch checked={exposeResources} onCheckedChange={setExposeResources} />
                                            <Label>暴露资源</Label>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Switch checked={debug} onCheckedChange={setDebug} />
                                            <Label>调试模式</Label>
                                        </div>
                                    </div>
                                </div>
                            </CollapsibleContent>
                        </Collapsible>

                        <div className="flex items-end justify-end gap-2">
                            <Button type="button" variant="outline" onClick={resetForm}>
                                取消
                            </Button>
                            <Button type="submit">{editing ? "保存" : "添加"}</Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Probe status */}
            {probeStatus && (
                <div
                    className={`rounded-md border px-4 py-2 text-sm ${probeStatus.type === "error" ? "border-destructive bg-destructive/10 text-destructive" : "border-green-600 bg-green-600/10 text-green-700 dark:text-green-400"}`}
                >
                    {probeStatus.message}
                </div>
            )}

            {/* Server list */}
            {list && list.length > 0 && (
                <div className="space-y-3">
                    {list.map((item) => {
                        const serverTools = toolsByServer.get(item.name) ?? []
                        const endpoint = item.server.url || `${item.server.command || ""} ${(item.server.args || []).join(" ")}`.trim()

                        return (
                            <Card key={item.name}>
                                <CardHeader className="py-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <code className="font-mono text-sm font-semibold">{item.name}</code>
                                            <TransportBadge server={item.server} />
                                            <LifecycleBadge lifecycle={item.server.lifecycle} />
                                            {item.server.directTools && (
                                                <Badge variant="default" className="text-[10px]">
                                                    direct: {Array.isArray(item.server.directTools) ? item.server.directTools.length : "all"}
                                                </Badge>
                                            )}
                                            {item.server.debug && (
                                                <Badge variant="outline" className="text-[10px]">
                                                    debug
                                                </Badge>
                                            )}
                                            {item.server.auth && (
                                                <Badge variant="secondary" className="text-[10px]">
                                                    {item.server.auth}
                                                </Badge>
                                            )}
                                            {item.server.exposeResources === false && (
                                                <Badge variant="outline" className="text-[10px]">
                                                    no-resources
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => startEdit(item)}>
                                                <Pencil className="size-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="size-8" disabled={!!probing} onClick={() => handleProbe(item.name)}>
                                                <RefreshCw className={`size-4 ${probing === item.name ? "animate-spin" : ""}`} />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => handleRemove(item.name)}>
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground font-mono">{endpoint}</p>
                                    {item.server.env && <p className="text-xs text-muted-foreground">env: {Object.keys(item.server.env).join(", ")}</p>}
                                </CardHeader>
                                <CardContent className="pt-0">
                                    {serverTools.length > 0 ? (
                                        <div>
                                            <h4 className="text-xs font-medium text-muted-foreground mb-2">Tools ({serverTools.length})</h4>
                                            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 max-h-60 overflow-auto">
                                                {serverTools.map((t) => (
                                                    <button
                                                        key={t.name}
                                                        type="button"
                                                        className="rounded-md border px-3 py-2 space-y-0.5 text-left hover:bg-accent/40 transition-colors"
                                                        onClick={() =>
                                                            setSelectedTool({
                                                                name: t.label,
                                                                description: t.description,
                                                                inputSchema: t.parameters,
                                                            })
                                                        }
                                                    >
                                                        <div className="flex items-center gap-1.5">
                                                            <code className="font-mono text-xs font-medium truncate">{t.label}</code>
                                                            {t.direct && (
                                                                <Badge variant="default" className="text-[10px] px-1 py-0 shrink-0">
                                                                    direct
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        {t.description && <p className="text-[11px] text-muted-foreground line-clamp-2">{t.description}</p>}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            未探测工具 — 点击 <RefreshCw className="inline size-3 mx-0.5" /> 探测
                                        </p>
                                    )}
                                </CardContent>
                            </Card>
                        )
                    })}
                </div>
            )}

            {list && list.length === 0 && <p className="text-sm text-muted-foreground">暂无 MCP 服务配置。</p>}

            <Dialog open={!!selectedTool} onOpenChange={(open) => !open && setSelectedTool(null)}>
                <DialogContent className="sm:max-w-md">
                    {selectedTool && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    <code className="font-mono">{selectedTool.name}</code>
                                </DialogTitle>
                                <DialogDescription>{selectedTool.description || "无描述"}</DialogDescription>
                            </DialogHeader>
                            <div>
                                <h4 className="text-sm font-medium mb-2">Parameters</h4>
                                <ParamList parameters={(selectedTool.inputSchema ?? undefined) as Record<string, unknown> | undefined} />
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    )
}
