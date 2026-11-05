import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigManager } from "../config/index"
import type { SolverInstance } from "../runtime/types"
import type { SolverAssignmentReview } from "./solver-review"
import { parseSolverAssignmentReview } from "./solver-review"
import { ChallengeManager } from "./manager"
import { hashChallengeAsset } from "./store"

const roots: string[] = []
const originalDir = process.env.TCH_CHALLENGE_DIR

afterEach(async () => {
    if (originalDir === undefined) delete process.env.TCH_CHALLENGE_DIR
    else process.env.TCH_CHALLENGE_DIR = originalDir
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "tch-assignment-review-"))
    roots.push(root)
    process.env.TCH_CHALLENGE_DIR = root
    const config = {
        getHostSettings: async () => ({ runtime: { maxSolvers: 1 }, planner: {} }),
        listModelPrefs: async () => [], listAgentPrompts: async () => [],
    } as unknown as ConfigManager
    const manager = new ChallengeManager(config)
    const requestPlanner = mock(() => {})
    manager.requestSolverReviewPlanner = requestPlanner
    const challengeId = "review-project"
    const solverId = "review-solver"
    const asset = "https://review.example/"
    const hash = hashChallengeAsset(asset)
    const task = `目标入口:\n- [${hash}] ${asset}\n\n本次测试项:\n- A\n- B\n\n当前 Memory 摘要:\n无`
    await manager.createChallenge({ id: challengeId, name: "Review fixture", title: "Review fixture", description: "test", difficulty: "easy", level: 1, hint_viewed: false, instance_status: "running", entrypoint: [asset], assets: { urls: [{ asset, asset_hash: hash, scanned: false }], ips: [] } })
    await manager.appendAttemptLog({ challengeId, solverId, promptName: "test", task })
    const solver: SolverInstance = { id: solverId, challengeId, containerId: solverId, name: solverId, promptName: "test", task, status: "running", createdAt: Date.now() }
    const sendCommand = mock(() => {})
    const stopSolver = mock(async () => { solver.status = "stopped" })
    manager.attachRuntime({ list: () => [solver], listAll: async () => [solver], sendCommand, stopSolver } as never)
    async function report() {
        return manager.submitReport(challengeId, { solverId, assetHash: hash, report: "Claimed complete", testResults: [
            { test_item: "A", status: "completed", evidence: "request A returned response A" },
            { test_item: "B", status: "completed", evidence: "request B returned response B" },
        ] })
    }
    function review(verdict: "verified" | "unsupported" = "verified"): SolverAssignmentReview {
        return {
            summary: verdict === "verified" ? "Both tests have tool evidence" : "Test B was claimed without a tool result",
            checklist: [
                { asset_hash: hash, test_item: "A", verdict: "verified", evidence: "tool call and response A match the report" },
                { asset_hash: hash, test_item: "B", verdict, evidence: verdict === "verified" ? "tool call and response B match" : "no test B call in history" },
            ],
            concerns: verdict === "verified" ? [] : ["Unsupported completion claim"],
            remaining_work: verdict === "verified" ? [] : ["Execute B and attach raw response"],
            suggested_decision: verdict === "verified" ? "stop" : "continue",
        }
    }
    return { manager, config, root, challengeId, solverId, solver, hash, sendCommand, stopSolver, report, review, requestPlanner }
}

