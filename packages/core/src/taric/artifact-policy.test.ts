import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommittedTaricArtifact } from "./artifact-service"
import { TaricArtifactPolicy } from "./artifact-policy"

const artifact: CommittedTaricArtifact = { engagementId: "019a0000-0000-7000-8000-000000000001", sessionId: "policy-session", contentRef: "019a0000-0000-7000-8000-000000000002@v1", artifactId: "019a0000-0000-7000-8000-000000000002", version: 1, category: "evidence", payloadKind: "text", mediaType: "text/plain", byteLength: 12, contentHash: `sha256:${"a".repeat(64)}`, manifestHash: `sha256:${"b".repeat(64)}`, storageMode: "taric_stored", contentStatus: "available", integrityStatus: "verified" }

describe("host Artifact lifecycle policy", () => {
    test("a failed journal save remains unreadable and retry persists before publishing the registration", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-artifact-policy-retry-"))
        const parent = join(root, "occupied-parent")
        const options = { journalPath: join(parent, "policy.json"), retentionMs: 60_000 }
        try {
            await Bun.write(parent, "This file prevents creating the journal directory.")
            const policy = new TaricArtifactPolicy(options)
            await expect(policy.register(artifact)).rejects.toThrow()
            await expect(policy.assertReadable(artifact)).rejects.toThrow("no matching")
            await rm(parent)
            await mkdir(parent)
            await policy.register(artifact)
            await policy.assertReadable(artifact)
            expect(await Bun.file(options.journalPath).exists()).toBe(true)
            await new TaricArtifactPolicy(options).assertReadable(artifact)
        } finally { await rm(root, { recursive: true, force: true }) }
    })
    test("redacts and minimizes before storage, rejects configuration secrets and preserves valid UTF-8", () => {
        const policy = new TaricArtifactPolicy({ journalPath: "/unused", retentionMs: 1000, configurationSecrets: ["config-key"], redactValues: ["target-value"], maxOrdinaryBytes: 18 })
        const result = policy.prepareOrdinaryText("target-value观察正文过长")
        expect(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)).toBe("[REDACTED]观察")
        expect(result.bytes.byteLength).toBeLessThanOrEqual(18)
        expect(result.redacted).toBe(true)
        expect(result.minimized).toBe(true)
        expect(result.limitations).toHaveLength(2)
        expect(() => policy.prepareOrdinaryText("config-key")).toThrow("configuration secrets")
    })

    test("persists retention across restart and denies unknown or expired reads without claiming physical deletion", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-artifact-policy-"))
        let now = 1000
        const options = { journalPath: join(root, "policy.json"), retentionMs: 1000, now: () => now }
        try {
            const first = new TaricArtifactPolicy(options)
            await expect(first.assertReadable(artifact)).rejects.toThrow("no matching")
            await first.register(artifact)
            await first.assertReadable(artifact)
            await expect(first.delete(artifact, { authorized: true, reason: "retention" })).rejects.toThrow("not expired")
            now = 2000
            const restarted = new TaricArtifactPolicy(options)
            await expect(restarted.assertReadable(artifact)).rejects.toThrow("retention")
            await restarted.register(artifact)
            await expect(restarted.assertReadable(artifact)).rejects.toThrow("retention")
            const deleted = await restarted.delete(artifact, { authorized: true, reason: "retention" })
            expect(deleted).toMatchObject({ access: "deleted", deletion: "unsupported", committedAt: new Date(1000).toISOString(), expiresAt: new Date(2000).toISOString() })
            const report = await Bun.file(options.journalPath).text()
            expect(report).not.toMatch(/payload|password|token|root/)
            await expect(new TaricArtifactPolicy(options).assertReadable(artifact)).rejects.toThrow("retention")
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("requires explicit deletion and confirms only the deployment adapter result, with idempotent retries", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-artifact-delete-"))
        let deletions = 0
        const options = { journalPath: join(root, "policy.json"), retentionMs: 1000, deleteStoredContent: async () => { deletions += 1; return { deleted: true } } }
        try {
            const policy = new TaricArtifactPolicy(options)
            await policy.register(artifact)
            await expect(policy.delete(artifact, { authorized: false, reason: "operator" } as never)).rejects.toThrow("authorization")
            expect(deletions).toBe(0)
            expect(await policy.delete(artifact, { authorized: true, reason: "operator" })).toMatchObject({ access: "deleted", deletion: "confirmed" })
            expect(await new TaricArtifactPolicy(options).delete(artifact, { authorized: true, reason: "operator" })).toMatchObject({ deletion: "confirmed" })
            expect(deletions).toBe(1)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("external metadata never implies retrieval and target authentication cannot use external references", () => {
        const policy = new TaricArtifactPolicy({ journalPath: "/unused", retentionMs: 1000 })
        expect(policy.externalAvailability({ storageMode: "external", targetAuth: true, availability: "available" })).toMatchObject({ usable: false, recovered: false })
        expect(policy.externalAvailability({ storageMode: "external", targetAuth: false })).toMatchObject({ usable: false, recovered: false })
        expect(policy.externalAvailability({ storageMode: "external", targetAuth: false, availability: "available" })).toMatchObject({ usable: true, recovered: false })
    })
})
