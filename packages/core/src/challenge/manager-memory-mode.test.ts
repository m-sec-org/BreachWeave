import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR } from "./env"
import { ChallengeManager } from "./manager"
import type { ChallengeMemoryProvider } from "./memory-provider"
import { computeChallengeCompleted, createChallengeRecord, hashChallengeAsset, listChallengeSubmissionLogs, readChallengeRecord, saveChallengeRecord } from "./store"
import { buildChallengeStatsOverview } from "./stats"

const originalChallengeDir = process.env[CHALLENGE_ENV_DIR]

describe("ChallengeManager memory mode binding", () => {
    test("rejects competition completion writes for authorized projects independently of authority availability", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-completion-domain-"))
        process.env[CHALLENGE_ENV_DIR] = root
        try {
            const challenge = createChallengeRecord({ id: "authorized-domain", name: "Authorized domain", assets_url: "http://127.0.0.1", project: { mode: "authorized_pentest", tenant_id: "tenant-a", engagement_id: "engagement-a", scope_revision: 1, coverage_manifest_id: "manifest-a", memory_mode: "taric_required", taric_engagement_id: "engagement-a" } })
            await saveChallengeRecord(root, challenge, "test")
            let providerCalls = 0
            const provider = { mode: "taric_required", async assertAvailable() { providerCalls += 1 } } as unknown as ChallengeMemoryProvider
            const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
            const manager = new ChallengeManager(config, undefined, provider)
            await expect(manager.updateChallengeAssetScanned(challenge.id, "urls", "http://127.0.0.1", true)).rejects.toMatchObject({ code: "COMPLETION_DOMAIN_MISMATCH" })
            await expect(manager.submitReport(challenge.id, { assetHash: hashChallengeAsset("http://127.0.0.1"), report: "This report cannot close an authorized engagement" })).rejects.toMatchObject({ code: "COMPLETION_DOMAIN_MISMATCH" })
            expect(providerCalls).toBe(0)
            expect(await listChallengeSubmissionLogs(root, challenge.id, challenge.project_id)).toEqual([])
            const stored = await readChallengeRecord(root, challenge.id)
            expect(stored?.assets?.urls[0]?.scanned).toBe(false)
            expect(computeChallengeCompleted({ ...challenge, assets: { urls: [{ asset: "http://127.0.0.1", asset_hash: hashChallengeAsset("http://127.0.0.1"), scanned: true }], ips: [] } })).toBe(false)
            const overview = buildChallengeStatsOverview([{ challenge: stored!, stats: { challenge_id: challenge.id, solver_count: 0, attempt_count: 0, submission_count: 1, solver_active_duration_ms_total: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }, updated_at: new Date().toISOString() }, solver_stats: [], submissions: [] }])
            expect(overview.challenges_total).toBe(0)
            expect(overview.challenges_completed).toBe(0)
            expect(overview.assets_scanned).toBe(0)
            expect(overview.reports_total).toBe(0)
            await saveChallengeRecord(root, createChallengeRecord({ id: "competition-domain", name: "Competition domain", assets_url: "http://127.0.0.2" }), "test")
            const listed = await manager.listChallenges()
            expect(listed.remote.challenges.map((entry) => entry.code)).toEqual(["competition-domain"])
            expect(listed.remote.total_challenges).toBe(1)
            expect(listed.summary).toMatchObject({ remote: 1, total: 1, local: 2, platform_solved: 0, reports_completed: 0 })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    afterEach(() => {
        if (originalChallengeDir === undefined) delete process.env[CHALLENGE_ENV_DIR]
        else process.env[CHALLENGE_ENV_DIR] = originalChallengeDir
    })

    test("blocks authorized startup on canonical contract gaps before provider dispatch", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-contract-gate-"))
        process.env[CHALLENGE_ENV_DIR] = root
        try {
            const challenge = createChallengeRecord({
                id: "contract-blocked", name: "Contract blocked",
                project: { mode: "authorized_pentest", tenant_id: "tenant-a", engagement_id: "engagement-a", scope_revision: 1, coverage_manifest_id: "manifest-a", memory_mode: "taric_required", taric_engagement_id: "engagement-a" },
            })
            await saveChallengeRecord(root, challenge, "test")
            let providerDispatched = false
            const provider = {
                mode: "taric_required",
                async assertAvailable() { providerDispatched = true },
            } as unknown as ChallengeMemoryProvider
            const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
            const manager = new ChallengeManager(config, undefined, provider)
            await expect(manager.startChallenge(challenge.id)).rejects.toMatchObject({ code: "TARIC_GOVERNANCE_REQUIRED", operation: "solver" })
            expect(providerDispatched).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("required projects reject a best-effort provider before platform startup", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-memory-mode-"))
        process.env[CHALLENGE_ENV_DIR] = root
        try {
            const project = {
                mode: "authorized_pentest" as const,
                tenant_id: "tenant-a",
                engagement_id: "engagement-host",
                scope_revision: 1,
                coverage_manifest_id: "coverage-a",
                memory_mode: "taric_required" as const,
                taric_engagement_id: "taric-engagement-a",
            }
            const challenge = createChallengeRecord({ id: "authorized-project", name: "Authorized Project", project })
            await saveChallengeRecord(root, challenge, "test")

            const provider = { mode: "taric_best_effort" } as ChallengeMemoryProvider
            const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
            const manager = new ChallengeManager(config, undefined, provider)

            await expect(manager.startChallenge(challenge.id)).rejects.toMatchObject({ code: "TARIC_GOVERNANCE_REQUIRED", operation: "solver" })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("daemon-scoped Taric provider factories are cached and closed on reload", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-memory-factory-"))
        process.env[CHALLENGE_ENV_DIR] = root
        try {
            const project = {
                mode: "competition" as const,
                tenant_id: "tenant-a",
                platform_id: "platform-a",
                competition_id: "competition-a",
                team_id: "team-a",
                challenge_code: "factory-project",
                provider: "local_practice" as const,
                memory_mode: "taric_best_effort" as const,
                taric_engagement_id: "engagement-a",
            }
            const challenge = createChallengeRecord({ id: "factory-project", name: "Factory Project", project })
            await saveChallengeRecord(root, challenge, "test")
            let factoryCalls = 0
            let closes = 0
            const provider = {
                mode: "taric_best_effort" as const,
                listMemory: async () => [],
                getReadDiagnostics: () => ({ status: "complete", watermark: 12 }),
                close: async () => { closes += 1 },
            } as unknown as ChallengeMemoryProvider
            const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
            const manager = new ChallengeManager(config, undefined, undefined, async (scope) => {
                factoryCalls += 1
                expect(scope.project?.taric_engagement_id).toBe("engagement-a")
                return provider
            })

            await manager.listMemory(challenge.id)
            await manager.listMemory(challenge.id)
            await expect(manager.getMemoryReadDiagnostics(challenge.id)).resolves.toEqual({ status: "complete", watermark: 12 })
            expect(factoryCalls).toBe(1)
            await manager.reloadFromConfig()
            expect(closes).toBe(1)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
