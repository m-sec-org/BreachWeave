import type { CommittedTaricArtifact } from "./artifact-service"
import type { TaricArtifactReferenceDto } from "./types"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SENSITIVE = /(?:password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]|bearer\s+\S+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|https?:\/\/[^/\s:@]+:[^@\s/]+@/i

/** Trusted ResourceRevision and WorkRun values are resolved by the host, never inferred from tool text. */
export interface TaricEvidenceBinding {
    engagementId: string
    hostPrincipalId: string
    sessionId: string
    resourceId: string
    resourceRevisionId: string
    resourceRevision: number
    workRunId: string
    attemptId: string
    generation: number
}

export interface TaricEvidenceInput {
    resourceRef: string
    resourceRevision: number
    observedAt: string
    statement: string
    limitations: readonly string[]
    artifact: CommittedTaricArtifact
}

export interface TaricEvidenceCandidate {
    schema_version: "1.0.0"
    engagement_id: string
    kind: "evidence"
    resource_ref: string
    observed_at: string
    statement: string
    limitations: string[]
    artifact_ref: TaricArtifactReferenceDto & { version: number; payload_kind: CommittedTaricArtifact["payloadKind"]; provenance_ref: string }
    provenance: { host_id: string; producer_id: string; source_kind: "host"; attempt_ref: string; source_refs: string[] }
}

function text(value: unknown, field: string, limit: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\0\r]/.test(value) || SENSITIVE.test(value)) throw new Error(`Evidence ${field} is invalid or sensitive`)
    return value
}

function uuid(value: unknown, field: string): string {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Evidence ${field} must be a Taric UUID`)
    return value
}

/** Produces an L0 proposal payload only. Calling this does not create or admit canonical Evidence. */
export function buildTaricEvidenceCandidate(input: TaricEvidenceInput, binding: TaricEvidenceBinding): TaricEvidenceCandidate {
    if (Object.keys(input).some((key) => !["resourceRef", "resourceRevision", "observedAt", "statement", "limitations", "artifact"].includes(key))) throw new Error("Evidence contains an unapproved field")
    const engagementId = uuid(binding.engagementId, "engagementId")
    const resourceId = uuid(binding.resourceId, "resourceId")
    const revisionId = uuid(binding.resourceRevisionId, "resourceRevisionId")
    const workRunId = uuid(binding.workRunId, "workRunId")
    const attemptId = uuid(binding.attemptId, "attemptId")
    if (!Number.isSafeInteger(binding.resourceRevision) || binding.resourceRevision < 1 || !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new Error("Evidence binding revisions are invalid")
    if (uuid(input.resourceRef, "resourceRef") !== resourceId || input.resourceRevision !== binding.resourceRevision) throw new Error("Evidence ResourceRevision does not match the authoritative binding")
    const observedAt = text(input.observedAt, "observedAt", 64)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString().slice(0, 19) !== observedAt.slice(0, 19)) throw new Error("Evidence observation time is invalid")
    const statement = text(input.statement, "statement", 4096)
    if (!Array.isArray(input.limitations) || input.limitations.length > 32) throw new Error("Evidence limitations must be a bounded array")
    const limitations = input.limitations.map((value) => text(value, "limitation", 512))
    const artifact = input.artifact
    if (!artifact || artifact.category !== "evidence" || artifact.storageMode !== "taric_stored" || artifact.contentStatus !== "available" || artifact.integrityStatus !== "verified") throw new Error("Evidence requires an ordinary committed and verified evidence Artifact")
    if (artifact.engagementId !== engagementId || artifact.sessionId !== binding.sessionId || artifact.workRunId !== workRunId || artifact.attemptId !== attemptId || artifact.generation !== binding.generation || (artifact.ownerHost !== undefined && artifact.ownerHost !== binding.hostPrincipalId)) throw new Error("Evidence Artifact does not match the Engagement, session or active run fence")
    uuid(artifact.artifactId, "artifactId")
    if (!Number.isSafeInteger(artifact.version) || artifact.version < 1 || artifact.contentRef !== `${artifact.artifactId}@v${artifact.version}` || !/^sha256:[0-9a-f]{64}$/.test(artifact.contentHash) || !/^sha256:[0-9a-f]{64}$/.test(artifact.manifestHash) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || !["text", "binary", "manifest"].includes(artifact.payloadKind) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(artifact.mediaType)) throw new Error("Evidence Artifact identity or integrity is invalid")
    return {
        schema_version: "1.0.0", engagement_id: engagementId, kind: "evidence", resource_ref: resourceId, observed_at: observedAt, statement, limitations,
        artifact_ref: { content_ref: artifact.contentRef, artifact_id: artifact.artifactId, version: artifact.version, storage_mode: "taric_stored", content_status: "available", integrity_status: "verified", payload_kind: artifact.payloadKind, media_type: artifact.mediaType, byte_length: artifact.byteLength, content_hash: artifact.contentHash, manifest_hash: artifact.manifestHash, provenance_ref: workRunId },
        provenance: { host_id: text(binding.hostPrincipalId, "hostPrincipalId", 128), producer_id: text(binding.hostPrincipalId, "hostPrincipalId", 128), source_kind: "host", attempt_ref: attemptId, source_refs: [resourceId, revisionId] },
    }
}

export type TaricToolEvidenceResult = { disposition: "candidate"; candidate: TaricEvidenceCandidate } | { disposition: "host_audit"; diagnostic: "unsupported_tool_event" | "invalid_evidence"; eventDigest: string }

/** Unsupported or incomplete tool events remain hash-only host audit, never invented observations. */
export function adaptTaricToolEvidence(eventType: string, input: unknown, binding: TaricEvidenceBinding): TaricToolEvidenceResult {
    let serialized: string
    try { serialized = JSON.stringify(input) ?? "undefined" } catch { serialized = "unserializable_tool_event" }
    const eventDigest = `sha256:${new Bun.CryptoHasher("sha256").update(serialized).digest("hex")}`
    if (eventType !== "evidence.observed") return { disposition: "host_audit", diagnostic: "unsupported_tool_event", eventDigest }
    try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid shape")
        return { disposition: "candidate", candidate: buildTaricEvidenceCandidate(input as TaricEvidenceInput, binding) }
    } catch {
        return { disposition: "host_audit", diagnostic: "invalid_evidence", eventDigest }
    }
}
