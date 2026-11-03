import { describe, expect, test } from "bun:test"
import { assertEngagementBoundarySupported, assertProductionActivationSupported, createTaricHostModuleForProject } from "./provider-factory"
import type { ConfigManager } from "../config/index"
import { TaricUnavailableError } from "./types"
import type { Project } from "../project/types"

const competitionProject: Project = {
    mode: "competition",
    provider: "local_practice",
    tenant_id: "tenant-a",
    platform_id: "platform-a",
    competition_id: "competition-a",
    team_id: "team-a",
    challenge_code: "challenge-a",
    memory_mode: "taric_best_effort",
    taric_engagement_id: "engagement-shared",
}

const authorizedProject: Project = {
    mode: "authorized_pentest",
    tenant_id: "tenant-a",
    engagement_id: "engagement-a",
    scope_revision: 1,
    coverage_manifest_id: "manifest-a",
    memory_mode: "taric_required",
    taric_engagement_id: "engagement-a",
}

describe("Taric Engagement boundary support", () => {
    test("production activation rejects shared credentials and requires verified deployment evidence", () => {
        expect(() => assertProductionActivationSupported({ acceptanceProfile: "production_hardened", authorityProfile: "multi_host_authority", engagementBoundary: "shared_development", profile: "authenticated_proxy" })).toThrow("refuses shared Engagement credentials")
        expect(() => assertProductionActivationSupported({ acceptanceProfile: "production_hardened", authorityProfile: "single_host_sqlite", engagementBoundary: "project_bound", profile: "embedded_bun" })).toThrow("activation is blocked")
        expect(() => assertProductionActivationSupported({ acceptanceProfile: "production_hardened", authorityProfile: "multi_host_authority", engagementBoundary: "project_bound", profile: "authenticated_proxy" })).toThrow("activation is blocked")
        expect(() => assertProductionActivationSupported({ acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite", engagementBoundary: "shared_development", profile: "embedded_bun" })).not.toThrow()
    })

    test("provider creation blocks production shared identity before creating a transport", async () => {
        const config = {
            async getHostSettings() { return { taric: { enabled: true, acceptanceProfile: "production_hardened", engagementBoundary: "shared_development", profile: "authenticated_proxy", gatewayHost: "127.0.0.1", gatewayPort: 1 } } },
        } as unknown as ConfigManager
        await expect(createTaricHostModuleForProject(config, authorizedProject)).rejects.toThrow("refuses shared Engagement credentials")
    })

    test("available canonical mappings proceed to explicit host configuration checks", async () => {
        let configRead = false
        const config = {
            async getHostSettings() { configRead = true; return { taric: { enabled: false } } },
        } as unknown as ConfigManager
        await expect(createTaricHostModuleForProject(config, authorizedProject)).rejects.toThrow("Taric is disabled")
        expect(configRead).toBe(true)
    })

    test("keeps explicitly shared development projects available", () => {
        expect(() => assertEngagementBoundarySupported(competitionProject, "shared_development")).not.toThrow()
    })

    test("allows authorized projects to use the shared local development policy", () => {
        expect(() => assertEngagementBoundarySupported(authorizedProject, "shared_development")).not.toThrow()
    })

    test("fails closed when project-bound credentials are not provisioned", () => {
        for (const project of [competitionProject, authorizedProject]) {
            try {
                assertEngagementBoundarySupported(project, "project_bound")
                throw new Error("expected project-bound configuration to be rejected")
            } catch (error) {
                expect(error).toBeInstanceOf(TaricUnavailableError)
                expect(error).toMatchObject({ blocked: project.memory_mode === "taric_required" })
                expect((error as Error).message).toContain("project-specific Engagement provisioning")
            }
        }
    })
})
