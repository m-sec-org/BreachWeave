import { mkdir, readdir, rename, rm } from "fs/promises"
import { dirname, join } from "path"

export type IdeaStatus = "pending" | "testing" | "verified" | "failed" | "skipped"
export type MemoryKind = "fact" | "evidence" | "failure" | "note" | "hint"

export interface MemoryEntry {
    id: string
    challengeId: string
    kind: MemoryKind
    content: string
    refs: string[]
    source: string
    created_at: string
    updated_at: string
}

export interface AddMemoryInput {
    challengeId: string
    kind: MemoryKind
    content: string
    refs?: string[]
    source: string
}

export interface IdeaRecord {
    id: string
    content: string
    normalized: string
    status: IdeaStatus
    result: string
    created_at: string
    updated_at: string
}

interface IdeasIndexRecord {
    challengeId: string
    updated_at: string
    items: IdeaRecord[]
}

interface MemoryEntryWithPath {
    path: string
    entry: MemoryEntry
}

export interface AddIdeaResult {
    created: boolean
    item: IdeaRecord
}

export interface AddIdeaInput {
    content: string
    status?: IdeaStatus
    result?: string
}

export interface UpdateIdeaInput {
    content?: string
    status?: IdeaStatus
    result?: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function normalizeIdeaText(content: string): string {
    return content.trim().toLowerCase()
}

function isDirectoryExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"
}

function createEntityId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function ideasLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "ideas.lock")
}

function ideasIndexPath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "ideas", "index.json")
}

function ideaByIdPath(rootDir: string, challengeId: string, ideaId: string): string {
    return join(challengeDir(rootDir, challengeId), "ideas", "by-id", `${ideaId}.json`)
}

function memoryEntriesDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "memory", "entries")
}

function memoryLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "memory.lock")
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return
    try {
        return (await file.json()) as T
    } catch {
        return
    }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

