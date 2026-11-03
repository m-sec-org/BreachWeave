export interface AddResult {
    id: string
    rejected?: string
}

export interface HostRuntimeSettings {
    image?: string
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    binds?: string[]
    maxSolvers?: number
    networkMode?: "bridge" | "host"
}

export interface HostPlannerSettings {
    tickIntervalMs?: number
    staleTimeoutMs?: number
}

export interface HostAuthSettings {
    registrationEnabled?: boolean
    jwtSecret?: string
}

export type TaricAcceptanceProfile = "local_development" | "production_hardened"
export type TaricAuthorityProfile = "single_host_sqlite" | "multi_host_authority"

/** Non-secret Taric host profile. Credentials and authority databases are never persisted here. */
export interface TaricHostSettings {
    enabled?: boolean
    /** BreachWeave acceptance tier, independent from authority layout and transport. */
    acceptanceProfile?: TaricAcceptanceProfile
    /** Taric authority deployment layout; never a claim of host conformance. */
    authorityProfile?: TaricAuthorityProfile
    /** Authority boundary, independent from the embedded/proxy transport. */
    engagementBoundary?: "shared_development" | "project_bound"
    authorityPath?: string
    /** Canonical Taric Artifact content root for local task-session binding. */
    contentRoot?: string
    hostPrincipalId?: string
    /** Explicit trusted embedded-host grants; never inferred from the host role. */
    embeddedHostCapabilities?: ("admit" | "content_read")[]
    modelPrincipalId?: string
    profile?: "embedded_bun" | "authenticated_proxy"
    /** Authenticated Taric gateway transport; credentials are read from env. */
    gatewayTransport?: "https" | "tls_tcp"
    gatewayUrl?: string
    gatewayHost?: string
    gatewayPort?: number
    gatewayPath?: string
    gatewayCaFile?: string
    gatewayServerName?: string
    gatewayTokenEnv?: string
    gatewayHostTokenEnv?: string
    gatewayModelTokenEnv?: string
    /** Operator-only gateway credential used for authenticated status/reload. */
    gatewayOperatorTokenEnv?: string
    gatewayOperatorPrincipalId?: string
    gatewayTimeoutMs?: number
    apiVersion?: string
    schemaVersion?: string
    coreVersion?: string
    storageVersion?: string
    policyDigest?: string
    driverArtifact?: string
    driverDigest?: string
    /** Optional release hardening; local development does not require a report. */
    verificationRequired?: boolean
    verificationReportPath?: string
    outboxPath?: string
    outboxMaxBytes?: number
    outboxMaxEvents?: number
    /** Local gateway supervisor: explicit path to the taric CLI entry (dist/bin.js or an executable name). */
    localCliPath?: string
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    planner: HostPlannerSettings
    auth: HostAuthSettings
    taric?: TaricHostSettings
}
