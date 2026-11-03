import type { TaricHostModule } from "./host-module"
import { TaricOperationError } from "./types"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^sha256:[0-9a-f]{64}$/
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const DEFAULT_MAX_BYTES = 1024 * 1024
// Leaves room for the host's 32 KiB JSON request envelope and metadata.
const MAX_CHUNK_BYTES = 16 * 1024

export type TaricArtifactSessionBinding = {
    sessionId: string
    root: string
} & ({ mode: "host-session" } | {
    mode: "run-bound"
    workRunId: string
    attemptId: string
    generation: number
    ownerHost: string
})

export interface TaricArtifactRunFence {
    workRunId: string
    attemptId: string
    generation: number
    ownerHost: string
}

export interface CommittedTaricArtifact {
    engagementId: string
    sessionId: string
    contentRef: string
    artifactId: string
    version: number
    category: string
    payloadKind: "text" | "binary" | "manifest"
    mediaType: string
    byteLength: number
    contentHash: string
    manifestHash: string
    storageMode: "taric_stored"
    contentStatus: "available"
    integrityStatus: "verified"
    workRunId?: string
    attemptId?: string
    generation?: number
    ownerHost?: string
}

export interface TaricArtifactEgressGrant {
    principalId: string
    engagementId: string
    capability: "content_read"
}

export interface TaricArtifactServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost">
    maxPayloadBytes?: number
    chunkBytes?: number
    /** Trusted configuration inventory, never persisted or sent to Taric. */
    configurationSecrets?: readonly string[]
    /** Additional host gate; Taric must independently grant content_read. */
    egressGrant?: TaricArtifactEgressGrant
    /** Host-owned retention/deletion gate. Taric does not supply credential lifecycle policy. */
    assertReadable?: (artifact: CommittedTaricArtifact) => void | Promise<void>
    onCommitted?: (artifact: CommittedTaricArtifact) => void | Promise<void>
}

export interface StoreTargetAuthInput {
    sessionId: string
    requestId: string
    payloadKind: "text" | "binary"
    mediaType: string
    payload: string | Uint8Array
    storageMode?: "taric_stored"
    /** Optional run fence; normally inherited from a run-bound session. */
    workRunId?: string
    attemptId?: string
    generation?: number
    ownerHost?: string
}

export interface StoreTaricArtifactInput {
    sessionId: string
    requestId: string
    category: "evidence" | "report" | "tool-output"
    payloadKind: "text" | "binary" | "manifest"
    mediaType: string
    payload: string | Uint8Array
    storageMode?: "taric_stored"
    /** Optional run fence; normally inherited from a run-bound session. */
    workRunId?: string
    attemptId?: string
    generation?: number
    ownerHost?: string
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Taric Artifact response is invalid")
    return value as Record<string, unknown>
}

