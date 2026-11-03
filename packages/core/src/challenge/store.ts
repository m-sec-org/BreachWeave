import { mkdir, readdir, rename, rm, stat } from "fs/promises"
import { dirname, join, resolve, sep } from "path"
import { TCH_AGENT_HOME_DIR } from "../config/index"
import { deriveCompositeProjectKey, validateProject } from "../project/types"
import type { CompetitionProvider, CompositeProjectKey, MemoryMode, Project, ProjectMode } from "../project/types"
import { CHALLENGE_ENV_DIR, CHALLENGE_ENV_ARCHIVE_DIR } from "./env"

export const DEFAULT_CHALLENGE_DIR = resolve(TCH_AGENT_HOME_DIR, "challenge")
export const ARCHIVE_CHALLENGE_DIR = resolve(TCH_AGENT_HOME_DIR, "archive_challenge")

export interface ChallengeRecord {
    id: string
    project?: Project
    /** Opaque host-derived identity. Legacy records intentionally have none. */
    project_id?: CompositeProjectKey
    project_classification?: "trusted" | "legacy_unclassified"
    mode?: ProjectMode
    provider?: CompetitionProvider
    memory_mode?: MemoryMode
    name: string
    description: string
    created_at?: string
    assets_url?: string | string[] | null
    assets_ip?: string | string[] | null
    assets?: ChallengeAssetsRecord
    planner_prompt?: string | null
    planner_enabled?: boolean
    title: string
    difficulty: string
    level: number
    hint_viewed: boolean
    hint_content?: string | null
    instance_status: string
    planner_status?: "starting" | "running" | "stop" | "disabled"
    entrypoint: string[] | null
    /** Disposable metadata derived from Taric, never accepted as authorization. */
    authority_projection?: {
        source: "canonical_taric_records"
        read_seq: number
        lifecycle_mode: "dual_write" | "taric_projection"
        closed: boolean
        can_close: boolean
        gaps: unknown[]
        work_total: number
        coverage_total: number
        coverage_resolved: number
        evidence_refs: string[]
        report_refs: string[]
        action_event_total: number
    }
}

export interface ChallengeAssetRecord {
    asset: string
    asset_hash: string
    scanned: boolean
}

export interface ChallengeAssetsRecord {
    urls: ChallengeAssetRecord[]
    ips: ChallengeAssetRecord[]
}

export interface CreateChallengeInput {
    name: string
    project?: Project
    /** Explicit opt-out from the default taric_best_effort project binding on local deployments. */
    memory_mode?: "legacy_local"
    description?: string
    assets_url?: string | string[] | null
    assets_ip?: string | string[] | null
    planner_prompt?: string | null
    planner_enabled?: boolean
}

export interface ChallengeInfoRecord extends ChallengeRecord {
    created_at: string
    updated_at: string
    source: string
}

export interface ChallengeAttemptLogRecord {
    id: string
    challenge_id: string
    project_id?: string
    solver_id: string
    prompt_name: string
    task: string
    created_at: string
}

export interface ChallengeTestResult {
    test_item: string
    status: "completed" | "blocked"
    evidence: string
}

export interface ChallengeSubmissionLogRecord {
    id: string
    challenge_id: string
    project_id?: string
    solver_id?: string
    prompt_name?: string
    model_name?: string
    asset_hash: string
    asset: string
    report: string
    test_results?: ChallengeTestResult[]
    discoveries?: string[]
    created_at: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function requireSafeChallengeId(challengeId: string): string {
    const id = requireText(challengeId, "challengeId")
    if (id === "." || id === "..") {
        throw new Error("challengeId is invalid")
    }
    if (id.includes("/") || id.includes("\\")) {
        throw new Error("challengeId is invalid")
    }
    return id
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

function assertPathWithinRoot(root: string, target: string, label: string): void {
    const resolvedRoot = resolve(root)
    const resolvedTarget = resolve(target)
    if (resolvedTarget === resolvedRoot) {
        throw new Error(`${label} cannot target root directory`)
    }
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
    if (!resolvedTarget.startsWith(prefix)) {
        throw new Error(`${label} is outside allowed root`)
    }
}

function isDirectoryExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"
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
                throw new Error(`challenge lock timeout: ${lockDir}`)
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

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function challengePath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "challenge.json")
}

function challengeLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "challenge.lock")
}

function attemptLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "attempts")
}

function submissionLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "submissions")
}

export function resolveChallengeDir(challengeDir?: string): string {
    const fromParam = challengeDir?.trim()
    if (fromParam) return fromParam
    const fromEnv = process.env[CHALLENGE_ENV_DIR]?.trim()
    if (fromEnv) return fromEnv
    return DEFAULT_CHALLENGE_DIR
}

