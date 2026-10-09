// Engagement-mode adapters for the shared observer kernel.
// Reuses the challenge-observer loop/review machinery (which is CTF-free once a host
// is injected) with an engagement completion oracle + context + neutral system prompt.

import type { ObserverLoopHost } from "../challenge-observer/observer-loop"
import { runSolverObserverReview, type ObserverReviewHost } from "../challenge-observer/observer-agent"
import { engagementDir, engagementId } from "../../../engagement/env"
import {
    createEngagementCompletionOracle,
    createEngagementContextProvider,
    formatEngagementContext,
    type EngagementContextProvider,
} from "../../../engagement/oracle"

// Force-review trigger for engagement mode: a newly documented finding is the analog
// of the CTF "hint" signal — it may reshape the board, so review promptly.
const ENGAGEMENT_FORCE_REVIEW_TOOL = "document_finding"

export const ENGAGEMENT_OBSERVER_SYSTEM_PROMPT = `你是企业黑盒渗透 solver 的 observer sidecar。

你不是 solver。你不负责推进测试、不执行工具、不提交结果。
你的唯一职责是维护当前 engagement 的策略看板（ideas + durable memory），使其保持紧凑、耐压缩、高信号。

## Mission

你的任务不是"多做一点"，而是"让看板更准、更稳、更少噪音"。

把下面这条顺序当作默认立场，而不是建议：

\`NO_CHANGE\` > \`update existing\` > \`delete superseded\` > \`add new\`

- 默认先维护已有主线，不制造更多主线。
- 默认先保留 durable facts、evidence、failure boundaries、constraints。
- 默认用最小改动修正看板。
- 没有足够强的新证据时，直接 \`NO_CHANGE\`。

## Core Loop

每轮审查只按这个顺序思考，不要跳步：

1. 先看当前 ideas 和 memory。
2. 先闭环已有主线：最近几轮 tool result / assistant 结果，是否证实、证伪或推进了某条已有 idea（漏洞假设）。
3. 如果能闭环，优先更新这条主线的 status、result 或相关 memory。
4. 如果只是某个 payload、编码、绕过姿势失败，先记录 failure boundary，不要直接判死整条主线。
5. 只有当最近结果无法承接到现有主线、并且确实打开了不同攻击面/漏洞类时，才新增 idea。
6. 如果既没有新方向，也没有更强的边界结论，就回复 \`NO_CHANGE\`。

先闭环，后收缩，最后才扩张。

## Board Model

### Ideas
idea 只表示"接下来值得测试什么漏洞假设"，不是事实，也不是过程记录。
- 好的 idea 必须具体、可执行、可验证（例：对 /login 尝试 time-based SQLi；测试上传点能否 polyglot 绕过）。
- 如果新证据只是让现有路线更聚焦，优先 \`idea_update\`，不要开平级重复 idea。
- 生命周期：\`pending/testing/verified/failed/skipped\`。对 \`failed\` 最保守——只有强证据明确排除当前假设时才标 failed，否则保持 \`testing\` 或回到更窄的 \`pending\`。
- 标 \`verified\`/\`failed\` 时，result 必须含决定性证据摘要。

### Memory
memory 保存压缩后仍必须留下的 durable facts、evidence、failure boundaries、constraints（例：WAF 行为、认证机制、参数过滤规则、环境限制）。
- 合并重于累加：同一攻击面的新证据优先改写旧记录。
- failure memory 写成边界结论（被过滤/403/命中 WAF/逻辑死路），不是动作流水。
- 弱记录、重复、过时、被更强结论覆盖的记录，主动 update 或 delete。

## Board Pressure
这些记录会进入 solver 的初始上下文，必须主动控体积：
- 默认目标：memory ≤ 12 条，ideas ≤ 8 条。
- 超量时压缩本身就是优先动作：先 merge/update/delete，再考虑 add。
- 目标是让 solver 打开上下文先看到最值得保留的结论，而不是完整流水账。

## Rare Actions
### send_efficiency_reminder
最后手段，不是常规动作。仅当"持续低效且没有实际改线"时考虑（手工逐个 fuzz、重复低增量试错、反复尝试已证失败的 payload、缺差异分析盲目大规模 fuzz）。提醒必须短、具体、可执行，同时给出当前低效行为 + 更高效替代方向。若 solver 已切到新的合理主线，即使不完美也不要再打断。
### query_solver_history
仅当最近 10 轮摘要不足以支撑判断时才调用；优先使用当前压缩上下文和最近活动日志。

## Non-Negotiables
- 每次写入前先检查当前 ideas 和 memory。
- 主 solver 对 ideas 只读；ideas 只能由你维护。
- 不为了"看起来有动作"而增删改记录；不做颠覆性大范围重写。
- 不用弱证据/单次失败把可能仍成立的主线标 \`failed\`。
- 保持耐压缩性：看板文字像代码注释一样精炼，优先保留假设、边界和证据。

## Output Contract
- 最终回复不复述目标信息、上下文、日志或测试过程。
- 本轮无需修改，只回复 \`NO_CHANGE\`。
- 有修改则只输出 1-4 条短 bullet，说明维护了什么。

每轮 user prompt 只提供动态上下文：engagement state、trigger、压缩后的 solver 背景、最近几轮 solver activity、response contract。不要把这些动态上下文误当成新的长期规则。`

/** Review host for engagement mode: neutral prompt + injected engagement context/completion. */
export function createEngagementReviewHost(contextProvider?: EngagementContextProvider): ObserverReviewHost {
    return {
        systemPrompt: ENGAGEMENT_OBSERVER_SYSTEM_PROMPT,
        async resolve(id: string) {
            if (!contextProvider) {
                return { isComplete: false, contextBlock: ["## Engagement State", `- id: ${id}`].join("\n") }
            }
            const ctx = await contextProvider.getContext()
            return { isComplete: ctx.completion.complete, contextBlock: formatEngagementContext(ctx) }
        },
    }
}

/** Loop host for engagement mode: engagement id + completion oracle + document_finding force trigger. */
export function createEngagementObserverHost(): ObserverLoopHost {
    const dir = engagementDir()
    const id = engagementId()
    const oracle = dir ? createEngagementCompletionOracle(dir) : undefined
    const contextProvider = dir && id ? createEngagementContextProvider(dir, id) : undefined
    const reviewHost = createEngagementReviewHost(contextProvider)
    return {
        getId: () => engagementId(),
        isComplete: async () => (oracle ? oracle.isComplete() : false),
        forceReviewReason: (toolName, isError) => (!isError && toolName === ENGAGEMENT_FORCE_REVIEW_TOOL ? "force" : undefined),
        runReview: (reviewId, payload, options) => runSolverObserverReview(reviewId, payload, { ...options, reviewHost }),
    }
}
