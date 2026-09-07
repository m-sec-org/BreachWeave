import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { providers, builtIn } from "../../lib/api"
import type { ProviderEntry } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Badge } from "../ui/badge"

function formatProviderDisplayName(provider: Pick<ProviderEntry, "name" | "id">) {
    return `${provider.name} (${provider.id})`
}

export function ProvidersPage() {
    const { data: list, loading, reload } = useFetch(providers.list)
    const { data: builtInProviders } = useFetch(builtIn.providers)
    const { data: protocols } = useFetch(builtIn.protocols)

    const [name, setName] = useState("")
    const [customName, setCustomName] = useState("")
    const [baseUrl, setBaseUrl] = useState("")
    const [api, setApi] = useState("")
    const [customApi, setCustomApi] = useState("")
    const [apiKey, setApiKey] = useState("")

    const effectiveName = name === "__custom__" ? customName.trim() : name
    const effectiveApi = api === "__custom__" ? customApi.trim() : api
    const isCustomMode = name === "__custom__"
    const selectedProviderApis = !isCustomMode && name ? (builtInProviders?.find((p) => p.provider === name)?.apis ?? []) : (protocols ?? [])

    function handleProviderSelect(val: string) {
        setName(val)
        if (val !== "__custom__") {
            const bp = builtInProviders?.find((p) => p.provider === val)
            if (bp) {
                setBaseUrl(bp.baseUrls[0] ?? "")
                setApi(bp.apis[0] ?? "")
                setCustomApi("")
            }
        } else {
            setBaseUrl("")
            setApi("")
        }
    }

    const [dupAlert, setDupAlert] = useState<string | null>(null)

    async function handleSave(e: React.FormEvent) {
        e.preventDefault()
        if (!effectiveName) return
        const result = await providers.add({
            name: effectiveName,
            api: effectiveApi || undefined,
            baseUrl: baseUrl.trim() || undefined,
            apiKey: apiKey.trim() || undefined,
        })
        if (result.rejected) {
            setDupAlert(result.rejected)
            return
        }
        setName("")
        setCustomName("")
        setBaseUrl("")
        setApi("")
        setCustomApi("")
        setApiKey("")
        reload()
    }

    async function handleRemove(id: string) {
        await providers.remove(id)
        reload()
    }

    async function handleUpdate(id: string, patch: Partial<ProviderEntry>) {
        const result = await providers.update(id, patch)
        if (result.rejected) {
            setDupAlert(result.rejected)
            reload()
            return
        }
        reload()
    }

    const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

    const toggleKeyVisibility = (id: string) => {
        setVisibleKeys((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const allProviders = list ?? []

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <CardTitle>Providers</CardTitle>
                    <Badge variant="secondary">{allProviders.length} configured</Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {dupAlert && (
                    <div className="flex items-center justify-between rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-400">
                        <span>⚠️ {dupAlert}</span>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDupAlert(null)}>
                            ×
                        </Button>
                    </div>
                )}
                <form onSubmit={handleSave} className="space-y-3">
                    <div className="grid gap-3 lg:grid-cols-[16rem_14rem_minmax(0,1fr)_auto]">
                        <div className="space-y-2">
                            <Label>Provider</Label>
                            {isCustomMode ? (
                                <div className="flex gap-1">
                                    <Input placeholder="custom-name" value={customName} onChange={(e) => setCustomName(e.target.value)} />
                                    <Button type="button" variant="ghost" size="sm" onClick={() => setName("")} className="shrink-0 text-xs">
                                        ×
                                    </Button>
                                </div>
                            ) : (
                                <Select value={name} onValueChange={(val) => handleProviderSelect(val ?? "")}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select provider" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {builtInProviders?.map((bp) => (
                                            <SelectItem key={bp.provider} value={bp.provider}>
                                                {bp.provider}
                                            </SelectItem>
                                        ))}
                                        <SelectItem value="__custom__">Custom...</SelectItem>
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label>Protocol</Label>
                            {api === "__custom__" ? (
                                <div className="flex gap-1">
                                    <Input placeholder="custom-api" value={customApi} onChange={(e) => setCustomApi(e.target.value)} />
                                    <Button type="button" variant="ghost" size="sm" onClick={() => setApi("")} className="shrink-0 text-xs">
                                        ×
                                    </Button>
                                </div>
                            ) : (
                                <Select value={api} onValueChange={(val) => setApi(val ?? "")} disabled={!name || selectedProviderApis.length === 0}>
                                    <SelectTrigger>
                                        <SelectValue placeholder={!name ? "Select provider first" : "Select protocol"} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {selectedProviderApis.map((p) => (
                                            <SelectItem key={p} value={p}>
                                                {p}
                                            </SelectItem>
                                        ))}
                                        <SelectItem value="__custom__">Custom...</SelectItem>
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="min-w-0 space-y-2">
                            <Label>API Key</Label>
                            <Input type="password" placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label className="invisible">Action</Label>
                            <Button className="w-full lg:w-auto" type="submit" disabled={!effectiveName || (!apiKey.trim() && !effectiveApi)}>
                                Save
                            </Button>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label>Base URL</Label>
                        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={isCustomMode ? "https://my-proxy.example.com/v1" : "Override default endpoint (optional)"} />
                    </div>
                </form>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                ) : allProviders.length === 0 ? (
                    <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No providers configured yet.</div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Provider</TableHead>
                                <TableHead>API Key</TableHead>
                                <TableHead>Protocol</TableHead>
                                <TableHead>Base URL</TableHead>
                                <TableHead className="w-24 text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {allProviders.map((p) => (
                                <TableRow key={p.id}>
                                    <TableCell className="font-medium">
                                        {formatProviderDisplayName(p)}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-1">
                                            <Input
                                                className="h-7 min-w-0 flex-1 font-mono text-xs"
                                                type={visibleKeys.has(p.id) ? "text" : "password"}
                                                defaultValue={p.apiKey || ""}
                                                placeholder="sk-..."
                                                onBlur={(e) => {
                                                    const v = e.target.value.trim()
                                                    if (v !== (p.apiKey || "")) handleUpdate(p.id, { apiKey: v || undefined })
                                                }}
                                            />
                                            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 px-0 text-xs" onClick={() => toggleKeyVisibility(p.id)}>
                                                {visibleKeys.has(p.id) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                            </Button>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Select value={p.api || "none"} onValueChange={(v) => handleUpdate(p.id, { api: !v || v === "none" ? undefined : v })}>
                                            <SelectTrigger className="h-7 w-full text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">—</SelectItem>
                                                {(protocols ?? []).map((proto) => (
                                                    <SelectItem key={proto} value={proto}>
                                                        {proto}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </TableCell>
                                    <TableCell>
                                        <Input
                                            className="h-7 text-xs"
                                            defaultValue={p.baseUrl || ""}
                                            placeholder="https://..."
                                            onBlur={(e) => {
                                                const v = e.target.value.trim()
                                                if (v !== (p.baseUrl || "")) handleUpdate(p.id, { baseUrl: v || undefined })
                                            }}
                                        />
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button variant="ghost" size="sm" onClick={() => handleRemove(p.id)}>
                                            Delete
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    )
}
