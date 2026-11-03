import { describe, expect, test } from "bun:test"
import type { TaricHostModule } from "./host-module"
import { TaricAuthorityScopeService } from "./authority-scope-service"

const engagementId = "019a0000-0000-7000-8000-000000000001"
const scopeId = "019a0000-0000-7000-8000-000000000002"
const revisionId = "019a0000-0000-7000-8000-000000000003"
const policyDigest = `sha256:${"a".repeat(64)}`
const policy = { allowed_targets: ["example.test"], excluded_targets: [], protocols: ["https" as const], ports: [{ from: 443, to: 443 }], methods: ["GET"], dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 8 }, redirects: { max_hops: 1, same_scope_only: true }, valid_from: "2020-01-01T00:00:00.000Z", valid_until: "2099-01-01T00:00:00.000Z" }

function fixture() {
    let scope: Record<string, unknown> = { id: scopeId, engagement_id: engagementId, kind: "scope", version: 2, trust_level: "L2", current_revision_ref: revisionId, revision_state: "approved", policy_digest: policyDigest }
    let revision: Record<string, unknown> = { id: revisionId, engagement_id: engagementId, kind: "scope_revision", trust_level: "L2", scope_ref: scopeId, revision: 1, approval_status: "approved", policy_digest: policyDigest, policy, roe_artifact_ref: "roe@v1", roe_artifact_version: 1, roe_content_hash: policyDigest }
    const calls: Array<{ operation: string; input: Record<string, unknown>; role: string }> = []
    const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator"> = {
        getBinding() { return { tenantId: "tenant", projectId: "project", engagementId, hostPrincipalId: "host", modelPrincipalId: "model" } },
        async invokeHost(operation, input) {
            calls.push({ operation, input, role: "host" })
            return { records: operation === "resource.query" ? [scope] : [revision], read_seq: 20 }
        },
        async invokeOperator(operation, input) {
            calls.push({ operation, input, role: "operator" })
            return { scope, revision }
        },
    }
    return { calls, service: new TaricAuthorityScopeService({ host }), setScope(value: Record<string, unknown>) { scope = { ...scope, ...value } }, setRevision(value: Record<string, unknown>) { revision = { ...revision, ...value } } }
}

describe("canonical ScopeRevision authority", () => {
    test("rebuilds canonical policy and verified ROE binding at one watermark", async () => {
        const f = fixture()
        const scope = await f.service.resolve({ scopeId, scopeVersion: 2 })
        expect(scope).toMatchObject({ scopeRevisionId: revisionId, policyDigest, roeBinding: "committed_integrity_verified_artifact", source: "canonical_scope_revision", readSeq: 20 })
        expect(f.calls[1]!.input.as_of).toBe(20)
        expect(await fixture().service.resolve({ scopeId })).toEqual(scope)
    })

    test("rejects setup-only Scope, wrong principal domain and stale revisions", async () => {
        const f = fixture()
        f.setScope({ revision_state: undefined })
        await expect(f.service.resolve({ scopeId })).rejects.toMatchObject({ code: "scope_unresolved" })
        f.setScope({ revision_state: "approved" })
        await expect(f.service.resolve({ scopeId, scopeVersion: 1 })).rejects.toMatchObject({ code: "stale_scope" })
        f.setRevision({ engagement_id: "019a0000-0000-7000-8000-000000000099" })
        await expect(f.service.resolve({ scopeId })).rejects.toMatchObject({ code: "authorization_error" })
    })

    test("revision changes invalidate saved authorization premises", async () => {
        const f = fixture()
        const saved = await f.service.resolve({ scopeId })
        f.setScope({ version: 3, current_revision_ref: "019a0000-0000-7000-8000-000000000004" })
        await expect(f.service.assertCurrent(saved)).rejects.toMatchObject({ code: "stale_scope" })
    })

    test("expired and mismatched ROE policies cannot resolve", async () => {
        const f = fixture()
        f.setRevision({ policy: { ...policy, valid_until: "2021-01-01T00:00:00.000Z" } })
        await expect(f.service.resolve({ scopeId })).rejects.toMatchObject({ code: "stale_scope" })
        f.setRevision({ policy, policy_digest: `sha256:${"b".repeat(64)}` })
        await expect(f.service.resolve({ scopeId })).rejects.toMatchObject({ code: "stale_scope" })
    })

    test("Scope revisions are issued only through the operator channel", async () => {
        const f = fixture()
        expect((await f.service.revise({ scopeId, expectedVersion: 1, policy, roeArtifactRef: "roe@v1", roeArtifactVersion: 1, idempotencyKey: "scope-revision" })).scopeRevisionId).toBe(revisionId)
        expect(f.calls[0]).toMatchObject({ operation: "scope.revise", role: "operator" })
    })
})
