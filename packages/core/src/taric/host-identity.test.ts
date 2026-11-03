import { describe, expect, test } from "bun:test"
import { assertBoundTaricIdentifiers, deriveStableHostRequestIdentity, requireTaricUuid } from "./host-identity"

const binding = { projectId: "project-a", tenantId: "tenant-a", engagementId: "019a0000-0000-7000-8000-000000000001", hostPrincipalId: "host-a", modelPrincipalId: "model-a" }

describe("stable host correlation identities", () => {
    test("retries resolve the same keys without claiming canonical UUIDs", () => {
        const input = { kind: "work_item" as const, challengeId: "challenge-a", assetId: "asset-a", dimensions: ["manifest-v1", "category-a"] }
        const first = deriveStableHostRequestIdentity(binding, input)
        expect(deriveStableHostRequestIdentity({ ...binding }, { ...input, dimensions: [...input.dimensions] })).toEqual(first)
        expect(first.clientRequestId).toMatch(/^bw:work_item:[a-f0-9]{64}$/)
        expect(() => requireTaricUuid(first.clientRequestId, "canonicalId")).toThrow("Taric UUID")
        expect(deriveStableHostRequestIdentity({ ...binding, projectId: "project-b" }, input)).not.toEqual(first)
        expect(deriveStableHostRequestIdentity(binding, { ...input, dimensions: ["category-a", "manifest-v1"] })).not.toEqual(first)
    })

    test("covers every host-derived governance locator", () => {
        const kinds = ["project", "scope", "resource", "resource_revision", "coverage", "work_item", "work_run", "attempt", "task_session", "pi_session"] as const
        const identities = kinds.map((kind) => deriveStableHostRequestIdentity(binding, {
            kind,
            ...(kind === "project" || kind === "scope" ? {} : { challengeId: "challenge-a", assetId: "asset-a" }),
            dimensions: kind === "resource_revision" ? ["revision-3"] : [],
        }))
        expect(new Set(identities.map((identity) => identity.idempotencyKey)).size).toBe(kinds.length)
        for (const identity of identities) expect(identity.clientRequestId).toMatch(/^bw:[a-z_]+:[a-f0-9]{64}$/)
        expect(deriveStableHostRequestIdentity(binding, { kind: "work_run", challengeId: "challenge-a", assetId: "asset-a", dimensions: ["attempt-1"] })).toEqual(
            deriveStableHostRequestIdentity(binding, { kind: "work_run", challengeId: "challenge-a", assetId: "asset-a", dimensions: ["attempt-1"] }),
        )
    })

    test("rejects mutable text, incomplete identity and caller substitutions", () => {
        expect(() => deriveStableHostRequestIdentity(binding, { kind: "resource", challengeId: "challenge-a" })).toThrow("assetId")
        expect(() => deriveStableHostRequestIdentity(binding, { kind: "attempt", challengeId: "challenge-a" })).toThrow("assetId")
        expect(() => deriveStableHostRequestIdentity(binding, { kind: "resource", challengeId: "challenge-a", assetId: "a title from the model" })).toThrow("opaque")
        expect(() => deriveStableHostRequestIdentity({ ...binding, engagementId: "forged" }, { kind: "project" })).toThrow("UUID")
        expect(() => assertBoundTaricIdentifiers({ projectId: "project-a", engagementId: binding.engagementId }, { projectId: "project-b" })).toThrow("substitution")
        expect(() => assertBoundTaricIdentifiers({ projectId: "project-a" }, { principalId: "forged" })).toThrow("substitution")
        expect(() => assertBoundTaricIdentifiers({ projectId: "project-a" }, { projectId: "project-a" })).not.toThrow()
    })
})
