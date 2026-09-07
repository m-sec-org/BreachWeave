import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR, CHALLENGE_ENV_ARCHIVE_DIR } from "./env"
import { ChallengeManager } from "./manager"
import { appendChallengeSubmissionLog, hashChallengeAsset, listChallengeSubmissionLogs, saveChallengeRecord, type ChallengeRecord } from "./store"

function assetRecord(asset: string, scanned: boolean) {
    return { asset, asset_hash: hashChallengeAsset(asset), scanned }
}

function buildTestChallenge(overrides: Pick<ChallengeRecord, "id"> & Record<string, unknown>): ChallengeRecord {
    const typed = overrides as Partial<ChallengeRecord> & Pick<ChallengeRecord, "id">
    const name = typed.name ?? typed.title ?? typed.id
    return {
        id: typed.id,
        name,
        title: typed.title ?? name,
        description: typed.description ?? "",
        assets_url: typed.assets_url ?? null,
        assets_ip: typed.assets_ip ?? null,
        planner_prompt: typed.planner_prompt ?? null,
        planner_enabled: typed.planner_enabled ?? true,
        difficulty: typed.difficulty ?? "easy",
        level: typed.level ?? 1,
        hint_viewed: typed.hint_viewed ?? false,
        hint_content: typed.hint_content ?? null,
        instance_status: typed.instance_status ?? "stopped",
        planner_status: typed.planner_status ?? "stop",
        entrypoint: typed.entrypoint ?? ["127.0.0.1:8080"],
        assets: typed.assets,
    }
}
import { readSolverBoardSnapshot } from "../solver/board-store"
import { solverSessionDir } from "../runtime/types"

let challengeDir: string
let archiveChallengeDir: string
let manager: ChallengeManager
const originalFetch = globalThis.fetch

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-manager-test-"))
    archiveChallengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-manager-archive-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    process.env[CHALLENGE_ENV_ARCHIVE_DIR] = archiveChallengeDir
    const config = {
        getHostSettings: async () => ({ runtime: {}, planner: {} }),
        getPrompt: async () => ({ meta: { isSubagent: false } }),
        listAgentPrompts: async () => [],
        listModelPrefs: async () => [],
    } as unknown as ConfigManager
    manager = new ChallengeManager(config)
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_DIR]
    delete process.env[CHALLENGE_ENV_ARCHIVE_DIR]
    globalThis.fetch = originalFetch
    await rm(challengeDir, { recursive: true, force: true })
    await rm(archiveChallengeDir, { recursive: true, force: true })
})