function text(value: unknown, field: string, max = 256): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${field} must be bounded text`)
    return value
}

function opaqueSegment(value: unknown, field: string): string {
    const result = text(value, field)
    if (result === "." || result === ".." || /[/\\]/.test(result)) throw new Error(`${field} must be an opaque segment`)
    return result
}

function uuid(value: unknown, field: string): string {
    const result = text(value, field)
    if (!UUID.test(result)) throw new Error(`${field} must be a Taric UUID`)
    return result
}

function hash(bytes: Uint8Array): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
    return value
}

/** Opaque Artifact transport. This service owns no local payload store or credential API. */
export class TaricArtifactService {
    private readonly options: TaricArtifactServiceOptions
    private readonly maxPayloadBytes: number
    private readonly chunkBytes: number
    private readonly sessionBindings = new Map<string, TaricArtifactSessionBinding>()

    constructor(options: TaricArtifactServiceOptions) {
        this.options = { ...options, configurationSecrets: [...options.configurationSecrets ?? []], ...(options.egressGrant ? { egressGrant: { ...options.egressGrant } } : {}) }
        this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_BYTES, "maxPayloadBytes")
        this.chunkBytes = positiveInteger(options.chunkBytes ?? MAX_CHUNK_BYTES, "chunkBytes")
        if (this.chunkBytes > MAX_CHUNK_BYTES) throw new Error("chunkBytes exceeds the host transport envelope")
        this.assertSafeMetadata(this.options.host.getBinding())
        this.assertSafeMetadata(this.options.egressGrant)
    }

    async bindSession(input: TaricArtifactSessionBinding): Promise<void> {
        const allowed = new Set(["sessionId", "root", "mode", "workRunId", "attemptId", "generation", "ownerHost"])
        if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Artifact binding contains an unapproved field")
        this.assertSafeMetadata(input)
        const sessionId = opaqueSegment(input.sessionId, "sessionId")
        const root = text(input.root, "root", 4096)
        const value = input as TaricArtifactSessionBinding & Record<string, unknown>
        const runFields = ["workRunId", "attemptId", "generation", "ownerHost"]
        if (input.mode === "host-session") {
            if (runFields.some((key) => value[key] !== undefined)) throw new Error("host-session cannot include run attribution")
            await this.options.host.invokeHost("artifact.session.bind", { session_id: sessionId, root, mode: input.mode })
            this.sessionBindings.set(sessionId, { sessionId, root, mode: input.mode })
            return
        }
        if (input.mode !== "run-bound") throw new Error("Artifact session mode is required")
        if (input.ownerHost !== this.options.host.getBinding().hostPrincipalId) throw new Error("run-bound owner must match the trusted host principal")
        // Taric validates this entire fence against its current authority state.
        await this.options.host.invokeHost("artifact.session.bind", {
            session_id: sessionId, root, mode: input.mode,
            work_run_id: uuid(input.workRunId, "workRunId"), attempt_id: uuid(input.attemptId, "attemptId"),
            generation: positiveInteger(input.generation, "generation"), owner_host: input.ownerHost,
        })
        this.sessionBindings.set(sessionId, { sessionId, root, mode: input.mode, workRunId: uuid(input.workRunId, "workRunId"), attemptId: uuid(input.attemptId, "attemptId"), generation: positiveInteger(input.generation, "generation"), ownerHost: input.ownerHost })
    }

    async storeTargetAuth(input: StoreTargetAuthInput): Promise<CommittedTaricArtifact> {
        const allowed = new Set(["sessionId", "requestId", "payloadKind", "mediaType", "payload", "storageMode", "workRunId", "attemptId", "generation", "ownerHost"])
        if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Target credential upload contains an unapproved field")
        if (input.storageMode !== undefined && input.storageMode !== "taric_stored") throw new Error("Target credentials require Taric-managed storage")
        if (input.payloadKind !== "text" && input.payloadKind !== "binary") throw new Error("Target credential payload kind must be text or binary")
        return this.store({ ...input, category: "target-auth" })
    }

    /** Ordinary raw content remains an Artifact until an admitted Evidence domain record references it. */
    async storeArtifact(input: StoreTaricArtifactInput): Promise<CommittedTaricArtifact> {
        const allowed = new Set(["sessionId", "requestId", "category", "payloadKind", "mediaType", "payload", "storageMode", "workRunId", "attemptId", "generation", "ownerHost"])
        if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Artifact upload contains an unapproved field")
        if (!["evidence", "report", "tool-output"].includes(input.category)) throw new Error("Ordinary Artifact category is invalid")
        if (!["text", "binary", "manifest"].includes(input.payloadKind)) throw new Error("Artifact payload kind is invalid")
        if (input.storageMode !== undefined && input.storageMode !== "taric_stored") throw new Error("Authority-critical Artifacts require Taric-managed storage")
        return this.store(input)
    }

    private async store(input: Omit<StoreTaricArtifactInput, "category"> & { category: string }): Promise<CommittedTaricArtifact> {
        this.assertSafeMetadata({ sessionId: input.sessionId, requestId: input.requestId, category: input.category, payloadKind: input.payloadKind, mediaType: input.mediaType, storageMode: input.storageMode, workRunId: input.workRunId, attemptId: input.attemptId, generation: input.generation, ownerHost: input.ownerHost })
        const sessionId = opaqueSegment(input.sessionId, "sessionId")
        const requestId = text(input.requestId, "requestId", 128)
        if (!REQUEST_ID.test(requestId)) throw new Error("requestId is invalid")
        const mediaType = text(input.mediaType, "mediaType", 128)
        if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new Error("mediaType is invalid")
        const fence = this.resolveRunFence(sessionId, input)
        if (typeof input.payload !== "string" && !(input.payload instanceof Uint8Array)) throw new Error("Artifact payload must be opaque bytes or text")
        const bytes = typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : new Uint8Array(input.payload)
        try {
            if (bytes.byteLength > this.maxPayloadBytes) throw new Error("Artifact payload exceeds the host limit")
            const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && content.includes(Buffer.from(secret)))) throw new Error("Trusted configuration secrets cannot be target credential payloads")
            const contentHash = hash(bytes)
            const begin = record(await this.options.host.invokeHost("artifact.store.begin", {
                session_id: sessionId, payload_kind: input.payloadKind, media_type: mediaType,
                storage_mode: "taric_stored", category: input.category, expected_bytes: bytes.byteLength,
                expected_hash: contentHash, idempotency_key: `${requestId}:begin`,
                ...(fence ? { work_run_id: fence.workRunId, attempt_id: fence.attemptId, generation: fence.generation } : {}),
            }))
            const uploadId = opaqueSegment(begin.upload_id, "upload_id")
            const artifactId = uuid(begin.artifact_id, "artifact_id")
            const version = positiveInteger(begin.version, "version")
            this.assertSafeMetadata({ uploadId, artifactId, version })
            const chunkBytes = Math.min(this.chunkBytes, positiveInteger(begin.max_chunk_bytes, "max_chunk_bytes"))
            const chunkCount = Math.ceil(bytes.byteLength / chunkBytes)
            const commitInput = { session_id: sessionId, upload_id: uploadId, total_bytes: bytes.byteLength, chunk_count: chunkCount, content_hash: contentHash, idempotency_key: `${requestId}:commit` }
            // A repeated begin returns its durable upload ID. Probe the declared-idempotent
            // commit before append, because Taric's JSON append needs a live upload.
            let committed: unknown
            try {
                committed = await this.options.host.invokeHost("artifact.store.commit", commitInput)
            } catch (error) {
                if (!(error instanceof TaricOperationError) || error.code !== "conflict") throw error
                for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
                    const chunk = bytes.subarray(ordinal * chunkBytes, (ordinal + 1) * chunkBytes)
                    await this.options.host.invokeHost("artifact.store.append", {
                        session_id: sessionId, upload_id: uploadId, ordinal, chunk_hash: hash(chunk),
                        data: Buffer.from(chunk).toString("base64"), encoding: "base64", idempotency_key: `${requestId}:chunk:${ordinal}`,
                    })
                }
                committed = await this.options.host.invokeHost("artifact.store.commit", commitInput)
            }
            const metadata = this.projectCommitted(committed, sessionId, fence)
            if (metadata.artifactId !== artifactId || metadata.version !== version || metadata.contentHash !== contentHash || metadata.byteLength !== bytes.byteLength || metadata.category !== input.category || metadata.payloadKind !== input.payloadKind || metadata.mediaType !== mediaType) throw new Error("Committed Artifact does not match its upload identity")
            await this.options.onCommitted?.(metadata)
            return metadata
        } finally {
            bytes.fill(0)
        }
    }

    async metadata(sessionId: string, contentRef: string): Promise<CommittedTaricArtifact> {
        this.assertSafeMetadata({ sessionId, contentRef })
        const session = opaqueSegment(sessionId, "sessionId")
        const ref = opaqueSegment(contentRef, "contentRef")
        const metadata = this.projectCommitted(await this.options.host.invokeHost("artifact.metadata", { session_id: session, content_ref: ref }), session)
        if (metadata.contentRef !== ref) throw new Error("Artifact metadata reference does not match the request")
        return metadata
    }

    /** Host execution boundary only. Never return the callback result or bytes to an API. */
    async consumeTargetAuth(input: { sessionId: string; contentRef: string }, consumer: (bytes: Uint8Array) => Promise<void>): Promise<void> {
        return this.consume(input, true, consumer)
    }

    /** Trusted host consumers only. Target credentials cannot cross this ordinary-content channel. */
    async consumeArtifact(input: { sessionId: string; contentRef: string }, consumer: (bytes: Uint8Array) => Promise<void>): Promise<void> {
        return this.consume(input, false, consumer)
    }

    private async consume(input: { sessionId: string; contentRef: string }, targetAuth: boolean, consumer: (bytes: Uint8Array) => Promise<void>): Promise<void> {
        const binding = this.options.host.getBinding()
        const grant = this.options.egressGrant
        if (grant?.capability !== "content_read" || grant.principalId !== binding.hostPrincipalId || grant.engagementId !== binding.engagementId) throw new Error("Explicit trusted host content_read grant is required")
        const metadata = await this.metadata(input.sessionId, input.contentRef)
        if (targetAuth ? metadata.category !== "target-auth" || (metadata.payloadKind !== "text" && metadata.payloadKind !== "binary") : metadata.category === "target-auth") throw new Error("Artifact cannot enter the requested execution channel")
        if (metadata.byteLength > this.maxPayloadBytes) throw new Error("Artifact payload exceeds the host limit")
        await this.options.assertReadable?.(metadata)
        const bytes = new Uint8Array(metadata.byteLength)
        let offset = 0
        try {
            do {
                const response = record(await this.options.host.invokeHost("artifact.content.read", {
                    session_id: metadata.sessionId, content_ref: metadata.contentRef, offset,
                    ...(metadata.byteLength > 0 ? { length: Math.min(this.chunkBytes, metadata.byteLength - offset) } : {}), max_response_bytes: this.chunkBytes,
                }))
                if (response.encoding !== "base64" || typeof response.data !== "string" || response.data.length > Math.ceil(this.chunkBytes / 3) * 4 || response.chunk_verified !== true || response.integrity_status !== "verified" || response.content_ref !== metadata.contentRef || response.content_hash !== metadata.contentHash || response.byte_offset !== offset) throw new Error("Artifact content read failed binding or integrity verification")
                const chunk = Buffer.from(response.data, "base64")
                try {
                    if (chunk.toString("base64") !== response.data || response.byte_length !== chunk.byteLength || chunk.byteLength > bytes.byteLength - offset || (chunk.byteLength === 0 && bytes.byteLength > offset)) throw new Error("Artifact content read is invalid or truncated")
                    bytes.set(chunk, offset)
                    offset += chunk.byteLength
                } finally { chunk.fill(0) }
            } while (offset < bytes.byteLength)
            if (hash(bytes) !== metadata.contentHash) throw new Error("Artifact content hash mismatch")
            if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(secret)))) throw new Error("Trusted configuration secrets cannot enter an Artifact execution channel")
            await consumer(bytes)
        } finally { bytes.fill(0) }
    }

    private projectCommitted(value: unknown, sessionId: string, expectedFence?: TaricArtifactRunFence): CommittedTaricArtifact {
        const metadata = record(value)
        const binding = this.options.host.getBinding()
        if (metadata.engagement_id !== binding.engagementId || metadata.session_id !== sessionId) throw new Error("Artifact is outside the bound Engagement or session")
        if (metadata.storage_mode !== "taric_stored" || metadata.content_status !== "available" || metadata.integrity_status !== "verified") throw new Error("Artifact is not committed with verified Taric-managed content")
        if (!HASH.test(String(metadata.content_hash)) || !HASH.test(String(metadata.manifest_hash))) throw new Error("Artifact integrity hashes are invalid")
        if (typeof metadata.byte_length !== "number" || !Number.isSafeInteger(metadata.byte_length) || metadata.byte_length < 0) throw new Error("Artifact byte length is invalid")
        if (!["text", "binary", "manifest"].includes(String(metadata.payload_kind))) throw new Error("Artifact payload kind is invalid")
        const artifactId = uuid(metadata.artifact_id, "artifact_id")
        const version = positiveInteger(metadata.version, "version")
        const contentRef = opaqueSegment(metadata.content_ref, "content_ref")
        if (contentRef !== `${artifactId}@v${version}`) throw new Error("Artifact content reference is invalid")
        const category = text(metadata.category, "category", 64)
        const mediaType = text(metadata.media_type, "media_type", 128)
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(category) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new Error("Artifact category or media type is invalid")
        const runFields = [metadata.work_run_id, metadata.attempt_id, metadata.generation]
        const hasRun = runFields.some((value) => value !== undefined && value !== null)
        const run: Partial<TaricArtifactRunFence> = hasRun ? {
            workRunId: uuid(metadata.work_run_id, "work_run_id"), attemptId: uuid(metadata.attempt_id, "attempt_id"),
            generation: positiveInteger(metadata.generation, "generation"),
            ...(metadata.owner_host === undefined || metadata.owner_host === null ? {} : { ownerHost: text(metadata.owner_host, "owner_host") }),
        } : {}
        if (expectedFence && (!hasRun || run.workRunId !== expectedFence.workRunId || run.attemptId !== expectedFence.attemptId || run.generation !== expectedFence.generation || (run.ownerHost !== undefined && run.ownerHost !== expectedFence.ownerHost))) throw new Error("Committed Artifact does not match the active WorkRun fence")
        const projected: CommittedTaricArtifact = {
            engagementId: binding.engagementId, sessionId, contentRef, artifactId, version,
            category, payloadKind: metadata.payload_kind as CommittedTaricArtifact["payloadKind"], mediaType, byteLength: metadata.byte_length,
            contentHash: String(metadata.content_hash), manifestHash: String(metadata.manifest_hash),
            storageMode: "taric_stored", contentStatus: "available", integrityStatus: "verified",
            ...run,
        }
        this.assertSafeMetadata(projected)
        return projected
    }

    private resolveRunFence(sessionId: string, input: { workRunId?: string; attemptId?: string; generation?: number; ownerHost?: string }): TaricArtifactRunFence | undefined {
        const provided = [input.workRunId, input.attemptId, input.generation, input.ownerHost].some((value) => value !== undefined)
        const binding = this.sessionBindings.get(sessionId)
        if (provided) {
            if (input.workRunId === undefined || input.attemptId === undefined || input.generation === undefined || input.ownerHost === undefined) throw new Error("Artifact WorkRun fencing requires workRunId, attemptId, generation and ownerHost")
            const fence = { workRunId: uuid(input.workRunId, "workRunId"), attemptId: uuid(input.attemptId, "attemptId"), generation: positiveInteger(input.generation, "generation"), ownerHost: text(input.ownerHost, "ownerHost") }
            if (fence.ownerHost !== this.options.host.getBinding().hostPrincipalId) throw new Error("Artifact owner must match the trusted host principal")
            if (binding?.mode === "host-session") throw new Error("host-session cannot publish a run-bound Artifact")
            if (binding?.mode === "run-bound" && (binding.workRunId !== fence.workRunId || binding.attemptId !== fence.attemptId || binding.generation !== fence.generation || binding.ownerHost !== fence.ownerHost)) throw new Error("Artifact WorkRun fence does not match the bound session")
            return fence
        }
        if (binding?.mode === "run-bound") return { workRunId: binding.workRunId, attemptId: binding.attemptId, generation: binding.generation, ownerHost: binding.ownerHost }
        return undefined
    }

    private assertSafeMetadata(value: unknown): void {
        if (typeof value === "string") {
            if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && value.includes(secret))) throw new Error("Trusted configuration secrets cannot enter Artifact metadata or bindings")
        } else if (value && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) { this.assertSafeMetadata(key); this.assertSafeMetadata(item) }
        }
    }
}
