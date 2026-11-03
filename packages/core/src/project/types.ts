/**
 * The memory policy is deliberately part of the project contract.  It is not
 * inferred from provider availability or from a request made by a solver.
 */
export type MemoryMode = "legacy_local" | "taric_best_effort" | "taric_required"

export type ProjectMode = "competition" | "authorized_pentest"

export type CompetitionProvider = "remote" | "local_practice"

export interface CompetitionProject {
    mode: "competition"
    provider: CompetitionProvider
    tenant_id: string
    platform_id: string
    competition_id: string
    team_id: string
    challenge_code: string
    instance_generation?: number
    memory_mode: "legacy_local" | "taric_best_effort"
    taric_engagement_id?: string
}

export interface AuthorizedPentestProject {
    mode: "authorized_pentest"
    tenant_id: string
    engagement_id: string
    scope_revision: number
    coverage_manifest_id: string
    memory_mode: "taric_required"
    taric_engagement_id: string
}

/** Historical design documents used this name for the authorized project. */
export type AuthorizedEngagement = AuthorizedPentestProject

export type Project = CompetitionProject | AuthorizedPentestProject

/**
 * A project key is derived by the host from the validated identity fields.
 * The branded string prevents accidentally passing a challenge id where a
 * project namespace is required while keeping the value convenient for maps,
 * paths, and persistence.
 */
export type CompositeProjectKey = string & {
    readonly __brand: "CompositeProjectKey"
}

export interface CompositeProjectKeyDetails {
    key: CompositeProjectKey
    /** Stable, length-delimited JSON used as the hash input. */
    canonical: string
    /** Lowercase SHA-256 digest of `canonical`. */
    digest: string
    mode: ProjectMode
}

export class ProjectValidationError extends Error {
    readonly code = "PROJECT_VALIDATION_FAILED"

    constructor(message: string) {
        super(message)
        this.name = "ProjectValidationError"
    }
}

function requireIdentifier(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
        throw new ProjectValidationError(`${fieldName} is required`)
    }
    const normalized = value.trim()
    if (!normalized) {
        throw new ProjectValidationError(`${fieldName} is required`)
    }
    if ([...normalized].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) {
        throw new ProjectValidationError(`${fieldName} contains control characters`)
    }
    return normalized
}

function requireOptionalIdentifier(value: unknown, fieldName: string): string | undefined {
    if (value === undefined || value === null) return
    return requireIdentifier(value, fieldName)
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new ProjectValidationError(`${fieldName} must be a non-negative integer`)
    }
    return value
}

function requireObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProjectValidationError("project must be an object; a bare challenge id is not a project")
    }
    return value as Record<string, unknown>
}

/**
 * Validate and normalize a host-created project contract.
 *
 * The returned object contains only contract fields.  In particular, a
 * caller-supplied `project_id`, `project_key`, principal, or Engagement value
 * cannot become part of the derived namespace by being copied through here.
 */
export function validateProject(value: unknown): Project {
    const input = requireObject(value)
    const mode = input.mode

    if (mode === "competition") {
        const memoryMode = input.memory_mode
        if (memoryMode !== "legacy_local" && memoryMode !== "taric_best_effort") {
            throw new ProjectValidationError(
                `competition.memory_mode must be legacy_local or taric_best_effort; received ${String(memoryMode)}`,
            )
        }

        const instanceGeneration = input.instance_generation === undefined
            ? undefined
            : requireNonNegativeInteger(input.instance_generation, "instance_generation")
        const taricEngagementId = requireOptionalIdentifier(input.taric_engagement_id, "taric_engagement_id")

        return {
            mode,
            provider: requireCompetitionProvider(input.provider),
            tenant_id: requireIdentifier(input.tenant_id, "tenant_id"),
            platform_id: requireIdentifier(input.platform_id, "platform_id"),
            competition_id: requireIdentifier(input.competition_id, "competition_id"),
            team_id: requireIdentifier(input.team_id, "team_id"),
            challenge_code: requireIdentifier(input.challenge_code, "challenge_code"),
            ...(instanceGeneration === undefined ? {} : { instance_generation: instanceGeneration }),
            memory_mode: memoryMode,
            ...(taricEngagementId === undefined ? {} : { taric_engagement_id: taricEngagementId }),
        }
    }

    if (mode === "authorized_pentest") {
        if (input.memory_mode !== "taric_required") {
            throw new ProjectValidationError("authorized_pentest.memory_mode must be taric_required")
        }

        return {
            mode,
            tenant_id: requireIdentifier(input.tenant_id, "tenant_id"),
            engagement_id: requireIdentifier(input.engagement_id, "engagement_id"),
            scope_revision: requireNonNegativeInteger(input.scope_revision, "scope_revision"),
            coverage_manifest_id: requireIdentifier(input.coverage_manifest_id, "coverage_manifest_id"),
            memory_mode: "taric_required",
            taric_engagement_id: requireIdentifier(input.taric_engagement_id, "taric_engagement_id"),
        }
    }

    if (typeof mode === "string") {
        throw new ProjectValidationError(`project.mode must be competition or authorized_pentest; received ${mode}`)
    }
    throw new ProjectValidationError("project.mode is required")
}

function requireCompetitionProvider(value: unknown): CompetitionProvider {
    if (value === "remote" || value === "local_practice") return value
    throw new ProjectValidationError("competition.provider must be remote or local_practice")
}

export function isProject(value: unknown): value is Project {
    try {
        validateProject(value)
        return true
    } catch {
        return false
    }
}

export function isCompetitionProject(value: unknown): value is CompetitionProject {
    return isProject(value) && value.mode === "competition"
}

export function isAuthorizedPentestProject(value: unknown): value is AuthorizedPentestProject {
    return isProject(value) && value.mode === "authorized_pentest"
}

function identityFields(project: Project): Record<string, string | number> {
    if (project.mode === "competition") {
        return {
            mode: project.mode,
            tenant_id: project.tenant_id,
            platform_id: project.platform_id,
            competition_id: project.competition_id,
            team_id: project.team_id,
            challenge_code: project.challenge_code,
        }
    }

    return {
        mode: project.mode,
        tenant_id: project.tenant_id,
        engagement_id: project.engagement_id,
    }
}

function canonicalIdentity(project: Project): string {
    // Object insertion order is fixed by identityFields and therefore stable.
    return JSON.stringify(["breachweave-project-key-v1", identityFields(project)])
}

/** Return the host-derived opaque namespace for a validated project. */
export function deriveCompositeProjectKey(value: unknown): CompositeProjectKey {
    const project = validateProject(value)
    const canonical = canonicalIdentity(project)
    const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex")
    return `bwpk_v1_${digest}` as CompositeProjectKey
}

/** Return key material for diagnostics without exposing identity fields in the key. */
export function describeCompositeProjectKey(value: unknown): CompositeProjectKeyDetails {
    const project = validateProject(value)
    const canonical = canonicalIdentity(project)
    const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex")
    return {
        key: `bwpk_v1_${digest}` as CompositeProjectKey,
        canonical,
        digest,
        mode: project.mode,
    }
}

/** Explicit alias used by callers that treat the key as a project namespace. */
export const createCompositeProjectKey = deriveCompositeProjectKey
export const deriveProjectKey = deriveCompositeProjectKey

export function isCompositeProjectKey(value: unknown): value is CompositeProjectKey {
    return typeof value === "string" && /^bwpk_v1_[0-9a-f]{64}$/.test(value)
}
