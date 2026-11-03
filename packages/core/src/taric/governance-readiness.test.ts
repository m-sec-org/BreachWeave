import { describe, expect, test } from "bun:test"
import { TARIC_ACCEPTANCE_PROFILES, buildAuthorizedGovernanceReadiness } from "./governance-readiness"

const now = new Date("2026-10-30T00:00:00.000Z")

describe("authorized governance readiness", () => {
    test("keeps transport, acceptance tier and authority layout separate", () => {
        const report = buildAuthorizedGovernanceReadiness({
            taric: {
                enabled: true,
                profile: "authenticated_proxy",
                acceptanceProfile: "local_development",
                authorityProfile: "single_host_sqlite",
                engagementBoundary: "shared_development",
                gatewayHostTokenEnv: "HOST_TOKEN_ENV",
                gatewayModelTokenEnv: "MODEL_TOKEN_ENV",
            }, now,
        })
        expect(report).toMatchObject({
            generatedAt: now.toISOString(), status: "blocked", blockingReason: "governed_agent_lifecycle_incomplete",
            deployment: { taricEnabled: true, profile: "authenticated_proxy", acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite", engagementBoundary: "shared_development", projectBoundAuthorityReady: false },
            acceptance: { localDevelopment: "unverified", productionHardened: "unverified", productionEvidenceRequiredForLocal: false, fixtureEvidenceIsProductionConformance: false, profileDiagnostics: [] },
        })
        expect(report.contract.missingFacts).toEqual([])
        expect(report.contract.status).toBe("available")
        expect(report.capabilities.find((item) => item.id === "contract_mapping")?.status).toBe("implemented")
        expect(JSON.stringify(report)).not.toContain("HOST_TOKEN_ENV")
        expect(JSON.stringify(report)).not.toContain("MODEL_TOKEN_ENV")
    })

    test("reports implemented canonical services while keeping full product activation blocked", () => {
        const report = buildAuthorizedGovernanceReadiness({ taric: { enabled: true }, now })
        for (const id of ["scope_roe_revision", "project_bootstrap", "coverage_report", "action_audit", "checkpoint_recovery"]) expect(report.capabilities.find((item) => item.id === id)?.status).toBe("implemented")
        for (const id of ["scope_egress_enforcement", "workrun_scheduler", "review_close_recovery"]) expect(report.capabilities.find((item) => item.id === id)?.status).toBe("partial")
        expect(report.contract.status).toBe("available")
        expect(report.contract.missingFacts).toEqual([])
        expect(report.status).toBe("blocked")
        expect(report.blockingReason).toBe("governed_agent_lifecycle_incomplete")
        expect(report.acceptance.localDevelopment).toBe("unverified")
        expect(report.deployment.projectBoundAuthorityReady).toBe(false)
    })

    test("makes missing configuration explicit and includes local recovery requirements", () => {
        const report = buildAuthorizedGovernanceReadiness({ now })
        expect(report.deployment).toEqual({ taricEnabled: false, profile: "unconfigured", acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite", engagementBoundary: "shared_development", projectBoundAuthorityReady: false })
        expect(report.acceptance.requiredEvidence).toContain("connection_time_authorization")
        expect(report.acceptance.requiredEvidence).toContain("restart_recovery")
        expect(report.acceptance.requiredEvidence).toContain("projection_rebuild")
        expect(report.acceptance.requiredEvidence).not.toContain("postgresql")
        expect(report.acceptance.requiredEvidence).not.toContain("token_rotation_revocation")
        expect(TARIC_ACCEPTANCE_PROFILES.local_development.fixtureIdentityAllowed).toBe(true)
        expect(TARIC_ACCEPTANCE_PROFILES.production_hardened.fixtureIdentityAllowed).toBe(false)
    })

    test("never promotes local fixture evidence into production conformance", () => {
        const local = buildAuthorizedGovernanceReadiness({ taric: { enabled: true }, now })
        const production = buildAuthorizedGovernanceReadiness({ taric: { enabled: true, acceptanceProfile: "production_hardened", authorityProfile: "multi_host_authority", engagementBoundary: "shared_development" }, now })
        expect(production.status).toBe("blocked")
        expect(production.acceptance.productionHardened).toBe("unverified")
        expect(production.acceptance.fixtureEvidenceIsProductionConformance).toBe(false)
        expect(production.acceptance.requiredEvidence).toContain("postgresql")
        expect(production.acceptance.requiredEvidence).toContain("multi_host_fencing")
        expect(production.acceptance.profileDiagnostics).toContain("production_hardened requires project-bound Engagements and non-fixture identities")
        expect(local.acceptance.productionEvidenceRequiredForLocal).toBe(false)
        expect(local.acceptance.profileDiagnostics).toEqual([])
    })

    test("detects a multi-host layout selected under a local acceptance tier", () => {
        const report = buildAuthorizedGovernanceReadiness({ taric: { acceptanceProfile: "local_development", authorityProfile: "multi_host_authority" }, now })
        expect(report.acceptance.profileDiagnostics).toHaveLength(1)
        expect(report.status).toBe("blocked")
    })
})
