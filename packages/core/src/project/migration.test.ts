import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { archiveLegacyUnclassified, dryRunLegacyMigration } from "./migration"
import { createChallengeRecord, saveChallengeRecord } from "../challenge/store"

describe("legacy migration", () => {
    test("never treats an authorized local record as canonical provenance or auto-admits it", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-migration-authorized-"))
        try {
            const record = createChallengeRecord({ id: "authorized", name: "Authorized", project: {
                mode: "authorized_pentest", tenant_id: "tenant", engagement_id: "engagement", scope_revision: 1,
                coverage_manifest_id: "manifest", memory_mode: "taric_required", taric_engagement_id: "authority-engagement",
            } })
            await saveChallengeRecord(root, record, "test")
            const path = join(root, "authorized", "challenge.json")
            const before = await Bun.file(path).text()
            const report = await dryRunLegacyMigration(root)
            expect(report.counts).toMatchObject({ trusted: 0, hostAuditOnly: 1 })
            expect(report.items[0]).toMatchObject({ classification: "host_audit_only", authorityProvenance: "unverified", canonicalAdmission: "not_requested" })
            expect(await Bun.file(path).text()).toBe(before)
            expect(JSON.stringify(report)).not.toContain("authority-engagement")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("includes malformed and forged records that normal store listing omits", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-migration-conflicts-"))
        try {
            const project = { mode: "competition", provider: "local_practice", tenant_id: "tenant", platform_id: "platform", competition_id: "competition", team_id: "team", challenge_code: "same", memory_mode: "legacy_local" }
            const rawRecords: Record<string, string> = {
                broken: "{ not-json",
                forged: JSON.stringify({ id: "forged", project, project_id: "bwpk_v1_forged" }),
                duplicate: JSON.stringify({ id: "duplicate", project }),
                unknown: JSON.stringify({ id: "unknown", project: { mode: "unknown" } }),
            }
            for (const [id, content] of Object.entries(rawRecords)) {
                await mkdir(join(root, id))
                await Bun.write(join(root, id, "challenge.json"), content)
            }
            const report = await dryRunLegacyMigration(root)
            expect(report.counts).toMatchObject({ total: 4, trusted: 0, conflicts: 4 })
            expect(report.items.every((item) => item.classification === "conflict" && item.canonicalAdmission === "not_requested")).toBe(true)
            expect(report.items.find((item) => item.challengeId === "broken")?.conflicts).toEqual(["challenge record is not valid JSON"])
            expect(report.items.find((item) => item.challengeId === "forged")?.conflicts).toContain("record project_id does not match the host-derived identity")
            expect(report.items.find((item) => item.challengeId === "duplicate")?.conflicts).toContain("project identity is shared by multiple legacy records; explicit mapping review is required")
            for (const [id, content] of Object.entries(rawRecords)) expect(await Bun.file(join(root, id, "challenge.json")).text()).toBe(content)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("bounds sensitive warnings and never includes sensitive values", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-migration-sensitive-"))
        try {
            await mkdir(join(root, "sensitive"))
            const secrets = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`token_${index}`, "flag{never-print-this}"]))
            await Bun.write(join(root, "sensitive", "challenge.json"), JSON.stringify({ id: "sensitive", ...secrets }))
            const report = await dryRunLegacyMigration(root)
            expect(report.items[0].sensitiveWarnings).toHaveLength(32)
            expect(JSON.stringify(report)).not.toContain("never-print-this")
            expect(report.items[0].contentDigest).toMatch(/^[a-f0-9]{64}$/)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("classifies without writing and archives only explicit ambiguous records", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-migration-"))
        const archive = await mkdtemp(join(tmpdir(), "bw-migration-archive-"))
        try {
            const trusted = createChallengeRecord({ id: "trusted", name: "Trusted", project: {
                mode: "competition", provider: "local_practice", tenant_id: "tenant", platform_id: "platform", competition_id: "competition", team_id: "team", challenge_code: "code", memory_mode: "legacy_local",
            } })
            const legacy = createChallengeRecord({ id: "legacy", name: "Legacy", description: "flag{secret}" })
            await saveChallengeRecord(root, trusted, "test")
            await saveChallengeRecord(root, legacy, "test")
            const before = await readFile(join(root, "legacy", "challenge.json"), "utf8")
            const report = await dryRunLegacyMigration(root)
            expect(report.readOnly).toBe(true)
            expect(report.counts).toMatchObject({ total: 2, trusted: 1, legacyUnclassified: 1, sensitive: 2 })
            expect(report.items.find((item) => item.challengeId === "legacy")).toMatchObject({ classification: "legacy_unclassified", contentDigest: expect.any(String) })
            expect(await readFile(join(root, "legacy", "challenge.json"), "utf8")).toBe(before)

            await expect(archiveLegacyUnclassified(report, ["trusted"], archive)).rejects.toThrow("not an unclassified")
            expect(await archiveLegacyUnclassified(report, ["legacy"], archive)).toMatchObject({ archived: ["legacy"] })
        } finally {
            await rm(root, { recursive: true, force: true })
            await rm(archive, { recursive: true, force: true })
        }
    })
})
