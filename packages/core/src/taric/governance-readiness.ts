import type { TaricAcceptanceProfile, TaricAuthorityProfile, TaricHostSettings } from "../config/types"
import { inspectTaricControlPlaneContract } from "./control-plane-contract"
import type { TaricControlPlaneContractDiagnostic } from "./control-plane-contract"

export type GovernanceReadinessStatus = "implemented" | "partial" | "blocked"

export interface GovernanceCapabilityReadiness {
    id: string
    status: GovernanceReadinessStatus
    tasks: readonly { id: string; status: GovernanceReadinessStatus | "complete" }[]
    summary: string
    supportNeeded?: string
}

export const TARIC_ACCEPTANCE_PROFILES = {
    local_development: {
        authorityProfiles: ["single_host_sqlite"],
        fixtureIdentityAllowed: true,
        requiredEvidence: ["contract", "binding", "connection_time_authorization", "work_fencing", "restart_recovery", "artifact_round_trip", "coverage", "action_audit", "projection_rebuild"],
    },
    production_hardened: {
        authorityProfiles: ["single_host_sqlite", "multi_host_authority"],
        fixtureIdentityAllowed: false,
        requiredEvidence: ["local_acceptance", "project_engagement_isolation", "token_rotation_revocation", "tls_pki", "persistent_egress", "real_reviewer_owner", "retention", "paired_backup_restore"],
        multiHostRequiredEvidence: ["postgresql", "schema_lease_health", "current_source_runtime_conformance", "multi_host_fencing", "network_partition_recovery", "artifact_routing_recovery"],
    },
} as const

export interface AuthorizedGovernanceReadiness {
    format: "breachweave-authorized-governance-readiness/1"
    generatedAt: string
    status: "partial" | "blocked"
    blockingReason: "governed_agent_lifecycle_incomplete"
    deployment: {
        taricEnabled: boolean
        /** Transport profile, not the acceptance tier or authority layout. */
        profile: NonNullable<TaricHostSettings["profile"]> | "unconfigured"
        acceptanceProfile: TaricAcceptanceProfile
        authorityProfile: TaricAuthorityProfile
        engagementBoundary: NonNullable<TaricHostSettings["engagementBoundary"]>
        projectBoundAuthorityReady: false
    }
    acceptance: {
        localDevelopment: "unverified"
        productionHardened: "unverified"
        productionEvidenceRequiredForLocal: false
        fixtureEvidenceIsProductionConformance: false
        requiredEvidence: readonly string[]
        profileDiagnostics: readonly string[]
    }
    contract: TaricControlPlaneContractDiagnostic
    capabilities: readonly GovernanceCapabilityReadiness[]
}

