import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import type { AuthorizedProjectBinding } from "../config/authorized-projects"
import type { AuthorizedChallengeProjection, AuthorizedChallengeProjectionProvider } from "./authorized-projection"
import { CHALLENGE_ENV_DIR, CHALLENGE_ENV_ARCHIVE_DIR } from "./env"
import { ChallengeManager, parsePlannerTextActions, resolvePlannerSolverPromptName } from "./manager"
import { appendChallengeSubmissionLog, hashChallengeAsset, listChallengeAttemptLogs, listChallengeSubmissionLogs, saveChallengeRecord, type ChallengeInfoRecord, type ChallengeRecord } from "./store"

function assetRecord(asset: string, scanned: boolean) {
    return { asset, asset_hash: hashChallengeAsset(asset), scanned }
}

function buildAssignedSolverTask(asset: string, testItems: string[]) {
    return `目标入口:\n- [${hashChallengeAsset(asset)}] ${asset}\n\n本次测试项:\n${testItems.map((item) => `- ${item}`).join("\n")}\n\n当前 Memory 摘要:\n无`
}

function buildTestChallenge(overrides: Pick<ChallengeRecord, "id"> & Record<string, unknown>): ChallengeRecord {
    const typed = overrides as Partial<ChallengeRecord> & Pick<ChallengeRecord, "id">
    const name = typed.name ?? typed.title ?? typed.id
    return {
        id: typed.id,
        ...(typed.project === undefined ? {} : { project: typed.project }),
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
import { deriveCompositeProjectKey } from "../project/types"

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
    test("planner prompt selection preserves a valid requested prompt", () => {
        expect(resolvePlannerSolverPromptName("  solver-a  ", ["solver-a", "solver-b"], "solver-b")).toBe("solver-a")
    })

    test("planner prompt selection falls back to the only available prompt", () => {
        expect(resolvePlannerSolverPromptName("unknown", ["msec-security"])).toBe("msec-security")
        expect(resolvePlannerSolverPromptName(undefined, ["msec-security"])).toBe("msec-security")
    })

    test("planner prompt selection uses the user's available preferred prompt", () => {
        expect(resolvePlannerSolverPromptName("unknown", ["solver-a", "solver-b"], "  solver-b  ")).toBe("solver-b")
        expect(resolvePlannerSolverPromptName(undefined, ["solver-a", "solver-b"], "solver-a")).toBe("solver-a")
    })

    test("planner prompt selection rejects ambiguous or unavailable defaults", () => {
        expect(() => resolvePlannerSolverPromptName("unknown", ["solver-a", "solver-b"])).toThrow("available prompts: solver-a, solver-b")
        expect(() => resolvePlannerSolverPromptName(undefined, ["solver-a", "solver-b"], "missing")).toThrow("invalid solver promptName (missing)")
        expect(() => resolvePlannerSolverPromptName("unknown", [], "solver-a")).toThrow("available prompts: none")
    })

    test("parses only supported planner lifecycle text actions", () => {
        const actions = parsePlannerTextActions(`
            <planner_launch_challenge>
            {"projectId":"c5b1c4f9"}
            </planner_launch_challenge>
            <planner_launch_solver>
            {"challengeId":"c5b1c4f9","promptName":"msec-security","solverHandoff":["first","second"],"entrypoints":[]}
            </planner_launch_solver>
            <planner_complete_asset>
            {"challengeId":"c5b1c4f9","assetHash":"66edf0e4270fe56e0133c72dafb11d31","rationale":"Reviewed all findings."}
            </planner_complete_asset>
            <planner_execute_arbitrary>
            {"command":"rm -rf /"}
            </planner_execute_arbitrary>
        `)

        expect(actions).toEqual([
            { toolName: "planner_start_challenge", args: { projectId: "c5b1c4f9" } },
            {
                toolName: "planner_launch_solver",
                args: { challengeId: "c5b1c4f9", promptName: "msec-security", solverHandoff: ["first", "second"], entrypoints: [] },
            },
            {
                toolName: "planner_complete_asset",
                args: { challengeId: "c5b1c4f9", assetHash: "66edf0e4270fe56e0133c72dafb11d31", rationale: "Reviewed all findings." },
            },
        ])
    })

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
        const list = await manager.listChallenges()
        expect(list.summary.platform_solved).toBe(0)
        expect(list.summary.reports_completed).toBe(0)
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

    test("asset completion waits for assigned tests and planner review of discoveries", async () => {
        const challengeId = "mock-test-result-completion"
        const asset = "https://assigned-tests.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            assets: { urls: [assetRecord(asset, false)], ips: [] },
        }))
        for (const [solverId, testItem] of [["solver-a", "A"], ["solver-b", "B"]] as const) {
            await manager.appendAttemptLog({ challengeId, solverId, promptName: "pentest-orchestrator", task: buildAssignedSolverTask(asset, [testItem]) })
        }
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }> }).createPlannerTools({
            challenges: [{ id: challengeId }],
            availableSolverPrompts: [],
            activeSolvers: [],
        })
        const completeAssetTool = tools.find((tool) => tool.name === "planner_complete_asset")!
        await expect(completeAssetTool.execute("review-before-report", {
            challengeId,
            assetHash,
            rationale: "Attempt to review without a solver report.",
        })).rejects.toThrow("asset has no solver report to review")

        await expect(manager.submitReport(challengeId, {
            solverId: "solver-a",
            assetHash,
            report: "A report without per-test results",
        })).rejects.toThrow("test_results must cover every assigned test item")
        await expect(manager.submitReport(challengeId, {
            solverId: "solver-a",
            assetHash,
            report: "A report with an unassigned test",
            testResults: [
                { test_item: "A", status: "completed", evidence: "A request and response" },
                { test_item: "extra", status: "completed", evidence: "extra request and response" },
            ],
        })).rejects.toThrow("test_results contains an unassigned test item")
        expect(await manager.listSubmissionLogs(challengeId)).toHaveLength(0)
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-a")).toBe(false)

        const completedA = await manager.submitReport(challengeId, {
            solverId: "solver-a",
            assetHash,
            report: "A completed with reproducible evidence",
            testResults: [{ test_item: "A", status: "completed", evidence: "A request and response" }],
        })
        expect(completedA.assets_scanned).toBe(0)
        expect(completedA.assets_pending).toBe(1)
        expect(completedA.assets_completed).toBe(false)
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-a")).toBe(true)
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-b")).toBe(false)

        const discoveries = ["An additional upload endpoint needs a separate follow-up test."]
        const blockedB = await manager.submitReport(challengeId, {
            solverId: "solver-b",
            assetHash,
            report: "B blocked by unavailable credentials",
            testResults: [{ test_item: "B", status: "blocked", evidence: "The endpoint returns 401 with the supplied credentials." }],
            discoveries,
        })
        expect(blockedB.assets_scanned).toBe(0)
        expect(blockedB.assets_pending).toBe(1)
        expect(blockedB.assets_completed).toBe(false)
        expect((await manager.getChallenge(challengeId))?.assets?.urls[0]?.scanned).toBe(false)
        const persistedBlocked = (await manager.listSubmissionLogs(challengeId)).find((item) => item.solver_id === "solver-b")
        expect(persistedBlocked?.discoveries).toEqual(discoveries)
        expect(persistedBlocked?.test_results).toEqual(blockedB.submission.test_results)
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-b")).toBe(true)
        await expect(completeAssetTool.execute("review-blocked-work", {
            challengeId,
            assetHash,
            rationale: "Attempt to review while B is blocked.",
        })).rejects.toThrow("asset still has incomplete assigned test items: B")

        await manager.appendAttemptLog({ challengeId, solverId: "solver-b-follow-up", promptName: "pentest-orchestrator", task: buildAssignedSolverTask(asset, ["B"]) })
        const completedB = await manager.submitReport(challengeId, {
            solverId: "solver-b-follow-up",
            assetHash,
            report: "B completed after credentials were provided",
            testResults: [{ test_item: "B", status: "completed", evidence: "Authenticated request and response complete the assigned test." }],
        })
        expect(completedB.assets_scanned).toBe(0)
        expect(completedB.assets_pending).toBe(1)
        expect(completedB.assets_completed).toBe(false)
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-b-follow-up")).toBe(true)
        expect(await manager.isSolverTaskCompleted(challengeId, "unknown-solver")).toBe(false)

        await completeAssetTool.execute("review-completed-work", {
            challengeId,
            assetHash,
            rationale: "Reviewed the upload discovery; completed tests A and B cover it and no further testing is needed.",
        })
        expect((await manager.getChallenge(challengeId))?.assets?.urls[0]?.scanned).toBe(true)
        expect(await manager.isChallengeCompleted(challengeId)).toBe(true)
    })

    test("a corrected blocked report supersedes that solver's earlier completed result", async () => {
        const challengeId = "mock-corrected-test-result"
        const asset = "https://corrected-result.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({ id: challengeId, assets: { urls: [assetRecord(asset, false)], ips: [] } }))
        await manager.appendAttemptLog({ challengeId, solverId: "solver-a", promptName: "pentest-orchestrator", task: buildAssignedSolverTask(asset, ["A"]) })
        await manager.submitReport(challengeId, {
            solverId: "solver-a", assetHash, report: "Initial result",
            testResults: [{ test_item: "A", status: "completed", evidence: "Initial response" }],
        })
        await Bun.sleep(2)
        await manager.submitReport(challengeId, {
            solverId: "solver-a", assetHash, report: "Corrected result: the response did not verify the test",
            testResults: [{ test_item: "A", status: "blocked", evidence: "Verification requires an account that is not available." }],
        })
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }> }).createPlannerTools({
            challenges: [{ id: challengeId }], availableSolverPrompts: [], activeSolvers: [],
        })
        const completeAsset = tools.find((tool) => tool.name === "planner_complete_asset")!
        await expect(completeAsset.execute("close-corrected-result", { challengeId, assetHash, rationale: "Review latest evidence" }))
            .rejects.toThrow("asset still has incomplete assigned test items: A")
        expect((await manager.getChallenge(challengeId))?.assets?.urls[0]?.scanned).toBe(false)
    })

    test("a completed assignment waits for final observer review before the planner closes its asset", async () => {
        const challengeId = "mock-final-observer-completion-gate"
        const asset = "https://observer-completion.example"
        const assetHash = hashChallengeAsset(asset)
        const task = buildAssignedSolverTask(asset, ["A"])
        await manager.createChallenge(buildTestChallenge({ id: challengeId, assets: { urls: [assetRecord(asset, false)], ips: [] } }))
        await manager.appendAttemptLog({ challengeId, solverId: "reporting-solver", promptName: "pentest-orchestrator", task })
        const report = await manager.submitReport(challengeId, {
            solverId: "reporting-solver",
            assetHash,
            report: "A is complete and the solver has no extra discoveries to report.",
            testResults: [{ test_item: "A", status: "completed", evidence: "A reproducible request and response complete the assignment." }],
        })
        expect(report.assets_scanned).toBe(0)
        expect(report.assets_pending).toBe(1)
        expect(report.assets_completed).toBe(false)
        expect(await manager.isSolverTaskCompleted(challengeId, "reporting-solver")).toBe(true)
        const finalIdea = await manager.addIdea(challengeId, { content: "The final observer found an import authorization candidate for planner review." })
        let solverActive = true
        manager.attachRuntime({
            listAll: mock(async () => [{ id: "reporting-solver", challengeId, task, status: solverActive ? "running" : "stopped", createdAt: Date.now() }]),
            stopSolver: mock(async () => {}),
        } as never)
        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId: string) => Promise<unknown> }).buildPlannerSnapshot("final-observer-gate", challengeId)
        expect(snapshot).toMatchObject({ challenges: [{
            sharedIdeas: expect.arrayContaining([expect.objectContaining({ id: finalIdea.item.id })]),
        }] })
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }> }).createPlannerTools(snapshot)
        const completeAsset = tools.find((tool) => tool.name === "planner_complete_asset")!
        const review = { challengeId, assetHash, rationale: "Reviewed the final observer candidate and verified no further testing is required." }

        await expect(completeAsset.execute("close-before-observer-exit", review)).rejects.toThrow("wait for assigned solvers to finish their final observer review")
        expect(await manager.isChallengeCompleted(challengeId)).toBe(false)
        solverActive = false
        await completeAsset.execute("close-after-observer-exit", review)
        expect(await manager.isChallengeCompleted(challengeId)).toBe(true)
    })

    test("a new discovery report reopens an asset that the planner already reviewed", async () => {
        const challengeId = "mock-late-report-discovery"
        const asset = "https://late-discovery.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({ id: challengeId, assets: { urls: [assetRecord(asset, false)], ips: [] } }))
        await manager.appendAttemptLog({ challengeId, solverId: "late-reporting-solver", promptName: "pentest-orchestrator", task: buildAssignedSolverTask(asset, ["A"]) })
        const testResults = [{ test_item: "A", status: "completed" as const, evidence: "Verified request and response for A." }]
        await manager.submitReport(challengeId, { solverId: "late-reporting-solver", assetHash, report: "A completed.", testResults })
        await manager.updateChallengeAssetScanned(challengeId, "urls", asset, true)
        expect(await manager.isChallengeCompleted(challengeId)).toBe(true)

        const reopened = await manager.submitReport(challengeId, {
            solverId: "late-reporting-solver",
            assetHash,
            report: "A remains complete, but a new import endpoint was discovered.",
            testResults,
            discoveries: ["Validate the newly observed import endpoint before closing the asset."],
        })

        expect(reopened.assets_scanned).toBe(0)
        expect(reopened.assets_pending).toBe(1)
        expect(reopened.assets_completed).toBe(false)
        expect(await manager.isChallengeCompleted(challengeId)).toBe(false)
        expect(await manager.isSolverTaskCompleted(challengeId, "late-reporting-solver")).toBe(true)
    })

    test("solver launch permits a blocked test handoff and rejects completed historical work", async () => {
        const challengeId = "mock-blocked-test-handoff"
        const asset = "https://test-handoff.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            instance_status: "running",
            assets: { urls: [assetRecord(asset, false)], ips: [] },
        }))
        for (const [solverId, testItem] of [["solver-completed", "A"], ["solver-blocked", "B"]] as const) {
            await manager.appendAttemptLog({ challengeId, solverId, promptName: "pentest-orchestrator", task: buildAssignedSolverTask(asset, [testItem]) })
        }
        await manager.submitReport(challengeId, {
            solverId: "solver-completed",
            assetHash,
            report: "A completed",
            testResults: [{ test_item: "A", status: "completed", evidence: "A completed evidence" }],
        })
        await manager.submitReport(challengeId, {
            solverId: "solver-blocked",
            assetHash,
            report: "B needs another solver",
            testResults: [{ test_item: "B", status: "blocked", evidence: "B blocked evidence" }],
        })
        const launch = mock(async (promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-follow-up",
            containerId: options?.solverId ?? "solver-follow-up",
            name: options?.solverId ?? "solver-follow-up",
            promptName,
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ listAll: mock(async () => []), launch } as never)

        await expect(manager.launchSolver(challengeId, "pentest-orchestrator", {
            entrypoints: [{ asset_hash: assetHash, asset }],
            testItems: ["A"],
        })).rejects.toMatchObject({ code: "SOLVER_ASSET_CONFLICT" })
        const solver = await manager.launchSolver(challengeId, "pentest-orchestrator", {
            entrypoints: [{ asset_hash: assetHash, asset }],
            testItems: ["B"],
        })

        expect(launch).toHaveBeenCalledTimes(1)
        expect(solver.task).toContain("本次测试项:\n- B")
        expect(await manager.listAttemptLogs(challengeId)).toHaveLength(3)
    })

    test("multi-asset handoff releases only the blocked asset and test pair", async () => {
        const challengeId = "mock-multi-asset-blocked-handoff"
        const completedAsset = "https://completed-test.example"
        const blockedAsset = "https://blocked-test.example"
        const completedHash = hashChallengeAsset(completedAsset)
        const blockedHash = hashChallengeAsset(blockedAsset)
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            instance_status: "running",
            assets: { urls: [assetRecord(completedAsset, false), assetRecord(blockedAsset, false)], ips: [] },
        }))
        const task = [
            "目标入口:",
            `- [${completedHash}] ${completedAsset}`,
            `- [${blockedHash}] ${blockedAsset}`,
            "",
            "本次测试项:",
            "- A",
            "",
            "当前 Memory 摘要:",
            "无",
        ].join("\n")
        await manager.appendAttemptLog({ challengeId, solverId: "original-solver", promptName: "pentest-orchestrator", task })
        await manager.submitReport(challengeId, {
            solverId: "original-solver",
            assetHash: completedHash,
            report: "A completed on the first asset",
            testResults: [{ test_item: "A", status: "completed", evidence: "First asset request and response verify A." }],
        })
        await manager.submitReport(challengeId, {
            solverId: "original-solver",
            assetHash: blockedHash,
            report: "A needs a handoff on the second asset",
            testResults: [{ test_item: "A", status: "blocked", evidence: "Second asset requires credentials unavailable to this solver." }],
        })
        const launch = mock(async (promptName: string, nextTask: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "follow-up-solver",
            containerId: options?.solverId ?? "follow-up-solver",
            name: options?.solverId ?? "follow-up-solver",
            promptName,
            task: nextTask,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({
            listAll: mock(async () => [{ id: "original-solver", challengeId, task, status: "stopped" }]),
            launch,
        } as never)

        await expect(manager.launchSolver(challengeId, "pentest-orchestrator", {
            entrypoints: [{ asset_hash: completedHash, asset: completedAsset }],
            testItems: ["A"],
        })).rejects.toMatchObject({ code: "SOLVER_ASSET_CONFLICT" })
        const followUp = await manager.launchSolver(challengeId, "pentest-orchestrator", {
            entrypoints: [{ asset_hash: blockedHash, asset: blockedAsset }],
            testItems: ["A"],
        })

        expect(launch).toHaveBeenCalledTimes(1)
        expect(followUp.task).toContain(`- [${blockedHash}] ${blockedAsset}`)
        expect(followUp.task).not.toContain(`- [${completedHash}] ${completedAsset}`)
        expect(followUp.task).toContain("本次测试项:\n- A")
    })

    test("a reported wildcard assignment leaves discoveries available for specific follow-up tests", async () => {
        const challengeId = "mock-wildcard-discovery-handoff"
        const asset = "https://wildcard-handoff.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            instance_status: "running",
            assets: { urls: [assetRecord(asset, false)], ips: [] },
        }))
        const task = `目标入口:\n- [${assetHash}] ${asset}\n\n当前 Memory 摘要:\n无`
        await manager.appendAttemptLog({ challengeId, solverId: "wildcard-solver", promptName: "pentest-orchestrator", task })
        const result = await manager.submitReport(challengeId, {
            solverId: "wildcard-solver",
            assetHash,
            report: "Initial asset review completed; a new import route requires a separate assignment.",
            discoveries: ["Validate authorization on the newly observed /imports endpoint."],
        })
        expect(result.assets_completed).toBe(false)
        expect(await manager.isSolverTaskCompleted(challengeId, "wildcard-solver")).toBe(true)
        const launch = mock(async (promptName: string, nextTask: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "specific-follow-up",
            containerId: options?.solverId ?? "specific-follow-up",
            name: options?.solverId ?? "specific-follow-up",
            promptName,
            task: nextTask,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({
            listAll: mock(async () => [{ id: "wildcard-solver", challengeId, task, status: "stopped" }]),
            launch,
        } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId: string) => Promise<unknown> }).buildPlannerSnapshot("wildcard-handoff-test", challengeId)
        expect(snapshot).toMatchObject({ challenges: [{
            id: challengeId,
            availableAssets: { urls: [expect.objectContaining({ asset_hash: assetHash, asset, scanned: false })], ips: [] },
        }] })
        const followUp = await manager.launchSolver(challengeId, "pentest-orchestrator", {
            entrypoints: [{ asset_hash: assetHash, asset }],
            testItems: ["Verify import authorization"],
        })

        expect(launch).toHaveBeenCalledTimes(1)
        expect(followUp.task).toContain("本次测试项:\n- Verify import authorization")
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
        await manager.finishChallenge("mock-normalized-assets")
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
        await manager.finishChallenge("mock-ip-port-distinct")
        const listed = await manager.listChallenges()
        expect(listed.summary.platform_solved).toBe(0)
        expect(listed.summary.solved).toBe(0)
        expect(listed.summary.reports_completed).toBe(1)
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

    test("remote challenge sync preserves the host-trusted project binding", async () => {
        const project = {
            mode: "competition" as const,
            tenant_id: "tenant-a",
            platform_id: "platform-a",
            competition_id: "competition-a",
            team_id: "team-a",
            challenge_code: "bound-project",
            provider: "local_practice" as const,
            memory_mode: "taric_best_effort" as const,
        }
        await manager.createChallengeFromInput({ name: "Bound Project", project })
        const before = await manager.listStoredChallenges()
        expect(before[0]?.project_id).toBe(deriveCompositeProjectKey(project))

        await manager.listChallenges()

        const after = await manager.getChallenge(before[0]!.id)
        expect(after?.project).toEqual(project)
        expect(after?.project_id).toBe(deriveCompositeProjectKey(project))
        expect(after?.memory_mode).toBe("taric_best_effort")
    })

    test("rebuilds authorized challenge, report and stats reads with no local challenge file", async () => {
        const project = {
            mode: "authorized_pentest" as const,
            tenant_id: "tenant-projection",
            engagement_id: "engagement-projection",
            scope_revision: 1,
            coverage_manifest_id: "manifest-projection",
            memory_mode: "taric_required" as const,
            taric_engagement_id: "engagement-projection",
        }
        const binding: AuthorizedProjectBinding = {
            challengeId: "projection-rebuild",
            title: "Projection rebuild",
            project,
            scopeId: "019a0000-0000-7000-8000-000000000008",
        }
        const challenge = {
            ...buildTestChallenge({ id: binding.challengeId, title: binding.title }),
            project,
            project_id: deriveCompositeProjectKey(project),
            project_classification: "trusted" as const,
            mode: "authorized_pentest" as const,
            memory_mode: "taric_required" as const,
            created_at: "2026-11-01T00:00:00.000Z",
            updated_at: "2026-11-02T00:00:00.000Z",
            source: "taric:canonical_projection",
        } satisfies ChallengeInfoRecord
        const projection: AuthorizedChallengeProjection = {
            challenge,
            attempts: [],
            submissions: [{ id: "report-1", challenge_id: challenge.id, asset_hash: "authorized-report", asset: "authorized-engagement", report: "canonical report", created_at: "2026-11-02T00:00:00.000Z" }],
            stats: {
                stats: { challenge_id: challenge.id, solver_count: 0, attempt_count: 0, submission_count: 1, solver_active_duration_ms_total: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }, updated_at: "2026-11-02T00:00:00.000Z" },
                solver_stats: [],
            },
            authority: {} as AuthorizedChallengeProjection["authority"],
        }
        const provider: AuthorizedChallengeProjectionProvider = {
            async listBindings() { return [binding] },
            async read(challengeId) { return challengeId === binding.challengeId ? projection : undefined },
            async registerFromManifest() { throw new Error("registration is not expected in this read test") },
        }
        const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
        const projectedManager = new ChallengeManager(config, undefined, undefined, undefined, provider)

        expect(await Bun.file(`${challengeDir}/${encodeURIComponent(challenge.id)}/challenge.json`).exists()).toBe(false)
        await expect(projectedManager.getChallenge(challenge.id)).resolves.toMatchObject({ source: "taric:canonical_projection", project_id: deriveCompositeProjectKey(project) })
        await expect(projectedManager.listStoredChallenges()).resolves.toEqual([challenge])
        await expect(projectedManager.listSubmissionLogs(challenge.id)).resolves.toEqual(projection.submissions)
        await expect(projectedManager.refreshStats(challenge.id)).resolves.toEqual(projection.stats)
        expect(await Bun.file(`${challengeDir}/${encodeURIComponent(challenge.id)}/challenge.json`).exists()).toBe(false)
    })

    test("recovers authorized WorkRuns once per startup and blocks replanning states", async () => {
        const project = {
            mode: "authorized_pentest" as const,
            tenant_id: "tenant-recovery",
            engagement_id: "engagement-recovery",
            scope_revision: 1,
            coverage_manifest_id: "manifest-recovery",
            memory_mode: "taric_required" as const,
            taric_engagement_id: "engagement-recovery",
        }
        const binding: AuthorizedProjectBinding = { challengeId: "recovery-project", title: "Recovery project", project, scopeId: "019a0000-0000-7000-8000-000000000008" }
        const challenge = buildTestChallenge({ id: binding.challengeId, title: binding.title, project, mode: "authorized_pentest", memory_mode: "taric_required", project_id: deriveCompositeProjectKey(project), project_classification: "trusted" }) as ChallengeInfoRecord
        const authority = { format: "breachweave-authorized-projection/1", source: "canonical_taric_records", readSeq: 9, refreshedAt: "2026-11-02T00:00:00.000Z", lifecycleMode: "taric_projection", diagnostics: { status: "complete", reconciliation: "matched", evidenceClass: "authority_projection" }, scope: [], scopeRevisions: [], resources: [], resourceRevisions: [], work: [], context: [], coverage: [], coverageGate: {}, evidence: [], actionAudit: [] } as AuthorizedChallengeProjection["authority"]
        let recoverCalls = 0
        const provider: AuthorizedChallengeProjectionProvider = {
            async listBindings() { return [binding] },
            async read() { return { challenge, attempts: [], submissions: [], stats: { stats: { challenge_id: challenge.id, solver_count: 0, attempt_count: 0, submission_count: 0, solver_active_duration_ms_total: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0 }, updated_at: authority.refreshedAt }, solver_stats: [] }, authority } },
            async prepareLifecycle() { return this.read(binding.challengeId) },
            async recoverStartup() {
                recoverCalls += 1
                return [{ workItemId: "work-item", resourceId: "resource", status: "replan_required", reason: "lease_reclaimed", generation: 2 }]
            },
            async registerFromManifest() {},
        }
        const config = { getHostSettings: async () => ({ runtime: {}, planner: {} }) } as unknown as ConfigManager
        const projectedManager = new ChallengeManager(config, undefined, undefined, undefined, provider)

        const first = await projectedManager.recoverAuthorizedStartup("test:first")
        const second = await projectedManager.recoverAuthorizedStartup("test:second")
        expect(recoverCalls).toBe(1)
        expect(first).toEqual(second)
        expect(projectedManager.getAuthorizedStartupRecovery()).toMatchObject([{ challengeId: binding.challengeId, status: "blocked", results: [{ reason: "lease_reclaimed", generation: 2 }] }])
        await expect(projectedManager.updateChallengePlannerStatus(binding.challengeId, "starting")).rejects.toMatchObject({ code: "TARIC_RECOVERY_REPLAN_REQUIRED" })

        await projectedManager.reloadFromConfig()
        await projectedManager.recoverAuthorizedStartup("test:after-reload")
        expect(recoverCalls).toBe(2)
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

    test("authorized projects are excluded from legacy planner context and block scoped planning", async () => {
        await saveChallengeRecord(challengeDir, buildTestChallenge({
            id: "authorized-planner",
            title: "authorized-planner",
            assets_url: "http://127.0.0.1:8080",
            project: {
                mode: "authorized_pentest",
                tenant_id: "tenant-local",
                engagement_id: "engagement-local",
                scope_revision: 1,
                coverage_manifest_id: "manifest-local",
                memory_mode: "taric_required",
                taric_engagement_id: "engagement-local",
            },
        }), "legacy-authorized-fixture")
        await manager.createChallenge(buildTestChallenge({
            id: "competition-planner",
            title: "competition-planner",
            assets_url: "https://competition.example",
        }))

        const listAll = mock(async () => [{ id: "authorized-solver", challengeId: "authorized-planner", status: "running" }])
        manager.attachRuntime({ listAll } as never)
        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ challenges: Array<{ id: string }>; activeSolvers: Array<{ id: string }> }> }).buildPlannerSnapshot("test")

        expect(snapshot.challenges.map((challenge) => challenge.id)).toContain("competition-planner")
        expect(snapshot.challenges.map((challenge) => challenge.id)).not.toContain("authorized-planner")
        expect(snapshot.activeSolvers.map((solver) => solver.id)).not.toContain("authorized-solver")
        await expect(manager.runPlannerForChallenge("authorized-planner", "pentest-orchestrator")).rejects.toMatchObject({
            code: "TARIC_GOVERNANCE_REQUIRED",
            operation: "planner",
        })
        await expect(manager.updateChallengePlannerStatus("authorized-planner", "starting")).rejects.toMatchObject({ code: "TARIC_AUTHORITY_REQUIRED" })
    })

    test("authorized solver launch blocks before local startup, board seeding, and runtime launch", async () => {
        await saveChallengeRecord(challengeDir, buildTestChallenge({
            id: "authorized-solver",
            title: "authorized-solver",
            assets_url: "http://127.0.0.1:8080",
            project: {
                mode: "authorized_pentest",
                tenant_id: "tenant-local",
                engagement_id: "engagement-local",
                scope_revision: 1,
                coverage_manifest_id: "manifest-local",
                memory_mode: "taric_required",
                taric_engagement_id: "engagement-local",
            },
        }), "legacy-authorized-fixture")
        const launch = mock(async () => { throw new Error("runtime launch must not be reached") })
        manager.attachRuntime({ launch } as never)

        await expect(manager.launchSolver("authorized-solver", "pentest-orchestrator")).rejects.toMatchObject({
            code: "TARIC_GOVERNANCE_REQUIRED",
            operation: "solver",
        })
        expect(launch).not.toHaveBeenCalled()
        expect((await manager.getChallenge("authorized-solver"))?.instance_status).toBe("stopped")
        expect(await manager.listAttemptLogs("authorized-solver")).toEqual([])
    })

    test("authorized lifecycle events cannot write local attempt state or use the competition stop API", async () => {
        const challenge = buildTestChallenge({
            id: "authorized-fenced-capture",
            title: "authorized-fenced-capture",
            project: {
                mode: "authorized_pentest",
                tenant_id: "tenant-local",
                engagement_id: "engagement-local",
                scope_revision: 1,
                coverage_manifest_id: "manifest-local",
                memory_mode: "taric_required",
                taric_engagement_id: "engagement-local",
            },
        })
        await saveChallengeRecord(challengeDir, challenge, "authorized-fixture")
        const fetch = mock(async () => { throw new Error("competition API must not be reached") })
        globalThis.fetch = fetch as unknown as typeof globalThis.fetch
        manager.attachRuntime({
            get: () => ({ id: "solver-a", challengeId: challenge.id, projectId: "forged-local-project", status: "running" }),
        } as never)

        await expect(manager.appendAttemptLog({ challengeId: challenge.id, solverId: "solver-a", promptName: "pentest-orchestrator", task: "test" })).rejects.toMatchObject({ code: "TARIC_AUTHORITY_REQUIRED" })
        await expect(manager.captureHostObservation(challenge.id, { sourceKind: "host_event", observation: {} })).rejects.toMatchObject({ code: "TARIC_RUN_FENCE_REQUIRED" })
        await expect(manager.stopChallenge(challenge.id)).rejects.toMatchObject({ code: "COMPLETION_DOMAIN_MISMATCH" })
        await manager.captureSolverEvent("solver-a", { type: "agent_end", generation: 999 })

        expect(fetch).not.toHaveBeenCalled()
        await expect(listChallengeAttemptLogs(challengeDir, challenge.id)).resolves.toEqual([])
        expect(await Bun.file(`${challengeDir}/${encodeURIComponent(challenge.id)}/taric-capture-audit.ndjson`).exists()).toBe(false)
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

    test("finishChallenge leaves reported solvers running for final observer review", async () => {
        const challengeId = "mock-finish-observer-review"
        const asset = "https://final-review.example"
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            instance_status: "stopped",
            assets: { urls: [assetRecord(asset, true)], ips: [] },
        }))
        await manager.appendAttemptLog({
            challengeId,
            solverId: "solver-reported",
            promptName: "pentest-orchestrator",
            task: buildAssignedSolverTask(asset, ["A"]),
        })
        await manager.submitReport(challengeId, {
            solverId: "solver-reported",
            assetHash: hashChallengeAsset(asset),
            report: "The assigned test is complete; final observer review is pending.",
            testResults: [{ test_item: "A", status: "completed", evidence: "Reproducible request and response for A." }],
        })
        expect(await manager.isSolverTaskCompleted(challengeId, "solver-reported")).toBe(true)
        await manager.updateChallengeAssetScanned(challengeId, "urls", asset, true)

        const stopSolver = mock(async () => {})
        manager.attachRuntime({
            listAll: mock(async () => [
                { id: "solver-reported", challengeId, status: "running" },
                { id: "solver-unreported", challengeId, status: "running" },
            ]),
            stopSolver,
        } as never)

        await manager.finishChallenge(challengeId)

        expect(stopSolver).toHaveBeenCalledTimes(1)
        expect(stopSolver).toHaveBeenCalledWith("solver-unreported")
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

    test("planner state includes shared findings, ideas, blocked test evidence and discoveries", async () => {
        const challengeId = "mock-planner-report-handoff"
        const asset = "https://planner-handoff.example"
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            assets: { urls: [assetRecord(asset, false)], ips: [] },
        }))
        const memory = await manager.appendMemory({
            challengeId,
            kind: "fact",
            content: "The authenticated portal exposes an upload endpoint.",
            refs: ["http-evidence-1"],
            source: "observer:solver-initial",
        })
        const idea = await manager.addIdea(challengeId, { content: "Verify the upload endpoint using a newly provisioned account." })
        await manager.appendAttemptLog({
            challengeId,
            solverId: "solver-initial",
            promptName: "pentest-orchestrator",
            task: buildAssignedSolverTask(asset, ["Upload authorization"]),
        })
        const submission = await manager.submitReport(challengeId, {
            solverId: "solver-initial",
            assetHash: hashChallengeAsset(asset),
            report: "The assigned upload authorization test needs valid credentials.",
            testResults: [{ test_item: "Upload authorization", status: "blocked", evidence: "The supplied account receives HTTP 401 from /upload." }],
            discoveries: ["A separate /imports endpoint was observed and requires follow-up."],
        })
        manager.attachRuntime({ listAll: mock(async () => []) } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId?: string) => Promise<unknown> }).buildPlannerSnapshot("test", challengeId)
        expect(snapshot).toMatchObject({ challenges: [{
            pendingTargetCount: 1,
            sharedMemory: expect.arrayContaining([expect.objectContaining({ id: memory.id, content: memory.content })]),
            sharedIdeas: expect.arrayContaining([expect.objectContaining({ content: idea.item.content })]),
            submissions: expect.arrayContaining([expect.objectContaining({
                id: submission.submission.id,
                test_results: [{ test_item: "Upload authorization", status: "blocked", evidence: "The supplied account receives HTTP 401 from /upload." }],
                discoveries: ["A separate /imports endpoint was observed and requires follow-up."],
            })]),
        }] })

        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: () => Promise<unknown> }> }).createPlannerTools(snapshot)
        const stateTool = tools.find((tool) => tool.name === "planner_get_state")
        const state = await stateTool?.execute() as { content?: Array<{ text?: string }> } | undefined
        const text = state?.content?.[0]?.text ?? ""
        expect(text).toContain(memory.content)
        expect(text).toContain(idea.item.content)
        expect(text).toContain(submission.submission.report)
        expect(text).toContain("Upload authorization: blocked; evidence: The supplied account receives HTTP 401 from /upload.")
        expect(text).toContain("Discovery for planner follow-up: A separate /imports endpoint was observed and requires follow-up.")
    })

    test("planner state keeps an older pending handoff after six newer completed asset reports", async () => {
        const challengeId = "mock-older-pending-report"
        const pendingAsset = "https://pending-handoff.example"
        const completedAssets = Array.from({ length: 6 }, (_, index) => `https://completed-${index + 1}.example`)
        await manager.createChallenge(buildTestChallenge({
            id: challengeId,
            assets: { urls: [assetRecord(pendingAsset, false), ...completedAssets.map((asset) => assetRecord(asset, true))], ips: [] },
        }))
        await manager.appendAttemptLog({ challengeId, solverId: "pending-solver", promptName: "pentest-orchestrator", task: buildAssignedSolverTask(pendingAsset, ["Pending authorization test"]) })
        await manager.submitReport(challengeId, {
            solverId: "pending-solver",
            assetHash: hashChallengeAsset(pendingAsset),
            report: "The earliest report contains an unresolved authorization handoff.",
            testResults: [{ test_item: "Pending authorization test", status: "blocked", evidence: "The original account cannot access the pending endpoint." }],
            discoveries: ["The oldest import candidate still needs a follow-up assignment."],
        })
        for (const asset of completedAssets) {
            await manager.submitReport(challengeId, { assetHash: hashChallengeAsset(asset), report: `Completed review of ${asset}.` })
        }
        expect(await manager.listSubmissionLogs(challengeId)).toHaveLength(7)
        manager.attachRuntime({ listAll: mock(async () => []) } as never)
        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId: string) => Promise<unknown> }).buildPlannerSnapshot("older-pending-handoff", challengeId)
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: () => Promise<unknown> }> }).createPlannerTools(snapshot)
        const state = await tools.find((tool) => tool.name === "planner_get_state")!.execute() as { content: Array<{ text: string }> }
        const text = state.content[0]!.text

        expect(text).toContain("The earliest report contains an unresolved authorization handoff.")
        expect(text).toContain("Pending authorization test: blocked; evidence: The original account cannot access the pending endpoint.")
        expect(text).toContain("Discovery for planner follow-up: The oldest import candidate still needs a follow-up assignment.")
    })

    test("planner launch solver rejects ambiguous promptName and validates the assignment", async () => {
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

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string, challengeId?: string) => Promise<{ availableSolverPrompts: Array<{ name: string }> }> }).buildPlannerSnapshot(
            "test",
            "mock-explicit-prompt-launch",
        )
        snapshot.availableSolverPrompts = [{ name: "pentest-orchestrator" }, { name: "another" }]
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }> }).createPlannerTools(snapshot)
        const launchTool = tools.find((tool) => tool.name === "planner_launch_solver")

        await expect(launchTool?.execute("tool-call-1", {
            challengeId: "mock-explicit-prompt-launch",
            solverHandoff: "check the explicit prompt path",
        })).rejects.toThrow("invalid solver promptName")

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

        await expect(launchTool?.execute("tool-call-5", {
            challengeId: "mock-explicit-prompt-launch",
            promptName: "pentest-orchestrator",
            entrypoints: [{ asset_hash: hashChallengeAsset("https://explicit-prompt.example"), asset: "https://explicit-prompt.example" }],
            solverHandoff: "repeat the same target",
        })).rejects.toThrow("asset/test assignment overlaps a solver already launched in this planner round")
        expect(launch).toHaveBeenCalledTimes(1)
    })

    test("solver launch rejects active asset overlap but allows a disjoint asset", async () => {
        const firstAsset = "https://first.example"
        const secondAsset = "https://second.example"
        const firstHash = hashChallengeAsset(firstAsset)
        const secondHash = hashChallengeAsset(secondAsset)
        await manager.createChallenge(buildTestChallenge({
            id: "mock-asset-claims",
            title: "mock-asset-claims",
            instance_status: "running",
            assets: {
                urls: [assetRecord(firstAsset, false), assetRecord(secondAsset, false)],
                ips: [],
            },
        }))

        const activeSolver = {
            id: "solver-first",
            containerId: "solver-first",
            name: "solver-first",
            promptName: "pentest-orchestrator",
            task: `目标入口:\n- [${firstHash}] ${firstAsset}`,
            challengeId: "mock-asset-claims",
            status: "running" as const,
            createdAt: Date.now(),
        }
        const launch = mock(async (promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-second",
            containerId: options?.solverId ?? "solver-second",
            name: options?.solverId ?? "solver-second",
            promptName,
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ listAll: mock(async () => [activeSolver]), launch } as never)

        await expect(manager.launchSolver("mock-asset-claims", "pentest-orchestrator", {
            entrypoints: [{ asset_hash: firstHash, asset: firstAsset }],
        })).rejects.toMatchObject({ code: "SOLVER_ASSET_CONFLICT" })

        const solver = await manager.launchSolver("mock-asset-claims", "pentest-orchestrator", {
            entrypoints: [{ asset_hash: secondHash, asset: secondAsset }],
        })
        expect(solver.task).toContain(`目标入口:\n- [${secondHash}] ${secondAsset}`)
        expect(launch).toHaveBeenCalledTimes(1)
    })

    test("solver launch allows different test items on the same asset", async () => {
        const asset = "https://same-target.example"
        const assetHash = hashChallengeAsset(asset)
        await manager.createChallenge(buildTestChallenge({
            id: "mock-test-item-claims",
            title: "mock-test-item-claims",
            instance_status: "running",
            assets: { urls: [assetRecord(asset, false)], ips: [] },
        }))
        const activeSolver = {
            id: "solver-sqli",
            containerId: "solver-sqli",
            name: "solver-sqli",
            promptName: "pentest-orchestrator",
            task: `目标入口:\n- [${assetHash}] ${asset}\n\n本次测试项:\n- SQL injection\n\n当前 Memory 摘要:`,
            challengeId: "mock-test-item-claims",
            status: "running" as const,
            createdAt: Date.now(),
        }
        const launch = mock(async (promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-xss",
            containerId: options?.solverId ?? "solver-xss",
            name: options?.solverId ?? "solver-xss",
            promptName,
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ listAll: mock(async () => [activeSolver]), launch } as never)

        const solver = await manager.launchSolver("mock-test-item-claims", "pentest-orchestrator", {
            entrypoints: [{ asset_hash: assetHash, asset }],
            testItems: ["Cross-site scripting"],
        })
        expect(solver.task).toContain("本次测试项:\n- Cross-site scripting")
        expect(launch).toHaveBeenCalledTimes(1)

        await expect(manager.launchSolver("mock-test-item-claims", "pentest-orchestrator", {
            entrypoints: [{ asset_hash: assetHash, asset }],
            testItems: ["SQL injection"],
        })).rejects.toMatchObject({ code: "SOLVER_ASSET_CONFLICT" })
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

    test("planner loop eligibility skips assets already claimed by an active solver", async () => {
        const firstAsset = "https://claimed-first.example"
        const secondAsset = "https://claimed-second.example"
        await manager.createChallenge(buildTestChallenge({
            id: "mock-claimed-loop",
            title: "mock-claimed-loop",
            assets: {
                urls: [assetRecord(firstAsset, false), assetRecord(secondAsset, false)],
                ips: [],
            },
        }))

        const task = [firstAsset, secondAsset]
            .map((asset) => `- [${hashChallengeAsset(asset)}] ${asset}`)
            .join("\n")
        const listAll = mock(async () => [{
            id: "solver-claimed",
            challengeId: "mock-claimed-loop",
            status: "running" as const,
            task: `目标入口:\n${task}`,
            promptName: "p",
            createdAt: Date.now(),
        }])
        manager.attachRuntime({ listAll } as never)

        const eligible = await (manager as unknown as { shouldRunPlannerForPendingAssets: (settings: { runtime: { maxSolvers?: number }; planner: {}; auth: {} }) => Promise<boolean> })
            .shouldRunPlannerForPendingAssets({ runtime: { maxSolvers: 3 }, planner: {}, auth: {} })

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
