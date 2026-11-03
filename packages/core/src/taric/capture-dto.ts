import type { TaricArtifactReferenceDto, TaricObservationDto } from "./types"

/** The capture adapters are intentionally narrower than the Taric record schema. */
export type TaricCaptureDtoKind = "solver" | "attempt" | "report" | "platform"

export interface CaptureDtoDiagnostic {
    code: "invalid_shape" | "unknown_field" | "invalid_uuid" | "invalid_timestamp" | "sensitive_value" | "oversized" | "invalid_artifact" | "invalid_value"
    field: string
    message: string
}

export class CaptureDtoError extends Error {
    readonly code: CaptureDtoDiagnostic["code"]
    readonly diagnostic: CaptureDtoDiagnostic

    constructor(diagnostic: CaptureDtoDiagnostic) {
        super(`${diagnostic.field}: ${diagnostic.message}`.slice(0, 256))
        this.name = "CaptureDtoError"
        this.code = diagnostic.code
        this.diagnostic = diagnostic
    }
}

export interface CaptureDtoAdapterInput {
    kind: TaricCaptureDtoKind
    hostPrincipalId: string
    eventId: string
    observation: unknown
}

export interface AdaptedCaptureDto {
    kind: TaricCaptureDtoKind
    /** Stable, host-derived correlation reference. It is not sent as an observation field. */
    originRef: string
    observation: TaricObservationDto
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^sha256:[a-f0-9]{64}$/
const SENSITIVE_KEY = /(flag|token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i
const SENSITIVE_TEXT = /flag\{[^}]*\}|bearer\s+[a-z0-9._~+/-]+=*|(?:password|secret|token|api[_-]?key)\s*[:=]|https?:\/\/[^/\s:@]+:[^@\s/]+@|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i
const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_ARTIFACT_REFS = 128
const MAX_LIMITATIONS = 32
const MAX_LIMITATION_CHARS = 512
const STORAGE_MODES = new Set(["external", "taric_stored"])
const CONTENT_STATUSES = new Set(["external", "staged", "available", "unavailable", "integrity_failed", "quarantined", "deleted"])
const INTEGRITY_STATUSES = new Set(["unverified", "verified", "mismatch", "missing"])

const COMMON_FIELDS = ["resource_ref", "observed_at", "statement", "artifact_refs", "limitations", "status"] as const
const SOURCE_FIELDS: Record<TaricCaptureDtoKind, readonly string[]> = {
    solver: [...COMMON_FIELDS, "solver_id", "project_id", "generation", "event_type"],
    attempt: [...COMMON_FIELDS, "attempt_id", "solver_id", "prompt_name", "task", "event_type"],
    report: [...COMMON_FIELDS, "submission_id", "asset_hash", "asset", "report", "event_type"],
    platform: [...COMMON_FIELDS, "platform_id", "result_id", "submission_id", "asset_hash", "asset", "report", "event_type"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function diagnostic(code: CaptureDtoDiagnostic["code"], field: string, message: string): never {
    const safeField = field.split(".").map((part) => SENSITIVE_KEY.test(part) ? "<redacted-field>" : part).join(".")
    throw new CaptureDtoError({ code, field: safeField.slice(0, 128), message: message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 180) })
}

function requiredText(value: unknown, field: string, max = 256): string {
    if (typeof value !== "string" || !value.trim() || value.length > max) diagnostic("invalid_value", field, `must be a non-empty string of at most ${max} characters`)
    return (value as string).trim()
}

function validateSafeMetadata(value: unknown, field: string, depth = 0): void {
    if (depth > 4) diagnostic("invalid_shape", field, "nested metadata exceeds the allowed depth")
    if (typeof value === "string") {
        if (value.length > 16_384) diagnostic("oversized", field, "text exceeds the capture limit")
        if (SENSITIVE_TEXT.test(value)) diagnostic("sensitive_value", field, "sensitive value is not accepted")
        return
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) diagnostic("invalid_value", field, "numbers must be finite")
        return
    }
    if (typeof value === "boolean" || value === null) return
    if (Array.isArray(value)) {
        if (value.length > 128) diagnostic("oversized", field, "array exceeds the capture limit")
        value.forEach((item, index) => validateSafeMetadata(item, `${field}[${index}]`, depth + 1))
        return
    }
    if (!isRecord(value)) diagnostic("invalid_shape", field, "must be JSON-compatible metadata")
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(key)) diagnostic("sensitive_value", `${field}.${key}`, "sensitive field is not accepted")
        validateSafeMetadata(item, `${field}.${key}`, depth + 1)
    }
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    return JSON.stringify(value) ?? "null"
}

