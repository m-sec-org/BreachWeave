import { mkdir, rename } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { CommittedTaricArtifact } from "./artifact-service"

export interface ArtifactRetentionRecord {
    engagementId: string
    sessionId: string
    contentRef: string
    category: string
    contentHash: string
    committedAt: string
    expiresAt: string
    access: "available" | "expired" | "deleted"
    deletion: "not_requested" | "unsupported" | "confirmed"
}

export interface ArtifactPolicyOptions {
    journalPath: string
    retentionMs: number
    configurationSecrets?: readonly string[]
    redactValues?: readonly string[]
    maxOrdinaryBytes?: number
    now?: () => number
    /** Explicit deployment adapter, never an implicit deletion of Taric spool paths. */
    deleteStoredContent?: (artifact: ArtifactRetentionRecord) => Promise<{ deleted: boolean }>
}

/** Host policy journal contains identifiers and decisions only, never raw Artifact content. */
export class TaricArtifactPolicy {
    private readonly options: ArtifactPolicyOptions
    private readonly records = new Map<string, ArtifactRetentionRecord>()
    private pending: Promise<void> = Promise.resolve()
    private loaded = false

    constructor(options: ArtifactPolicyOptions) {
        if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 1) throw new Error("Artifact retention must be a positive duration")
        if (options.maxOrdinaryBytes !== undefined && (!Number.isSafeInteger(options.maxOrdinaryBytes) || options.maxOrdinaryBytes < 1)) throw new Error("Artifact minimization bound is invalid")
        this.options = { ...options, journalPath: resolve(options.journalPath), configurationSecrets: [...options.configurationSecrets ?? []], redactValues: [...options.redactValues ?? []] }
    }

    prepareOrdinaryText(text: string): { bytes: Uint8Array; redacted: boolean; minimized: boolean; limitations: string[] } {
        if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && text.includes(secret))) throw new Error("Trusted configuration secrets cannot enter task Artifacts")
        let prepared = text
        for (const value of this.options.redactValues ?? []) if (value.length > 0) prepared = prepared.split(value).join("[REDACTED]")
        const redacted = prepared !== text
        const encoded = new TextEncoder().encode(prepared)
        const bound = this.options.maxOrdinaryBytes ?? 1024 * 1024
        const minimized = encoded.byteLength > bound
        // A partial UTF-8 sequence is not retained; the byte limit is a hard ceiling.
        let bytes = encoded
        if (minimized) {
            let end = bound
            while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
            bytes = encoded.slice(0, end)
            encoded.fill(0)
        }
        return { bytes, redacted, minimized, limitations: [
            ...(redacted ? ["Host policy redacted configured target authentication values before storage."] : []),
            ...(minimized ? ["Host policy retained only the bounded prefix; omitted content is unavailable as Evidence."] : []),
        ] }
    }

    async register(artifact: CommittedTaricArtifact): Promise<void> {
        await this.serialize(async () => {
            await this.load()
            const key = this.key(artifact)
            const existing = this.records.get(key)
            if (existing) {
                if (existing.contentHash !== artifact.contentHash || existing.category !== artifact.category) throw new Error("Artifact policy identity changed")
                return
            }
            const now = this.now()
            this.records.set(key, { engagementId: artifact.engagementId, sessionId: artifact.sessionId, contentRef: artifact.contentRef, category: artifact.category, contentHash: artifact.contentHash, committedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.options.retentionMs).toISOString(), access: "available", deletion: "not_requested" })
            try { await this.save() } catch (error) { this.records.delete(key); throw error }
        })
    }

    async assertReadable(artifact: CommittedTaricArtifact): Promise<void> {
        await this.serialize(async () => {
            await this.load()
            const record = this.records.get(this.key(artifact))
            if (!record || record.contentHash !== artifact.contentHash || record.category !== artifact.category) throw new Error("Artifact has no matching host retention decision")
            if (record.access === "available" && this.now() >= Date.parse(record.expiresAt)) {
                record.access = "expired"
                await this.save()
            }
            if (record.access !== "available") throw new Error("Artifact content is unavailable under host retention or deletion policy")
        })
    }

    async delete(artifact: CommittedTaricArtifact, authorization: { authorized: true; reason: "retention" | "operator" }): Promise<ArtifactRetentionRecord> {
        return this.serialize(async () => {
            if (authorization.authorized !== true || !["retention", "operator"].includes(authorization.reason)) throw new Error("Explicit host deletion authorization is required")
            await this.load()
            const record = this.records.get(this.key(artifact))
            if (!record || record.contentHash !== artifact.contentHash) throw new Error("Artifact has no matching host retention decision")
            if (authorization.reason === "retention" && this.now() < Date.parse(record.expiresAt)) throw new Error("Artifact retention has not expired")
            if (record.access === "deleted" && record.deletion === "confirmed") return { ...record }
            record.access = "deleted"
            // Persist denial before attempting deployment-specific physical deletion.
            record.deletion = this.options.deleteStoredContent ? "not_requested" : "unsupported"
            await this.save()
            if (this.options.deleteStoredContent) {
                const result = await this.options.deleteStoredContent({ ...record })
                record.deletion = result.deleted === true ? "confirmed" : "unsupported"
                await this.save()
            }
            return { ...record }
        })
    }

    /** Metadata checks never fetch an external host_ref or imply content recovery. */
    externalAvailability(input: { storageMode: "external"; targetAuth: boolean; availability?: "available" | "unavailable" }): { usable: boolean; recovered: false; diagnostic: string } {
        if (input.storageMode !== "external" || input.targetAuth) return { usable: false, recovered: false, diagnostic: "target_auth_requires_taric_stored" }
        return { usable: input.availability === "available", recovered: false, diagnostic: input.availability === "available" ? "host_verified_external_availability" : "external_availability_unverified" }
    }

    private now(): number { return (this.options.now ?? Date.now)() }
    private key(value: Pick<ArtifactRetentionRecord, "engagementId" | "sessionId" | "contentRef">): string { return JSON.stringify([value.engagementId, value.sessionId, value.contentRef]) }

    private async load(): Promise<void> {
        if (this.loaded) return
        const file = Bun.file(this.options.journalPath)
        if (await file.exists()) {
            const value: unknown = await file.json()
            if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("records" in value) || !Array.isArray(value.records)) throw new Error("Artifact policy journal is invalid")
            for (const entry of value.records as unknown[]) {
                if (!entry || typeof entry !== "object") throw new Error("Artifact policy journal record is invalid")
                const record = entry as ArtifactRetentionRecord
                const keys = new Set(["engagementId", "sessionId", "contentRef", "category", "contentHash", "committedAt", "expiresAt", "access", "deletion"])
                if (Object.keys(record).some((key) => !keys.has(key))) throw new Error("Artifact policy journal record contains unapproved fields")
                if (typeof record.engagementId !== "string" || typeof record.sessionId !== "string" || typeof record.contentRef !== "string" || typeof record.category !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.contentHash) || !Number.isFinite(Date.parse(record.committedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || !["available", "expired", "deleted"].includes(record.access) || !["not_requested", "unsupported", "confirmed"].includes(record.deletion)) throw new Error("Artifact policy journal record is invalid")
                if (this.records.has(this.key(record))) throw new Error("Artifact policy journal contains duplicate identity")
                this.records.set(this.key(record), { ...record })
            }
        }
        this.loaded = true
    }

    private async save(): Promise<void> {
        const path = this.options.journalPath
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const pending = `${path}.${crypto.randomUUID()}.tmp`
        await Bun.write(pending, `${JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2)}\n`, { mode: 0o600 })
        await rename(pending, path)
    }

    private async serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation)
        this.pending = result.then(() => {}, () => {})
        return result
    }
}
