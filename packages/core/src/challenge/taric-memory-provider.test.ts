import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
    TARIC_BUN_DRIVER_INTEGRITY,
    TARIC_BUN_DRIVER_PACKAGE,
    TARIC_BUN_DRIVER_VERSION,
    TARIC_COMPATIBILITY_BASELINE,
    EncryptedTaricOutbox,
    TaricOperationError,
    createTaricHostModule,
} from "../taric"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "../taric"
import { deriveCompositeProjectKey } from "../project/types"
import { TaricMemoryProvider } from "./taric-memory-provider"

const project = {
    mode: "competition" as const,
    provider: "local_practice" as const,
    tenant_id: "tenant-a",
    platform_id: "platform-a",
    competition_id: "competition-a",
    team_id: "team-a",
    challenge_code: "same-code",
    memory_mode: "taric_best_effort" as const,
    taric_engagement_id: "engagement-a",
}
const projectKey = deriveCompositeProjectKey(project)
const binding: TaricHostBinding = {
    projectId: projectKey,
    tenantId: project.tenant_id,
    engagementId: project.taric_engagement_id,
    hostPrincipalId: "host-a",
    modelPrincipalId: "model-a",
}
const compatibility: TaricCompatibility = {
    ...TARIC_COMPATIBILITY_BASELINE,
    policyDigest: "sha256:policy",
    bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
}

async function createProvider(invoke: TaricServiceAdapter["invoke"], options: { readLimits?: { maxPages?: number; maxRecords?: number; maxBytes?: number } } = {}): Promise<TaricMemoryProvider> {
    const adapter: TaricServiceAdapter = {
        async getProfile() {
            return { status: "verified", compatibility }
        },
        async getBinding() {
            return binding
        },
        invoke,
        async close() {},
    }
    const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
    await host.initialize()
    return new TaricMemoryProvider({ host, mode: "taric_best_effort", ...options })
}

