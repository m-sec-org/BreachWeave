import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

const MAX_CHALLENGE_RETRY_ATTEMPTS = 10
const CHALLENGE_CONTINUATION_MESSAGE =
    "仅继续本次分配的资产和测试项清单，不要重复已完成步骤。逐项记录 completed 或 blocked 及证据，通过 challenge_submit_report 提交 test_results；本次分工完成并提交报告后结束。额外发现写入 discoveries 交给 planner 调度，不要自行扩展分工。"
const CHALLENGE_CUSTOM_MESSAGE_TYPE = "challenge-continuation"
const BASE_CHALLENGE_DELAY_MS = 1000
const MAX_CHALLENGE_DELAY_MS = 10000

export function isChallengeMode(): boolean {
    const challengeId = process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim()
    return Boolean(challengeId)
}

export function buildChallengeExtensionAppendPrompt(): string {
    return [
        "## Challenge Extension Contract",
        "- 你会持续收到系统同步或协作同步消息。它们是 challenge extension / host bridge 注入的协作信号，不是噪音。",
        "- 这些同步消息可能来自：赛题 hint 更新、其他 solver 的报告、以及 challenge extension 的续跑机制。",
        "- 收到新的同步消息后，如果它影响本次分工的攻击路线或排除结论，先调用 `board_refresh` 从 host 权威状态刷新，再决定下一步。",
        "- 协作同步和 observer 建议是高价值参考，不是绝对事实；不要因为别人一句判断就直接放弃你手上的实测线索。",
        "- 如果同步消息、task 下发时注入的 challenge 背景、以及你当前的实测结果存在冲突，优先重新验证关键分歧点，而不是机械服从任一方。",
        "- `idea` 是待验证的攻击假设，不是事实。observer sidecar 会维护你的 idea 板，你负责读取、验证、推进。",
        "- `memory` 是 durable facts、evidence、failure boundaries、hints、constraints。observer sidecar 维护 memory，你通过 `memory_list` 读取。",
        "- `memory_list` / `idea_list` 会展示 solver 本地层和 challenge 全局层；本地记录不等于已广播，全局层才是同题 solver 共享背景。",
        "- observer 只有在明确设置 `publish_to_challenge` 时才会把记录发布到 challenge 全局层；普通本地记录不会自动广播。",
        "- 在切换路线、重复某个攻击向量、或收到新的协作同步后，先查看 `idea_list` 或 `idea_search`；如果怀疑自己忘了之前结论，先看 `memory_list`。",
        "- 如果当前推进已经与某条 `testing` / `verified` 主线一致，不要为了响应同步消息而机械改线；优先继续推进当前有效主线。",
        "- 只执行本次分配的资产和测试项清单，不因其他 solver 的进展或额外发现自行扩大测试范围。",
        "- `challenge_submit_report` 是 host 提供的正式提交工具；把报告写入工作区、在最终文本中描述报告或只发送协作消息都不算提交。",
        "- 通过 `challenge_submit_report` 的 `test_results` 逐项报告 completed / blocked 和证据；本次分工完成并提交报告后结束，无需等待整个项目完成。",
        "- 将额外发现和后续测试建议写入报告的 `discoveries` 交给 planner 决定是否继续分配。",
    ].join("\n")
}

function getAgentEndError(messages: AgentMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message.role !== "assistant") continue
        if (message.stopReason !== "error") return
        return message.errorMessage ?? "Agent ended with an unknown error"
    }

    return
}

function getChallengeDelayMs(attempt: number): number {
    return Math.min(BASE_CHALLENGE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_CHALLENGE_DELAY_MS)
}

interface ChallengeCompletionState {
    is_completed: boolean
    solver_task_completed?: boolean
}

interface ChallengeContinuationOptions {
    readCompletion?: () => Promise<ChallengeCompletionState>
}

async function isChallengeCompletedByHostBridge(readCompletion: () => Promise<ChallengeCompletionState>): Promise<boolean> {
    try {
        const result = await readCompletion()
        return result.is_completed === true || result.solver_task_completed === true
    } catch {
        return false
    }
}

export function attachChallengeContinuation(pi: ExtensionAPI, options: ChallengeContinuationOptions = {}): void {
    let consecutiveErrors = 0
    let assignmentComplete = false
    const readCompletion = options.readCompletion ?? (() => requestHostBridge<ChallengeCompletionState>("challenge_is_completed", {}))

    pi.on("tool_execution_end", (event) => {
        if (event.isError || event.toolName !== "challenge_submit_report") return
        const result = event.result
        if (!result || typeof result !== "object" || !("details" in result)) return
        const details = result.details
        if (details && typeof details === "object" && "solver_task_completed" in details && details.solver_task_completed === true) {
            assignmentComplete = true
        }
    })

    pi.on("tool_call", () => {
        if (!assignmentComplete) return
        return { block: true, terminate: true, reason: "本次分工报告已齐全，请结束并总结已提交结果；额外发现和剩余资产由 planner 安排。" }
    })

    pi.on("agent_end", async (event) => {
        if (assignmentComplete || await isChallengeCompletedByHostBridge(readCompletion)) {
            return
        }

        const errorMessage = getAgentEndError(event.messages)
        if (errorMessage) {
            consecutiveErrors += 1
            if (consecutiveErrors > MAX_CHALLENGE_RETRY_ATTEMPTS) return
            await Bun.sleep(getChallengeDelayMs(consecutiveErrors))
        } else {
            consecutiveErrors = 0
        }

        setImmediate(() => {
            if (assignmentComplete) return
            pi.sendMessage(
                {
                    customType: CHALLENGE_CUSTOM_MESSAGE_TYPE,
                    content: [{ type: "text", text: CHALLENGE_CONTINUATION_MESSAGE }],
                    display: false,
                    details: undefined,
                },
                { triggerTurn: true },
            )
        })
    })
}
