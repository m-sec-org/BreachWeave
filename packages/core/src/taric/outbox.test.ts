import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { EncryptedTaricOutbox, TaricOutboxError, TaricSubscriptionRecovery } from "./outbox"

describe("encrypted Taric outbox", () => {
    test("stores encrypted append-only events and keeps duplicate event identity bound to the first payload", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-"))
        try {
            const path = join(dir, "events.jsonl")
            const outbox = new EncryptedTaricOutbox({ path, key: new Uint8Array(32).fill(7), maxEvents: 2 })
            const event = await outbox.append({ eventId: "event-1", projectId: "project-1", payload: { content: "secret observation" } })
            expect(event.status).toBe("pending")
            expect(await outbox.append({ eventId: "event-1", projectId: "project-1", payload: { content: "ignored" } })).toEqual(event)
            expect(await outbox.list()).toHaveLength(1)
            expect((await outbox.list())[0]?.payload).toEqual({ content: "secret observation" })
            await outbox.markReplayed("event-1", { accepted: true })
            expect((await outbox.list())[0]).toMatchObject({ eventId: "event-1", status: "replayed" })
            expect(await readFile(path, "utf8")).not.toContain("secret observation")
            await outbox.append({ eventId: "event-2", projectId: "project-1", payload: {} })
            await expect(outbox.append({ eventId: "event-3", projectId: "project-1", payload: {} })).rejects.toMatchObject({ code: "TARIC_OUTBOX_FULL" })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("requires a host encryption key and rejects event rebinding", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-"))
        try {
            const path = join(dir, "events.jsonl")
            const missingKey = new EncryptedTaricOutbox({ path })
            await expect(missingKey.list()).rejects.toBeInstanceOf(TaricOutboxError)
            const outbox = new EncryptedTaricOutbox({ path, key: new Uint8Array(32).fill(1) })
            await outbox.append({ eventId: "event-1", projectId: "project-1", payload: {} })
            await expect(outbox.append({ eventId: "event-1", projectId: "project-2", payload: {} })).rejects.toMatchObject({ code: "TARIC_OUTBOX_CONFLICT" })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("replays events in sequence, preserves results, and stops at a conflict", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-replay-"))
        try {
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "events.jsonl"), key: new Uint8Array(32).fill(8) })
            await outbox.append({ eventId: "event-1", projectId: "project-1", payload: { n: 1 } })
            await outbox.append({ eventId: "event-2", projectId: "project-1", payload: { n: 2 } })
            await outbox.append({ eventId: "event-3", projectId: "project-1", payload: { n: 3 } })

            const calls: string[] = []
            let secondPass = false
            const first = await outbox.replayOrdered({
                projectId: "project-1",
                apply: async (event) => {
                    calls.push(event.eventId)
                    if (event.eventId === "event-2") throw Object.assign(new Error("stale version"), { code: "stale_version" })
                    return { result: { accepted: true, eventId: event.eventId }, readSeq: event.sequence }
                },
            })
            expect(first).toMatchObject({ replayed: 1, conflicts: 1, stopped: true, watermark: 1 })
            expect(calls).toEqual(["event-1", "event-2"])
            expect(await outbox.pending("project-1")).toHaveLength(1)

            const second = await outbox.replayOrdered({
                projectId: "project-1",
                apply: async (event) => {
                    secondPass = true
                    expect(event.eventId).toBe("event-3")
                    return { result: { accepted: true }, readSeq: 3 }
                },
            })
            expect(secondPass).toBe(false)
            expect(second.results).toEqual(expect.arrayContaining([
                expect.objectContaining({ eventId: "event-1", status: "replayed", result: { accepted: true, eventId: "event-1" } }),
                expect.objectContaining({ eventId: "event-2", status: "conflict" }),
            ]))
            expect(second.stopped).toBe(true)
            expect(await outbox.pending("project-1")).toHaveLength(1)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("preserves an ambiguous non-idempotent capture without replaying it", async () => {
        const path = join(await mkdtemp(join(tmpdir(), "taric-outbox-indeterminate-")), "outbox.jsonl")
        const outbox = new EncryptedTaricOutbox({ path, key: new Uint8Array(32).fill(9) })
        await outbox.append({ eventId: "capture-1", projectId: "project-1", payload: { operation: "capture.observation", observation: { resource_ref: "resource" } } })
        await outbox.markIndeterminate("capture-1", "timeout after dispatch")
        let applied = 0
        const summary = await outbox.replayOrdered({ projectId: "project-1", apply: async () => { applied += 1; return { result: true, readSeq: 1 } } })
        expect(applied).toBe(0)
        expect(summary.stopped).toBe(true)
        expect((await outbox.list())[0]?.status).toBe("indeterminate")
    })

    test("returns the original authority result on duplicate replay without invoking Taric again", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-idempotency-"))
        try {
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "events.jsonl"), key: new Uint8Array(32).fill(9) })
            await outbox.append({ eventId: "event-1", projectId: "project-1", payload: { content: "candidate" } })
            let calls = 0
            const apply = async () => {
                calls += 1
                return { result: { authorityId: "fact-1" }, readSeq: 7 }
            }
            const first = await outbox.replayOrdered({ projectId: "project-1", apply })
            const second = await outbox.replayOrdered({ projectId: "project-1", apply })
            expect(calls).toBe(1)
            expect(first.results).toEqual([{ eventId: "event-1", status: "replayed", result: { authorityId: "fact-1" }, readSeq: 7 }])
            expect(second.results).toEqual(first.results)
            expect(second.watermark).toBe(7)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("coalesces duplicate and reconnect signals and advances only on confirmed read_seq", async () => {
        const requests: Array<{ afterReadSeq: number; reason: string }> = []
        let release: (() => void) | undefined
        let queryCount = 0
        const recovery = new TaricSubscriptionRecovery({
            projectId: "project-1",
            initialReadSeq: 4,
            query: async (request) => {
                requests.push({ afterReadSeq: request.afterReadSeq, reason: request.reason })
                queryCount += 1
                if (queryCount === 1) await new Promise<void>((resolve) => { release = resolve })
                return { records: [{ seq: queryCount }], readSeq: queryCount === 1 ? 5 : 6 }
            },
        })

        const first = recovery.notify("signal")
        const duplicate = recovery.notify("reconnect")
        release?.()
        await Promise.all([first, duplicate])
        expect(requests).toEqual([
            { afterReadSeq: 4, reason: "signal" },
            { afterReadSeq: 5, reason: "reconnect" },
        ])
        expect(recovery.snapshot()).toMatchObject({ state: "healthy", confirmedReadSeq: 6 })
        await recovery.close()
        await expect(recovery.notify("manual")).rejects.toThrow("closed")
    })

    test("does not accept a backwards authority watermark", async () => {
        const recovery = new TaricSubscriptionRecovery({
            projectId: "project-1",
            initialReadSeq: 10,
            query: async () => ({ records: [], readSeq: 9 }),
        })
        await expect(recovery.notify("slow_consumer")).rejects.toThrow("moved backwards")
        expect(recovery.snapshot()).toMatchObject({ state: "degraded", confirmedReadSeq: 10 })
    })

    test("uses the pinned operation policy for bounded retries and blocks ambiguous non-idempotent writes", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-policy-"))
        try {
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "events.jsonl"), key: new Uint8Array(32).fill(3), configurationSecrets: ["gateway-token"] })
            await expect(outbox.append({ eventId: "artifact-1", projectId: "project-1", operation: "artifact.store.append", idempotencyKey: "artifact-1", payload: { operation: "artifact.store.append", data: "opaque" } })).rejects.toMatchObject({ code: "TARIC_OUTBOX_VALIDATION" })
            await expect(outbox.append({ eventId: "secret-1", projectId: "project-1", payload: { operation: "proposal.submit", token: "gateway-token" } })).rejects.toMatchObject({ code: "TARIC_OUTBOX_VALIDATION" })

            await outbox.append({ eventId: "capture-1", projectId: "project-1", operation: "capture.observation", idempotencyKey: "capture-1", payload: { operation: "capture.observation", observation: { resource_ref: "resource" } } })
            let calls = 0
            const first = await outbox.replayOrdered({ projectId: "project-1", apply: async () => {
                calls += 1
                throw Object.assign(new Error("timeout after dispatch"), { code: "timeout" })
            } })
            expect(calls).toBe(1)
            expect(first.results[0]).toMatchObject({ status: "indeterminate" })
            expect((await outbox.list())[0]).toMatchObject({ status: "indeterminate", automaticRetryBlocked: true, dispatchState: "after_dispatch" })
            const second = await outbox.replayOrdered({ projectId: "project-1", apply: async () => { calls += 1; return { result: true, readSeq: 1 } } })
            expect(calls).toBe(1)
            expect(second.stopped).toBe(true)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("rejects secret-bearing checkpoints and log values and redacts private keys from outbox diagnostics", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-secret-scan-"))
        try {
            const path = join(dir, "events.jsonl")
            const outbox = new EncryptedTaricOutbox({ path, key: new Uint8Array(32).fill(5) })
            const tlsPrivateKey = "-----BEGIN PRIVATE KEY-----\nfixture-tls-private-key-bytes\n-----END PRIVATE KEY-----"
            const cases: Array<{ eventId: string; payload: Record<string, unknown> }> = [
                { eventId: "checkpoint-cookie", payload: { operation: "checkpoint.commit", checkpoint: { next_steps: ["cookie=fixture-cookie-bytes"] } } },
                { eventId: "log-db-url", payload: { operation: "error.report", message: "postgres://fixture:database-password@db.invalid/app" } },
                { eventId: "registry-key", payload: { operation: "proposal.submit", metadata: { registry_key: "fixture-registry-key-bytes" } } },
                { eventId: "private-key", payload: { operation: "proposal.submit", details: tlsPrivateKey } },
            ]
            for (const item of cases) {
                await expect(outbox.append({ ...item, projectId: "project-1" })).rejects.toMatchObject({ code: "TARIC_OUTBOX_VALIDATION" })
            }
            await outbox.append({ eventId: "safe-event", projectId: "project-1", payload: { operation: "capture.observation", observation: { resource_ref: "resource" } } })
            await outbox.markIndeterminate("safe-event", `authority returned api_key=fixture-api-key ${tlsPrivateKey}`)
            expect(JSON.stringify(await outbox.list())).not.toContain("fixture-tls-private-key-bytes")
            expect(JSON.stringify(await outbox.list())).not.toContain("fixture-api-key")
            expect(await Bun.file(path).text()).not.toContain("fixture-tls-private-key-bytes")
            expect(await Bun.file(path).text()).not.toContain("fixture-api-key")
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("retries a declared idempotent operation once with the same bound key", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-idempotent-retry-"))
        try {
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "events.jsonl"), key: new Uint8Array(32).fill(4) })
            await outbox.append({ eventId: "commit-1", projectId: "project-1", operation: "artifact.store.commit", idempotencyKey: "same-commit-key", payload: { operation: "artifact.store.commit", upload_id: "upload-1" } })
            const keys: Array<string | undefined> = []
            const summary = await outbox.replayOrdered({ apply: async (event) => {
                keys.push(event.idempotencyKey)
                if (keys.length === 1) throw Object.assign(new Error("lost acknowledgement"), { code: "timeout", dispatchState: "after_dispatch" })
                return { result: { content_ref: "fixture-artifact@v1" }, readSeq: 8 }
            } })
            expect(keys).toEqual(["same-commit-key", "same-commit-key"])
            expect(summary).toMatchObject({ replayed: 1, stopped: false, watermark: 8 })
            expect((await outbox.list())[0]).toMatchObject({ status: "replayed", attempts: 2 })
            await expect(outbox.append({ eventId: "commit-1", projectId: "project-1", operation: "artifact.store.commit", idempotencyKey: "different-key", payload: {} })).rejects.toMatchObject({ code: "TARIC_OUTBOX_CONFLICT" })
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("allows one pre-dispatch retry and persists retry exhaustion across restart", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-predispatch-"))
        try {
            const options = { path: join(dir, "events.jsonl"), key: new Uint8Array(32).fill(5) }
            const outbox = new EncryptedTaricOutbox(options)
            await outbox.append({ eventId: "capture-1", projectId: "project-1", operation: "capture.observation", payload: { operation: "capture.observation" } })
            let calls = 0
            const summary = await outbox.replayOrdered({ apply: async () => {
                calls += 1
                throw Object.assign(new Error("connection refused"), { code: "transport_error", dispatchState: "pre_dispatch" })
            } })
            expect(calls).toBe(2)
            expect(summary.results[0]?.status).toBe("deferred")
            expect((await outbox.list())[0]).toMatchObject({ status: "deferred", dispatchState: "pre_dispatch", preDispatchRetries: 2, automaticRetryBlocked: true })
            await new EncryptedTaricOutbox(options).replayOrdered({ apply: async () => { calls += 1; return { result: true, readSeq: 1 } } })
            expect(calls).toBe(2)
        } finally { await rm(dir, { recursive: true, force: true }) }
    })

    test("records bounded validation, authorization and permanent outcomes without returning error payloads", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-taric-outbox-outcomes-"))
        try {
            for (const [code, expected] of [["validation_error", "rejected_validation"], ["authorization_error", "rejected_authorization"], ["unsupported_schema_version", "failed_permanent"]] as const) {
                const outbox = new EncryptedTaricOutbox({ path: join(dir, `${code}.jsonl`), key: new Uint8Array(32).fill(6) })
                await outbox.append({ eventId: "event-1", projectId: "project-1", operation: "proposal.submit", idempotencyKey: "proposal-1", payload: { operation: "proposal.submit" } })
                const summary = await outbox.replayOrdered({ apply: async () => { throw Object.assign(new Error("Authorization: Bearer must-never-persist"), { code }) } })
                expect(summary.results[0]?.status).toBe(expected)
                expect((await outbox.list())[0]?.status).toBe(expected)
                expect(JSON.stringify(await outbox.list())).not.toContain("must-never-persist")
            }
            const accepted = new EncryptedTaricOutbox({ path: join(dir, "accepted.jsonl"), key: new Uint8Array(32).fill(6) })
            await accepted.append({ eventId: "accepted-1", projectId: "project-1", payload: {} })
            await accepted.markOutcome("accepted-1", "accepted")
            let applied = false
            await accepted.replayOrdered({ apply: async () => { applied = true; return { result: true, readSeq: 1 } } })
            expect(applied).toBe(false)
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
})