describe("challenge-manager local api", () => {
    test("limits running challenges to 3", async () => {
        for (const id of ["mock-a", "mock-b", "mock-c", "mock-d"]) {
            await manager.createChallenge(buildTestChallenge({
                id,
                name: id,
                title: id,
                difficulty: "easy",
                description: "",
                level: 1,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: ["127.0.0.1:8080"],
            }))
        }

        await manager.startChallenge("mock-a")
        await manager.startChallenge("mock-b")
        await manager.startChallenge("mock-c")

        await expect(manager.startChallenge("mock-d")).rejects.toThrow("at most 3 challenges can run at the same time")
    })

    test("submits report for a known asset and hint still requires running instance", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-web-1",
            title: "mock-web-1",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            hint_content: "mock hint",
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            assets: { urls: [{ asset: "https://target.example", scanned: false }, { asset: "https://other.example", scanned: false }], ips: [] },
        }))
        await expect(manager.submitReport("mock-web-1", { assetHash: hashChallengeAsset("https://missing.example"), report: "missing" })).rejects.toThrow("asset hash")
        await expect(manager.getHint("mock-web-1")).rejects.toThrow("challenge instance is not running")

        await manager.startChallenge("mock-web-1")
        const submit = await manager.submitReport("mock-web-1", { assetHash: hashChallengeAsset("https://target.example"), report: "### report" })
        expect(submit.submission.asset_hash).toBe(hashChallengeAsset("https://target.example"))
        expect(submit.submission.asset).toBe("https://target.example")
        expect(submit.submission.report).toBe("### report")
        expect(submit.assets_completed).toBe(false)

        const hint = await manager.getHint("mock-web-1")
        expect(hint.remote.hint_content).toBe("mock hint")
        const challenge = await manager.getChallenge("mock-web-1")
        expect(challenge?.hint_viewed).toBe(true)
        expect(challenge?.hint_content).toBe("mock hint")
        expect(challenge?.assets?.urls[0]?.scanned).toBe(true)
    })

    test("report submission records every report and marks assets scanned", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-multi-asset",
            title: "mock-multi-asset",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            assets: {
                urls: [
                    { asset: "https://a.example", scanned: false },
                    { asset: "https://b.example", scanned: false },
                    { asset: "https://c.example", scanned: false },
                ],
                ips: [],
            },
        }))

        await manager.startChallenge("mock-multi-asset")

        const first = await manager.submitReport("mock-multi-asset", { assetHash: hashChallengeAsset("https://a.example"), report: "report a" })
        expect(first.assets_scanned).toBe(1)
        expect(first.assets_completed).toBe(false)

        const second = await manager.submitReport("mock-multi-asset", { assetHash: hashChallengeAsset("https://a.example"), report: "report a again" })
        expect(second.assets_scanned).toBe(1)
        expect(second.assets_completed).toBe(false)

        const third = await manager.submitReport("mock-multi-asset", { assetHash: hashChallengeAsset("https://b.example"), report: "report b" })
        expect(third.assets_scanned).toBe(2)
        expect(third.assets_completed).toBe(false)

        await expect(manager.submitReport("mock-multi-asset", { assetHash: "   ", report: "x" })).rejects.toThrow("assetHash is required")

        const submissions = await listChallengeSubmissionLogs(challengeDir, "mock-multi-asset")
        expect(submissions.map((item) => item.report).sort()).toEqual(["report a", "report a again", "report b"].sort())
    })

    test("report submission matches url and ip assets by exact hash", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-normalized-assets",
            title: "mock-normalized-assets",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["http://example.com:8081"],
            assets: {
                urls: [
                    { asset: "http://example.com:8081", scanned: false },
                    { asset: "http://path.example.com:8082/root", scanned: false },
                ],
                ips: [
                    { asset: "10.0.0.8", scanned: false },
                    { asset: "10.0.0.9:8080", scanned: false },
                ],
            },
        }))

        await manager.startChallenge("mock-normalized-assets")

        await expect(manager.submitReport("mock-normalized-assets", {
            assetHash: hashChallengeAsset("http://example.com:8081/admin/login"),
            report: "wrong path hash",
        })).rejects.toThrow("asset hash")

        const url = await manager.submitReport("mock-normalized-assets", { assetHash: hashChallengeAsset("http://example.com:8081"), report: "url report" })
        expect(url.submission.asset).toBe("http://example.com:8081")
        expect(url.assets_scanned).toBe(1)

        const pathUrl = await manager.submitReport("mock-normalized-assets", { assetHash: hashChallengeAsset("http://path.example.com:8082/root"), report: "url path report" })
        expect(pathUrl.submission.asset).toBe("http://path.example.com:8082/root")
        expect(pathUrl.assets_scanned).toBe(2)

        const plainIp = await manager.submitReport("mock-normalized-assets", { assetHash: hashChallengeAsset("10.0.0.8"), report: "ip report" })
        expect(plainIp.assets_scanned).toBe(3)

        const ipWithPort = await manager.submitReport("mock-normalized-assets", { assetHash: hashChallengeAsset("10.0.0.9:8080"), report: "ip port report" })
        expect(ipWithPort.assets_scanned).toBe(4)
        expect(ipWithPort.assets_completed).toBe(true)

        const challenge = await manager.getChallenge("mock-normalized-assets")
        expect(challenge?.assets?.urls).toEqual([
            assetRecord("http://example.com:8081", true),
            assetRecord("http://path.example.com:8082/root", true),
        ])
        expect(challenge?.assets?.ips).toEqual([
            assetRecord("10.0.0.8", true),
            assetRecord("10.0.0.9:8080", true),
        ])

        const submissions = await listChallengeSubmissionLogs(challengeDir, "mock-normalized-assets")
        expect(submissions.map((item) => item.asset).sort()).toEqual([
            "10.0.0.8",
            "10.0.0.9:8080",
            "http://example.com:8081",
            "http://path.example.com:8082/root",
        ])
    })

    test("report submission marks only the exact hash when url assets share a host", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-same-host-path-assets",
            title: "mock-same-host-path-assets",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["http://example.com/1.php", "http://example.com/2.php"],
            assets: {
                urls: [
                    { asset: "http://example.com/1.php", scanned: false },
                    { asset: "http://example.com/2.php", scanned: false },
                ],
                ips: [],
            },
        }))

        await manager.startChallenge("mock-same-host-path-assets")

        const submit = await manager.submitReport("mock-same-host-path-assets", { assetHash: hashChallengeAsset("http://example.com/1.php"), report: "path report" })
        expect(submit.submission.asset).toBe("http://example.com/1.php")
        expect(submit.assets_scanned).toBe(1)
        expect(submit.assets_pending).toBe(1)
        expect(submit.assets_completed).toBe(false)

        const challenge = await manager.getChallenge("mock-same-host-path-assets")
        expect(challenge?.assets?.urls).toEqual([
            assetRecord("http://example.com/1.php", true),
            assetRecord("http://example.com/2.php", false),
        ])
    })

    test("report submission keeps ip and ip port assets distinct", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-ip-port-distinct",
            title: "mock-ip-port-distinct",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["10.0.0.8:8080"],
            assets: {
                urls: [],
                ips: [{ asset: "10.0.0.8:8080", scanned: false }],
            },
        }))

        await manager.startChallenge("mock-ip-port-distinct")

        await expect(manager.submitReport("mock-ip-port-distinct", { assetHash: hashChallengeAsset("10.0.0.8"), report: "wrong asset" })).rejects.toThrow("asset hash")

        const submit = await manager.submitReport("mock-ip-port-distinct", { assetHash: hashChallengeAsset("10.0.0.8:8080"), report: "right asset" })
        expect(submit.assets_scanned).toBe(1)
        expect(submit.assets_completed).toBe(true)
    })

    test("local mode lists all stored challenges", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "local-visible",
            title: "local-visible",
            difficulty: "easy",
            description: "",
            level: 1,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
        }))

        await saveChallengeRecord(
            challengeDir,
            buildTestChallenge({
                id: "web-real",
                title: "web-real",
                difficulty: "easy",
                description: "",
                level: 1,
                hint_viewed: false,
                instance_status: "running",
                entrypoint: ["127.0.0.1:8080"],
            }),
            "test",
        )

        const challenges = await manager.listStoredChallenges()
        expect(challenges.map((item) => item.id).sort()).toEqual(["local-visible", "web-real"])
        expect(await manager.getChallenge("web-real")).toBeDefined()
    })

    test("listChallengesSafe reads local files", async () => {
        const localConfig = {
            getHostSettings: async () => ({ runtime: {}, planner: {} }),
        } as unknown as ConfigManager
        const localManager = new ChallengeManager(localConfig)

        await saveChallengeRecord(
            challengeDir,
            buildTestChallenge({
                id: "mock-local",
                title: "mock-local",
                instance_status: "stopped",
                entrypoint: null,
            }),
            "test",
        )

        await saveChallengeRecord(
            challengeDir,
            buildTestChallenge({
                id: "real-local",
                title: "real-local",
                instance_status: "stopped",
                entrypoint: null,
            }),
            "test",
        )

        const challenges = await localManager.listChallengesSafe("test")
        expect(challenges.map((item) => item.id).sort()).toEqual(["mock-local", "real-local"])
    })

    test("createChallengeFromInput writes local project fields", async () => {
        const challenge = await manager.createChallengeFromInput({
            name: "Portal Login",
            description: "test upload",
            assets_url: ["https://portal.example/login", "https://api.portal.example"],
            assets_ip: ["10.0.0.8:8080", "10.0.0.9"],
            planner_prompt: "优先关注上传面",
        })

        expect(challenge).toBeDefined()
        expect(challenge?.name).toBe("Portal Login")
        expect(challenge?.description).toBe("test upload")
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
        expect(challenge?.difficulty).toBe("local")
        expect(challenge?.entrypoint).toEqual(["https://portal.example/login", "https://api.portal.example", "10.0.0.8:8080", "10.0.0.9"])
        expect(challenge?.source).toBe("manual")

        const stored = await manager.listStoredChallenges()
        expect(stored.some((item) => item.id === challenge?.id)).toBe(true)
    })

    test("updateChallengePlannerPrompt writes project planner prompt", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-planner-prompt",
            title: "mock-planner-prompt",
            planner_prompt: null,
        }))

        const updated = await manager.updateChallengePlannerPrompt("mock-planner-prompt", "  优先验证登录绕过  ")
        expect(updated.planner_prompt).toBe("优先验证登录绕过")

        const cleared = await manager.updateChallengePlannerPrompt("mock-planner-prompt", "  ")
        expect(cleared.planner_prompt).toBeNull()
    })

    test("planner status can be updated and refreshed from solvers", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-planner-status",
            title: "mock-planner-status",
            flags: ["flag{ok}"],
        }))

        const starting = await manager.updateChallengePlannerStatus("mock-planner-status", "starting")
        expect(starting.planner_status).toBe("starting")

        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "mock-planner-status", status: "running" },
            { id: "solver-b", challengeId: "other", status: "running" },
        ])
        manager.attachRuntime({ listAll } as never)

        const running = await manager.refreshChallengePlannerStatusFromSolvers("mock-planner-status")
        expect(running?.planner_status).toBe("running")

        listAll.mockImplementation(async () => [
            { id: "solver-a", challengeId: "mock-planner-status", status: "stopped" },
        ])
        const stopped = await manager.refreshChallengePlannerStatusFromSolvers("mock-planner-status")
        expect(stopped?.planner_status).toBe("stop")
    })

    test("launchSolver starts challenge and records attempt", async () => {
        const config = {
            getHostSettings: async () => ({ runtime: {}, planner: {} }),
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        manager = new ChallengeManager(config)

        await manager.createChallenge(buildTestChallenge({
            id: "mock-launch",
            title: "mock-launch",
            difficulty: "medium",
            description: "portal target",
            level: 2,
            assets_url: "https://portal.example/login",
            assets_ip: "127.0.0.1:8080",
            planner_prompt: "优先关注上传面",
            hint_viewed: true,
            hint_content: "check upload",
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        }))
        await manager.appendMemory({
            challengeId: "mock-launch",
            kind: "fact",
            content: "login page exposes /admin",
            refs: ["scan-1"],
            source: "observer",
        })
        await manager.addIdea("mock-launch", { content: "test upload for webshell" })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-launch",
            solverId: "solver-prev-1",
            promptName: "pentest-orchestrator",
            modelName: "anthropic/claude-sonnet",
            assetHash: hashChallengeAsset("https://upload.example"),
            asset: "https://upload.example",
            report: "upload polyglot bypass -> webshell -> collect evidence -> submit detailed asset report",
        })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-launch",
            solverId: "solver-prev-2",
            promptName: "pentest-orchestrator",
            modelName: "anthropic/claude-sonnet",
            assetHash: hashChallengeAsset("https://login.example"),
            asset: "https://login.example",
            report: "tried login SQLi on /admin/login and captcha bypass",
        })

        const launch = mock(async (_promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-1",
            containerId: options?.solverId ?? "solver-1",
            name: options?.solverId ?? "solver-1",
            promptName: "pentest-orchestrator",
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ launch } as never)

        const solver = await manager.launchSolver("mock-launch", "pentest-orchestrator", {
            plannerHandoff: "优先检查上传链；只有明确需要时再看 hint。",
            entrypoints: [{ asset_hash: hashChallengeAsset("https://portal.example/login"), asset: "https://portal.example/login" }],
        })
        const attempts = await manager.listAttemptLogs("mock-launch")

        expect(launch).toHaveBeenCalledTimes(1)
        expect(solver.challengeId).toBe("mock-launch")
        expect(solver.task).toContain("项目名: mock-launch")
        expect(solver.task).toContain("portal target")
        expect(solver.task).toContain(`目标入口:\n- [${hashChallengeAsset("https://portal.example/login")}] https://portal.example/login`)
        expect(solver.task).not.toContain("目标入口:\n- 127.0.0.1:8080")
        expect(solver.task).not.toContain("Project Planner Prompt（项目级追加要求）:")
        expect(solver.task).not.toContain("优先关注上传面")
        expect(solver.task).toContain("项目级别启动补充说明（最高优先级遵循）:")
        expect(solver.task).toContain("优先检查上传链；只有明确需要时再看 hint。")
        expect(solver.task).toContain("当前 Memory 摘要:")
        expect(solver.task).toContain("login page exposes /admin")
        expect(solver.task).toContain("当前 Ideas 摘要:")
        expect(solver.task).toContain("test upload for webshell")
        expect(solver.task).toContain("当前 Submissions 摘要:")
        expect(solver.task).toContain("https://upload.example")
        expect(solver.task).toContain("upload polyglot bypass -> webshell -> collect evidence -> submit detailed asset report")
        expect(solver.task).toContain("https://login.example")
        expect(solver.task).toContain("先看当前 Submissions 摘要")
        const seededBoard = await readSolverBoardSnapshot(solverSessionDir(solver.id))
        if (seededBoard.memory.length > 0 || seededBoard.ideas.length > 0) {
            expect(seededBoard.memory).toEqual(
                expect.arrayContaining([expect.objectContaining({ content: "login page exposes /admin", source: "observer" })]),
            )
            expect(seededBoard.ideas).toEqual(
                expect.arrayContaining([expect.objectContaining({ content: "test upload for webshell", status: "pending" })]),
            )
        }
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.solver_id).toBe(solver.id)
    })

    test("launchSolver compacts initial memory and ideas context", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-compact",
            title: "mock-compact",
            difficulty: "hard",
            description: "compact me",
            level: 3,
            hint_viewed: true,
            hint_content: "focus on internal pivot",
            instance_status: "running",
            entrypoint: ["127.0.0.1:8081"],
        }))

        await manager.appendMemory({
            challengeId: "mock-compact",
            kind: "hint",
            content: "hint-priority",
            source: "observer",
        })
        for (let index = 0; index < 12; index += 1) {
            await manager.appendMemory({
                challengeId: "mock-compact",
                kind: "failure",
                content: `failure-${index}`,
                source: "observer",
            })
        }

        for (let index = 0; index < 10; index += 1) {
            await manager.addIdea("mock-compact", { content: `idea-${index}` })
        }

        const launch = mock(async (_promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-compact",
            containerId: options?.solverId ?? "solver-compact",
            name: options?.solverId ?? "solver-compact",
            promptName: "pentest-orchestrator",
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ launch } as never)

        const solver = await manager.launchSolver("mock-compact", "pentest-orchestrator")

        expect(solver.task).toContain("compact me")
        expect(solver.task).toContain("初始上下文仅展示最近 10/13 条 memory")
        expect(solver.task).toContain("初始上下文仅展示最近 8/10 条 idea")
        expect(solver.task).toContain("failure-11")
        expect(solver.task).not.toContain("failure-0")
        expect(solver.task).toContain("idea-9")
        expect(solver.task).not.toContain("idea-0")
        expect(solver.task).toContain("需要全量记录时再调用 memory_list")
        expect(solver.task).toContain("需要全量策略板时再调用 idea_list 或 idea_search")
        expect(solver.task).toContain("memory / ideas 已在 solver 启动时作为初始背景拼接给你")
    })

    test("appendMemory broadcasts challenge memory updates to running solvers on same challenge", async () => {
        const sendCommand = mock(() => {})
        manager.attachRuntime({
            list: () => [
                { id: "solver-a", challengeId: "chal-1", status: "running" },
                { id: "solver-b", challengeId: "chal-1", status: "starting" },
                { id: "solver-c", challengeId: "other", status: "running" },
            ],
            sendCommand,
        } as never)

        await manager.appendMemory({
            challengeId: "chal-1",
            kind: "hint",
            content: "focus on upload parser differential",
            source: "challenge-ui",
        })

        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-a", {
            type: "follow_up",
            message: `协作同步：Challenge Memory 已新增。
 - kind: hint
 - source: challenge-ui
 - content: focus on upload parser differential
 - 这是 challenge 级背景更新；如它影响当前路线，再自行吸收并调整。`.replace(/^ /gm, ""),
        })
    })

    test("addIdea broadcasts challenge idea updates to running solvers on same challenge", async () => {
        const sendCommand = mock(() => {})
        manager.attachRuntime({
            list: () => [
                { id: "solver-a", challengeId: "chal-1", status: "running" },
                { id: "solver-b", challengeId: "chal-1", status: "stopped" },
                { id: "solver-c", challengeId: "other", status: "running" },
            ],
            sendCommand,
        } as never)

        await manager.addIdea("chal-1", {
            content: "test upload parser differential",
            status: "testing",
            result: "png header accepted but php tail blocked",
        })

        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-a", {
            type: "follow_up",
            message: `协作同步：Challenge Idea 已新增。
 - status: testing
 - content: test upload parser differential
 - result: png header accepted but php tail blocked
 - 这是 challenge 级背景更新；把它当作参考假设，不要直接当作结论。`.replace(/^ /gm, ""),
        })
    })

    test("addIdea does not broadcast when dedupe returns an existing challenge idea", async () => {
        const sendCommand = mock(() => {})
        manager.attachRuntime({
            list: () => [{ id: "solver-a", challengeId: "chal-1", status: "running" }],
            sendCommand,
        } as never)

        await manager.addIdea("chal-1", {
            content: "test upload parser differential",
        })
        sendCommand.mockClear()

        const result = await manager.addIdea("chal-1", {
            content: "  TEST UPLOAD PARSER DIFFERENTIAL  ",
        })

        expect(result.created).toBe(false)
        expect(sendCommand).not.toHaveBeenCalled()
    })

    test("finishChallenge stops challenge instance and matching active solvers", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-finish",
            title: "mock-finish",
            instance_status: "running",
            assets: { urls: [{ asset: "https://done.example", scanned: true }], ips: [] },
        }))

        const stopSolver = mock(async () => {})
        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "mock-finish", status: "running" },
            { id: "solver-b", challengeId: "mock-finish", status: "starting" },
            { id: "solver-c", challengeId: "other", status: "running" },
            { id: "solver-d", challengeId: "mock-finish", status: "stopped" },
        ])
        manager.attachRuntime({ listAll, stopSolver } as never)

        await manager.finishChallenge("mock-finish")

        expect(stopSolver).toHaveBeenCalledTimes(2)
        expect(stopSolver).toHaveBeenNthCalledWith(1, "solver-a")
        expect(stopSolver).toHaveBeenNthCalledWith(2, "solver-b")

        const challenge = await manager.getChallenge("mock-finish")
        expect(challenge?.instance_status).toBe("stopped")
    })

    test("planner tools do not expose hint action", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-plan-hint",
            title: "mock-plan-hint",
            planner_prompt: "本项目优先验证弱口令入口",
            hint_content: "planner hint",
            instance_status: "running",
            assets: { urls: [{ asset: "https://planner-hint.example", scanned: false }], ips: [] },
            flags: ["flag{ok}"],
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: { challengeId: string }) => Promise<unknown> }> }).createPlannerTools(snapshot)

        expect(tools.some((tool) => tool.name === "planner_get_hint")).toBe(false)
        const stateTool = tools.find((tool) => tool.name === "planner_get_state")
        const stateResult = await stateTool?.execute("tool-call-1", { challengeId: "mock-plan-hint" }) as { content?: Array<{ text?: string }> } | undefined
        expect(stateResult?.content?.[0]?.text).toContain("Project Planner Prompt")
        expect(stateResult?.content?.[0]?.text).toContain("本项目优先验证弱口令入口")
    })

    test("planner state renders asset targets with scanned status", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-assets-plan",
            title: "mock-assets-plan",
            description: "asset scoped project",
            assets: {
                urls: [
                    { asset: "https://portal.example/login", scanned: true },
                    { asset: "https://api.portal.example", scanned: false },
                ],
                ips: [{ asset: "10.0.0.8:8080", scanned: false }],
            },
            flags: ["flag{ok}"],
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: () => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stateTool = tools.find((tool) => tool.name === "planner_get_state")
        const stateResult = await stateTool?.execute() as { content?: Array<{ text?: string }> } | undefined
        const text = stateResult?.content?.[0]?.text ?? ""

        expect(text).toContain("## Projects")
        expect(text).toContain("| ID | Name | Instance | Solvers | URL Targets | IP Targets | Scanned | Pending | Untouched | Stale |")
        expect(text).toContain("- URL targets: 2")
        expect(text).toContain("- IP targets: 1")
        expect(text).toContain("- Scanned targets: 1")
        expect(text).toContain("- Pending targets: 2")
        expect(text).toContain("| Asset Hash | Target | Scanned |")
        expect(text).toContain(`| ${hashChallengeAsset("https://portal.example/login")} | https://portal.example/login | yes |`)
        expect(text).toContain("| https://portal.example/login | yes |")
        expect(text).toContain("| https://api.portal.example | no |")
        expect(text).toContain("| 10.0.0.8:8080 | no |")
        expect(text).not.toContain("Entrypoints:")
        expect(text).not.toContain("Difficulty")
        expect(text).not.toContain("Score")
        expect(text).not.toContain("Flags")
        expect(text).not.toContain("Hint viewed")
    })

    test("planner launch solver requires explicit promptName", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-explicit-prompt-launch",
            title: "mock-explicit-prompt-launch",
            instance_status: "running",
            assets: { urls: [{ asset: "https://explicit-prompt.example", scanned: false }], ips: [] },
        }))

        const launch = mock(async (promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-explicit-prompt",
            containerId: options?.solverId ?? "solver-explicit-prompt",
            name: options?.solverId ?? "solver-explicit-prompt",
            promptName,
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ listAll: mock(async () => []), launch } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId?: string) => Promise<unknown> }).buildPlannerSnapshot(
            "test",
            "mock-explicit-prompt-launch",
        )
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }> }).createPlannerTools(snapshot)
        const launchTool = tools.find((tool) => tool.name === "planner_launch_solver")

        await expect(launchTool?.execute("tool-call-1", {
            challengeId: "mock-explicit-prompt-launch",
            solverHandoff: "check the explicit prompt path",
        })).rejects.toThrow("promptName is required")

        await expect(launchTool?.execute("tool-call-2", {
            challengeId: "mock-explicit-prompt-launch",
            promptName: "pentest-orchestrator",
            solverHandoff: "check the explicit prompt path",
        })).rejects.toThrow("entrypoints is required")

        await expect(launchTool?.execute("tool-call-3", {
            challengeId: "mock-explicit-prompt-launch",
            promptName: "pentest-orchestrator",
            entrypoints: [{ asset_hash: hashChallengeAsset("https://outside.example"), asset: "https://outside.example" }],
            solverHandoff: "check the explicit prompt path",
        })).rejects.toThrow("entrypoints contain invalid asset hash/target pairs")

        await launchTool?.execute("tool-call-4", {
            challengeId: "mock-explicit-prompt-launch",
            promptName: "pentest-orchestrator",
            entrypoints: [{ asset_hash: hashChallengeAsset("https://explicit-prompt.example"), asset: "https://explicit-prompt.example" }],
            solverHandoff: "check the explicit prompt path",
        })

        expect(launch).toHaveBeenCalledTimes(1)
        expect(launch.mock.calls[0]?.[0]).toBe("pentest-orchestrator")
        expect(launch.mock.calls[0]?.[1]).toContain(`目标入口:\n- [${hashChallengeAsset("https://explicit-prompt.example")}] https://explicit-prompt.example`)
        expect(launch.mock.calls[0]?.[1]).not.toContain("目标入口:\n- 127.0.0.1:8080")
    })

    test("planner snapshot filters to pending asset projects", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-pending-assets",
            title: "mock-pending-assets",
            assets: { urls: [{ asset: "https://pending.example", scanned: false }], ips: [] },
            flags: ["flag{ok}"],
        }))
        await manager.createChallenge(buildTestChallenge({
            id: "mock-scanned-assets",
            title: "mock-scanned-assets",
            assets: { urls: [{ asset: "https://scanned.example", scanned: true }], ips: [] },
            flags: ["flag{ok}"],
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ challenges: Array<{ id: string }> }> }).buildPlannerSnapshot("test")

        expect(snapshot.challenges.map((challenge) => challenge.id)).toEqual(["mock-pending-assets"])
    })

    test("planner loop eligibility skips disabled pending projects", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-disabled-loop",
            title: "mock-disabled-loop",
            planner_enabled: false,
            assets: { urls: [{ asset: "https://disabled.example", scanned: false }], ips: [] },
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const eligible = await (manager as unknown as { shouldRunPlannerForPendingAssets: (settings: { runtime: { maxSolvers?: number }; planner: {}; auth: {} }) => Promise<boolean> })
            .shouldRunPlannerForPendingAssets({ runtime: { maxSolvers: 1 }, planner: {}, auth: {} })

        expect(eligible).toBe(false)
    })

    test("planner loop eligibility skips when solver capacity is full", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-full-loop",
            title: "mock-full-loop",
            assets: { urls: [{ asset: "https://pending.example", scanned: false }], ips: [] },
        }))

        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "mock-full-loop", status: "running", promptName: "p", createdAt: Date.now() },
        ])
        manager.attachRuntime({ listAll } as never)

        const eligible = await (manager as unknown as { shouldRunPlannerForPendingAssets: (settings: { runtime: { maxSolvers?: number }; planner: {}; auth: {} }) => Promise<boolean> })
            .shouldRunPlannerForPendingAssets({ runtime: { maxSolvers: 1 }, planner: {}, auth: {} })

        expect(eligible).toBe(false)
    })

    test("planner loop eligibility allows enabled pending projects with solver capacity", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-eligible-loop",
            title: "mock-eligible-loop",
            assets: { urls: [{ asset: "https://pending.example", scanned: false }], ips: [] },
        }))

        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "other", status: "stopped", promptName: "p", createdAt: Date.now() },
        ])
        manager.attachRuntime({ listAll } as never)

        const eligible = await (manager as unknown as { shouldRunPlannerForPendingAssets: (settings: { runtime: { maxSolvers?: number }; planner: {}; auth: {} }) => Promise<boolean> })
            .shouldRunPlannerForPendingAssets({ runtime: { maxSolvers: 1 }, planner: {}, auth: {} })

        expect(eligible).toBe(true)
    })

    test("planner snapshot shows idle running challenge instances without active solvers", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-idle-instance",
            title: "mock-idle-instance",
            instance_status: "running",
            assets: { urls: [{ asset: "https://scanned.example", scanned: true }], ips: [] },
        }))
        await manager.createChallenge(buildTestChallenge({
            id: "mock-pending-assets",
            title: "mock-pending-assets",
            instance_status: "stopped",
            assets: { urls: [{ asset: "https://pending.example", scanned: false }], ips: [] },
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ constraints: { activeChallenges: number }; challenges: Array<{ id: string; idleInstance: boolean }> }> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: () => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stateTool = tools.find((tool) => tool.name === "planner_get_state")
        const stateResult = await stateTool?.execute() as { content?: Array<{ text?: string }> } | undefined
        const text = stateResult?.content?.[0]?.text ?? ""

        expect(snapshot.constraints.activeChallenges).toBe(1)
        expect(snapshot.challenges.map((challenge) => challenge.id)).toEqual(["mock-pending-assets", "mock-idle-instance"])
        expect(snapshot.challenges.find((challenge) => challenge.id === "mock-idle-instance")?.idleInstance).toBe(true)
        expect(text).toContain("Idle Instance")
        expect(text).toContain("| mock-idle-instance |")
        expect(text).toContain("- Idle instance: yes")
    })

    test("planner stop challenge allows idle running challenge instances", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-idle-stop",
            title: "mock-idle-stop",
            instance_status: "running",
            assets: { urls: [{ asset: "https://scanned.example", scanned: true }], ips: [] },
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: { challengeId: string }) => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stopTool = tools.find((tool) => tool.name === "planner_stop_challenge")

        await stopTool?.execute("tool-call-stop", { challengeId: "mock-idle-stop" })

        const challenge = await manager.getChallenge("mock-idle-stop")
        expect(challenge?.instance_status).toBe("stopped")
    })

    test("planner stop challenge still blocks non-stale active solver work", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-active-stop-blocked",
            title: "mock-active-stop-blocked",
            instance_status: "running",
            assets: { urls: [{ asset: "https://pending.example", scanned: false }], ips: [] },
        }))

        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "mock-active-stop-blocked", status: "running", promptName: "p", createdAt: Date.now() },
        ])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: { challengeId: string }) => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stopTool = tools.find((tool) => tool.name === "planner_stop_challenge")

        await expect(stopTool?.execute("tool-call-stop", { challengeId: "mock-active-stop-blocked" })).rejects.toThrow("not stale or idle")
    })

    test("updateChallengeAssetScanned persists asset scan state", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-mark-scanned",
            title: "mock-mark-scanned",
            assets: { urls: [{ asset: "https://target.example", scanned: false }], ips: [] },
            flags: ["flag{ok}"],
        }))

        const updated = await manager.updateChallengeAssetScanned("mock-mark-scanned", "urls", "https://target.example", true)

        expect(updated.assets?.urls).toEqual([assetRecord("https://target.example", true)])
    })

    test("disabled planner projects are excluded and reject manual planner start", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-disabled-planner",
            title: "mock-disabled-planner",
            planner_enabled: false,
            assets: { urls: [{ asset: "https://disabled.example", scanned: false }], ips: [] },
            flags: ["flag{ok}"],
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const challenge = await manager.getChallenge("mock-disabled-planner")
        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ challenges: Array<{ id: string }> }> }).buildPlannerSnapshot("test")

        expect(challenge?.planner_enabled).toBe(false)
        expect(challenge?.planner_status).toBe("disabled")
        expect(snapshot.challenges).toEqual([])
        await expect(manager.runPlannerForChallenge("mock-disabled-planner", "solver-prompt")).rejects.toThrow("planner is disabled")
    })

    test("updateChallengePlannerEnabled toggles disabled status", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-toggle-planner",
            title: "mock-toggle-planner",
            assets: { urls: [{ asset: "https://toggle.example", scanned: false }], ips: [] },
            flags: ["flag{ok}"],
        }))

        const disabled = await manager.updateChallengePlannerEnabled("mock-toggle-planner", false)
        const enabled = await manager.updateChallengePlannerEnabled("mock-toggle-planner", true)

        expect(disabled.planner_enabled).toBe(false)
        expect(disabled.planner_status).toBe("disabled")
        expect(enabled.planner_enabled).toBe(true)
        expect(enabled.planner_status).toBe("stop")
    })

    test("project planner snapshot is scoped to one challenge", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "mock-plan-a",
            title: "mock-plan-a",
            planner_prompt: "只调度 A 项目",
            flags: ["flag{a}"],
        }))
        await manager.createChallenge(buildTestChallenge({
            id: "mock-plan-b",
            title: "mock-plan-b",
            planner_prompt: "不要出现在 A 项目 planner 状态里",
            flags: ["flag{b}"],
        }))

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId?: string) => Promise<{ challenges: Array<{ id: string }> }> }).buildPlannerSnapshot(
            "test",
            "mock-plan-a",
        )
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: () => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stateTool = tools.find((tool) => tool.name === "planner_get_state")
        const stateResult = await stateTool?.execute() as { content?: Array<{ text?: string }> } | undefined

        expect(snapshot.challenges.map((challenge) => challenge.id)).toEqual(["mock-plan-a"])
        expect(stateResult?.content?.[0]?.text).toContain("只调度 A 项目")
        expect(stateResult?.content?.[0]?.text).not.toContain("不要出现在 A 项目 planner 状态里")
    })

    test("deleteChallenge archives challenge and related solvers", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "delete-me",
            title: "delete-me",
            instance_status: "stopped",
        }))

        const stopSolver = mock(async () => {})
        const deleteSolver = mock(async () => {})
        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "delete-me", status: "stopped" },
            { id: "solver-b", challengeId: "other", status: "stopped" },
        ])
        manager.attachRuntime({ listAll, stopSolver, deleteSolver } as never)

        await manager.deleteChallenge("delete-me")

        expect(stopSolver).not.toHaveBeenCalled()
        expect(deleteSolver).toHaveBeenCalledTimes(1)
        expect(deleteSolver).toHaveBeenCalledWith("solver-a")
        expect(await manager.getChallenge("delete-me")).toBeUndefined()
        expect((await manager.listStoredChallenges()).some((item) => item.id === "delete-me")).toBe(false)
    })

    test("deleteChallenge stops active solvers before archiving them", async () => {
        await manager.createChallenge(buildTestChallenge({
            id: "delete-active",
            title: "delete-active",
            instance_status: "stopped",
        }))

        const stopSolver = mock(async () => {})
        const deleteSolver = mock(async () => {})
        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "delete-active", status: "running" },
            { id: "solver-b", challengeId: "delete-active", status: "starting" },
        ])
        manager.attachRuntime({ listAll, stopSolver, deleteSolver } as never)

        await manager.deleteChallenge("delete-active")

        expect(stopSolver).toHaveBeenCalledTimes(2)
        expect(deleteSolver).toHaveBeenCalledTimes(2)
    })

    test("deleteChallenge rejects empty id and missing challenge", async () => {
        await expect(manager.deleteChallenge("   ")).rejects.toThrow("challengeId is required")
        await expect(manager.deleteChallenge("missing-id")).rejects.toThrow('challenge "missing-id" not found')
    })
})
