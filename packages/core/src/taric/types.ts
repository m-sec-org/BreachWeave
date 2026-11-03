export type TaricMemoryMode = "taric_best_effort" | "taric_required"

export interface TaricHostBinding {
    projectId: string
    tenantId: string
    engagementId: string
    hostPrincipalId: string
    modelPrincipalId: string
}

export interface TaricCompatibility {
    sourceCommit: string
    apiContractVersion: string
    adapterContractVersion: string
    schemaVersion: string
    coreVersion: string
    storageContract: string
    sqlContract: string
    policyVersion: string
    policyDigest: string
    bunDriver: {
        packageName: string
        version: string
        integrity: string
    }
}

export interface TaricAdapterProfile {
    status: "verified" | "unavailable"
    compatibility: TaricCompatibility
}

export interface TaricServiceAdapter {
    /** Transport profile used for diagnostics and startup health reporting. */
    readonly transportProfile?: "bun_in_process" | "authenticated_proxy"
    getProfile(): Promise<TaricAdapterProfile>
    getBinding(): Promise<TaricHostBinding>
    checkHealth?(): Promise<void>
    /** Authenticated gateway management operations, when the transport supports them. */
    gatewayStatus?(): Promise<unknown>
    gatewayReload?(): Promise<unknown>
    /** Dispatch with an explicit trusted role; transport must never infer role from request body. */
    invoke(operation: string, input: Record<string, unknown>, role?: "model" | "host"): Promise<unknown>
    /** Optional separately configured operator identity; never inferred from model/host requests. */
    invokeOperator?(operation: string, input: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}

export type TaricHealthStatus = "unavailable" | "healthy" | "degraded" | "closed"

export interface TaricHealth {
    status: TaricHealthStatus
    profile: "bun_in_process" | "authenticated_proxy" | "unavailable"
    mode: TaricMemoryMode
    checkedAt: string
    reason?: string
}

export interface TaricHostModuleOptions {
    binding: TaricHostBinding
    expectedCompatibility: TaricCompatibility
    mode: TaricMemoryMode
    adapter?: TaricServiceAdapter
}

export interface TaricQueryInput {
    [key: string]: unknown
}

export interface TaricProposalInput {
    eventId: string
    subjectType: "claim" | "test_hypothesis" | "work_item" | "resource"
    expectedVersion: number
    content: Record<string, unknown>
    targetId?: string
}

export interface TaricCheckpointProposalInput {
    eventId: string
    workRunId: string
    generation: number
    checkpoint: Record<string, unknown>
}

export type TaricObservationSourceKind = "tool_result" | "platform_result" | "host_event"
export type TaricCaptureDtoKind = "solver" | "attempt" | "report" | "platform"

export interface TaricHostObservationInput {
    eventId: string
    sourceKind: TaricObservationSourceKind
    /** Optional source adapter. Host captures default to the platform DTO. */
    captureKind?: TaricCaptureDtoKind
    /** Strict DTOs are required for authorized host_event captures. Legacy competition adapters may carry an opaque event until migration. */
    observation: TaricObservationDto | Record<string, unknown>
    targetId?: string
    workRunId?: string
    generation?: number
}

export interface TaricObservationDto {
    resource_ref: string
    observed_at: string
    statement: string
    artifact_refs: TaricArtifactReferenceDto[]
    limitations?: string[]
    /** Capture creates a candidate; it cannot assert admission or verification. */
    status?: "proposed"
}

export type TaricArtifactReferenceDto = ({ host_ref: string } | { content_ref: string }) & {
    artifact_id?: string
    content_hash?: string
    manifest_hash?: string
    storage_mode?: "external" | "taric_stored"
    content_status?: "external" | "staged" | "available" | "unavailable" | "integrity_failed" | "quarantined" | "deleted"
    integrity_status?: "unverified" | "verified" | "mismatch" | "missing"
    media_type?: string
    byte_length?: number
}

export class TaricOperationError extends Error {
    readonly code: string
    readonly details?: unknown

    constructor(code: string, message: string, details?: unknown) {
        super(message)
        this.name = "TaricOperationError"
        this.code = code
        this.details = details
    }
}

export class TaricUnavailableError extends Error {
    readonly code = "TARIC_UNAVAILABLE"
    readonly mode: TaricMemoryMode
    readonly blocked: boolean
    readonly dispatchState?: "pre_dispatch" | "after_dispatch"

    constructor(message: string, mode: TaricMemoryMode = "taric_required", dispatchState?: "pre_dispatch" | "after_dispatch") {
        super(message)
        this.name = "TaricUnavailableError"
        this.mode = mode
        this.blocked = mode === "taric_required"
        this.dispatchState = dispatchState
    }
}
