import { describe, expect, test } from "bun:test"
import { TaricOperationError } from "./types"
import { readGovernancePages } from "./governance-query-reader"
import type { GovernanceQueryDiagnostics, GovernanceQueryLimits } from "./governance-query-reader"

const limits: GovernanceQueryLimits = { maxPages: 8, maxRecords: 100, maxBytes: 16_384 }

function binding(filters: Record<string, unknown> = {}, readSeq?: number) {
    return {
        principalId: "principal-a",
        engagementId: "engagement-a",
        filters,
        pageSize: 2,
        ...(readSeq === undefined ? {} : { readSeq }),
    }
}

describe("readGovernancePages", () => {
    test("pins Resource pages with the supported as_of field and keeps authority order", async () => {
        const calls: Array<Record<string, unknown>> = []
        const result = await readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding({ kind: "claim" }),
            limits,
            pageKey: "records",
            readSeqInput: "as_of",
            query: async (input) => {
                calls.push(input)
                if (!input.cursor) return { records: [{ id: "a" }, { id: "b" }], next_cursor: "page-2", read_seq: 19 }
                return { records: [{ id: "c" }], read_seq: 19 }
            },
        })

        expect(result.records.map((record) => record.id)).toEqual(["a", "b", "c"])
        expect(result.readSeq).toBe(19)
        expect(calls).toEqual([
            { kind: "claim", page_size: 2 },
            { kind: "claim", page_size: 2, cursor: "page-2", as_of: 19 },
        ])
        expect(result.diagnostics).toMatchObject({ kind: "resource", status: "complete", pages: 2, records: 3, readSeq: 19, hasMore: false, continuationSafe: true })
    })

    test("uses Context's cursor/read_seq contract without inventing page_size", async () => {
        const calls: Array<Record<string, unknown>> = []
        const result = await readGovernancePages({
            kind: "context",
            snapshotPinned: true,
            binding: binding({ budget: 1024, filters: { kind: "work_item" } }),
            limits,
            pageKey: "items",
            cursorKey: "cursor",
            pageSizeInput: false,
            readSeqInput: "read_seq",
            query: async (input) => {
                calls.push(input)
                if (!input.cursor) return { items: [{ id: "work-1" }], cursor: "context-next", read_seq: 22 }
                return { items: [{ id: "work-2" }], read_seq: 22 }
            },
        })

        expect(result.records.map((record) => record.id)).toEqual(["work-1", "work-2"])
        expect(calls).toEqual([
            { budget: 1024, filters: { kind: "work_item" } },
            { budget: 1024, filters: { kind: "work_item" }, cursor: "context-next", read_seq: 22 },
        ])
    })

    test.each([
        ["work", "items"],
        ["coverage", "cells"],
        ["proposal", "proposals"],
    ] as const)("follows %s cursors without inventing a read_seq request field", async (kind, pageKey) => {
        const calls: Array<Record<string, unknown>> = []
        const filters = kind === "work" ? { status: ["queued"] } : kind === "coverage" ? { test_category: "authz" } : {}
        const result = await readGovernancePages({
            kind,
            snapshotPinned: kind !== "coverage",
            binding: binding(filters),
            limits,
            pageKey,
            query: async (input) => {
                calls.push(input)
                if (!input.cursor) return { [pageKey]: [{ id: "a" }], next_cursor: `${kind}-next`, read_seq: 30 }
                return { [pageKey]: [{ id: "b" }], read_seq: 30 }
            },
        })

        expect(result.records.map((record) => record.id)).toEqual(["a", "b"])
        expect(calls).toEqual([
            { ...filters, page_size: 2 },
            { ...filters, page_size: 2, cursor: `${kind}-next` },
        ])
        expect(result.readSeq).toBe(30)
        expect(result.diagnostics.snapshotPinned).toBe(kind !== "coverage")
        if (kind === "coverage") expect(result.diagnostics.status).toBe("unpinned")
    })

    test("reports record and byte truncation without an unsafe continuation cursor", async () => {
        const recordLimited = await readGovernancePages({
            kind: "work",
            snapshotPinned: true,
            binding: binding(),
            limits: { ...limits, maxRecords: 1 },
            pageKey: "items",
            query: async () => ({ items: [{ id: "a" }, { id: "b" }], next_cursor: "after-page", read_seq: 9 }),
        })
        expect(recordLimited.records.map((record) => record.id)).toEqual(["a"])
        expect(recordLimited).not.toHaveProperty("nextCursor")
        expect(recordLimited.diagnostics).toMatchObject({ status: "truncated", truncationReason: "max_records", hasMore: true, continuationSafe: false })

        const byteLimited = await readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding(),
            limits: { ...limits, maxBytes: 10 },
            pageKey: "records",
            query: async () => ({ records: [{ id: "too-large", body: "x".repeat(64) }], next_cursor: "after-page", read_seq: 9 }),
        })
        expect(byteLimited.records).toEqual([])
        expect(byteLimited).not.toHaveProperty("nextCursor")
        expect(byteLimited.diagnostics).toMatchObject({ status: "truncated", truncationReason: "max_bytes", hasMore: true, continuationSafe: false })
    })

    test("returns a safe page-boundary cursor when the page budget is exhausted", async () => {
        const result = await readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding(),
            limits: { ...limits, maxPages: 1 },
            pageKey: "records",
            query: async () => ({ records: [{ id: "cell-1" }], next_cursor: "page-2", read_seq: 5 }),
        })
        expect(result.nextCursor).toBe("page-2")
        expect(result.continuation).toEqual({ cursor: "page-2", readSeq: 5, bindingDigest: result.diagnostics.bindingDigest })
        expect(result.diagnostics).toMatchObject({ status: "truncated", truncationReason: "max_pages", hasMore: true, continuationSafe: true })
        const resumedCalls: Array<Record<string, unknown>> = []
        const resumed = await readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding(),
            limits: { ...limits, maxPages: 1 },
            pageKey: "records",
            readSeqInput: "as_of",
            continuation: result.continuation,
            query: async (input) => {
                resumedCalls.push(input)
                return { records: [{ id: "cell-2" }], read_seq: 5 }
            },
        })
        expect(resumedCalls).toEqual([{ page_size: 2, cursor: "page-2", as_of: 5 }])
        expect(resumed.readSeq).toBe(5)
    })

    test("captures cursor expiry as a reconnect diagnostic and binds filters and limits", async () => {
        let observed: GovernanceQueryDiagnostics | undefined
        const initial = await readGovernancePages({
            kind: "proposal",
            snapshotPinned: true,
            binding: binding({}),
            limits: { ...limits, maxPages: 1 },
            pageKey: "proposals",
            query: async () => ({ proposals: [], next_cursor: "expired-cursor", read_seq: 3 }),
        })
        await expect(readGovernancePages({
            kind: "proposal",
            snapshotPinned: true,
            binding: binding({}),
            limits: { ...limits, maxPages: 1 },
            pageKey: "proposals",
            continuation: initial.continuation,
            query: async () => { throw new TaricOperationError("invalid_cursor", "continuation cursor expired") },
            onDiagnostics: (diagnostics) => { observed = diagnostics },
        })).rejects.toMatchObject({ code: "invalid_cursor" })
        expect(observed).toMatchObject({ status: "failed", errorCode: "invalid_cursor", reconnectRequired: true, continuationSafe: false, lastCursor: "expired-cursor" })
        await expect(readGovernancePages({
            kind: "proposal",
            snapshotPinned: true,
            binding: binding({ status: "pending" }),
            limits: { ...limits, maxPages: 1 },
            pageKey: "proposals",
            continuation: initial.continuation,
            query: async () => ({ proposals: [], read_seq: 3 }),
        })).rejects.toMatchObject({ code: "invalid_cursor" })

        const base = await readGovernancePages({ kind: "resource", snapshotPinned: true, binding: binding({ kind: "claim" }), limits, pageKey: "records", query: async () => ({ records: [], read_seq: 1 }) })
        const otherPrincipal = await readGovernancePages({ kind: "resource", snapshotPinned: true, binding: { ...binding({ kind: "claim" }), principalId: "principal-b" }, limits, pageKey: "records", query: async () => ({ records: [], read_seq: 1 }) })
        const otherFilter = await readGovernancePages({ kind: "resource", snapshotPinned: true, binding: binding({ kind: "resource" }), limits, pageKey: "records", query: async () => ({ records: [], read_seq: 1 }) })
        expect(base.diagnostics.filterDigest).not.toBe(otherFilter.diagnostics.filterDigest)
        expect(base.diagnostics.bindingDigest).not.toBe(otherPrincipal.diagnostics.bindingDigest)
        expect(base.diagnostics.bindingDigest).not.toBe(otherFilter.diagnostics.bindingDigest)
    })

    test("rejects watermark drift, repeated cursors, and out-of-order pages", async () => {
        await expect(readGovernancePages({
            kind: "proposal",
            snapshotPinned: true,
            binding: binding(),
            limits,
            pageKey: "proposals",
            query: async (input) => input.cursor
                ? { proposals: [{ id: "b" }], read_seq: 2 }
                : { proposals: [{ id: "a" }], next_cursor: "next", read_seq: 1 },
        })).rejects.toMatchObject({ code: "conflict" })

        await expect(readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding(),
            limits,
            pageKey: "records",
            query: async () => ({ records: [], next_cursor: "repeat", read_seq: 1 }),
        })).rejects.toMatchObject({ code: "invalid_cursor" })

        await expect(readGovernancePages({
            kind: "resource",
            snapshotPinned: true,
            binding: binding(),
            limits,
            pageKey: "records",
            query: async (input) => input.cursor
                ? { records: [{ id: "a" }], read_seq: 2 }
                : { records: [{ id: "b" }], next_cursor: "next", read_seq: 2 },
        })).rejects.toMatchObject({ code: "conflict" })

        await expect(readGovernancePages({
            kind: "work",
            snapshotPinned: true,
            binding: binding(),
            limits,
            pageKey: "items",
            query: async () => ({ items: [{ id: "foreign", engagement_id: "engagement-b" }], read_seq: 2 }),
        })).rejects.toMatchObject({ code: "authorization_error" })

        await expect(readGovernancePages({
            kind: "work",
            snapshotPinned: true,
            binding: binding(),
            limits,
            pageKey: "items",
            query: async () => ({ items: [{ id: "a" }], has_more: true, read_seq: 2 }),
        })).rejects.toMatchObject({ code: "invalid_cursor" })
    })
})