async function withDirectoryLock<T>(lockDir: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = 5000
    const staleMs = 60_000

    while (true) {
        try {
            await mkdir(lockDir)
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error

            const lockMeta = await readJsonFile<{ created_at?: string }>(join(lockDir, "lock-meta.json"))
            const lockCreatedAt = lockMeta?.created_at ? Date.parse(lockMeta.created_at) : Number.NaN
            const lockAge = Number.isFinite(lockCreatedAt) ? Date.now() - lockCreatedAt : Number.NaN
            if (Number.isFinite(lockAge) && lockAge > staleMs) {
                await rm(lockDir, { recursive: true, force: true })
                continue
            }

            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`challenge memory lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }

    await Bun.write(join(lockDir, "lock-meta.json"), JSON.stringify({ created_at: nowIso(), pid: process.pid }, null, 2))
    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "memory", "entries"), { recursive: true })
    await mkdir(join(baseDir, "ideas", "by-id"), { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
}

async function readIdeasIndex(rootDir: string, challengeId: string): Promise<IdeasIndexRecord> {
    const id = requireText(challengeId, "challengeId")
    const existing = await readJsonFile<IdeasIndexRecord>(ideasIndexPath(rootDir, id))
    if (existing) return existing
    return { challengeId: id, updated_at: nowIso(), items: [] }
}

async function writeIdeasIndex(rootDir: string, challengeId: string, record: IdeasIndexRecord): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    await atomicWriteJson(ideasIndexPath(rootDir, id), record)
}

export async function appendChallengeMemory(rootDir: string, input: AddMemoryInput): Promise<MemoryEntry> {
    const challengeId = requireText(input.challengeId, "challengeId")
    const content = requireText(input.content, "content")
    await ensureChallengeDirs(rootDir, challengeId)

    const entry: MemoryEntry = {
        id: createEntityId("mem"),
        challengeId,
        kind: input.kind,
        content,
        refs: [...new Set((input.refs ?? []).map((item) => item.trim()).filter((item) => item.length > 0))],
        source: requireText(input.source, "source"),
        created_at: nowIso(),
        updated_at: nowIso(),
    }
    const filename = `${Date.now()}-${entry.id}.json`
    await atomicWriteJson(join(memoryEntriesDir(rootDir, challengeId), filename), entry)
    return entry
}

export async function listChallengeMemory(rootDir: string, challengeId: string): Promise<MemoryEntry[]> {
    const dir = memoryEntriesDir(rootDir, requireText(challengeId, "challengeId"))
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(files.map((file) => readJsonFile<MemoryEntry>(join(dir, file))))
    return items.filter((item): item is MemoryEntry => Boolean(item))
}

async function listChallengeMemoryWithPaths(rootDir: string, challengeId: string): Promise<MemoryEntryWithPath[]> {
    const dir = memoryEntriesDir(rootDir, requireText(challengeId, "challengeId"))
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(
        files.map(async (file) => {
            const path = join(dir, file)
            const entry = await readJsonFile<MemoryEntry>(path)
            return entry ? { path, entry } : undefined
        }),
    )
    return items.filter((item): item is MemoryEntryWithPath => Boolean(item))
}

function findMemoryEntryByIdOrPrefix(items: MemoryEntryWithPath[], entryIdOrPrefix: string): MemoryEntryWithPath {
    const lookup = requireText(entryIdOrPrefix, "entryIdOrPrefix")
    const exact = items.find((item) => item.entry.id === lookup)
    if (exact) return exact
    const matched = items.filter((item) => item.entry.id.startsWith(lookup))
    if (matched.length === 0) throw new Error(`memory "${lookup}" not found`)
    if (matched.length > 1) throw new Error(`memory id prefix "${lookup}" is ambiguous`)
    return matched[0]
}

export async function updateChallengeMemory(
    rootDir: string,
    challengeId: string,
    entryIdOrPrefix: string,
    patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string },
): Promise<MemoryEntry> {
    const id = requireText(challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, id)

    return withDirectoryLock(memoryLockDir(rootDir, id), async () => {
        const items = await listChallengeMemoryWithPaths(rootDir, id)
        const matched = findMemoryEntryByIdOrPrefix(items, entryIdOrPrefix)
        const nextContent = patch.content !== undefined ? requireText(patch.content, "content") : matched.entry.content
        const nextSource = patch.source !== undefined ? requireText(patch.source, "source") : matched.entry.source
        const nextRefs =
            patch.refs !== undefined ? [...new Set(patch.refs.map((item) => item.trim()).filter((item) => item.length > 0))] : matched.entry.refs
        const updated: MemoryEntry = {
            ...matched.entry,
            ...(patch.kind ? { kind: patch.kind } : {}),
            content: nextContent,
            refs: nextRefs,
            source: nextSource,
            updated_at: nowIso(),
        }
        await atomicWriteJson(matched.path, updated)
        return updated
    })
}

export async function deleteChallengeMemory(rootDir: string, challengeId: string, entryIdOrPrefix: string): Promise<MemoryEntry> {
    const id = requireText(challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, id)

    return withDirectoryLock(memoryLockDir(rootDir, id), async () => {
        const items = await listChallengeMemoryWithPaths(rootDir, id)
        const matched = findMemoryEntryByIdOrPrefix(items, entryIdOrPrefix)
        await rm(matched.path, { force: true })
        return matched.entry
    })
}

export async function listChallengeIdeas(rootDir: string, challengeId: string): Promise<IdeaRecord[]> {
    const index = await readIdeasIndex(rootDir, challengeId)
    return [...index.items]
}

export async function searchChallengeIdeas(rootDir: string, challengeId: string, query: string): Promise<IdeaRecord[]> {
    const normalizedQuery = requireText(query, "query").toLowerCase()
    const index = await readIdeasIndex(rootDir, challengeId)
    return index.items.filter((item) => item.content.toLowerCase().includes(normalizedQuery) || item.result.toLowerCase().includes(normalizedQuery))
}

export async function addChallengeIdea(rootDir: string, challengeId: string, input: AddIdeaInput): Promise<AddIdeaResult> {
    const id = requireText(challengeId, "challengeId")
    const normalizedContent = requireText(input.content, "content")
    const dedupKey = normalizeIdeaText(normalizedContent)
    await ensureChallengeDirs(rootDir, id)

    return withDirectoryLock(ideasLockDir(rootDir, id), async () => {
        const index = await readIdeasIndex(rootDir, id)
        const existing = index.items.find((item) => item.normalized === dedupKey)
        if (existing) return { created: false, item: existing }

        const now = nowIso()
        const idea: IdeaRecord = {
            id: createEntityId("idea"),
            content: normalizedContent,
            normalized: dedupKey,
            status: input.status ?? "pending",
            result: input.result?.trim() ?? "",
            created_at: now,
            updated_at: now,
        }
        const nextIndex: IdeasIndexRecord = {
            ...index,
            updated_at: now,
            items: [...index.items, idea],
        }
        await writeIdeasIndex(rootDir, id, nextIndex)
        await atomicWriteJson(ideaByIdPath(rootDir, id, idea.id), idea)
        return { created: true, item: idea }
    })
}

function findIdeaByIdOrPrefix(items: IdeaRecord[], ideaIdOrPrefix: string): IdeaRecord {
    const lookup = requireText(ideaIdOrPrefix, "ideaIdOrPrefix")
    const exact = items.find((item) => item.id === lookup)
    if (exact) return exact
    const prefixed = items.filter((item) => item.id.startsWith(lookup))
    if (prefixed.length === 0) throw new Error(`idea "${lookup}" not found`)
    if (prefixed.length > 1) throw new Error(`idea id prefix "${lookup}" is ambiguous`)
    return prefixed[0]
}

export async function updateChallengeIdea(rootDir: string, challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
    const id = requireText(challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, id)

    return withDirectoryLock(ideasLockDir(rootDir, id), async () => {
        const index = await readIdeasIndex(rootDir, id)
        const matched = findIdeaByIdOrPrefix(index.items, ideaIdOrPrefix)

        let nextContent = matched.content
        let nextNormalized = matched.normalized
        if (patch.content !== undefined) {
            const content = requireText(patch.content, "content")
            const normalized = normalizeIdeaText(content)
            const duplicate = index.items.find((item) => item.id !== matched.id && item.normalized === normalized)
            if (duplicate) {
                throw new Error(`idea content duplicates ${duplicate.id}`)
            }
            nextContent = content
            nextNormalized = normalized
        }

        const now = nowIso()
        const updated: IdeaRecord = {
            ...matched,
            content: nextContent,
            normalized: nextNormalized,
            status: patch.status ?? matched.status,
            result: patch.result !== undefined ? patch.result.trim() : matched.result,
            updated_at: now,
        }
        const nextIndex: IdeasIndexRecord = {
            ...index,
            updated_at: now,
            items: index.items.map((item) => (item.id === matched.id ? updated : item)),
        }
        await writeIdeasIndex(rootDir, id, nextIndex)
        await atomicWriteJson(ideaByIdPath(rootDir, id, updated.id), updated)
        return updated
    })
}

export async function deleteChallengeIdea(rootDir: string, challengeId: string, ideaIdOrPrefix: string): Promise<IdeaRecord> {
    const id = requireText(challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, id)

    return withDirectoryLock(ideasLockDir(rootDir, id), async () => {
        const index = await readIdeasIndex(rootDir, id)
        const matched = findIdeaByIdOrPrefix(index.items, ideaIdOrPrefix)
        const nextIndex: IdeasIndexRecord = {
            ...index,
            updated_at: nowIso(),
            items: index.items.filter((item) => item.id !== matched.id),
        }
        await writeIdeasIndex(rootDir, id, nextIndex)
        await rm(ideaByIdPath(rootDir, id, matched.id), { force: true })
        return matched
    })
}