const CAPABILITIES: readonly GovernanceCapabilityReadiness[] = [
    {
        id: "contract_mapping", status: "implemented", tasks: [{ id: "1.1", status: "complete" }],
        summary: "All 66 operations and package artifacts are pinned to Taric 1.0.4; immutable Scope/ROE, fixed complete Coverage, ActionEvent audit, ReportSnapshot and CloseDecision contracts are available.",
        supportNeeded: "Contract availability is independently verified; host lifecycle acceptance still requires current-source evidence.",
    },
    {
        id: "project_engagement_isolation", status: "partial", tasks: [{ id: "1.2", status: "complete" }, { id: "7.1", status: "blocked" }],
        summary: "A shared Development Engagement is a local development boundary; per-project authority isolation remains unverified.",
        supportNeeded: "Production requires project-bound Engagements and real credential rotation/revocation.",
    },
    {
        id: "scope_roe_revision", status: "implemented", tasks: [{ id: "1.5", status: "complete" }],
        summary: "ScopeRevision approval and invalidation use explicit operator authority and a committed integrity-verified ROE Artifact; fresh queries resolve immutable revision and policy bindings without setup fallback.",
    },
    {
        id: "project_bootstrap", status: "implemented", tasks: [{ id: "2.1", status: "complete" }],
        summary: "The canonical bootstrap service provisions Resource/Revision, manifest-bound Coverage cells and admitted WorkItems with stable retry identities; the real embedded SQLite fixture verifies duplicate bootstrap and an incomplete non-closable manifest.",
    },
    {
        id: "scope_egress_enforcement", status: "partial", tasks: [{ id: "4.5", status: "partial" }],
        summary: "Explicit loopback HTTP execution resolves canonical ScopeRevision policy, pins DNS to a real TCP/TLS socket, records the observed peer and checks method, protocol, port, time and ownership before sending. General tool networking has not cut over to this executor.",
        supportNeeded: "Loopback fixture execution does not enable arbitrary tool networking or authorized project activation.",
    },
    {
        id: "workrun_scheduler", status: "partial", tasks: [{ id: "2.2", status: "complete" }, { id: "2.4", status: "partial" }],
        summary: "Canonical admission, complete pinned Work reads, claim/renew/transition, independent host reservations and immutable ScopeRevision checkpoint fencing pass local fixtures; Planner/Solver startup and completion still require a governed lifecycle cutover.",
    },
    {
        id: "artifact_evidence", status: "partial", tasks: [{ id: "3.4", status: "partial" }, { id: "3.5", status: "complete" }],
        summary: "Managed Artifact bytes and hashes survive SQLite restart and SIGKILL fixtures; Resource/Revision/run-bound Evidence is admitted canonically. Authorized lifecycle payload ownership cutover remains incomplete.",
    },
    {
        id: "coverage_report", status: "implemented", tasks: [{ id: "5.1", status: "complete" }, { id: "5.3", status: "complete" }],
        summary: "Complete manifest-bound Coverage snapshots and CAS updates feed canonical ReportSnapshot commits with Evidence and report Artifact digests. Operator close/reopen uses authority CAS and reconstructs immutable decisions from Taric queries.",
    },
    {
        id: "action_audit", status: "implemented", tasks: [{ id: "4.7", status: "complete" }],
        summary: "Canonical recommendations, decisions, results and explicit unknown reconciliation bind WorkRun, generation and immutable ScopeRevision. Complete pinned ActionEvent history survives SQLite restart; stale results are idempotently quarantined without changing current Actions.",
    },
    {
        id: "checkpoint_recovery", status: "implemented", tasks: [{ id: "2.8", status: "complete" }],
        summary: "Allowlisted checkpoints bind immutable ScopeRevision, policy and trusted task-session/run premises; recovery discovers runs through canonical queries and validates checkpoint state through work.resume.",
    },
    {
        id: "review_close_recovery", status: "partial", tasks: [{ id: "5.2", status: "partial" }, { id: "5.7", status: "partial" }],
        summary: "Standalone canonical services rebuild Scope/ROE, Work, checkpoints, Coverage, report Artifact metadata and the same close decision from authority. Product session, Planner/Solver, Web/stat/report projection cutover remains incomplete.",
        supportNeeded: "Fixture review remains L1 evidence; reviewer-only review.submit does not imply independent L2 verification.",
    },
    {
        id: "controlled_evaluation", status: "partial", tasks: [{ id: "6.5", status: "complete" }],
        summary: "Current-source tests/build and explicit SQLite/loopback fixtures have separate reports; historical gateway smoke, complete local acceptance and production conformance remain distinct and unverified.",
    },
]

/** Bounded metadata only. Helper availability never constitutes acceptance evidence. */
export function buildAuthorizedGovernanceReadiness(input: {
    taric?: TaricHostSettings
    now?: Date
} = {}): AuthorizedGovernanceReadiness {
    const acceptanceProfile = input.taric?.acceptanceProfile ?? "local_development"
    const authorityProfile = input.taric?.authorityProfile ?? "single_host_sqlite"
    const engagementBoundary = input.taric?.engagementBoundary ?? "shared_development"
    const profileDiagnostics: string[] = []
    if (acceptanceProfile === "local_development" && authorityProfile === "multi_host_authority") profileDiagnostics.push("multi_host_authority requires separate production conformance; select single_host_sqlite for independent local acceptance")
    if (acceptanceProfile === "production_hardened" && engagementBoundary === "shared_development") profileDiagnostics.push("production_hardened requires project-bound Engagements and non-fixture identities")
    const requiredEvidence: readonly string[] = acceptanceProfile === "production_hardened" && authorityProfile === "multi_host_authority"
        ? [...TARIC_ACCEPTANCE_PROFILES.production_hardened.requiredEvidence, ...TARIC_ACCEPTANCE_PROFILES.production_hardened.multiHostRequiredEvidence]
        : TARIC_ACCEPTANCE_PROFILES[acceptanceProfile].requiredEvidence
    return {
        format: "breachweave-authorized-governance-readiness/1",
        generatedAt: (input.now ?? new Date()).toISOString(),
        status: "blocked",
        blockingReason: "governed_agent_lifecycle_incomplete",
        deployment: {
            taricEnabled: input.taric?.enabled === true,
            profile: input.taric?.profile ?? "unconfigured",
            acceptanceProfile,
            authorityProfile,
            engagementBoundary,
            projectBoundAuthorityReady: false,
        },
        acceptance: {
            localDevelopment: "unverified",
            productionHardened: "unverified",
            productionEvidenceRequiredForLocal: false,
            fixtureEvidenceIsProductionConformance: false,
            requiredEvidence: [...requiredEvidence],
            profileDiagnostics,
        },
        contract: inspectTaricControlPlaneContract(),
        capabilities: CAPABILITIES.map((capability) => ({ ...capability, tasks: capability.tasks.map((task) => ({ ...task })) })),
    }
}
