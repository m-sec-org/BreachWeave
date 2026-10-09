import { DefaultResourceLoader, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { requestHostBridge } from "../../../challenge/host-bridge-client"
import { DEFAULT_CONFIG_DIR, ConfigManager } from "../../../config/index"
import type { ChallengeInfoRecord } from "../../../challenge/store"
import { createObserverSidecarToolsWithOptions } from "./tools"
import type { ObserverReviewPayload } from "./types"

const OBSERVER_SYSTEM_PROMPT = `你是 CTF 解题 Agent 的 observer sidecar。

你不是 solver。你不负责推进解题，不负责执行工具，不负责获取 hint，也不负责提交 flag。
你的唯一职责是维护当前赛题的策略看板，使其保持紧凑、耐压缩、高信号。

## Mission

你的任务不是“多做一点”，而是“让看板更准、更稳、更少噪音”。

把下面这条顺序当作默认立场，而不是建议：

\`NO_CHANGE\` > \`update existing\` > \`delete superseded\` > \`add new\`

也就是说：
- 默认先维护已有主线，不制造更多主线。
- 默认先保留 durable facts、evidence、failure boundaries、hints、constraints。
- 默认用最小改动修正看板。
- 没有足够强的新证据时，直接 \`NO_CHANGE\`。

## Core Loop

每轮审查只按这个顺序思考，不要跳步：

1. 先看当前 ideas 和 memory。
2. 先闭环已有主线：最近几轮 tool result / assistant 结果，是否证实、证伪或推进了某条已有 idea。
3. 如果能闭环，优先更新这条主线的 status、result 或相关 memory。
4. 如果只是某个 payload、编码、子分支、利用姿势失败，先记录 failure boundary，不要直接判死整条主线。
5. 只有当最近结果无法承接到现有主线、并且确实打开了不同攻击方向时，才新增 idea。
6. 如果既没有新方向，也没有更强的边界结论，就回复 \`NO_CHANGE\`。

一句话概括你的默认动作：
先闭环，后收缩，最后才扩张。

## Board Model

你维护两块板：

### Ideas

idea 只表示“接下来值得测试什么”，不是事实，也不是过程记录。

判断标准：
- 好的 idea 必须具体、可执行、可验证。
- 如果新证据只是让现有路线更具体、更聚焦、更接近利用点，优先 \`idea_update\`。
- 不要把同一主线拆成多个近义、同级、上下级重复 idea。
- 只有新证据真正打开不同攻击方向时，才新增 idea。
- idea 生命周期通过 \`idea_update\` 推进到 \`pending/testing/verified/failed/skipped\`。

对 \`failed\` 要最保守。只有强证据已经明确排除这条路线当前假设时，才允许标成 \`failed\`。

在你准备把 idea 改成 \`failed\` 前，先连续自问这三个问题：

1. 这次失败，否定的是整条路线，还是只否定了某个 payload / 编码 / 子分支 / 利用姿势？
2. 这条路线是否仍存在合理变体、上下文条件或未验证前提？
3. 这次更适合把失败边界写进 result 或 memory，而不是关闭整条主线吗？

只要这三个问题里有任何一个不能明确排除，就不要把 idea 改成 \`failed\`。
优先保持 \`testing\`，或回到更窄的 \`pending\`。

当 idea 被更新为 \`verified\` 或 \`failed\` 时，result 必须包含决定性的证据摘要，而不只是一句结论。

好例子：
- "检查上传点是否能用 polyglot php 绕过"
- "对登录口尝试 time-based SQLi"
- "逆向解析器寻找 format string bug"

坏例子：
- "已经下载了 binary"
- "访问过 /admin"
- "SQL 注入被 WAF 拦了"
- "需要再想想"

### Memory

memory 保存压缩后仍必须留下的 durable facts、evidence、failures、hints、constraints。

默认原则不是“继续记”，而是“保留最有用的那条”：
- 合并重于累加：同一攻击面的新证据，优先改写旧记录，而不是新增近义记录。
- 新增 memory 前，先检查是否已有同主题记录可以承接；默认先考虑 \`memory_update\`。
- failure memory 应整理成边界结论，而不是动作流水。
- failure memory 要尽量写清失败边界或触发的防御机制，例如参数被过滤、返回 403、命中 WAF、还是走到逻辑死路。
- 环境限制或隐含约束属于高优先级 memory，例如无外网、只读文件系统、缺失关键依赖、沙箱限制。
- 弱记录、重复记录、过时记录、被更强结论覆盖的记录，应主动 update 或 delete。
- 如果新结论已经覆盖旧结论，不要让两条近义记录长期并存。

## Board Pressure

这些记录会进入 solver 的初始上下文，所以你必须主动控体积，而不是只顾着追加。

- 默认目标：memory 保持在 12 条以内，ideas 保持在 8 条以内。
- 超过这个体积时，压缩本身就是优先动作：先 merge / update / delete，再考虑 add。
- 如果一条更强的结论已经覆盖旧记录，不允许两条近义 memory 长期并存。
- 如果一个新结果只是在补强现有主线，默认改写已有 idea/result，不要再开平级分支。
- 你的目标是让 solver 打开上下文时先看到最值得保留的结论，而不是完整流水账。

当你拿不准是否该把某条 idea 判成 \`failed\` 时，默认先新增或更新 failure memory，保存失败边界，而不是直接关闭主线。

好例子：
- "对 /login 的 union/time/error SQLi 均失败，疑似已参数化"

坏例子：
- 低价值动作流水
- 重复尝试
- 短暂 chatter
- 模糊总结

## Rare Actions

### send_efficiency_reminder

\`send_efficiency_reminder\` 是最后手段，不是常规动作。
只有在“持续低效且没有实际改线”时才考虑它。

四个前提必须同时满足：
1. 当前方法明显低效、重复、低信息增量。
2. 这种状态已经持续出现，而不是正常验证中的短暂停留。
3. solver 并不处于合理主线的正常推进阶段。
4. 如果之前已经提醒过，那么之后几轮并没有真正改线，或者又明显回到了同一低效模式。

如果 solver 已经切到新的主线或新的验证方向，即使还不完美，也不要再次打断。

典型低效模式：
- 手工逐个 fuzz
- 手工逐个列目录
- 重复低增量试错
- 在已有字典或脚本条件下继续手工猜测
- 反复尝试已被看板证明失败的 payload
- 缺少差异分析时盲目大规模 fuzz

提醒内容必须短、具体、可执行，最好同时包含：
- 当前低效行为
- 更高效的替代方向

如果 solver 发现了一条你未预料但显然高价值的新路径，优先更新看板兼容它。
如果 solver 持续陷入已被更强证据排除的旧路径，才考虑提醒。

### query_solver_history

\`query_solver_history\` 不是默认流程。
只有在最近 10 轮摘要不足以支撑判断、继续推测可能出错时，才调用它。
优先使用当前提供的压缩上下文和最近活动日志。

## Non-Negotiables

这些不是偏好，是硬约束：
- 每次写入前都先检查当前 ideas 和 memory。
- 主 Agent 对 ideas 是只读的；ideas 只能由你维护，solver 只负责读取并验证。
- 你不能自己提交 flag、获取 hint、或执行 solver 行为。
- 不要为了“看起来有动作”而新增、改写、删除记录。
- 不要做颠覆性重写，不要一次性大范围改动看板。
- 不要仅因为最近几轮没提到某条记录，就删除它。
- 不要随意回退已有 idea 状态，除非新日志提供了明确证据。
- 不要用弱证据、单次失败、或不完整验证把一条可能仍成立的主线标成 \`failed\`。
- 保持耐压缩性：看板上的文字应像代码注释一样精炼，优先保留假设、边界和证据，而不是过程流水。

## Output Contract

- 最终回复不能复述题面、上下文、日志或做题过程。
- 如果本轮无需修改，只回复 \`NO_CHANGE\`。
- 如果有修改，只输出 1-4 条短 bullet，说明你维护了什么。

每轮 user prompt 只提供动态上下文：
- challenge state
- trigger
- 压缩后的 solver 背景
- 最近几轮 solver activity
- response contract

不要把这些动态上下文误当成新的长期规则。`

// Mode adapter for the review agent: only the system prompt + context/completion source
// differ by mode. Challenge default preserves host-bridge behavior; engagement injects its own.
export interface ObserverReviewHost {
    systemPrompt: string
    resolve(id: string): Promise<{ isComplete: boolean; contextBlock: string }>
}

export function createChallengeReviewHost(): ObserverReviewHost {
    return {
        systemPrompt: OBSERVER_SYSTEM_PROMPT,
        async resolve(id: string) {
            const state = await requestHostBridge<{ challenge?: ChallengeInfoRecord; is_completed: boolean }>("challenge_get_state", {})
            return { isComplete: state.is_completed === true, contextBlock: formatObserverChallengeContext(id, state.challenge) }
        },
    }
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function formatEntrypoint(entrypoint: string[] | null | undefined): string {
    if (!entrypoint || entrypoint.length === 0) return "-"
    return entrypoint.join(", ")
}

function formatObserverChallengeContext(challengeId: string, challenge: ChallengeInfoRecord | undefined): string {
    return [
        "## Challenge State",
        `- id: ${challengeId}`,
        `- title: ${challenge?.title ?? "-"}`,
        `- difficulty: ${challenge?.difficulty ?? "-"}`,
        `- level: ${challenge?.level ?? "-"}`,
        `- instance_status: ${challenge?.instance_status ?? "-"}`,
        `- entrypoint: ${formatEntrypoint(challenge?.entrypoint)}`,
        `- flags: ${challenge ? `${challenge.flag_got_count}/${challenge.flag_count}` : "-"}`,
        `- hint_viewed: ${challenge?.hint_viewed === true ? "yes" : "no"}`,
        `- hint_content: ${challenge?.hint_content?.trim() || "-"}`,
        `- updated_at: ${challenge?.updated_at ?? "-"}`,
    ].join("\n")
}

function formatObserverRounds(rounds: ObserverReviewPayload["rounds"]): string {
    if (rounds.length === 0) return "(none)"

    return rounds
        .map((round) => {
            const lines = [`### Round ${round.round}`]
            const assistantSummary = round.assistant_summary.trim()
            lines.push(`- assistant: ${assistantSummary || "(empty)"}`)
            if (round.tool_logs.length === 0) {
                lines.push("- tools: (none)")
            } else {
                lines.push("- tools:")
                for (const tool of round.tool_logs) {
                    const prefix = tool.is_error ? "error" : "ok"
                    lines.push(`  - [${prefix}] ${tool.tool_name}`)
                    lines.push(`    args: ${tool.args_summary || "-"}`)
                    lines.push(`    result: ${tool.result_summary || "-"}`)
                }
            }
            return lines.join("\n")
        })
        .join("\n\n")
}

function buildObserverPrompt(contextBlock: string, payload: ObserverReviewPayload): string {
    return [
        contextBlock,
        "",
        "## Recent Solver Context",
        "- 这段是压缩后的主 solver 背景，只保留少量用户目标与补充约束；最近几轮已足够时，优先看下方活动记录。",
        "<solver-context>",
        payload.session_context || "(empty)",
        "</solver-context>",
        "",
        "## Recent Solver Activity Log",
        formatObserverRounds(payload.rounds),
        "",
        "## Response Contract",
        "- 没有改动就只回复 `NO_CHANGE`。",
        "- 有改动就只写 1-4 条短 bullet，描述你维护了什么。",
    ].join("\n")
}

function resolveObserverSessionDir(): string {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) throw new Error("TCH_SOLVER_SESSION_DIR is required for observer sidecar")
    return join(solverSessionDir, ".observer")
}

function resolveObserverWorkspaceDir(): string {
    const solverWorkspaceDir = process.env.TCH_SOLVER_WORKSPACE?.trim()
    if (!solverWorkspaceDir) throw new Error("TCH_SOLVER_WORKSPACE is required for observer sidecar")
    return solverWorkspaceDir
}

async function resolveObserverSessionOptions(
    config: ConfigManager,
    systemPrompt: string,
    observerModel?: string,
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean,
): Promise<CreateAgentSessionOptions | undefined> {
    const resourceLoader = new DefaultResourceLoader({
        agentDir: DEFAULT_CONFIG_DIR,
        systemPromptOverride: () => systemPrompt,
    })
    await resourceLoader.reload()
    const solverEntries = await loadMainSolverEntries()
    const opts: CreateAgentSessionOptions = {
        tools: [],
        customTools: createObserverSidecarToolsWithOptions({
            sendCorrectionNotice,
            getSolverEntries: () => solverEntries,
        }),
        resourceLoader,
        authStorage: config.auth,
        modelRegistry: config.models,
        settingsManager: config.settings,
    }

    const modelPrefId = observerModel?.trim()
    if (modelPrefId) {
        const resolvedModel = await config.resolveModelPref(modelPrefId)
        opts.model = resolvedModel.model
        opts.thinkingLevel = resolvedModel.thinkingLevel
    }

    return opts
}

async function loadMainSolverEntries(): Promise<unknown[]> {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) return []

    try {
        const files = (await readdir(solverSessionDir)).filter((name) => name.endsWith(".jsonl")).sort()
        const entries: unknown[] = []

        for (const name of files) {
            const text = await Bun.file(join(solverSessionDir, name)).text().catch(() => "")
            for (const rawLine of text.split("\n")) {
                const line = rawLine.trim()
                if (!line) continue
                try {
                    entries.push(JSON.parse(line))
                } catch {
                    // ignore malformed lines
                }
            }
        }

        return entries
    } catch {
        return []
    }
}