function deriveOriginRef(hostPrincipalId: string, kind: TaricCaptureDtoKind, eventId: string, observation: TaricObservationDto): string {
    const seed = canonicalJson({ version: 1, hostPrincipalId, kind, eventId, observation })
    const digest = new Bun.CryptoHasher("sha256").update(seed).digest("hex")
    return `bw-origin:${kind}:${digest}`
}

function artifactReference(value: unknown, index: number): TaricArtifactReferenceDto {
    const field = `artifact_refs[${index}]`
    if (!isRecord(value)) diagnostic("invalid_artifact", field, "must be an object")
    const allowed = new Set(["host_ref", "content_ref", "artifact_id", "content_hash", "manifest_hash", "storage_mode", "content_status", "integrity_status", "media_type", "byte_length"])
    for (const key of Object.keys(value)) if (!allowed.has(key)) diagnostic("unknown_field", `${field}.${key}`, "field is not allowed")
    const hostRef = value.host_ref === undefined ? undefined : requiredText(value.host_ref, `${field}.host_ref`, 512)
    const contentRef = value.content_ref === undefined ? undefined : requiredText(value.content_ref, `${field}.content_ref`, 512)
    if (!hostRef && !contentRef) diagnostic("invalid_artifact", field, "requires host_ref or content_ref")
    if ((hostRef && SENSITIVE_TEXT.test(hostRef)) || (contentRef && SENSITIVE_TEXT.test(contentRef))) diagnostic("sensitive_value", field, "Artifact reference contains a sensitive value")
    const artifactId = value.artifact_id === undefined ? undefined : requiredText(value.artifact_id, `${field}.artifact_id`, 64)
    if (artifactId && !UUID.test(artifactId)) diagnostic("invalid_uuid", `${field}.artifact_id`, "must be a Taric Resource UUID")
    for (const key of ["content_hash", "manifest_hash"] as const) {
        if (value[key] !== undefined && (typeof value[key] !== "string" || !SHA256.test(value[key]))) diagnostic("invalid_value", `${field}.${key}`, "must be a sha256 digest")
    }
    if (value.storage_mode !== undefined && (typeof value.storage_mode !== "string" || !STORAGE_MODES.has(value.storage_mode))) diagnostic("invalid_value", `${field}.storage_mode`, "must be a supported storage mode")
    if (value.content_status !== undefined && (typeof value.content_status !== "string" || !CONTENT_STATUSES.has(value.content_status))) diagnostic("invalid_value", `${field}.content_status`, "must be a supported content status")
    if (value.integrity_status !== undefined && (typeof value.integrity_status !== "string" || !INTEGRITY_STATUSES.has(value.integrity_status))) diagnostic("invalid_value", `${field}.integrity_status`, "must be a supported integrity status")
    if (value.media_type !== undefined) {
        const mediaType = requiredText(value.media_type, `${field}.media_type`, 256)
        if (SENSITIVE_TEXT.test(mediaType)) diagnostic("sensitive_value", `${field}.media_type`, "sensitive value is not accepted")
    }
    if (value.byte_length !== undefined && (!Number.isSafeInteger(value.byte_length) || Number(value.byte_length) < 0)) diagnostic("invalid_value", `${field}.byte_length`, "must be a non-negative integer")
    const common = {
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(value.content_hash !== undefined ? { content_hash: value.content_hash as string } : {}),
        ...(value.manifest_hash !== undefined ? { manifest_hash: value.manifest_hash as string } : {}),
        ...(value.storage_mode !== undefined ? { storage_mode: value.storage_mode as TaricArtifactReferenceDto["storage_mode"] } : {}),
        ...(value.content_status !== undefined ? { content_status: value.content_status as TaricArtifactReferenceDto["content_status"] } : {}),
        ...(value.integrity_status !== undefined ? { integrity_status: value.integrity_status as TaricArtifactReferenceDto["integrity_status"] } : {}),
        ...(value.media_type !== undefined ? { media_type: value.media_type as string } : {}),
        ...(value.byte_length !== undefined ? { byte_length: value.byte_length as number } : {}),
    }
    return hostRef ? { ...common, host_ref: hostRef } : { ...common, content_ref: contentRef as string }
}

