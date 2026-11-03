import { describe, expect, test } from "bun:test"
import type { TaricHostModule } from "./host-module"
import { TaricAuthorityCoverageService } from "./authority-coverage-service"

const engagementId = "019a0000-0000-7000-8000-000000000001"
const resourceId = "019a0000-0000-7000-8000-000000000002"
const revisionId = "019a0000-0000-7000-8000-000000000003"
const scopeRevisionId = "019a0000-0000-7000-8000-000000000004"
const manifestId = "019a0000-0000-7000-8000-000000000005"
const cellId = "019a0000-0000-7000-8000-000000000006"
const secondCellId = "019a0000-0000-7000-8000-000000000007"
const policyDigest = `sha256:${"a".repeat(64)}`
const manifestDigest = `sha256:${"b".repeat(64)}`
const snapshotDigest = `sha256:${"c".repeat(64)}`
const dimension = { resource_ref: resourceId, resource_revision_ref: revisionId, test_category: "authorization", conditions: [] }
const cell = { id: cellId, kind: "coverage", trust_level: "L1", engagement_id: engagementId, ...dimension, scope_revision_ref: scopeRevisionId, policy_digest: policyDigest, status: "inconclusive" }

function fixture() {
    let secondDigest = snapshotDigest
    let canClose = false
    const calls: Array<{ operation: string; input: Record<string, unknown>; role: string }> = []
    const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator"> = {
        getBinding() { return { tenantId: "tenant", projectId: "project", engagementId, hostPrincipalId: "host", modelPrincipalId: "model" } },
        async invokeHost(operation, input) {
            calls.push({ operation, input, role: "host" })
            if (operation === "coverage.record") return cell
            if (operation === "coverage.gate") return { can_close: canClose, read_seq: 30, snapshot_digest: snapshotDigest, gaps: [{ kind: "inconclusive" }] }
            return { engagement_id: engagementId, manifest_ref: manifestId, manifest_digest: manifestDigest, scope_revision_ref: scopeRevisionId, policy_digest: policyDigest, cells: [input.cursor ? { ...cell, id: secondCellId } : cell], read_seq: 30, snapshot_id: "snapshot-30", snapshot_digest: input.cursor ? secondDigest : snapshotDigest, complete_domain: true, truncated: false, manifest_binding_verified: true, missing_items_complete: true, expected_cell_count_complete: true, manifest_binding_state: "approved", expected_cell_count: 2, domain_cell_count: 2, missing_items: [], has_more: !input.cursor, ...(input.cursor ? {} : { next_cursor: "signed-page-2" }) }
        },
        async invokeOperator(operation, input) {
            calls.push({ operation, input, role: "operator" })
            return { id: manifestId, engagement_id: engagementId, kind: "coverage_manifest", trust_level: "L1", scope_revision_ref: scopeRevisionId, policy_digest: policyDigest, manifest_digest: manifestDigest, expected_cells: input.expected_cells }
        },
    }
    return { calls, service: new TaricAuthorityCoverageService({ host }), setSecondDigest(value: string) { secondDigest = value }, setCanClose(value: boolean) { canClose = value } }
}

describe("canonical manifest-bound Coverage", () => {
    test("reads inconclusive cells across pinned complete-domain pages and gates the same snapshot", async () => {
        const f = fixture()
        const snapshot = await f.service.snapshot({ manifestId, manifestDigest, pageSize: 1 })
        expect(snapshot.cells.map((item) => item.status)).toEqual(["inconclusive", "inconclusive"])
        expect(snapshot.diagnostics).toMatchObject({ completeDomain: true, visibility: "complete", pages: 2, status: "complete" })
        expect(f.calls[1]!.input).toMatchObject({ cursor: "signed-page-2", as_of: 30, visibility_mode: "complete", include_candidates: true })
        expect(f.calls[2]!.input).toMatchObject({ manifest_ref: manifestId, manifest_digest: manifestDigest, as_of: 30 })
        expect(snapshot.gate.can_close).toBe(false)
    })

    test("rejects a changed snapshot digest between pages", async () => {
        const f = fixture()
        f.setSecondDigest(policyDigest)
        await expect(f.service.snapshot({ manifestId, manifestDigest, pageSize: 1 })).rejects.toMatchObject({ code: "conflict" })
    })

    test("a locally truncated read cannot grant closure", async () => {
        const f = fixture()
        f.setCanClose(true)
        await expect(f.service.snapshot({ manifestId, manifestDigest, pageSize: 1, limits: { maxPages: 1 } })).rejects.toMatchObject({ code: "incomplete_authority_snapshot" })
    })

    test("manifest commits require operator channel and nonempty explicit dimensions", async () => {
        const f = fixture()
        await expect(f.service.commitManifest({ scopeRevisionId, policyDigest, expectedCells: [], idempotencyKey: "empty" })).rejects.toMatchObject({ code: "empty_manifest" })
        expect(f.calls).toHaveLength(0)
        expect((await f.service.commitManifest({ scopeRevisionId, policyDigest, expectedCells: [dimension], idempotencyKey: "manifest" })).id).toBe(manifestId)
        expect(f.calls[0]).toMatchObject({ operation: "coverage.manifest.commit", role: "operator" })
    })

    test("Coverage writes carry exact ScopeRevision and CAS; missing NA reason is refused", async () => {
        const f = fixture()
        await expect(f.service.record({ dimension, scopeRevisionId, policyDigest, status: "not_applicable", expectedVersion: 0, idempotencyKey: "no-reason" })).rejects.toMatchObject({ code: "validation_error" })
        await expect(f.service.record({ dimension, scopeRevisionId, policyDigest, status: "tested_no_observation", expectedVersion: 1, idempotencyKey: "no-cell" })).rejects.toMatchObject({ code: "validation_error" })
        await f.service.record({ dimension, scopeRevisionId, policyDigest, status: "inconclusive", expectedVersion: 1, cellId, idempotencyKey: "cell-update" })
        expect(f.calls[0]!.input).toMatchObject({ cell_id: cellId, expected_version: 1, scope_revision_ref: scopeRevisionId, policy_digest: policyDigest })
    })

    test("response metadata is included in the snapshot byte budget", async () => {
        const f = fixture()
        await expect(f.service.snapshot({ manifestId, manifestDigest, limits: { maxBytes: 100 } })).rejects.toMatchObject({ code: "incomplete_authority_snapshot" })
    })
})