export function resolveArchiveChallengeDir(archiveDir?: string): string {
    const fromParam = archiveDir?.trim()
    if (fromParam) return fromParam
    const fromEnv = process.env[CHALLENGE_ENV_ARCHIVE_DIR]?.trim()
    if (fromEnv) return fromEnv
    return ARCHIVE_CHALLENGE_DIR
}

function archiveChallengeDir(archiveRootDir: string, challengeId: string): string {
    return join(archiveRootDir, encodeURIComponent(challengeId))
}

export async function ensureChallengeStoreBaseDir(rootDir: string): Promise<void> {
    await mkdir(rootDir, { recursive: true })
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
    await mkdir(attemptLogsDir(rootDir, id), { recursive: true })
    await mkdir(submissionLogsDir(rootDir, id), { recursive: true })
}

function createLogId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

function optionalText(value: unknown): string | null {
    const text = typeof value === "string" ? value.trim() : ""
    return text || null
}

function normalizeTextList(value: unknown): string[] {
    const rawItems = Array.isArray(value) ? value : [value]
    const items: string[] = []
    const seen = new Set<string>()
    for (const item of rawItems) {
        const text = optionalText(item)
        if (!text || seen.has(text)) continue
        seen.add(text)
        items.push(text)
    }
    return items
}

export function hashChallengeAsset(asset: string): string {
    return new Bun.CryptoHasher("md5").update(requireText(asset, "asset")).digest("hex")
}

function readAssetsGroup(value: unknown, group: "urls" | "ips"): unknown[] {
    if (typeof value !== "object" || value === null || !(group in value)) return []
    const items = (value as Record<string, unknown>)[group]
    return Array.isArray(items) ? items : []
}

function extractAssetTargets(items: unknown[]): string[] {
    return items
        .map((item) => (typeof item === "object" && item !== null ? optionalText((item as { asset?: unknown }).asset) : null))
        .filter((item): item is string => Boolean(item))
}

function mergeTextLists(...lists: string[][]): string[] {
    const items: string[] = []
    const seen = new Set<string>()
    for (const list of lists) {
        for (const item of list) {
            if (seen.has(item)) continue
            seen.add(item)
            items.push(item)
        }
    }
    return items
}

function normalizeAssetGroup(existingItems: unknown[], targets: string[]): ChallengeAssetRecord[] {
    const scannedByAsset = new Map<string, boolean>()
    for (const item of existingItems) {
        if (typeof item !== "object" || item === null) continue
        const asset = optionalText((item as { asset?: unknown }).asset)
        if (!asset || scannedByAsset.has(asset)) continue
        scannedByAsset.set(asset, (item as { scanned?: unknown }).scanned === true)
    }
    return targets.map((asset) => ({ asset, asset_hash: hashChallengeAsset(asset), scanned: scannedByAsset.get(asset) ?? false }))
}

function normalizePlannerStatus(value: unknown): ChallengeRecord["planner_status"] {
    return value === "starting" || value === "running" || value === "stop" || value === "disabled" ? value : "stop"
}

export function buildChallengeEntrypoints(assetsUrl?: string | string[] | null, assetsIp?: string | string[] | null): string[] | null {
    const items = mergeTextLists(normalizeTextList(assetsUrl), normalizeTextList(assetsIp))
    return items.length > 0 ? items : null
}

export function getChallengeDisplayName(challenge: Pick<ChallengeRecord, "id" | "name" | "title">): string {
    return optionalText(challenge.name) ?? optionalText(challenge.title) ?? challenge.id
}

