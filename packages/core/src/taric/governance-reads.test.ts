import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { AuthorizedPentestGovernance } from "./governance"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE } from "./compatibility"
import { createTaricHostModule } from "./host-module"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "./types"
import type { AuthorizedProjectSetup } from "./governance"

const compatibility: TaricCompatibility = {
    ...TARIC_COMPATIBILITY_BASELINE,
    policyDigest: "sha256:policy",
    bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
}

const binding: TaricHostBinding = {
    projectId: "project-authorized",
    tenantId: "tenant-a",
    engagementId: "engagement-a",
    hostPrincipalId: "host-a",
    modelPrincipalId: "model-a",
}

const resourceId = "00000000-0000-4000-8000-000000000001"
const setup: AuthorizedProjectSetup = {
    project: {
        mode: "authorized_pentest",
        tenant_id: "tenant-a",
        engagement_id: "engagement-a",
        taric_engagement_id: "engagement-a",
        scope_revision: 1,
        coverage_manifest_id: "manifest-a",
        memory_mode: "taric_required",
    },
    scope: { allowedTargets: [{ host: "127.0.0.1" }] },
    testWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" },
    manifest: [{ resourceId, revision: 1, testCategories: ["authentication"] }],
    secretReferences: ["secret:local"],
    retentionDays: 30,
    policyDigest: "sha256:policy",
}

function page(operation: string, input: Record<string, unknown>): Record<string, unknown> {
    const cursor = input.cursor
    if (operation === "context.query") return cursor ? { items: [{ id: "context-2" }], read_seq: 7 } : { items: [{ id: "context-1" }], cursor: "context-next", read_seq: 7 }
    if (operation === "work.query") return cursor ? { items: [{ id: "work-2" }], read_seq: 8 } : { items: [{ id: "work-1" }], next_cursor: "work-next", read_seq: 8 }
    if (operation === "resource.query" && input.kind === "work_item") return cursor ? { records: [{ id: "work-2", kind: "work_item", trust_level: "L1", status: "queued" }], read_seq: 8 } : { records: [{ id: "work-1", kind: "work_item", trust_level: "L2", status: "queued" }], next_cursor: "work-next", read_seq: 8 }
    if (operation === "resource.query" && input.kind === "coverage") return cursor ? { records: [{ id: "coverage-2", kind: "coverage", trust_level: "L1", resource_ref: resourceId, test_category: "authentication" }], read_seq: 10 } : { records: [{ id: "coverage-1", kind: "coverage", trust_level: "L2", resource_ref: resourceId, test_category: "authentication" }], next_cursor: "coverage-next", read_seq: 10 }
    if (operation === "resource.query") return cursor ? { records: [{ id: "resource-2" }], read_seq: 9 } : { records: [{ id: "resource-1" }], next_cursor: "resource-next", read_seq: 9 }
    if (operation === "coverage.query") return cursor ? { cells: [{ id: "coverage-2" }], read_seq: 10 } : { cells: [{ id: "coverage-1" }], next_cursor: "coverage-next", read_seq: 10 }
    return cursor ? { proposals: [{ id: "proposal-2" }], read_seq: 11 } : { proposals: [{ id: "proposal-1" }], next_cursor: "proposal-next", read_seq: 11 }
}