export async function runSolverObserverReview(
    id: string,
    payload: ObserverReviewPayload,
    options?: {
        observerModel?: string
        sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
        reviewHost?: ObserverReviewHost
    },
): Promise<{
    applied: boolean
    summary?: string
}> {
    const trimmedId = id.trim()
    if (!trimmedId) {
        throw new Error("id is required")
    }

    const rounds = Array.isArray(payload.rounds) ? payload.rounds.filter((item) => Array.isArray(item.tool_logs)) : []
    if (rounds.length === 0) return { applied: false }

    const reviewHost = options?.reviewHost ?? createChallengeReviewHost()
    const { isComplete, contextBlock } = await reviewHost.resolve(trimmedId)
    if (isComplete) {
        return { applied: false }
    }

    const config = await ConfigManager.getInstance()
    const sessionOpts = await resolveObserverSessionOptions(config, reviewHost.systemPrompt, options?.observerModel, options?.sendCorrectionNotice)
    if (!sessionOpts?.resourceLoader) return { applied: false }
    const observerSessionDir = resolveObserverSessionDir()
    const observerWorkspaceDir = resolveObserverWorkspaceDir()
    await mkdir(observerSessionDir, { recursive: true })

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: observerWorkspaceDir,
        sessionManager: SessionManager.create(observerWorkspaceDir, observerSessionDir),
    })
    let summary = ""
    session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
            summary = extractTextContent(event.message.content as Array<{ type: string; text?: string }> | undefined)
        }
    })

    try {
        await session.prompt(
            buildObserverPrompt(contextBlock, {
                ...payload,
                rounds,
            }),
        )
    } finally {
        session.dispose()
    }

    return { applied: true, summary: summary || undefined }
}
