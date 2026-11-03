import { describe, expect, test } from "bun:test"
import {
    describeCompositeProjectKey,
    deriveCompositeProjectKey,
    isCompositeProjectKey,
    isProject,
    validateProject,
} from "./types"

const competitionProject = {
    mode: "competition" as const,
    provider: "remote" as const,
    tenant_id: "tenant-a",
    platform_id: "platform-a",
    competition_id: "competition-a",
    team_id: "team-a",
    challenge_code: "challenge-001",
    memory_mode: "taric_best_effort" as const,
}

const authorizedProject = {
    mode: "authorized_pentest" as const,
    tenant_id: "tenant-a",
    engagement_id: "engagement-a",
    scope_revision: 3,
    coverage_manifest_id: "manifest-a",
    memory_mode: "taric_required" as const,
    taric_engagement_id: "taric-engagement-a",
}

describe("project contract", () => {
    test("validates both discriminated project modes", () => {
        expect(validateProject(competitionProject)).toEqual(competitionProject)
        expect(validateProject(authorizedProject)).toEqual(authorizedProject)
        expect(isProject(competitionProject)).toBe(true)
        expect(isProject(authorizedProject)).toBe(true)
    })

    test("rejects mode and memory policy combinations that cannot be trusted", () => {
        expect(() => validateProject({ ...competitionProject, memory_mode: "taric_required" })).toThrow("competition.memory_mode")
        expect(() => validateProject({ ...authorizedProject, memory_mode: "legacy_local" })).toThrow("taric_required")
        expect(() => validateProject({ ...authorizedProject, scope_revision: 1.5 })).toThrow("scope_revision")
        expect(() => validateProject({ ...competitionProject, provider: "unknown" })).toThrow("competition.provider")
    })

    test("rejects a bare challenge id instead of deriving a weak namespace", () => {
        expect(() => validateProject("challenge-001")).toThrow("bare challenge id")
        expect(() => deriveCompositeProjectKey("challenge-001")).toThrow("bare challenge id")
        expect(isProject("challenge-001")).toBe(false)
    })

    test("derives stable, opaque, and isolated composite keys from host identity", () => {
        const key = deriveCompositeProjectKey(competitionProject)
        expect(key).toBe(deriveCompositeProjectKey({ ...competitionProject }))
        expect(key).not.toBe(deriveCompositeProjectKey({ ...competitionProject, team_id: "team-b" }))
        expect(key).not.toBe(deriveCompositeProjectKey({ ...competitionProject, competition_id: "competition-b" }))
        expect(key).not.toBe(deriveCompositeProjectKey({ ...competitionProject, tenant_id: "tenant-b" }))
        expect(key).not.toContain(competitionProject.challenge_code)
        expect(isCompositeProjectKey(key)).toBe(true)

        const details = describeCompositeProjectKey(competitionProject)
        expect(details.key).toBe(key)
        expect(details.digest).toHaveLength(64)
        expect(details.canonical).toContain("challenge-001")
    })

    test("does not let a caller supplied key change the derived namespace", () => {
        const withUntrustedFields = {
            ...competitionProject,
            project_id: "attacker-selected",
            project_key: "attacker-selected",
        }
        expect(deriveCompositeProjectKey(withUntrustedFields)).toBe(deriveCompositeProjectKey(competitionProject))
    })
})
