import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { PromptSessionExtensionLike } from "../../../config/index"
import { engagementDir, isEngagementMode } from "../../../engagement/env"
import { createEngagementCompletionOracle, type CompletionOracle } from "../../../engagement/oracle"
import { readEngagementSolverGuidance } from "../../../engagement/solver-guidance"
import { attachObserverLoop } from "../challenge-observer/observer-loop"
import { challengeObserverAgentTools } from "../challenge-observer/tools"
import { attachEngagementContinuation } from "./engagement-continuation"
import { createEngagementObserverHost } from "./observer-host"

export interface EngagementObserverExtensionOptions {
    observerEnabled?: boolean
    observerModel?: string
}

export function buildEngagementExtensionAppendPrompt(): string {
    return [
        "## Engagement Contract",
        "- 你运行在企业授权黑盒渗透 engagement 中。所有动作必须落在授权范围（allowed_targets）内；越界或破坏性命令会被 scope-guard 拦截。",
        "- 你会持续收到系统同步或协作同步消息（新证据、新 finding、续跑信号）。它们是内核注入的协作信号，不是噪音。",
        "- `idea` 是待验证的攻击/漏洞假设，不是事实；observer sidecar 维护 idea 板，你负责读取、验证、推进。",
        "- `memory` 是 durable facts、evidence、failure boundaries、constraints。运行中用 `memory_list` 查看。",
        "- 切换攻击面、重复某个向量、或收到新同步后，先看 `idea_list`/`idea_search`；怀疑忘了结论就先 `memory_list`。",
        "- 只做 PoC 级非破坏性取证（可验证可利用即止）；禁止删改数据、持久化、横向/提权、DoS。",
        "- 发现漏洞后用 `document_finding` 记录，并附可复核证据（请求/响应/复现步骤）。",
    ].join("\n")
}

export function buildEngagementObserverAppendPrompt(): string {
    return [
        "## Observer Sidecar Contract",
        "- 已启用 observer sidecar。它会定期审查你最近几轮行为，保守地维护 ideas 和 memory。",
        "- observer 不替你测试、不替你验证漏洞；它负责整理策略看板和 durable memory，你负责实际验证与推进。",
        "- ideas 看板由 observer 异步维护，你把它当只读策略板，用来避免重复试错和判断下一步。",
        "- observer 维护的 idea 只是候选假设，必须通过你的实测确认、证伪或推进；不要机械照抄，也不要无视。",
        "- observer 的判断是建议不是结论；与你当前实测冲突时，优先重新验证关键分歧点。",
    ].join("\n")
}

export function engagementObserverExtension(options?: EngagementObserverExtensionOptions): PromptSessionExtensionLike {
    const observerEnabled = options?.observerEnabled === true
    const observerModel = options?.observerModel
    const appendSystemPrompt = observerEnabled
        ? `${buildEngagementExtensionAppendPrompt()}\n\n${buildEngagementObserverAppendPrompt()}`
        : buildEngagementExtensionAppendPrompt()

    const factory: ExtensionFactory = (pi) => {
        if (!isEngagementMode()) return
        console.log("Engagement observer extension initialized")

        if (observerEnabled) {
            for (const tool of challengeObserverAgentTools) {
                pi.registerTool(tool)
            }
        }

        const dir = engagementDir()
        const oracle: CompletionOracle = dir ? createEngagementCompletionOracle(dir) : { isComplete: async () => false }
        attachEngagementContinuation(pi, oracle)

        // Dynamic phase-aware guidance: complements the static engagement contract
        // (appendSystemPrompt). No-op when the engagement dir is missing.
        if (dir) {
            pi.on("before_agent_start", async (event) => {
                const guidance = await readEngagementSolverGuidance(dir)
                if (!guidance.trim()) return
                return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }
            })
        }

        if (observerEnabled) {
            attachObserverLoop(pi, { observerModel, host: createEngagementObserverHost() })
        }
    }

    return {
        factory,
        appendSystemPrompt: () => appendSystemPrompt,
    }
}
