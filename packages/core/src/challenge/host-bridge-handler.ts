import type { ChallengeManager } from "./manager"
import { AUTHORIZED_SOLVER_ENV, CHALLENGE_ENV_CHALLENGE_ID, CHALLENGE_ENV_PROJECT_ID } from "./env"
import type { IdeaStatus, MemoryKind } from "./memory"
import type { ChallengeTestResult } from "./store"
import type { HostBridgeHandleContext, HostBridgeHandleResult, HostBridgeHandler, SolverInstance } from "../runtime/types"
import { parseSolverAssignmentReview } from "./solver-review"

function getObjectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return value as Record<string, unknown>
}

function getRequiredString(data: Record<string, unknown>, key: string): string {
    const value = data[key]
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${key} is required`)
    }
    return value.trim()
}

function getOptionalString(data: Record<string, unknown>, key: string): string | undefined {
    const value = data[key]
    if (typeof value !== "string") return
    const text = value.trim()
    return text || undefined
}

function getStringArray(data: Record<string, unknown>, key: string): string[] {
    const value = data[key]
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === "string")
}

function getOptionalTestResults(data: Record<string, unknown>): ChallengeTestResult[] | undefined {
    const value = data.test_results
    if (value === undefined) return
    if (!Array.isArray(value)) throw new Error("test_results must be an array")
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("test_results items must be objects")
        const result = item as Record<string, unknown>
        const testItem = getRequiredString(result, "test_item")
        const evidence = getRequiredString(result, "evidence")
        if (result.status !== "completed" && result.status !== "blocked") throw new Error("test_results status must be completed or blocked")
        return { test_item: testItem, status: result.status, evidence }
    })
}

function getOptionalDiscoveries(data: Record<string, unknown>): string[] | undefined {
    const value = data.discoveries
    if (value === undefined) return
    if (!Array.isArray(value)) throw new Error("discoveries must be an array")
    return value.map((item) => {
        if (typeof item !== "string" || !item.trim()) throw new Error("discoveries items must be non-empty strings")
        return item.trim()
    })
}

function getMemoryKind(data: Record<string, unknown>): MemoryKind {
    const value = getRequiredString(data, "kind")
    if (value === "fact" || value === "evidence" || value === "failure" || value === "note" || value === "hint") {
        return value
    }
    throw new Error(`invalid memory kind: ${value}`)
}

function getOptionalIdeaStatus(data: Record<string, unknown>): IdeaStatus | undefined {
    const value = getOptionalString(data, "status")
    if (!value) return
    if (value === "pending" || value === "testing" || value === "verified" || value === "failed" || value === "skipped") {
        return value
    }
    throw new Error(`invalid idea status: ${value}`)
}

function getRequiredChallengeId(getSolverEnvValue: (key: string) => string | undefined): string {
    const challengeId = getSolverEnvValue(CHALLENGE_ENV_CHALLENGE_ID)
    if (!challengeId) {
        throw new Error(`${CHALLENGE_ENV_CHALLENGE_ID} is required for challenge actions`)
    }
    return challengeId
}

async function assertBoundProject(challengeManager: ChallengeManager, challengeId: string, getSolverEnvValue: (key: string) => string | undefined): Promise<void> {
    const assertBinding = (challengeManager as Partial<ChallengeManager>).assertSolverProjectBinding
    if (typeof assertBinding === "function") {
        await assertBinding.call(challengeManager, challengeId, getSolverEnvValue(CHALLENGE_ENV_PROJECT_ID))
    }
}

function getSolverPromptName(solver?: SolverInstance): string | undefined {
    return solver?.promptName?.trim() || undefined
}

function getSolverModelName(startup: unknown): string | undefined {
    if (!startup || typeof startup !== "object" || !("sessionOptions" in startup)) return
    const sessionOptions = (startup as { sessionOptions?: unknown }).sessionOptions
    if (!sessionOptions || typeof sessionOptions !== "object" || !("model" in sessionOptions)) return
    const model = (sessionOptions as { model?: unknown }).model
    if (!model || typeof model !== "object") return
    const provider = (model as { provider?: unknown }).provider
    const id = (model as { id?: unknown }).id
    const providerText = typeof provider === "string" ? provider.trim() : ""
    const idText = typeof id === "string" ? id.trim() : ""
    const text = [providerText, idText].filter(Boolean).join("/")
    return text || undefined
}

function sendSteerToSolver(context: HostBridgeHandleContext, solverId: string, message: string): void {
    const text = message.trim()
    if (!text) return
    context.sendCommand?.(solverId, {
        type: "steer",
        message: text,
    })
}

function sendHintToSolver(context: HostBridgeHandleContext, solverId: string, hintContent: string): void {
    const message = hintContent.trim()
    if (!message) return
    sendSteerToSolver(context, solverId, `系统同步：赛题 hint 已更新。\n- 立即吸收这条 hint，并结合当前路线评估是否需要转向。\n- 如果它改变了攻击面理解，优先刷新 memory_list / idea_list。\n- hint:\n${message}`)
}

async function broadcastHintToChallengeSolvers(challengeManager: ChallengeManager, context: HostBridgeHandleContext, challengeId: string, hintContent: string): Promise<void> {
    const targetChallengeId = challengeId.trim()
    const message = hintContent.trim()
    if (!targetChallengeId || !message) return
    const candidates = (context.listSolvers?.() ?? []).filter((solver) => solver.challengeId === targetChallengeId && solver.status === "running")
    const recipients = await Promise.all(candidates.map(async (solver) => {
        try {
            return await challengeManager.isSolverTaskCompleted(targetChallengeId, solver.id) ? undefined : solver
        } catch {
            return solver
        }
    }))
    for (const solver of recipients) {
        if (!solver) continue
        try {
            sendHintToSolver(context, solver.id, message)
        } catch {
            // ignore inactive solver pipes
        }
    }
}

async function handleChallengeAction(
    challengeManager: ChallengeManager,
    context: HostBridgeHandleContext,
): Promise<HostBridgeHandleResult> {
    const { solverId, action, params, getSolverEnvValue, getSolver, getSolverStartup } = context
    const data = getObjectValue(params)

    switch (action) {
        case "challenge_get_state": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const challenge = await challengeManager.getChallenge(challengeId)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            return { handled: true, data: { challenge_id: challengeId, challenge, is_completed: isCompleted } }
        }
        case "challenge_get_hint": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const challenge = await challengeManager.getChallenge(challengeId)
            const cachedHint = challenge?.hint_content?.trim()
            if (cachedHint) {
                return {
                    handled: true,
                    data: {
                        code: challengeId,
                        hint_content: cachedHint,
                    },
                }
            }
            const result = await challengeManager.getHint(challengeId)
            if (result.remote.hint_content?.trim()) {
                await broadcastHintToChallengeSolvers(challengeManager, context, challengeId, result.remote.hint_content)
            }
            return { handled: true, data: result.remote }
        }
        case "challenge_submit_report": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const assetHash = getRequiredString(data, "asset_hash")
            const report = getRequiredString(data, "report")
            const testResults = getOptionalTestResults(data)
            const discoveries = getOptionalDiscoveries(data)
            const result = await challengeManager.submitReport(challengeId, {
                assetHash,
                report,
                solverId,
                promptName: getSolverPromptName(getSolver?.()),
                modelName: getSolverModelName((await getSolverStartup?.()) ?? undefined),
                ...(testResults !== undefined ? { testResults } : {}),
                ...(discoveries !== undefined ? { discoveries } : {}),
            })
            return { handled: true, data: { challenge_id: challengeId, ...result } }
        }
        case "challenge_is_completed": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            const solverTaskCompleted = await challengeManager.isSolverTaskCompleted(challengeId, solverId)
            const context = await challengeManager.getSolverReviewContext(challengeId, solverId)
            if (context.current_review && !context.current_review.decision) challengeManager.requestSolverReviewPlanner(challengeId)
            if (context.current_review?.decision?.action === "continue" && getSolver?.()?.status === "running") {
                const decision = context.current_review.decision
                await challengeManager.decideSolverReview(challengeId, context.current_review.id, "continue", decision.rationale, decision.instructions)
            }
            return { handled: true, data: {
                challenge_id: challengeId, is_completed: isCompleted, solver_task_completed: solverTaskCompleted,
                solver_review_pending: context.solver_review_pending,
                solver_resume_required: context.solver_resume_required,
                solver_stop_approved: context.solver_stop_approved,
            } }
        }
        case "challenge_get_solver_review_context": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            return { handled: true, data: await challengeManager.getSolverReviewContext(challengeId, solverId) }
        }
        case "challenge_submit_solver_review": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const review = parseSolverAssignmentReview(data.review)
            if (!Array.isArray(data.submission_ids) || data.submission_ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error("submission_ids is required")
            const result = await challengeManager.submitSolverReview(challengeId, solverId, data.submission_ids as string[], review)
            return { handled: true, data: result }
        }
        case "challenge_memory_list": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const items = await challengeManager.listMemory(challengeId)
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_board_refresh": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const board = await challengeManager.readMemoryBoard(challengeId)
            return {
                handled: true,
                data: {
                    challenge_id: challengeId,
                    authoritative: true,
                    ...board,
                },
            }
        }
        case "challenge_memory_add": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const entry = await challengeManager.appendMemory({
                challengeId,
                kind: getMemoryKind(data),
                content: getRequiredString(data, "content"),
                refs: getStringArray(data, "refs"),
                source: `observer:${solverId}`,
            })
            return { handled: true, data: { challenge_id: challengeId, entry } }
        }
        case "challenge_idea_list": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const items = await challengeManager.listIdeas(challengeId)
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_idea_search": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const items = await challengeManager.searchIdeas(challengeId, getRequiredString(data, "query"))
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_idea_add": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const status = getOptionalIdeaStatus(data)
            const result = await challengeManager.addIdea(challengeId, {
                content: getRequiredString(data, "content"),
                ...(status ? { status } : {}),
                ...(data.result !== undefined ? { result: getOptionalString(data, "result") ?? "" } : {}),
            })
            return { handled: true, data: { challenge_id: challengeId, ...result } }
        }
        case "challenge_authorized_http": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const workRunId = getRequiredString({ workRunId: getSolverEnvValue("TCH_TARIC_WORK_RUN_ID") }, "workRunId")
            const resourceId = getRequiredString({ resourceId: getSolverEnvValue("TCH_TARIC_RESOURCE_ID") }, "resourceId")
            const ownerAgentId = getRequiredString({ ownerAgentId: getSolverEnvValue("TCH_TARIC_OWNER_AGENT_ID") }, "ownerAgentId")
            const generationText = getRequiredString({ generation: getSolverEnvValue("TCH_TARIC_WORK_GENERATION") }, "generation")
            const generation = Number(generationText)
            if (getSolverEnvValue(AUTHORIZED_SOLVER_ENV) !== "1" || ownerAgentId !== solverId || !Number.isSafeInteger(generation) || generation < 1) throw new Error("authorized Solver runtime binding is invalid")
            const result = await challengeManager.executeAuthorizedHttpAction({
                challengeId,
                workRunId,
                generation,
                agentId: solverId,
                resourceId,
                request: {
                    url: getRequiredString(data, "url"),
                    rationale: getRequiredString(data, "rationale"),
                    ...(typeof data.method === "string" ? { method: data.method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" } : {}),
                    ...(data.headers && typeof data.headers === "object" && !Array.isArray(data.headers) ? { headers: data.headers as Record<string, string> } : {}),
                    ...(typeof data.body === "string" ? { body: data.body } : {}),
                },
            })
            return { handled: true, data: result }
        }
        case "authorized_work_renew":
        case "authorized_work_finish": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            await assertBoundProject(challengeManager, challengeId, getSolverEnvValue)
            const workRunId = getRequiredString({ workRunId: getSolverEnvValue("TCH_TARIC_WORK_RUN_ID") }, "workRunId")
            const resourceId = getRequiredString({ resourceId: getSolverEnvValue("TCH_TARIC_RESOURCE_ID") }, "resourceId")
            const ownerAgentId = getRequiredString({ ownerAgentId: getSolverEnvValue("TCH_TARIC_OWNER_AGENT_ID") }, "ownerAgentId")
            const generation = Number(getRequiredString({ generation: getSolverEnvValue("TCH_TARIC_WORK_GENERATION") }, "generation"))
            if (getSolverEnvValue(AUTHORIZED_SOLVER_ENV) !== "1" || ownerAgentId !== solverId || !Number.isSafeInteger(generation) || generation < 1) throw new Error("authorized Solver runtime binding is invalid")
            const input = { challengeId, workRunId, generation, agentId: solverId, resourceId }
            if (action === "authorized_work_renew") await challengeManager.renewAuthorizedWorkRun(input)
            else await challengeManager.finishAuthorizedWorkRun(input)
            return { handled: true, data: { ok: true } }
        }
        default:
            return { handled: false }
    }
}

export function createChallengeHostBridgeHandler(challengeManager: ChallengeManager): HostBridgeHandler {
    return {
        async handle(context) {
            return handleChallengeAction(challengeManager, context)
        },
    }
}
