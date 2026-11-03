import type { TaricHostBinding } from "./types"

export type StableHostIdentityKind =
    | "project"
    | "scope"
    | "resource"
    | "resource_revision"
    | "coverage"
    | "work_item"
    | "work_run"
    | "attempt"
    | "task_session"
    | "pi_session"

export interface StableHostIdentityInput {
    kind: StableHostIdentityKind
    challengeId?: string
    assetId?: string
    /** Immutable host keys, never titles, model output, or target content. Order is significant. */
    dimensions?: readonly string[]
}

export class TaricIdentityError extends Error {
    readonly code = "invalid_host_identity"

    constructor(message: string) {
        super(message)
        this.name = "TaricIdentityError"
    }
}

export function requireOpaqueHostId(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new TaricIdentityError(`${field} must be a bounded opaque host identifier`)
    return value
}

export function requireTaricUuid(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new TaricIdentityError(`${field} must be a Taric UUID`)
    return value
}

/**
 * Correlation keys only: these are not fabricated canonical Taric object IDs.
 * Taric must return canonical IDs after the real provisioning/admission flow.
 */
export function deriveStableHostRequestIdentity(binding: TaricHostBinding, input: StableHostIdentityInput): { clientRequestId: string; idempotencyKey: string } {
    const tenantId = requireOpaqueHostId(binding.tenantId, "tenantId")
    const projectId = requireOpaqueHostId(binding.projectId, "projectId")
    const engagementId = requireTaricUuid(binding.engagementId, "engagementId")
    const kind = requireOpaqueHostId(input.kind, "kind")
    if (!["project", "scope", "resource", "resource_revision", "coverage", "work_item", "work_run", "attempt", "task_session", "pi_session"].includes(kind)) throw new TaricIdentityError("unsupported host identity kind")
    const challengeId = input.challengeId === undefined ? undefined : requireOpaqueHostId(input.challengeId, "challengeId")
    const assetId = input.assetId === undefined ? undefined : requireOpaqueHostId(input.assetId, "assetId")
    if (["resource", "resource_revision", "coverage", "work_item", "work_run", "attempt", "task_session", "pi_session"].includes(kind) && (!challengeId || !assetId)) throw new TaricIdentityError("challengeId and assetId are required for this identity kind")
    const dimensions = input.dimensions ?? []
    if (!Array.isArray(dimensions) || dimensions.length > 16) throw new TaricIdentityError("identity dimensions exceed the allowed bound")
    const keys = [...dimensions].map((value) => requireOpaqueHostId(value, "dimension"))
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(["breachweave-host-identity/1", tenantId, projectId, engagementId, kind, challengeId ?? null, assetId ?? null, keys])).digest("hex")
    return { clientRequestId: `bw:${kind}:${digest}`, idempotencyKey: `bw:${kind}:${digest}` }
}

/** Reject caller substitutions; the expected binding must come from trusted host/authority resolution. */
export function assertBoundTaricIdentifiers(expected: Readonly<Record<string, string>>, supplied: Readonly<Record<string, unknown>>): void {
    for (const [field, value] of Object.entries(supplied)) {
        if (!Object.prototype.hasOwnProperty.call(expected, field) || value !== expected[field]) throw new TaricIdentityError("identifier substitution rejected")
    }
}
