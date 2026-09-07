import { useState, useRef } from "react"
import { skills } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog"
import { ScrollArea } from "../ui/scroll-area"
import { Trash2Icon, UploadIcon, GitBranchIcon } from "lucide-react"

export function SkillsPage() {
    const { data: list, loading, reload } = useFetch(skills.list)
    const fileRef = useRef<HTMLInputElement>(null)
    const [uploading, setUploading] = useState(false)
    const [gitUrl, setGitUrl] = useState("")
    const [cloning, setCloning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    // Preview dialog state
    const [previewName, setPreviewName] = useState<string | null>(null)
    const [previewContent, setPreviewContent] = useState<string>("")
    const [previewLoading, setPreviewLoading] = useState(false)

    async function openPreview(name: string) {
        setPreviewName(name)
        setPreviewLoading(true)
        try {
            const res = await skills.content(name)
            setPreviewContent(res.content)
        } catch {
            setPreviewContent("(无法加载内容)")
        } finally {
            setPreviewLoading(false)
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0]
        if (!file) return
        setUploading(true)
        setError(null)
        setSuccess(null)
        try {
            const result = await skills.upload(file)
            setSuccess(`已安装 skill: ${result.name}`)
            reload()
        } catch (err: any) {
            setError(err.message || "上传失败")
        } finally {
            setUploading(false)
            if (fileRef.current) fileRef.current.value = ""
        }
    }

    async function handleGitInstall() {
        if (!gitUrl.trim()) return
        setCloning(true)
        setError(null)
        setSuccess(null)
        try {
            const result = await skills.installFromGit(gitUrl.trim())
            setSuccess(`已安装 skill: ${result.name}`)
            setGitUrl("")
            reload()
        } catch (err: any) {
            setError(err.message || "克隆失败")
        } finally {
            setCloning(false)
        }
    }

    async function handleRemove(name: string) {
        await skills.remove(name)
        reload()
    }

    return (
        <div className="space-y-4">
            {/* Install */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={handleUpload} />
                <Button variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
                    <UploadIcon className="size-4 mr-1.5" />
                    {uploading ? "上传中..." : "上传 .zip"}
                </Button>
                <div className="flex items-center gap-2 flex-1">
                    <Input
                        placeholder="https://github.com/user/skill-repo"
                        value={gitUrl}
                        onChange={(e) => setGitUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleGitInstall()}
                        className="flex-1"
                    />
                    <Button variant="outline" disabled={cloning || !gitUrl.trim()} onClick={handleGitInstall}>
                        <GitBranchIcon className="size-4 mr-1.5" />
                        {cloning ? "克隆中..." : "从 Git 安装"}
                    </Button>
                </div>
            </div>

            {/* Status */}
            {error && <div className="rounded-md border border-destructive bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
            {success && <div className="rounded-md border border-green-600 bg-green-600/10 px-4 py-2 text-sm text-green-700 dark:text-green-400">{success}</div>}

            {/* List */}
            {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
            ) : list && list.length > 0 ? (
                <div className="space-y-2">
                    {list.map((s) => (
                        <div
                            key={s.name}
                            role="button"
                            tabIndex={0}
                            className="flex items-center justify-between rounded-lg border px-4 py-3 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
                            onClick={() => openPreview(s.name)}
                            onKeyDown={(e) => e.key === "Enter" && openPreview(s.name)}
                        >
                            <div className="flex-1 min-w-0 space-y-0.5">
                                <span className="font-mono text-sm font-medium">{s.name}</span>
                                {s.description && <p className="text-xs text-muted-foreground line-clamp-2">{s.description}</p>}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-3">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        handleRemove(s.name)
                                    }}
                                >
                                    <Trash2Icon className="size-4 text-destructive" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">暂无 skill。上传 zip 包添加。</p>
            )}

            {/* SKILL.md Preview Dialog */}
            <Dialog open={!!previewName} onOpenChange={(open) => !open && setPreviewName(null)}>
                <DialogContent className="max-w-4xl w-[90vw] max-h-[85vh]">
                    <DialogHeader>
                        <DialogTitle className="font-mono">{previewName}</DialogTitle>
                    </DialogHeader>
                    {previewLoading ? (
                        <p className="text-sm text-muted-foreground">加载中...</p>
                    ) : (
                        <ScrollArea className="max-h-[70vh]">
                            <pre className="text-xs font-mono whitespace-pre-wrap break-words p-4">{previewContent}</pre>
                        </ScrollArea>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
