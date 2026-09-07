import { useState } from "react"
import { apiKeys } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Badge } from "../ui/badge"
import { Trash2Icon, PlusIcon, EyeIcon, EyeOffIcon } from "lucide-react"

export function ApiKeysPage() {
    const { data: keys, loading, reload } = useFetch(apiKeys.list)
    const [provider, setProvider] = useState("")
    const [key, setKey] = useState("")
    const [showKey, setShowKey] = useState(false)

    async function handleAdd() {
        if (!provider.trim() || !key.trim()) return
        await apiKeys.set(provider.trim(), key.trim())
        setProvider("")
        setKey("")
        setShowKey(false)
        reload()
    }

    async function handleRemove(p: string) {
        await apiKeys.remove(p)
        reload()
    }

    return (
        <div className="space-y-6">
            {/* Add form */}
            <div className="flex items-end gap-3">
                <div className="space-y-1.5">
                    <Label>Provider</Label>
                    <Input placeholder="e.g. anthropic" value={provider} onChange={(e) => setProvider(e.target.value)} className="w-48" />
                </div>
                <div className="space-y-1.5 flex-1">
                    <Label>API Key</Label>
                    <div className="flex gap-2">
                        <Input type={showKey ? "text" : "password"} placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} />
                        <Button variant="ghost" size="icon" onClick={() => setShowKey(!showKey)}>
                            {showKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                        </Button>
                    </div>
                </div>
                <Button onClick={handleAdd} disabled={!provider.trim() || !key.trim()}>
                    <PlusIcon className="size-4 mr-1" />
                    Add
                </Button>
            </div>

            {/* List */}
            {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
            ) : keys && keys.length > 0 ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Provider</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="w-12"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {keys.map((p) => (
                            <TableRow key={p}>
                                <TableCell className="font-mono text-sm">{p}</TableCell>
                                <TableCell>
                                    <Badge variant="secondary">Configured</Badge>
                                </TableCell>
                                <TableCell>
                                    <Button variant="ghost" size="icon" onClick={() => handleRemove(p)}>
                                        <Trash2Icon className="size-4 text-destructive" />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : (
                <p className="text-sm text-muted-foreground">No API keys configured.</p>
            )}
        </div>
    )
}