describe("TaricMemoryProvider", () => {
    test("readBoard returns memory and ideas from one authoritative watermark", async () => {
        const calls: string[] = []
        const provider = await createProvider(async (operation) => {
            calls.push(operation)
            if (operation === "proposal.list") {
                return { ok: true, data: { proposals: [{ id: "idea-1", subject_type: "claim", status: "pending", content: { title: `BreachWeave [${projectKey}] idea: inspect upload`, proposition: "inspect upload", evidence_refs: [] } }], read_seq: 12 } }
            }
            return { ok: true, data: { records: [{ id: "memory-1", kind: "claim", engagement_id: project.taric_engagement_id, title: `BreachWeave [${projectKey}] memory (fact): observer`, proposition: "upload parser accepts png", evidence_refs: [] }], read_seq: 12 } }
        })

        const board = await provider.readBoard({ challengeId: "same-code", project, projectKey })

        expect(board.memory.map((item) => item.id)).toEqual(["memory-1"])
        expect(board.ideas.map((item) => item.id)).toEqual(["idea-1"])
        expect(board.diagnostics).toMatchObject({ status: "complete", watermark: 12 })
        expect(calls).toEqual(["proposal.list", "resource.query"])
    })

    test("projects admitted claims and candidate proposals as separate trust states", async () => {
        const provider = await createProvider(async (operation) => {
            if (operation === "resource.query") {
                return {
                    ok: true,
                    data: {
                        records: [
                            { id: "claim-admitted", kind: "claim", engagement_id: project.taric_engagement_id, title: `BreachWeave [${projectKey}] memory (fact): source`, proposition: "Admitted fact", evidence_refs: [], artifact_refs: ["artifact-ref"], created_at: "2026-01-01T00:00:00.000Z" },
                            { id: "claim-foreign-engagement", kind: "claim", engagement_id: "other-engagement", title: `BreachWeave [${projectKey}] memory (fact): foreign`, proposition: "Foreign engagement fact", evidence_refs: [], created_at: "2026-01-01T00:00:00.000Z" },
                            { id: "claim-other-project", kind: "claim", title: "BreachWeave [bwpk_v1_other] memory (fact): source", proposition: "Other team's fact", evidence_refs: [], created_at: "2026-01-01T00:00:00.000Z" },
                        ],
                        next_cursor: undefined,
                        read_seq: 4,
                    },
                }
            }
            if (operation === "proposal.list") {
                return {
                    ok: true,
                    data: {
                        proposals: [
                            { id: "proposal-candidate", subject_type: "claim", status: "pending", content: { title: `BreachWeave [${projectKey}] memory (note): model`, proposition: "Unverified hypothesis", evidence_refs: [] } },
                            { id: "proposal-foreign-engagement", engagement_id: "other-engagement", subject_type: "claim", status: "pending", content: { title: `BreachWeave [${projectKey}] memory (note): foreign`, proposition: "Foreign engagement proposal", evidence_refs: [] } },
                            { id: "proposal-other-project", subject_type: "claim", status: "pending", content: { title: "BreachWeave [bwpk_v1_other] memory (fact): model", proposition: "Other team's proposal", evidence_refs: [] } },
                        ],
                        read_seq: 4,
                    },
                }
            }
            throw new Error(`unexpected operation ${operation}`)
        })

        const entries = await provider.listMemory({ challengeId: "same-code", project, projectKey })
        expect(entries.map(({ id, trustState, content }) => ({ id, trustState, content }))).toEqual([
            { id: "claim-admitted", trustState: "admitted", content: "Admitted fact" },
            { id: "proposal-candidate", trustState: "candidate", content: "Unverified hypothesis" },
        ])
        expect(entries[0]?.refs).toEqual(["artifact-ref"])
    })

    test("follows canonical and candidate keyset cursors, suppresses duplicates, and preserves merge order", async () => {
        const calls: Array<{ operation: string; cursor?: unknown; as_of?: unknown }> = []
        const canonicalRecord = (id: string, content: string) => ({
            id,
            kind: "claim",
            engagement_id: project.taric_engagement_id,
            title: `BreachWeave [${projectKey}] memory (fact): source`,
            proposition: content,
            evidence_refs: [],
        })
        const proposalRecord = (id: string, content: string) => ({
            id,
            subject_type: "claim",
            status: "pending",
            content: {
                title: `BreachWeave [${projectKey}] memory (note): model`,
                proposition: content,
                evidence_refs: [],
            },
        })
        const provider = await createProvider(async (operation, input) => {
            calls.push({ operation, cursor: input.cursor, as_of: input.as_of })
            if (operation === "resource.query") {
                expect(input.as_of).toBe(10)
                if (input.cursor === undefined) return { ok: true, data: { records: [canonicalRecord("canonical-1", "first")], next_cursor: "records-page-2", read_seq: 10 } }
                return { ok: true, data: { records: [canonicalRecord("canonical-1", "duplicate"), canonicalRecord("canonical-2", "second")], read_seq: 10 } }
            }
            if (input.cursor === undefined) return { ok: true, data: { proposals: [proposalRecord("candidate-1", "third")], next_cursor: "proposals-page-2", read_seq: 10 } }
            return { ok: true, data: { proposals: [proposalRecord("candidate-1", "duplicate"), proposalRecord("candidate-2", "fourth")], read_seq: 10 } }
        })

        const entries = await provider.listMemory({ challengeId: "same-code", project, projectKey })
        expect(entries.map((entry) => [entry.id, entry.content])).toEqual([
            ["canonical-1", "first"],
            ["canonical-2", "second"],
            ["candidate-1", "third"],
            ["candidate-2", "fourth"],
        ])
        expect(calls).toEqual([
            { operation: "proposal.list", cursor: undefined, as_of: undefined },
            { operation: "proposal.list", cursor: "proposals-page-2", as_of: undefined },
            { operation: "resource.query", cursor: undefined, as_of: 10 },
            { operation: "resource.query", cursor: "records-page-2", as_of: 10 },
        ])
        expect(provider.getReadDiagnostics()).toMatchObject({
            status: "complete",
            watermark: 10,
            limits: { maxPages: 24, maxRecords: 1000, maxBytes: 4 * 1024 * 1024 },
            totals: { pages: 4, records: 4, duplicatesSuppressed: 2 },
            canonical: { pages: 2, records: 2, duplicatesSuppressed: 1, hasMore: false, readSeq: 10, lastCursor: "records-page-2", continuationSafe: true },
            candidates: { pages: 2, records: 2, duplicatesSuppressed: 1, hasMore: false, readSeq: 10, lastCursor: "proposals-page-2", continuationSafe: true },
        })
    })

    test("rejects a page response that drifts from the pinned combined read watermark", async () => {
        const provider = await createProvider(async (operation) => {
            if (operation === "proposal.list") return { ok: true, data: { proposals: [], read_seq: 10 } }
            return { ok: true, data: { records: [], read_seq: 11 } }
        })

        await expect(provider.listMemory({ challengeId: "same-code", project, projectKey })).rejects.toMatchObject({ code: "conflict" })
        expect(provider.getReadDiagnostics()).toMatchObject({
            status: "failed",
            watermark: 10,
            candidates: { status: "complete", readSeq: 10 },
            canonical: { status: "failed", readSeq: 11, errorCode: "conflict" },
        })
    })

    test("rejects a proposal continuation that changes the cursor-pinned watermark", async () => {
        const provider = await createProvider(async (operation, input) => {
            if (operation === "proposal.list") {
                if (input.cursor === undefined) return { ok: true, data: { proposals: [], next_cursor: "proposal-page-2", read_seq: 10 } }
                return { ok: true, data: { proposals: [], read_seq: 11 } }
            }
            return { ok: true, data: { records: [], read_seq: 10 } }
        })

        await expect(provider.listMemory({ challengeId: "same-code", project, projectKey })).rejects.toMatchObject({ code: "conflict" })
        expect(provider.getReadDiagnostics()).toMatchObject({
            status: "failed",
            watermark: 10,
            candidates: { status: "failed", readSeq: 10, errorCode: "conflict", lastCursor: "proposal-page-2" },
        })
    })

    test("stops on a repeated continuation cursor instead of looping", async () => {
        let calls = 0
        const provider = await createProvider(async (operation) => {
            calls += 1
            if (operation === "resource.query") return { ok: true, data: { records: [], next_cursor: "repeat-me", read_seq: 8 } }
            return { ok: true, data: { proposals: [], read_seq: 8 } }
        })

        await expect(provider.listMemory({ challengeId: "same-code", project, projectKey })).rejects.toMatchObject({ code: "invalid_cursor" })
        expect(calls).toBe(3)
        expect(provider.getReadDiagnostics()).toMatchObject({ status: "failed", canonical: { status: "failed", errorCode: "invalid_cursor", pages: 2 } })
    })

    test("rejects malformed continuation cursors and reports the contract error", async () => {
        const provider = await createProvider(async (operation) => operation === "proposal.list"
            ? { ok: true, data: { proposals: [], read_seq: 8 } }
            : { ok: true, data: { records: [], next_cursor: 42, read_seq: 8 } })

        await expect(provider.listMemory({ challengeId: "same-code", project, projectKey })).rejects.toMatchObject({ code: "invalid_cursor" })
        expect(provider.getReadDiagnostics()).toMatchObject({ status: "failed", canonical: { status: "failed", errorCode: "invalid_cursor", pages: 1 } })
    })

    test("truncates a page sequence at the configured record and byte budgets", async () => {
        const record = {
            id: "canonical-budget",
            kind: "claim",
            engagement_id: project.taric_engagement_id,
            title: `BreachWeave [${projectKey}] memory (fact): source`,
            proposition: "budgeted record",
            evidence_refs: [],
        }
        const recordProvider = await createProvider(async (operation) => {
            if (operation === "resource.query") return { ok: true, data: { records: [record, { ...record, id: "canonical-budget-2" }], next_cursor: "more", read_seq: 9 } }
            return { ok: true, data: { proposals: [], read_seq: 9 } }
        }, { readLimits: { maxRecords: 2 } })

        expect((await recordProvider.listMemory({ challengeId: "same-code", project, projectKey })).map((entry) => entry.id)).toEqual(["canonical-budget"])
        expect(recordProvider.getReadDiagnostics()).toMatchObject({ status: "truncated", canonical: { status: "truncated", records: 1, truncationReason: "max_records", hasMore: true } })

        const byteProvider = await createProvider(async (operation) => {
            if (operation === "resource.query") return { ok: true, data: { records: [record], next_cursor: "more", read_seq: 9 } }
            return { ok: true, data: { proposals: [], read_seq: 9 } }
        }, { readLimits: { maxBytes: 2 } })

        expect(await byteProvider.listMemory({ challengeId: "same-code", project, projectKey })).toEqual([])
        expect(byteProvider.getReadDiagnostics()).toMatchObject({ status: "truncated", canonical: { status: "truncated", records: 0, truncationReason: "max_bytes", hasMore: true } })
    })

    test("truncates when the page budget is exhausted with another cursor available", async () => {
        const provider = await createProvider(async (operation) => {
            if (operation === "resource.query") return { ok: true, data: { records: [], next_cursor: "more", read_seq: 9 } }
            return { ok: true, data: { proposals: [], read_seq: 9 } }
        }, { readLimits: { maxPages: 2 } })

        expect(await provider.listMemory({ challengeId: "same-code", project, projectKey })).toEqual([])
        expect(provider.getReadDiagnostics()).toMatchObject({
            status: "truncated",
            watermark: 9,
            canonical: { status: "truncated", pages: 1, readSeq: 9, nextCursor: "more", continuationSafe: true, truncationReason: "max_pages", hasMore: true },
        })
    })

    test("submits a schema-shaped claim bound to the configured Engagement", async () => {
        const calls: Array<{ operation: string; input: Record<string, unknown> }> = []
        const provider = await createProvider(async (operation, input) => {
            calls.push({ operation, input })
            return { ok: true, data: { id: "proposal-id", status: "pending" } }
        })

        const proposal = await provider.appendMemory({ challengeId: "same-code", project, projectKey }, {
            kind: "fact",
            content: "A proposed observation",
            source: "solver",
        })

        expect(proposal.trustState).toBe("candidate")
        expect(calls).toHaveLength(1)
        expect(calls[0].operation).toBe("proposal.submit")
        expect(calls[0].input).toMatchObject({
            engagement_id: project.taric_engagement_id,
            subject_type: "claim",
            expected_version: 0,
            content: {
                schema_version: "1.0.0",
                engagement_id: project.taric_engagement_id,
                created_at: expect.any(String),
                kind: "claim",
                proposition: "A proposed observation",
                status: "proposed",
                evidence_refs: [],
                limitations: ["BreachWeave model or operator proposal; not an admitted fact."],
            },
        })
        expect(calls[0].input.client_request_id).toMatch(/^[0-9a-f-]{36}$/i)
    })

    test("captures host observations with host-owned provenance and stable event identity", async () => {
        const calls: Array<{ operation: string; input: Record<string, unknown> }> = []
        const provider = await createProvider(async (operation, input) => {
            calls.push({ operation, input })
            return { ok: true, data: { id: "observation-id" } }
        })

        await provider.captureObservation({ challengeId: "same-code", project, projectKey }, {
            eventId: "host-event-1",
            sourceKind: "platform_result",
            observation: {
                resource_ref: "00000000-0000-4000-8000-000000000001",
                observed_at: "2026-10-25T00:00:00.000Z",
                statement: "platform returned 200",
                artifact_refs: [{ host_ref: "breachweave://artifacts/committed/1", content_hash: `sha256:${"a".repeat(64)}`, content_status: "available", integrity_status: "verified" }],
            },
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].operation).toBe("capture.observation")
        expect(calls[0].input).toMatchObject({
            observation: {
                kind: "observation",
                engagement_id: project.taric_engagement_id,
                resource_ref: "00000000-0000-4000-8000-000000000001",
                observed_at: "2026-10-25T00:00:00.000Z",
                artifact_refs: [{ host_ref: "breachweave://artifacts/committed/1", content_hash: `sha256:${"a".repeat(64)}`, content_status: "available", integrity_status: "verified" }],
                provenance: {
                    host_id: binding.hostPrincipalId,
                    producer_id: binding.hostPrincipalId,
                    source_kind: "host",
                    dispatch_id: expect.stringMatching(/^bw-origin:report:[a-f0-9]{64}$/),
                },
            },
            client_request_id: "host-event-1",
            idempotency_key: "host-event-1",
        })
    })

    test("keeps an ambiguous non-idempotent capture indeterminate and never retries the same event id", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-capture-"))
        try {
            let sends = 0
            let available = true
            const adapter: TaricServiceAdapter = {
                async getProfile() { return { status: "verified", compatibility } },
                async getBinding() { return binding },
                async checkHealth() { if (!available) throw new Error("mock transport unavailable") },
                async invoke(operation) {
                    if (operation === "capture.observation") {
                        sends += 1
                        available = false
                        throw new Error("connection lost after dispatch")
                    }
                    return { ok: true, data: {} }
                },
                async close() {},
            }
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(8) })
            const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
            const input = { eventId: "capture-uncertain-1", sourceKind: "host_event" as const, observation: { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: "2026-10-25T00:00:00.000Z", statement: "Target returned HTTP 200", artifact_refs: [] } }
            await expect(provider.captureObservation({ challengeId: "same-code", project, projectKey }, input)).resolves.toMatchObject({ outcome: "indeterminate" })
            await expect(provider.captureObservation({ challengeId: "same-code", project, projectKey }, input)).resolves.toMatchObject({ outcome: "indeterminate" })
            expect(sends).toBe(1)
            expect((await outbox.list())[0]?.status).toBe("indeterminate")

            available = true
            await expect(provider.replayOutbox()).resolves.toEqual({ replayed: 0, conflicts: 0 })
            expect(sends).toBe(1)
            expect((await outbox.list())[0]?.status).toBe("indeterminate")
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("queues a capture when the mock transport is unavailable before dispatch", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-capture-before-send-"))
        try {
            let healthChecks = 0
            let sends = 0
            const adapter: TaricServiceAdapter = {
                async getProfile() { return { status: "verified", compatibility } },
                async getBinding() { return binding },
                async checkHealth() {
                    healthChecks += 1
                    if (healthChecks === 1) throw new Error("mock transport unavailable before dispatch")
                },
                async invoke() {
                    sends += 1
                    return { ok: true, data: { id: "unexpected" } }
                },
                async close() {},
            }
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(6) })
            const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
            const input = {
                eventId: "capture-before-send-1",
                sourceKind: "host_event" as const,
                observation: {
                    resource_ref: "00000000-0000-4000-8000-000000000001",
                    observed_at: "2026-10-25T00:00:00.000Z",
                    statement: "Mocked host observation",
                    artifact_refs: [],
                },
            }

            await expect(provider.captureObservation({ challengeId: "same-code", project, projectKey }, input)).resolves.toMatchObject({ outcome: "deferred", eventId: input.eventId })
            await expect(provider.captureObservation({ challengeId: "same-code", project, projectKey }, input)).resolves.toMatchObject({ outcome: "deferred", eventId: input.eventId })
            expect(sends).toBe(0)
            expect(await outbox.pending(projectKey)).toHaveLength(1)
            expect((await outbox.list())[0]).toMatchObject({ eventId: input.eventId, projectId: projectKey, status: "pending" })
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("does not queue permanent schema or authorization failures", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-capture-permanent-error-"))
        try {
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(5) })
            const codes = ["validation_error", "authorization_error"] as const
            for (const code of codes) {
                let sends = 0
                const adapter: TaricServiceAdapter = {
                    async getProfile() { return { status: "verified", compatibility } },
                    async getBinding() { return binding },
                    async invoke(operation) {
                        if (operation === "capture.observation") sends += 1
                        return { ok: false, error: { code, message: `mock permanent ${code}` } }
                    },
                    async close() {},
                }
                const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
                const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
                const eventId = `capture-permanent-${code}`
                await expect(provider.captureObservation({ challengeId: "same-code", project, projectKey }, {
                    eventId,
                    sourceKind: "host_event",
                    observation: {
                        resource_ref: "00000000-0000-4000-8000-000000000001",
                        observed_at: "2026-10-25T00:00:00.000Z",
                        statement: "Mocked host observation",
                        artifact_refs: [],
                    },
                })).rejects.toMatchObject({ code })
                expect(sends).toBe(1)
                expect(await outbox.list()).toHaveLength(0)
            }
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("rejects cross-project scope and non-record evidence references", async () => {
        const provider = await createProvider(async () => ({ ok: true, data: {} }))
        const otherProject = { ...project, team_id: "team-b" }
        await expect(provider.listMemory({ challengeId: "same-code", project: otherProject, projectKey: deriveCompositeProjectKey(otherProject) })).rejects.toThrow("does not match")
        const wrongEngagement = { ...project, taric_engagement_id: "other-engagement" }
        await expect(provider.listMemory({ challengeId: "same-code", project: wrongEngagement, projectKey })).rejects.toThrow("tenant or Engagement")
        await expect(provider.appendMemory({ challengeId: "same-code", project, projectKey }, {
            kind: "evidence",
            content: "A claim",
            source: "solver",
            refs: ["artifact-name"],
        })).rejects.toThrow("UUID references")
    })

    test("does not treat operation validation errors as outages", async () => {
        const provider = await createProvider(async () => ({ ok: false, error: { code: "validation_error", message: "invalid candidate" } }))
        await expect(provider.appendMemory({ challengeId: "same-code", project, projectKey }, {
            kind: "fact",
            content: "Valid text",
            source: "solver",
        })).rejects.toBeInstanceOf(TaricOperationError)
    })

    test("replays queued writes before later reads once the authority recovers", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-provider-"))
        try {
            let available = false
            const calls: Array<{ operation: string; input: Record<string, unknown> }> = []
            const adapter: TaricServiceAdapter = {
                async getProfile() {
                    return { status: "verified", compatibility }
                },
                async getBinding() {
                    return binding
                },
                async invoke(operation, input) {
                    calls.push({ operation, input })
                    if (operation === "proposal.submit" && !available) {
                        return { ok: false, error: { code: "unavailable_host", message: "authority offline" } }
                    }
                    if (operation === "resource.query") return { ok: true, data: { records: [], read_seq: 1 } }
                    if (operation === "proposal.list") return { ok: true, data: { proposals: [], read_seq: 1 } }
                    return { ok: true, data: { id: "proposal-accepted" } }
                },
                async close() {},
            }
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(7) })
            const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
            const scope = { challengeId: "same-code", project, projectKey }
            const candidate = await provider.appendMemory(scope, { kind: "fact", content: "deferred fact", source: "solver" })
            const [queued] = await outbox.pending(projectKey)
            expect(candidate.trustState).toBe("candidate")
            expect(queued).toBeDefined()
            expect(queued).toMatchObject({ operation: "proposal.submit", idempotencyKey: queued.eventId })

            available = true
            expect(await provider.listMemory(scope)).toEqual([])
            expect(await outbox.pending(projectKey)).toHaveLength(0)
            const submissions = calls.filter(({ operation }) => operation === "proposal.submit")
            expect(submissions).toHaveLength(2)
            expect(submissions[0].input.client_request_id).toBe(queued.eventId)
            expect(submissions[1].input.client_request_id).toBe(queued.eventId)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("does not manufacture an authority watermark from a local outbox sequence", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-watermark-"))
        try {
            let online = false
            const adapter: TaricServiceAdapter = {
                async getProfile() { return { status: "verified", compatibility } },
                async getBinding() { return binding },
                async checkHealth() { if (!online) throw new Error("fixture offline") },
                async invoke(operation) {
                    if (operation === "resource.query") return { ok: true, data: { records: [] } }
                    return { ok: true, data: { id: "accepted-without-watermark" } }
                },
                async close() {},
            }
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(4) })
            const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
            await provider.appendMemory({ challengeId: "same-code", project, projectKey }, { kind: "fact", content: "candidate fixture", source: "solver" })
            online = true
            expect(await provider.replayOutbox()).toEqual({ replayed: 0, conflicts: 0 })
            expect((await outbox.list())[0]?.status).toBe("indeterminate")
            expect(await outbox.confirmedReadSeq(projectKey)).toBe(0)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("replays an outbox proposal with the original stable request payload", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-provider-idempotency-"))
        try {
            let online = false
            const calls: Array<Record<string, unknown>> = []
            const adapter: TaricServiceAdapter = {
                async getProfile() { return { status: "verified", compatibility } },
                async getBinding() { return binding },
                async checkHealth() { if (!online) throw new Error("authority offline") },
                async invoke(operation, input) {
                    if (operation === "resource.query") return { ok: true, data: { records: [], read_seq: 1 } }
                    if (operation === "proposal.list") return { ok: true, data: { proposals: [], read_seq: 1 } }
                    calls.push(input)
                    return { ok: true, data: { id: "proposal-replayed" } }
                },
                async close() {},
            }
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(3) })
            const provider = new TaricMemoryProvider({ host, mode: "taric_best_effort", outbox })
            const scope = { challengeId: "same-code", project, projectKey }
            await provider.appendMemory(scope, { kind: "fact", content: "deferred", source: "solver" })
            const stored = await outbox.list<{ content: Record<string, unknown> }>()
            const originalContent = stored[0]?.payload.content
            expect(originalContent?.created_at).toEqual(expect.any(String))

            online = true
            await provider.replayOutbox()
            expect(calls).toHaveLength(1)
            expect(calls[0]?.content).toEqual(originalContent)
            expect(calls[0]?.idempotency_key).toBe(stored[0]?.eventId)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