describe("Observer audit and Planner assignment decisions", () => {
    test("a report pauses for audit; only an audited Planner stop releases the solver", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        expect(context).toMatchObject({ review_required: true, solver_review_pending: true, solver_stop_approved: false })
        expect(f.stopSolver).not.toHaveBeenCalled()
        const review = await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review())
        expect(f.requestPlanner).toHaveBeenCalledWith(f.challengeId)
        expect((await f.manager.getSolverReviewContext(f.challengeId, f.solverId)).review_required).toBe(false)
        await f.manager.decideSolverReview(f.challengeId, review.id, "stop", "All assigned work is supported by evidence")
        expect(f.stopSolver).toHaveBeenCalledWith(f.solverId)
        expect(f.solver.status).toBe("stopped")
        expect((await f.manager.getSolverReviewContext(f.challengeId, f.solverId)).solver_stop_approved).toBe(true)
        const reloaded = new ChallengeManager(f.config)
        expect((await reloaded.listSolverReviews(f.challengeId))[0]?.decision?.action).toBe("stop")
    })

    test("a timed out Planner can recover a validated stop audit without losing the review", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        const audit = f.review()
        audit.concerns = ["The report includes a disclosed evidence boundary; no assigned item is incomplete."]
        await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, audit)
        const internal = f.manager as unknown as { recoverSafeSolverReviewStops(challengeId: string): Promise<void> }
        await internal.recoverSafeSolverReviewStops(f.challengeId)
        expect(f.stopSolver).toHaveBeenCalledWith(f.solverId)
        expect((await f.manager.getSolverReviewContext(f.challengeId, f.solverId)).solver_stop_approved).toBe(true)
    })

    test("a timed out global Planner tick also releases validated stop audits", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review())

        const internal = f.manager as unknown as {
            runPlannerOnce(source: string): Promise<unknown>
        }
        internal.runPlannerOnce = async () => {
            throw new Error("Planner decision timed out; pending reviews remain available for retry")
        }

        await f.manager.tickPlanner("challenge-planner:loop")

        expect(f.stopSolver).toHaveBeenCalledWith(f.solverId)
        expect((await f.manager.getSolverReviewContext(f.challengeId, f.solverId)).solver_stop_approved).toBe(true)
    })

    test("unsupported work resumes the same solver, and revised reports require a new audit", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        const review = await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review("unsupported"))
        await expect(f.manager.decideSolverReview(f.challengeId, review.id, "stop", "Trust the self-report")).rejects.toThrow("incomplete or unsupported")
        await expect(f.manager.decideSolverReview(f.challengeId, review.id, "continue", "Fix missing evidence")).rejects.toThrow("instructions")
        await f.manager.decideSolverReview(f.challengeId, review.id, "continue", "B lacks execution evidence", "Execute B and resubmit its evidence")
        expect(f.sendCommand).toHaveBeenCalledWith(f.solverId, expect.objectContaining({ type: "resume_assignment", reviewId: review.id }))
        expect(f.stopSolver).not.toHaveBeenCalled()
        expect(await f.manager.isSolverTaskCompleted(f.challengeId, f.solverId)).toBe(false)
        expect(await f.manager.getSolverReviewContext(f.challengeId, f.solverId)).toMatchObject({ review_required: false, solver_resume_required: true, solver_review_pending: false })
        await f.report()
        const revised = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        expect(revised).toMatchObject({ review_required: true, solver_resume_required: false })
        await expect(f.manager.decideSolverReview(f.challengeId, review.id, "stop", "Use old review")).rejects.toThrow("stale")
        const final = await f.manager.submitSolverReview(f.challengeId, f.solverId, revised.submission_ids, f.review())
        await f.manager.decideSolverReview(f.challengeId, final.id, "stop", "Corrections verified")
        expect(f.stopSolver).toHaveBeenCalledTimes(1)
    })

    test("audit cannot omit, duplicate, invent items or certify stale report versions", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        const incomplete = f.review()
        incomplete.checklist.pop()
        await expect(f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, incomplete)).rejects.toThrow("omits")
        const duplicate = f.review()
        duplicate.checklist.push(duplicate.checklist[0]!)
        await expect(f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, duplicate)).rejects.toThrow("duplicate")
        const extra = f.review()
        extra.checklist[1]!.test_item = "unassigned"
        await expect(f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, extra)).rejects.toThrow("unassigned")
        await f.report()
        await expect(f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review())).rejects.toThrow("reports changed")
    })

    test("a full solver pool with all assets claimed still exposes the audit and decision tool", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        const review = await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review())
        const internal = f.manager as unknown as {
            shouldRunPlannerForPendingAssets(): Promise<boolean>
            buildPlannerSnapshot(source: string, challengeId: string): Promise<{ challenges: Array<{ solverReviews: unknown[] }>; constraints: { activeSolvers: number; maxSolvers: number } }>
            createPlannerTools(snapshot: unknown): Array<{ name: string; execute(id: string, params: unknown): Promise<unknown> }>
        }
        const snapshot = await internal.buildPlannerSnapshot("review-test", f.challengeId)
        expect(await internal.shouldRunPlannerForPendingAssets()).toBe(true)
        expect(snapshot.constraints.activeSolvers).toBe(snapshot.constraints.maxSolvers)
        expect(snapshot.challenges[0]?.solverReviews).toHaveLength(1)
        const decide = internal.createPlannerTools(snapshot).find((tool) => tool.name === "planner_decide_solver")!
        await decide.execute("decision", { challengeId: f.challengeId, reviewId: review.id, decision: "stop", rationale: "Audit passed" })
        expect(f.solver.status).toBe("stopped")
    })

    test("an audit queued during another Planner round runs despite a full solver pool", async () => {
        const f = await fixture()
        await f.report()
        f.manager.requestSolverReviewPlanner = ChallengeManager.prototype.requestSolverReviewPlanner.bind(f.manager)
        let finishFirst!: () => void
        let rounds = 0
        const planner = f.manager as unknown as { runPlannerOnce(source: string): Promise<unknown> }
        planner.runPlannerOnce = async () => {
            rounds += 1
            if (rounds === 1) await new Promise<void>((resolve) => { finishFirst = resolve })
            else {
                const review = (await f.manager.listSolverReviews(f.challengeId))[0]!
                await f.manager.decideSolverReview(f.challengeId, review.id, "stop", "Queued audit passed")
            }
            return { message: "done", launchedSolvers: [] }
        }
        const initial = f.manager.tickPlanner("initial")
        while (rounds === 0) await Bun.sleep(5)
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, f.review())
        expect(rounds).toBe(1)
        finishFirst()
        await initial
        const deadline = Date.now() + 2000
        while (f.solver.status !== "stopped" && Date.now() < deadline) await Bun.sleep(5)
        expect(rounds).toBe(2)
        expect(f.solver.status).toBe("stopped")
    })

    test("an objectively blocked audit cannot approve a contradictory completed report", async () => {
        const f = await fixture()
        await f.report()
        const context = await f.manager.getSolverReviewContext(f.challengeId, f.solverId)
        const audit = f.review()
        audit.checklist[1]!.verdict = "blocked"
        audit.checklist[1]!.evidence = "The tool response showed the required account was unavailable"
        audit.remaining_work = ["B needs an account before it can be verified"]
        const review = await f.manager.submitSolverReview(f.challengeId, f.solverId, context.submission_ids, audit)
        await expect(f.manager.decideSolverReview(f.challengeId, review.id, "stop", "Real blocker handed to Planner")).rejects.toThrow("contradicts reported completion")
        expect(f.stopSolver).not.toHaveBeenCalled()
    })

    test("audit parsing rejects missing evidence and invalid verdicts", () => {
        expect(() => parseSolverAssignmentReview({})).toThrow()
        expect(() => parseSolverAssignmentReview({ summary: "ok", checklist: [{ asset_hash: "a", test_item: "A", verdict: "completed", evidence: "" }] })).toThrow()
    })
})