export function normalizeChallengeRecord(record: ChallengeRecord): ChallengeRecord {
    const project = record.project === undefined ? undefined : validateProject(record.project)
    if (!project && record.project_id) {
        throw new Error("project_id requires a validated project identity")
    }
    const projectId = project ? deriveCompositeProjectKey(project) : undefined
    if (projectId && record.project_id && record.project_id !== projectId) {
        throw new Error("project_id does not match the host-derived project identity")
    }
    // A present validated project binding is the only source of trust; the API
    // sync round-trips records without it and must never downgrade or freeze
    // the classification of a host-bound project.
    const projectClassification = project ? "trusted" : "legacy_unclassified"
    const name = getChallengeDisplayName(record)
    const existingUrls = readAssetsGroup(record.assets, "urls")
    const existingIps = readAssetsGroup(record.assets, "ips")
    const assets_url = mergeTextLists(normalizeTextList(record.assets_url), extractAssetTargets(existingUrls))
    const assets_ip = mergeTextLists(normalizeTextList(record.assets_ip), extractAssetTargets(existingIps))
    const assets: ChallengeAssetsRecord = {
        urls: normalizeAssetGroup(existingUrls, assets_url),
        ips: normalizeAssetGroup(existingIps, assets_ip),
    }
    const entrypoint = record.entrypoint && record.entrypoint.length > 0 ? record.entrypoint : buildChallengeEntrypoints(assets_url, assets_ip)
    const planner_enabled = record.planner_enabled !== false

    return {
        ...record,
        project,
        project_id: projectId,
        project_classification: projectClassification,
        mode: project?.mode ?? "competition",
        provider: project?.mode === "competition" ? project.provider : project ? undefined : "local_practice",
        memory_mode: project?.memory_mode ?? "legacy_local",
        name,
        title: optionalText(record.title) ?? name,
        description: record.description ?? "",
        assets_url,
        assets_ip,
        assets,
        planner_prompt: optionalText(record.planner_prompt),
        planner_enabled,
        difficulty: record.difficulty || "local",
        level: Number.isFinite(record.level) ? record.level : 1,
        hint_viewed: record.hint_viewed === true,
        hint_content: optionalText(record.hint_content),
        instance_status: record.instance_status || "stopped",
        planner_status: planner_enabled ? (normalizePlannerStatus(record.planner_status) === "disabled" ? "stop" : normalizePlannerStatus(record.planner_status)) : "disabled",
        entrypoint,
    }
}

export function createChallengeRecord(input: CreateChallengeInput & { id: string }): ChallengeRecord {
    const name = requireText(input.name, "name")
    const assets_url = normalizeTextList(input.assets_url)
    const assets_ip = normalizeTextList(input.assets_ip)

    return normalizeChallengeRecord({
        id: requireText(input.id, "id"),
        ...(input.project === undefined ? {} : { project: validateProject(input.project) }),
        name,
        title: name,
        description: input.description?.trim() ?? "",
        assets_url,
        assets_ip,
        planner_prompt: optionalText(input.planner_prompt),
        planner_enabled: input.planner_enabled !== false,
        difficulty: "local",
        level: 1,
        hint_viewed: false,
        hint_content: null,
        instance_status: "stopped",
        planner_status: input.planner_enabled === false ? "disabled" : "stop",
        entrypoint: buildChallengeEntrypoints(assets_url, assets_ip),
    })
}

function normalizeChallengeInfoRecord(record: ChallengeInfoRecord): ChallengeInfoRecord {
    const updatedAt = optionalText(record.updated_at) ?? nowIso()
    return {
        ...normalizeChallengeRecord(record),
        created_at: optionalText(record.created_at) ?? updatedAt,
        updated_at: updatedAt,
        source: record.source,
    }
}

export async function saveChallengeRecord(rootDir: string, challenge: ChallengeRecord, source = "save"): Promise<void> {
    const challengeId = requireText(challenge.id, "challenge.id")
    await ensureChallengeDirs(rootDir, challengeId)
    await withDirectoryLock(challengeLockDir(rootDir, challengeId), async () => {
        const existing = await readJsonFile<ChallengeInfoRecord>(challengePath(rootDir, challengeId))
        const now = nowIso()
        const record: ChallengeInfoRecord = normalizeChallengeInfoRecord({
            ...challenge,
            created_at: optionalText(existing?.created_at) ?? optionalText(challenge.created_at) ?? now,
            updated_at: now,
            source,
        })
        await atomicWriteJson(challengePath(rootDir, challengeId), record)
    })
}

export async function appendChallengeAttemptLog(
    rootDir: string,
    input: { challengeId: string; projectId?: string; solverId: string; promptName: string; task: string },
): Promise<ChallengeAttemptLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)
    const record: ChallengeAttemptLogRecord = {
        id: createLogId("attempt"),
        challenge_id: challengeId,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        solver_id: requireText(input.solverId, "solverId"),
        prompt_name: requireText(input.promptName, "promptName"),
        task: requireText(input.task, "task"),
        created_at: nowIso(),
    }
    await atomicWriteJson(join(attemptLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`), record)
    return record
}

export async function appendChallengeSubmissionLog(
    rootDir: string,
    input: { challengeId: string; projectId?: string; solverId?: string; promptName?: string; modelName?: string; assetHash: string; asset: string; report: string; testResults?: ChallengeTestResult[]; discoveries?: string[] },
): Promise<ChallengeSubmissionLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)
    const record: ChallengeSubmissionLogRecord = {
        id: createLogId("submission"),
        challenge_id: challengeId,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        solver_id: typeof input.solverId === "string" && input.solverId.trim() ? input.solverId.trim() : undefined,
        prompt_name: typeof input.promptName === "string" && input.promptName.trim() ? input.promptName.trim() : undefined,
        model_name: typeof input.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : undefined,
        asset_hash: requireText(input.assetHash, "assetHash"),
        asset: requireText(input.asset, "asset"),
        report: requireText(input.report, "report"),
        ...(input.testResults ? { test_results: input.testResults } : {}),
        ...(input.discoveries ? { discoveries: input.discoveries } : {}),
        created_at: nowIso(),
    }
    await atomicWriteJson(join(submissionLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`), record)
    return record
}

