import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    archiveChallengeRecord,
    createChallengeRecord,
    hashChallengeAsset,
    isChallengeCompletedInStore,
    listChallengeAttemptLogs,
    listChallengeRecords,
    listChallengeSubmissionLogs,
    normalizeChallengeRecord,
    readChallengeRecord,
    saveChallengeRecord,
} from "./store"
import { deriveCompositeProjectKey } from "../project/types"

function assetRecord(asset: string, scanned: boolean) {
    return { asset, asset_hash: hashChallengeAsset(asset), scanned }
}

let challengeDir: string
let archiveDir: string

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-store-test-"))
    archiveDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-archive-test-"))
})

afterEach(async () => {
    await rm(challengeDir, { recursive: true, force: true })
    await rm(archiveDir, { recursive: true, force: true })
})

describe("challenge-store", () => {
    test("defaults records without trusted identity to an explicitly unclassified local project", () => {
        const record = createChallengeRecord({ id: "legacy-project", name: "Legacy Project" })

        expect(record.project).toBeUndefined()
        expect(record.project_id).toBeUndefined()
        expect(record.project_classification).toBe("legacy_unclassified")
        expect(record.mode).toBe("competition")
        expect(record.provider).toBe("local_practice")
        expect(record.memory_mode).toBe("legacy_local")
    })

    test("round-trips a trusted project and derives its opaque identity", async () => {
        const project = {
            mode: "competition" as const,
            provider: "local_practice" as const,
            tenant_id: "tenant-a",
            platform_id: "platform-a",
            competition_id: "competition-a",
            team_id: "team-a",
            challenge_code: "challenge-a",
            memory_mode: "legacy_local" as const,
        }
        const record = createChallengeRecord({ id: "trusted-project", name: "Trusted Project", project })

        expect(record.project).toEqual(project)
        expect(record.project_id).toBe(deriveCompositeProjectKey(project))
        expect(record.project_classification).toBe("trusted")

        await saveChallengeRecord(challengeDir, record, "test")
        const stored = await readChallengeRecord(challengeDir, record.id)
        expect(stored?.project).toEqual(project)
        expect(stored?.project_id).toBe(record.project_id)
        expect(stored?.project_classification).toBe("trusted")

        // A host-trusted project binding can never be downgraded to
        // legacy_unclassified, even when a stale field says otherwise.
        const downgraded = normalizeChallengeRecord({ ...record, project_classification: "legacy_unclassified" })
        expect(downgraded.project_id).toBe(record.project_id)
        expect(downgraded.project_classification).toBe("trusted")
    })

    test("rejects invalid mode-policy pairs supplied to the challenge store", () => {
        expect(() => createChallengeRecord({
            id: "invalid-project",
            name: "Invalid Project",
            project: {
                mode: "competition",
                provider: "remote",
                tenant_id: "tenant-a",
                platform_id: "platform-a",
                competition_id: "competition-a",
                team_id: "team-a",
                challenge_code: "challenge-a",
                memory_mode: "taric_required",
            } as never,
        })).toThrow("competition.memory_mode")
    })

    test("rejects an opaque identity that is not bound to a validated project", () => {
        expect(() => normalizeChallengeRecord({
            id: "unbound-project",
            name: "Unbound Project",
            description: "",
            title: "Unbound Project",
            difficulty: "local",
            level: 1,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
            project_id: "challenge-a" as never,
        })).toThrow("validated project identity")
    })

    test("hashChallengeAsset hashes the trimmed full asset string with MD5", () => {
        expect(hashChallengeAsset("  http://example.com/a  ")).toBe("3e27a17e84f5f8486fbc14488e12e6ff")
        expect(hashChallengeAsset("http://example.com/b")).not.toBe(hashChallengeAsset("http://example.com/a"))
    })

    test("save/read/list challenge records by challenge id", async () => {
        await saveChallengeRecord(challengeDir, {
            id: "abc123",
            name: "challenge-a",
            title: "challenge-a",
            difficulty: "easy",
            description: "desc",
            level: 1,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
            assets: { urls: [assetRecord("https://a.example", false)], ips: [] },
        })

        const challenge = await readChallengeRecord(challengeDir, "abc123")
        expect(challenge?.id).toBe("abc123")
        expect(challenge?.name).toBe("challenge-a")
        expect(challenge?.created_at).toBeTruthy()
        const createdAt = challenge?.created_at
        expect(await isChallengeCompletedInStore("abc123", challengeDir)).toBe(false)

        await Bun.sleep(2)
        await saveChallengeRecord(challengeDir, {
            id: "abc123",
            name: "challenge-a",
            title: "challenge-a",
            difficulty: "easy",
            description: "desc",
            level: 1,
            hint_viewed: true,
            instance_status: "stopped",
            entrypoint: null,
            assets: { urls: [assetRecord("https://a.example", true)], ips: [] },
        })

        const updated = await readChallengeRecord(challengeDir, "abc123")
        expect(updated?.instance_status).toBe("stopped")
        expect(updated?.hint_viewed).toBe(true)
        expect(updated?.created_at).toBe(createdAt)
        expect(updated?.updated_at).not.toBe(createdAt)
        expect(await isChallengeCompletedInStore("abc123", challengeDir)).toBe(true)

        const records = await listChallengeRecords(challengeDir)
        expect(records).toHaveLength(1)
        expect(records[0].id).toBe("abc123")
    })

    test("writes attempt logs and submission logs as files", async () => {
        const attempt = await appendChallengeAttemptLog(challengeDir, {
            challengeId: "abc123",
            solverId: "solver-1",
            promptName: "default",
            task: "solve it",
        })
        const submission = await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "abc123",
            solverId: "solver-1",
            promptName: "default",
            modelName: "anthropic/claude-sonnet",
            assetHash: hashChallengeAsset("https://target.example"),
            asset: "https://target.example",
            report: "upload polyglot bypass -> webshell -> write report",
        })

        const attempts = await listChallengeAttemptLogs(challengeDir, "abc123")
        const submissions = await listChallengeSubmissionLogs(challengeDir, "abc123")

        expect(attempts).toHaveLength(1)
        expect(attempts[0].id).toBe(attempt.id)
        expect(attempts[0].solver_id).toBe("solver-1")
        expect(submissions).toHaveLength(1)
        expect(submissions[0].id).toBe(submission.id)
        expect(submissions[0].solver_id).toBe("solver-1")
        expect(submissions[0].prompt_name).toBe("default")
        expect(submissions[0].model_name).toBe("anthropic/claude-sonnet")
        expect(submissions[0].asset_hash).toBe(hashChallengeAsset("https://target.example"))
        expect(submissions[0].asset).toBe("https://target.example")
        expect(submissions[0].report).toBe("upload polyglot bypass -> webshell -> write report")
    })

    test("createChallengeRecord writes new project fields", async () => {
        const record = createChallengeRecord({
            id: "proj001",
            name: "Portal Login",
            description: "test upload",
            assets_url: ["https://portal.example/login", "https://api.portal.example"],
            assets_ip: ["10.0.0.8:8080", "10.0.0.9"],
            planner_prompt: "优先关注上传面",
        })

        await saveChallengeRecord(challengeDir, record, "test")
        const challenge = await readChallengeRecord(challengeDir, "proj001")

        expect(challenge?.name).toBe("Portal Login")
        expect(challenge?.assets_url).toEqual(["https://portal.example/login", "https://api.portal.example"])
        expect(challenge?.assets_ip).toEqual(["10.0.0.8:8080", "10.0.0.9"])
        expect(challenge?.assets).toEqual({
            urls: [
                assetRecord("https://portal.example/login", false),
                assetRecord("https://api.portal.example", false),
            ],
            ips: [
                assetRecord("10.0.0.8:8080", false),
                assetRecord("10.0.0.9", false),
            ],
        })
        expect(challenge?.planner_prompt).toBe("优先关注上传面")
        expect(challenge?.planner_enabled).toBe(true)
        expect(challenge?.planner_status).toBe("stop")
        expect(challenge?.entrypoint).toEqual(["https://portal.example/login", "https://api.portal.example", "10.0.0.8:8080", "10.0.0.9"])
    })

    test("createChallengeRecord supports disabled project planner", async () => {
        const record = createChallengeRecord({
            id: "planner-disabled",
            name: "Planner Disabled",
            assets_url: ["https://disabled.example"],
            planner_enabled: false,
        })

        await saveChallengeRecord(challengeDir, record, "test")
        const challenge = await readChallengeRecord(challengeDir, "planner-disabled")

        expect(challenge?.planner_enabled).toBe(false)
        expect(challenge?.planner_status).toBe("disabled")
    })

    test("normalizeChallengeRecord backfills legacy asset strings and preserves scanned state", async () => {
        await saveChallengeRecord(
            challengeDir,
            {
                id: "legacy-assets",
                name: "Legacy Assets",
                title: "Legacy Assets",
                difficulty: "easy",
                description: "legacy assets",
                assets_url: "https://legacy.example",
                assets_ip: "10.1.1.8",
                assets: {
                    urls: [{ asset: "https://legacy.example", scanned: true }],
                    ips: [{ asset: "10.1.1.8", scanned: true }],
                } as never,
                level: 1,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
            },
            "test",
        )

        const challenge = await readChallengeRecord(challengeDir, "legacy-assets")
        expect(challenge?.assets_url).toEqual(["https://legacy.example"])
        expect(challenge?.assets_ip).toEqual(["10.1.1.8"])
        expect(challenge?.assets?.urls).toEqual([assetRecord("https://legacy.example", true)])
        expect(challenge?.assets?.ips).toEqual([assetRecord("10.1.1.8", true)])
    })

    test("normalizeChallengeRecord backfills legacy records without new fields", async () => {
        await saveChallengeRecord(
            challengeDir,
            {
                id: "legacy1",
                name: "",
                title: "Legacy Challenge",
                difficulty: "easy",
                description: "legacy desc",
                level: 1,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: ["127.0.0.1:9000"],
            },
            "test",
        )

        const challenge = await readChallengeRecord(challengeDir, "legacy1")
        expect(challenge?.name).toBe("Legacy Challenge")
        expect(challenge?.planner_enabled).toBe(true)
        expect(challenge?.planner_status).toBe("stop")
        expect(challenge?.entrypoint).toEqual(["127.0.0.1:9000"])
    })

    test("listChallengeRecords orders projects by newest created_at first", async () => {
        await saveChallengeRecord(challengeDir, {
            ...createChallengeRecord({ id: "older-project", name: "Older Project" }),
            created_at: "2026-04-12T00:00:00.000Z",
        })
        await saveChallengeRecord(challengeDir, {
            ...createChallengeRecord({ id: "newer-project", name: "Newer Project" }),
            created_at: "2026-04-13T00:00:00.000Z",
        })
        await saveChallengeRecord(challengeDir, {
            ...createChallengeRecord({ id: "same-time-a", name: "Same Time A" }),
            created_at: "2026-04-13T00:00:00.000Z",
        })

        const records = await listChallengeRecords(challengeDir)
        expect(records.map((item) => item.id)).toEqual(["newer-project", "same-time-a", "older-project"])
    })

    test("readChallengeRecord backfills created_at from updated_at for legacy files", async () => {
        const dir = join(challengeDir, encodeURIComponent("legacy-created-at"))
        await mkdir(dir, { recursive: true })
        await Bun.write(
            join(dir, "challenge.json"),
            JSON.stringify({
                id: "legacy-created-at",
                name: "Legacy Created At",
                title: "Legacy Created At",
                description: "",
                difficulty: "local",
                level: 1,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
                updated_at: "2026-04-14T00:00:00.000Z",
                source: "legacy",
            }, null, 2),
        )

        const challenge = await readChallengeRecord(challengeDir, "legacy-created-at")
        expect(challenge?.created_at).toBe("2026-04-14T00:00:00.000Z")
    })

    test("archiveChallengeRecord moves challenge directory into archive root", async () => {
        const record = createChallengeRecord({
            id: "archive-me",
            name: "Archive Me",
            description: "to archive",
        })
        await saveChallengeRecord(challengeDir, record, "test")
        await appendChallengeAttemptLog(challengeDir, {
            challengeId: "archive-me",
            solverId: "solver-1",
            promptName: "default",
            task: "solve it",
        })

        const archived = await archiveChallengeRecord(challengeDir, "archive-me", archiveDir)
        expect(archived).toBe(true)
        expect(await readChallengeRecord(challengeDir, "archive-me")).toBeUndefined()
        expect(await listChallengeRecords(challengeDir)).toHaveLength(0)

        const archivedChallengePath = join(archiveDir, encodeURIComponent("archive-me"), "challenge.json")
        const archivedFile = Bun.file(archivedChallengePath)
        expect(await archivedFile.exists()).toBe(true)
        const archivedRecord = await archivedFile.json()
        expect(archivedRecord.id).toBe("archive-me")
        expect(await listChallengeAttemptLogs(archiveDir, "archive-me")).toHaveLength(1)
    })

    test("archiveChallengeRecord rejects empty or invalid challenge ids", async () => {
        await expect(archiveChallengeRecord(challengeDir, "", archiveDir)).rejects.toThrow("challengeId is required")
        await expect(archiveChallengeRecord(challengeDir, "   ", archiveDir)).rejects.toThrow("challengeId is required")
        await expect(archiveChallengeRecord(challengeDir, "..", archiveDir)).rejects.toThrow("challengeId is invalid")
        await expect(archiveChallengeRecord(challengeDir, "bad/id", archiveDir)).rejects.toThrow("challengeId is invalid")
    })

    test("archiveChallengeRecord returns false when challenge directory is missing", async () => {
        const archived = await archiveChallengeRecord(challengeDir, "missing-id", archiveDir)
        expect(archived).toBe(false)
    })

    test("archiveChallengeRecord appends timestamp when archive target already exists", async () => {
        await saveChallengeRecord(
            challengeDir,
            createChallengeRecord({ id: "dup-id", name: "Dup" }),
            "test",
        )
        await mkdir(join(archiveDir, encodeURIComponent("dup-id")), { recursive: true })

        const archived = await archiveChallengeRecord(challengeDir, "dup-id", archiveDir)
        expect(archived).toBe(true)
        expect(await readChallengeRecord(challengeDir, "dup-id")).toBeUndefined()

        const entries = await readdir(archiveDir)
        expect(entries.some((entry) => entry === encodeURIComponent("dup-id"))).toBe(true)
        expect(entries.some((entry) => entry.startsWith(`${encodeURIComponent("dup-id")}-`))).toBe(true)
    })
})
