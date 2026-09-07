import type { ChallengeManager } from "./manager"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type { IdeaStatus, MemoryKind } from "./memory"
import type { HostBridgeHandleContext, HostBridgeHandleResult, HostBridgeHandler, SolverInstance } from "../runtime/types"

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

function broadcastHintToChallengeSolvers(context: HostBridgeHandleContext, challengeId: string, hintContent: string): void {
    const targetChallengeId = challengeId.trim()
    const message = hintContent.trim()
    if (!targetChallengeId || !message) return
    for (const solver of context.listSolvers?.() ?? []) {
        if (solver.challengeId !== targetChallengeId) continue
        if (solver.status !== "running") continue
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
            const challenge = await challengeManager.getChallenge(challengeId)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            return { handled: true, data: { challenge_id: challengeId, challenge, is_completed: isCompleted } }
        }
        case "challenge_get_hint": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
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
                broadcastHintToChallengeSolvers(context, challengeId, result.remote.hint_content)
            }
            return { handled: true, data: result.remote }
        }
        case "challenge_submit_report": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const assetHash = getRequiredString(data, "asset_hash")
            const report = getRequiredString(data, "report")
            const result = await challengeManager.submitReport(challengeId, {
                assetHash,
                report,
                solverId,
                promptName: getSolverPromptName(getSolver?.()),
                modelName: getSolverModelName((await getSolverStartup?.()) ?? undefined),
            })
            return { handled: true, data: { challenge_id: challengeId, ...result } }
        }
        case "challenge_is_completed": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            return { handled: true, data: { challenge_id: challengeId, is_completed: isCompleted } }
        }
        case "challenge_memory_list": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const items = await challengeManager.listMemory(challengeId)
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_memory_add": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const source = getOptionalString(data, "source") ?? `observer:${solverId}`
            const entry = await challengeManager.appendMemory({
                challengeId,
                kind: getMemoryKind(data),
                content: getRequiredString(data, "content"),
                refs: getStringArray(data, "refs"),
                source,
            })
            return { handled: true, data: { challenge_id: challengeId, entry } }
        }
        case "challenge_idea_list": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const items = await challengeManager.listIdeas(challengeId)
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_idea_search": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const items = await challengeManager.searchIdeas(challengeId, getRequiredString(data, "query"))
            return { handled: true, data: { challenge_id: challengeId, items } }
        }
        case "challenge_idea_add": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const status = getOptionalIdeaStatus(data)
            const result = await challengeManager.addIdea(challengeId, {
                content: getRequiredString(data, "content"),
                ...(status ? { status } : {}),
                ...(data.result !== undefined ? { result: getOptionalString(data, "result") ?? "" } : {}),
            })
            return { handled: true, data: { challenge_id: challengeId, ...result } }
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