export async function listChallengeAttemptLogs(rootDir: string, challengeId: string, projectId?: string): Promise<ChallengeAttemptLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = attemptLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(files.map((file) => readJsonFile<ChallengeAttemptLogRecord>(join(dir, file))))
    return items.filter((item): item is ChallengeAttemptLogRecord => Boolean(item) && (projectId === undefined || item?.project_id === projectId))
}

export async function listChallengeSubmissionLogs(rootDir: string, challengeId: string, projectId?: string): Promise<ChallengeSubmissionLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = submissionLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(files.map((file) => readJsonFile<ChallengeSubmissionLogRecord>(join(dir, file))))
    return items.filter((item): item is ChallengeSubmissionLogRecord => Boolean(item) && (projectId === undefined || item?.project_id === projectId))
}

export async function readChallengeRecord(rootDir: string, challengeId: string): Promise<ChallengeInfoRecord | undefined> {
    const id = requireText(challengeId, "challengeId")
    const record = await readJsonFile<ChallengeInfoRecord>(challengePath(rootDir, id))
    if (!record) return
    return normalizeChallengeInfoRecord(record)
}

async function listChallengeIds(rootDir: string): Promise<string[]> {
    await ensureChallengeStoreBaseDir(rootDir)
    try {
        const entries = await readdir(rootDir, { withFileTypes: true })
        return entries.filter((entry) => entry.isDirectory()).map((entry) => decodeURIComponent(entry.name)).sort()
    } catch {
        return []
    }
}

export async function listChallengeRecords(rootDir: string): Promise<ChallengeInfoRecord[]> {
    const ids = await listChallengeIds(rootDir)
    const records = await Promise.all(ids.map((id) => readChallengeRecord(rootDir, id)))
    return records
        .filter((item): item is ChallengeInfoRecord => Boolean(item))
        .sort((a, b) => {
            const timeDiff = Date.parse(b.created_at) - Date.parse(a.created_at)
            if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff
            return a.id.localeCompare(b.id)
        })
}

export function computeChallengeCompleted(challenge: ChallengeRecord | undefined): boolean {
    if (challenge?.project?.mode === "authorized_pentest" || challenge?.mode === "authorized_pentest") return false
    if (!challenge) return false
    const assets = [...(challenge.assets?.urls ?? []), ...(challenge.assets?.ips ?? [])]
    return assets.length > 0 && assets.every((item) => item.scanned === true)
}

export async function isChallengeCompletedInStore(challengeId: string, challengeDir?: string): Promise<boolean> {
    const rootDir = resolveChallengeDir(challengeDir)
    const challenge = await readChallengeRecord(rootDir, requireText(challengeId, "challengeId"))
    return computeChallengeCompleted(challenge)
}

export async function archiveChallengeRecord(
    rootDir: string,
    challengeId: string,
    archiveRootDir?: string,
): Promise<boolean> {
    const id = requireSafeChallengeId(challengeId)
    const resolvedRoot = resolve(rootDir)
    const resolvedArchiveRoot = resolve(resolveArchiveChallengeDir(archiveRootDir))
    const sourceDir = resolve(challengeDir(resolvedRoot, id))
    assertPathWithinRoot(resolvedRoot, sourceDir, "challenge source directory")

    if (!(await pathExists(sourceDir))) {
        return false
    }

    await mkdir(resolvedArchiveRoot, { recursive: true })

    let targetDir = resolve(archiveChallengeDir(resolvedArchiveRoot, id))
    assertPathWithinRoot(resolvedArchiveRoot, targetDir, "challenge archive directory")

    if (await pathExists(targetDir)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        targetDir = resolve(resolvedArchiveRoot, `${encodeURIComponent(id)}-${stamp}`)
        assertPathWithinRoot(resolvedArchiveRoot, targetDir, "challenge archive directory")
    }

    await rename(sourceDir, targetDir)
    return true
}