function adapt(kind: TaricCaptureDtoKind, hostPrincipalId: string, eventId: string, raw: unknown): AdaptedCaptureDto {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(hostPrincipalId)) diagnostic("invalid_value", "hostPrincipalId", "must be a bounded host identifier")
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) diagnostic("invalid_value", "eventId", "must be a bounded event identifier")
    if (!isRecord(raw)) diagnostic("invalid_shape", "observation", "must be an object")
    let rawBytes: number
    try {
        const serialized = JSON.stringify(raw)
        if (serialized === undefined) diagnostic("invalid_shape", "observation", "must be JSON-compatible")
        rawBytes = new TextEncoder().encode(serialized).byteLength
    } catch {
        diagnostic("invalid_shape", "observation", "must be JSON-compatible")
    }
    if (rawBytes! > MAX_CAPTURE_BYTES) diagnostic("oversized", "observation", `payload exceeds ${MAX_CAPTURE_BYTES} bytes`)
    const allowed = new Set(SOURCE_FIELDS[kind])
    for (const key of Object.keys(raw)) if (!allowed.has(key)) diagnostic("unknown_field", `observation.${key}`, "not an approved Taric field")
    if (typeof raw.resource_ref !== "string" || !raw.resource_ref.trim() || !UUID.test(raw.resource_ref.trim())) diagnostic("invalid_uuid", "observation.resource_ref", "must be a resolved Taric Resource UUID")
    const resourceRef = raw.resource_ref.trim()
    const observedAt = requiredText(raw.observed_at, "observation.observed_at", 128)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) diagnostic("invalid_timestamp", "observation.observed_at", "must be an ISO timestamp")
    const statement = requiredText(raw.statement, "observation.statement", 16_384)
    if (SENSITIVE_TEXT.test(statement)) diagnostic("sensitive_value", "observation.statement", "sensitive value is not accepted")
    if (!Array.isArray(raw.artifact_refs) || raw.artifact_refs.length > MAX_ARTIFACT_REFS) diagnostic("invalid_artifact", "observation.artifact_refs", `must contain at most ${MAX_ARTIFACT_REFS} references`)
    const artifacts = (raw.artifact_refs as unknown[]).map(artifactReference)
    if (raw.limitations !== undefined && (!Array.isArray(raw.limitations) || raw.limitations.length > MAX_LIMITATIONS)) diagnostic("invalid_value", "observation.limitations", `must contain at most ${MAX_LIMITATIONS} strings`)
    const limitations = raw.limitations === undefined ? undefined : (raw.limitations as unknown[]).map((item, index) => {
        const value = requiredText(item, `observation.limitations[${index}]`, MAX_LIMITATION_CHARS)
        if (SENSITIVE_TEXT.test(value)) diagnostic("sensitive_value", `observation.limitations[${index}]`, "sensitive value is not accepted")
        return value
    })
    if (raw.status !== undefined && raw.status !== "proposed") diagnostic("invalid_value", "observation.status", "must remain proposed until trusted admission")
    // Source metadata is validated for shape and sensitivity but is never copied
    // into the pinned observation record.
    for (const key of Object.keys(raw)) if (!(COMMON_FIELDS as readonly string[]).includes(key)) validateSafeMetadata(raw[key], `observation.${key}`)
    const observation: TaricObservationDto = {
        resource_ref: resourceRef,
        observed_at: observedAt,
        statement,
        artifact_refs: artifacts,
        ...(limitations ? { limitations } : {}),
        ...(raw.status === "proposed" ? { status: "proposed" as const } : {}),
    }
    if (new TextEncoder().encode(JSON.stringify(observation)).byteLength > MAX_CAPTURE_BYTES) diagnostic("oversized", "observation", `payload exceeds ${MAX_CAPTURE_BYTES} bytes`)
    return { kind, originRef: deriveOriginRef(hostPrincipalId, kind, eventId, observation), observation }
}

export function adaptSolverCaptureDto(input: Omit<CaptureDtoAdapterInput, "kind">): AdaptedCaptureDto {
    return adapt("solver", input.hostPrincipalId, input.eventId, input.observation)
}

export function adaptAttemptCaptureDto(input: Omit<CaptureDtoAdapterInput, "kind">): AdaptedCaptureDto {
    return adapt("attempt", input.hostPrincipalId, input.eventId, input.observation)
}

export function adaptReportCaptureDto(input: Omit<CaptureDtoAdapterInput, "kind">): AdaptedCaptureDto {
    return adapt("report", input.hostPrincipalId, input.eventId, input.observation)
}

export function adaptPlatformCaptureDto(input: Omit<CaptureDtoAdapterInput, "kind">): AdaptedCaptureDto {
    return adapt("platform", input.hostPrincipalId, input.eventId, input.observation)
}

export function adaptCaptureDto(input: CaptureDtoAdapterInput): AdaptedCaptureDto {
    return adapt(input.kind, input.hostPrincipalId, input.eventId, input.observation)
}

export const TARIC_CAPTURE_DTO_MAX_BYTES = MAX_CAPTURE_BYTES