describe("authorized governance bounded reads", () => {
    test("routes Context, Work, Resource, Coverage, and proposal reads through the shared reader", async () => {
        const calls: Array<{ operation: string; input: Record<string, unknown> }> = []
        const adapter: TaricServiceAdapter = {
            async getProfile() { return { status: "verified", compatibility } },
            async getBinding() { return binding },
            async invoke(operation, input) {
                calls.push({ operation, input })
                return { ok: true, data: page(operation, input) }
            },
            async close() {},
        }
        const root = await mkdtemp(join("/tmp", "breachweave-governance-reads-"))
        try {
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
            const governance = new AuthorizedPentestGovernance({ host, setup, artifactRoot: root, artifactKey: new Uint8Array(32).fill(4) })

            const context = await governance.readContext({ budget: 1024 })
            const work = await governance.readWork({ status: ["queued"] })
            const resources = await governance.readResources({ kind: "claim" })
            const coverage = await governance.readCoverage({ resourceRef: resourceId, testCategory: "authentication" })
            const proposals = await governance.listProposals({ pageSize: 2 }) as { proposals: Array<{ id: string }>; read_seq: number; diagnostics: { status: string } }

            expect(context.records.map((record) => record.id)).toEqual(["context-1", "context-2"])
            expect(work.records.map((record) => record.id)).toEqual(["work-1", "work-2"])
            expect(resources.records.map((record) => record.id)).toEqual(["resource-1", "resource-2"])
            expect(coverage.records.map((record) => record.id)).toEqual(["coverage-1", "coverage-2"])
            expect(proposals.proposals.map((record) => record.id)).toEqual(["proposal-1", "proposal-2"])
            expect(proposals.read_seq).toBe(11)
            expect(proposals.diagnostics.status).toBe("complete")
            expect(work.diagnostics.status).toBe("complete")
            expect(coverage.diagnostics.status).toBe("unpinned")
            expect(coverage.diagnostics.snapshotPinned).toBe(true)
            expect(coverage.diagnostics).toMatchObject({ visibility: "recall_filtered", completeDomain: false, errorCode: "coverage_recall_filtered" })
            expect(work.diagnostics.completeDomain).toBe(true)
            expect(work.diagnostics.principalId).toBe(binding.hostPrincipalId)
            expect(coverage.diagnostics.principalId).toBe(binding.hostPrincipalId)

            expect(calls).toEqual([
                { operation: "context.query", input: { budget: 1024, include_candidates: false, engagement_id: binding.engagementId } },
                { operation: "context.query", input: { budget: 1024, include_candidates: false, cursor: "context-next", read_seq: 7, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "work_item", include_candidates: true, page_size: 50, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "work_item", include_candidates: true, page_size: 50, cursor: "work-next", as_of: 8, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "claim", page_size: 50, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "claim", page_size: 50, cursor: "resource-next", as_of: 9, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "coverage", include_candidates: true, page_size: 50, engagement_id: binding.engagementId } },
                { operation: "resource.query", input: { kind: "coverage", include_candidates: true, page_size: 50, cursor: "coverage-next", as_of: 10, engagement_id: binding.engagementId } },
                { operation: "proposal.list", input: { page_size: 2, engagement_id: binding.engagementId } },
                { operation: "proposal.list", input: { page_size: 2, cursor: "proposal-next", engagement_id: binding.engagementId } },
            ])
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("accepts shared watermarks for canonical snapshots and keeps active runs explicitly live", async () => {
        const calls: Array<{ operation: string; input: Record<string, unknown>; role: string }> = []
        const adapter: TaricServiceAdapter = {
            async getProfile() { return { status: "verified", compatibility } },
            async getBinding() { return binding },
            async invoke(operation, input, role) {
                calls.push({ operation, input, role: role ?? "model" })
                return { ok: true, data: operation === "work.query" ? { items: [], read_seq: 23 } : { records: [], read_seq: input.as_of } }
            },
            async close() {},
        }
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        const governance = new AuthorizedPentestGovernance({ host, setup, artifactRoot: "/tmp/breachweave-unused-reads", artifactKey: new Uint8Array(32).fill(4) })
        const work = await governance.readWork({}, { readSeq: 17 })
        const coverage = await governance.readCoverage({}, { readSeq: 17 })
        expect(work.readSeq).toBe(17)
        expect(coverage.readSeq).toBe(17)
        expect(work.diagnostics.snapshotPinned).toBe(true)
        expect(coverage.diagnostics.snapshotPinned).toBe(true)
        expect(coverage.diagnostics.completeDomain).toBe(false)
        const live = await governance.readWork({ includeActiveRuns: true })
        expect(live.diagnostics.status).toBe("unpinned")
        expect(live.diagnostics.snapshotPinned).toBe(false)
        await expect(governance.readWork({ includeActiveRuns: true }, { readSeq: 17 })).rejects.toMatchObject({ code: "query_unpinned" })
        await expect(governance.readWork({ resourceRefs: [] })).rejects.toMatchObject({ code: "query_filter" })
        await expect(governance.readWork({ status: ["verified"] })).rejects.toMatchObject({ code: "query_filter" })
        await expect(governance.readWork({ contractVersion: "0.0.0" })).rejects.toMatchObject({ code: "query_contract" })
        await expect(governance.readCoverage({ resourceRef: "caller-title" })).rejects.toMatchObject({ code: "query_filter" })
        await expect(governance.readCoverage({ status: "verified" })).rejects.toMatchObject({ code: "query_filter" })
        expect(calls.every((call) => call.role === "host")).toBe(true)
        expect(calls.map((call) => call.input)).toEqual([
            { kind: "work_item", include_candidates: true, as_of: 17, page_size: 50, engagement_id: binding.engagementId },
            { kind: "coverage", include_candidates: true, as_of: 17, page_size: 50, engagement_id: binding.engagementId },
            { include_active_runs: true, page_size: 50, engagement_id: binding.engagementId },
        ])
        await host.close()
    })

    test("filters only after the raw read and preserves truncation and scan budgets", async () => {
        const adapter: TaricServiceAdapter = {
            async getProfile() { return { status: "verified", compatibility } },
            async getBinding() { return binding },
            async invoke(_operation, input) {
                const kind = input.kind
                const record = { id: input.cursor ? "row-2" : "row-1", kind, trust_level: "L1", resource_ref: resourceId, resource_refs: [resourceId], test_category: input.cursor ? "authentication" : "unrelated", status: input.cursor ? "queued" : "completed" }
                return { ok: true, data: { records: [record], read_seq: 12, ...(input.cursor ? {} : { next_cursor: "second-page" }) } }
            },
            async close() {},
        }
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        const governance = new AuthorizedPentestGovernance({ host, setup, artifactRoot: "/tmp/breachweave-unused-reads", artifactKey: new Uint8Array(32).fill(4) })
        const complete = await governance.readCoverage({ resourceRef: resourceId, testCategory: "authentication" })
        expect(complete.records.map((record) => record.id)).toEqual(["row-2"])
        expect(complete.diagnostics).toMatchObject({ status: "unpinned", pages: 2, records: 2, snapshotPinned: true, visibility: "recall_filtered", completeDomain: false })
        expect(complete.diagnostics.bytes).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(complete.records[0])).byteLength)
        const truncated = await governance.readCoverage({ testCategory: "authentication" }, { limits: { maxRecords: 1 } })
        expect(truncated.records).toEqual([])
        expect(truncated.diagnostics).toMatchObject({ status: "truncated", records: 1, hasMore: true, truncationReason: "max_records" })
        const work = await governance.readWork({ resourceRefs: [resourceId], status: ["queued"] })
        expect(work.records.map((record) => record.id)).toEqual(["row-2"])
        expect(work.diagnostics.records).toBe(2)
        await host.close()
    })

    test("rejects candidate or wrong-kind records instead of treating them as admitted snapshots", async () => {
        let record: Record<string, unknown> = { id: "candidate", kind: "coverage", trust_level: "L0" }
        const adapter: TaricServiceAdapter = {
            async getProfile() { return { status: "verified", compatibility } },
            async getBinding() { return binding },
            async invoke() { return { ok: true, data: { records: [record], read_seq: 12 } } },
            async close() {},
        }
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        const governance = new AuthorizedPentestGovernance({ host, setup, artifactRoot: "/tmp/breachweave-unused-reads", artifactKey: new Uint8Array(32).fill(4) })
        await expect(governance.readCoverage()).rejects.toMatchObject({ code: "query_untrusted_record" })
        record = { id: "model-proposal", kind: "proposal", trust_level: "L1" }
        await expect(governance.readWork()).rejects.toMatchObject({ code: "query_untrusted_record" })
        await host.close()
    })
})
