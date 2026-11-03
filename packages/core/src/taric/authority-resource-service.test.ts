import { describe, expect, test } from "bun:test"
import { TaricAuthorityResourceService } from "./authority-resource-service"
import type { TaricHostModule } from "./host-module"

const binding = { projectId: "project-a", tenantId: "tenant-a", engagementId: "019a0000-0000-7000-8000-000000000001", hostPrincipalId: "host-a", modelPrincipalId: "model-a" }
const id = "019a0000-0000-7000-8000-000000000002"
const asset = { challengeId: "challenge-a", assetId: "asset-a", origin: "http://127.0.0.1", path: "/approved" }

describe("authority Resource identities", () => {
    test("rejects caller substitutions and inline credentials before authority mutation", async () => {
        let mutations = 0
        const host = { getBinding() { return binding }, async invokeHost() { mutations += 1 }, async submitProposal() { mutations += 1 } } as unknown as Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
        const resources = new TaricAuthorityResourceService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(resources.provision({ ...asset, origin: "http://user:credential@127.0.0.1" })).rejects.toMatchObject({ code: "validation_error" })
        await expect(resources.provision({ ...asset, path: "/?token=fixture" })).rejects.toMatchObject({ code: "validation_error" })
        await expect(resources.provision({ ...asset, canonicalId: id } as typeof asset)).rejects.toMatchObject({ code: "validation_error" })
        await expect(resources.provision({ ...asset, origin: "invalid-origin-credential-canary" })).rejects.toMatchObject({ code: "validation_error", message: "Resource origin must be a valid HTTP origin" })
        expect(mutations).toBe(0)
    })

    test("rejects a returned Resource in another Engagement", async () => {
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
            getBinding() { return binding },
            async submitProposal() { return { id } },
            async invokeHost() { return { ok: true, record: { id, kind: "resource", engagement_id: "foreign-engagement", trust_level: "L1", identity: {} } } },
        }
        const resources = new TaricAuthorityResourceService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(resources.provision(asset)).rejects.toMatchObject({ code: "authorization_error" })
    })

    test("reconciles a lost ResourceRevision response by canonical content without replaying the non-idempotent write", async () => {
        const observationId = "019a0000-0000-7000-8000-000000000003"
        const resource = { id, kind: "resource", engagement_id: binding.engagementId, version: 1, revision: 1, trust_level: "L1", identity: { origin: "http://127.0.0.1", path: "/approved" } }
        const revision = { id: "019a0000-0000-7000-8000-000000000004", kind: "resource_revision", engagement_id: binding.engagementId, version: 1, revision: 1, resource_ref: id, content_hash: `sha256:${"b".repeat(64)}`, variant: { method: "GET", path_template: "/approved" }, source_observation_refs: [observationId], trust_level: "L1" }
        const observation = { id: observationId, kind: "observation", engagement_id: binding.engagementId, resource_ref: id, trust_level: "L1" }
        let storedResource = resource
        let storedRevision: typeof revision | undefined
        let reviseCalls = 0
        let requestId = ""
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
            getBinding() { return binding },
            async submitProposal() { throw new Error("unexpected proposal") },
            async invokeHost(operation, input) {
                if (operation === "resource.query") {
                    const records = input.kind === "resource" ? [storedResource] : input.kind === "observation" ? [observation] : input.kind === "resource_revision" ? storedRevision ? [storedRevision] : [] : []
                    return { records, read_seq: 10 }
                }
                if (operation === "resource.revise") {
                    reviseCalls += 1
                    requestId = String(input.client_request_id)
                    storedRevision = revision
                    storedResource = { ...resource, version: 2 }
                    throw new Error("reply lost after authority commit")
                }
                throw new Error(`unexpected operation ${operation}`)
            },
        }
        const resources = new TaricAuthorityResourceService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        const input = { challengeId: "challenge-a", assetId: "asset-a", resourceId: id, expectedVersion: 1, method: "GET", path: "/approved", contentHash: revision.content_hash, sourceObservationRefs: [observationId] }
        await expect(resources.provisionRevision(input)).rejects.toThrow("reply lost")
        const resolved = await resources.provisionRevision(input)
        expect(resolved.revision.id).toBe(revision.id)
        expect(resolved.readSeq).toBe(10)
        expect(reviseCalls).toBe(1)
        expect(requestId).toMatch(/^bw:resource_revision:[a-f0-9]{64}$/)
    })

    test("rejects a ResourceRevision source Observation for another Resource before mutation", async () => {
        const observationId = "019a0000-0000-7000-8000-000000000003"
        let reviseCalls = 0
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
            getBinding() { return binding },
            async submitProposal() { throw new Error("unexpected proposal") },
            async invokeHost(operation, input) {
                if (operation !== "resource.query") { reviseCalls += 1; return {} }
                return { read_seq: 10, records: input.kind === "resource" ? [{ id, kind: "resource", engagement_id: binding.engagementId, version: 1, trust_level: "L1" }] : [{ id: observationId, kind: "observation", engagement_id: binding.engagementId, resource_ref: "019a0000-0000-7000-8000-000000000099", trust_level: "L1" }] }
            },
        }
        const resources = new TaricAuthorityResourceService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(resources.provisionRevision({ challengeId: "challenge-a", assetId: "asset-a", resourceId: id, expectedVersion: 1, method: "GET", path: "/approved", contentHash: `sha256:${"b".repeat(64)}`, sourceObservationRefs: [observationId] })).rejects.toMatchObject({ code: "authorization_error" })
        expect(reviseCalls).toBe(0)
    })
})
