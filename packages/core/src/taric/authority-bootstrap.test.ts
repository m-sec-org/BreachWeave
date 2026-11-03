import { describe, expect, test } from "bun:test"
import type { TaricHostModule } from "./host-module"
import { TaricAuthorityProjectBootstrap } from "./authority-bootstrap"
import type { CanonicalScopeLocator } from "./authority-bootstrap"

const binding = { projectId: "project-a", tenantId: "tenant-a", engagementId: "019a0000-0000-7000-8000-000000000001", hostPrincipalId: "host-a", modelPrincipalId: "model-a" }
const scopeId = "019a0000-0000-7000-8000-000000000002"
const policyDigest = `sha256:${"a".repeat(64)}`

function fixture() {
    const calls: string[] = []
    const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator" | "submitProposal"> = {
        getBinding() { return binding },
        async submitProposal() { throw new Error("unexpected proposal") },
        async invokeOperator() { throw new Error("unexpected operator write") },
        async invokeHost(operation) {
            calls.push(operation)
            if (operation === "resource.query") return { records: [{ id: scopeId, kind: "scope", engagement_id: binding.engagementId, version: 1, trust_level: "L2", allowed_targets: ["example.test"], rules_of_engagement_ref: "setup-only" }], read_seq: 10 }
            throw new Error(`unexpected operation ${operation}`)
        },
    }
    return { calls, bootstrap: new TaricAuthorityProjectBootstrap({ host, policyDigest }) }
}

describe("authorized project authority bootstrap", () => {
    test("rejects empty manifests before any authority call", async () => {
        const f = fixture()
        await expect(f.bootstrap.bootstrap({ scopeId, scopeVersion: 1, manifest: [] })).rejects.toMatchObject({ code: "empty_manifest" })
        expect(f.calls).toEqual([])
    })

    test("setup-only ROE cannot authorize bootstrap mutations", async () => {
        const f = fixture()
        await expect(f.bootstrap.resolveScope({ scopeId, scopeVersion: 1 })).rejects.toMatchObject({ code: "scope_unresolved" })
        expect(f.calls).toEqual(["resource.query"])
    })

    test("rejects duplicate manifest dimensions before authority mutation", async () => {
        const f = fixture()
        const item = { challengeId: "challenge-a", assetId: "asset-a", origin: "https://example.test", path: "/", testCategories: ["authorization"] }
        await expect(f.bootstrap.bootstrap({ scopeId, scopeVersion: 1, manifest: [item, item] })).rejects.toMatchObject({ code: "invalid_manifest" })
        expect(f.calls).toEqual([])
    })

    test("out-of-scope manifest target, port, protocol and method fail before provisioning", async () => {
        const locator: CanonicalScopeLocator = { ...binding, scopeId, scopeVersion: 2, scopeRevisionId: "019a0000-0000-7000-8000-000000000003", revision: 1, readSeq: 10, policyDigest, policy: { allowed_targets: ["2001:db8::/32", "example.test"], excluded_targets: [], protocols: ["https"], ports: [{ from: 443, to: 443 }], methods: ["GET"], dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 4 }, redirects: { max_hops: 1, same_scope_only: true }, valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" }, roeArtifactRef: "roe@v1", roeArtifactVersion: 1, roeContentHash: policyDigest, source: "canonical_scope_revision", roeBinding: "committed_integrity_verified_artifact" }
        for (const item of [{ origin: "https://outside.test", method: "GET" }, { origin: "http://example.test", method: "GET" }, { origin: "https://example.test:444", method: "GET" }, { origin: "https://example.test", method: "POST" }, { origin: "https://192.0.2.1", method: "GET" }]) {
            const f = fixture()
            f.bootstrap.resolveScope = async () => locator
            await expect(f.bootstrap.bootstrap({ scopeId, scopeVersion: 2, manifest: [{ challengeId: "challenge", assetId: "asset", path: "/", testCategories: ["authorization"], ...item }] })).rejects.toMatchObject({ code: "authorization_error" })
            expect(f.calls).toEqual([])
        }
    })
})
