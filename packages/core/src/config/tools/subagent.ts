/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `tch-agent subagent` process for each invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentToolResult } from "@mariozechner/pi-agent-core"
import type { Message } from "@mariozechner/pi-ai"
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition, ToolRenderResultOptions, Theme } from "@mariozechner/pi-coding-agent"
import { defineTool, getMarkdownTheme } from "@mariozechner/pi-coding-agent"
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import type { PromptFile } from "../prompts/index"

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const COLLAPSED_ITEM_COUNT = 10
const textDecoder = new TextDecoder()

function formatTokens(count: number): string {
    if (count < 1000) return count.toString()
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    if (count < 1000000) return `${Math.round(count / 1000)}k`
    return `${(count / 1000000).toFixed(1)}M`
}

function formatUsageStats(
    usage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        cost: number
        contextTokens?: number
        turns?: number
    },
    model?: string,
): string {
    const parts: string[] = []
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`)
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
    }
    if (model) parts.push(model)
    return parts.join(" ")
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
    const shortenPath = (p: string) => {
        const home = os.homedir()
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p
    }

    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "..."
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview)
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string
            const filePath = shortenPath(rawPath)
            const offset = args.offset as number | undefined
            const limit = args.limit as number | undefined
            let text = themeFg("accent", filePath)
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1
                const endLine = limit !== undefined ? startLine + limit - 1 : ""
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`)
            }
            return themeFg("muted", "read ") + text
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string
            const filePath = shortenPath(rawPath)
            const content = (args.content || "") as string
            const lines = content.split("\n").length
            let text = themeFg("muted", "write ") + themeFg("accent", filePath)
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`)
            return text
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
        }
        case "ls": {
            const rawPath = (args.path || ".") as string
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath))
        }
        case "find": {
            const pattern = (args.pattern || "*") as string
            const rawPath = (args.path || ".") as string
            return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
        }
        case "grep": {
            const pattern = (args.pattern || "") as string
            const rawPath = (args.path || ".") as string
            return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
        }
        default: {
            const argsStr = JSON.stringify(args)
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`)
        }
    }
}

interface UsageStats {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens: number
    turns: number
}

interface SingleResult {
    agent: string
    task: string
    exitCode: number
    messages: Message[]
    stderr: string
    usage: UsageStats
    model?: string
    stopReason?: string
    errorMessage?: string
    step?: number
}

interface SubagentDetails {
    mode: "single" | "parallel" | "chain"
    results: SingleResult[]
}

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text
            }
        }
    }
    return ""
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }

function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = []
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") items.push({ type: "text", text: part.text })
                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments })
            }
        }
    }
    return items
}

function escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
    if (items.length === 0) return []
    const limit = Math.max(1, Math.min(concurrency, items.length))
    const results: TOut[] = new Array(items.length)
    let nextIndex = 0
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++
            if (current >= items.length) return
            results[current] = await fn(items[current], current)
        }
    })
    await Promise.all(workers)
    return results
}

function getSubagentInvocation(args: string[]): { command: string; args: string[] } {
    const execName = path.basename(process.execPath).toLowerCase()
    const isBunRuntime = execName === "bun" || execName === "bun.exe"
    if (!isBunRuntime) return { command: process.execPath, args: ["subagent", ...args] }

    const currentScript = process.argv[1]
    if (currentScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, "subagent", ...args] }
    }

    throw new Error("Failed to resolve subagent entrypoint from Bun runtime")
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void

async function runSingleAgent(
    baseCwd: string,
    subagentPrompts: Map<string, PromptFile>,
    promptName: string,
    task: string,
    toolCallId: string,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
    const prompt = subagentPrompts.get(promptName)

    if (!prompt) {
        const available = [...subagentPrompts.keys()].map((name) => `"${name}"`).join(", ") || "none"
        return {
            agent: promptName,
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${promptName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
        }
    }

    const args: string[] = ["--prompt", prompt.name]

    const currentResult: SingleResult = {
        agent: prompt.name,
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: prompt.meta.model,
        step,
    }

    const emitUpdate = (newMessages: Message[]) => {
        if (onUpdate) {
            const partialResult: SingleResult = {
                ...currentResult,
                messages: newMessages,
            }
            onUpdate({
                content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
                details: makeDetails([partialResult]),
            })
        }
    }

    const subagentCwd = path.resolve(baseCwd, ".subagents", `${prompt.name}-${toolCallId}${step !== undefined ? `-${step}` : ""}`)
    await fs.promises.mkdir(subagentCwd, { recursive: true })
    args.push(task)
    let wasAborted = false

    const invocation = getSubagentInvocation(args)
    const proc = Bun.spawn([invocation.command, ...invocation.args], {
        cwd: subagentCwd,
        env: {
            ...process.env,
            TCH_SOLVER_WORKSPACE: baseCwd,
            TCH_SUBAGENT_PARENT_TOOL_CALL_ID: toolCallId,
            ...(step !== undefined ? { TCH_SUBAGENT_STEP: String(step) } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
    })
    let buffer = ""

    const processLine = (line: string) => {
        if (!line.trim()) return
        let event: unknown
        try {
            event = JSON.parse(line)
        } catch {
            return
        }
        if (!event || typeof event !== "object") return
        const payload = event as { type?: string; message?: Message }

        if (payload.type === "message_end" && payload.message) {
            const msg = payload.message
            currentResult.messages.push(msg)

            if (msg.role === "assistant") {
                currentResult.usage.turns++
                const usage = msg.usage
                if (usage) {
                    currentResult.usage.input += usage.input || 0
                    currentResult.usage.output += usage.output || 0
                    currentResult.usage.cacheRead += usage.cacheRead || 0
                    currentResult.usage.cacheWrite += usage.cacheWrite || 0
                    currentResult.usage.cost += usage.cost?.total || 0
                    currentResult.usage.contextTokens = usage.totalTokens || 0
                }
                if (!currentResult.model && msg.model) currentResult.model = msg.model
                if (msg.stopReason) currentResult.stopReason = msg.stopReason
                if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
            }
            emitUpdate([msg])
            return
        }

        if (payload.type === "tool_result_end" && payload.message) {
            currentResult.messages.push(payload.message)
            emitUpdate([payload.message])
        }

    }

    const stdoutPump = (async () => {
        if (!proc.stdout) return
        const reader = proc.stdout.getReader()
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += textDecoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() || ""
                for (const line of lines) processLine(line)
            }
            buffer += textDecoder.decode()
            if (buffer.trim()) processLine(buffer)
            buffer = ""
        } finally {
            reader.releaseLock()
        }
    })()

    const stderrPump = (async () => {
        if (!proc.stderr) return
        const reader = proc.stderr.getReader()
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                currentResult.stderr += textDecoder.decode(value, { stream: true })
            }
            currentResult.stderr += textDecoder.decode()
        } finally {
            reader.releaseLock()
        }
    })()

    if (signal) {
        const killProc = () => {
            wasAborted = true
            proc.kill()
        }
        if (signal.aborted) killProc()
        else signal.addEventListener("abort", killProc, { once: true })
    }

    const [exitCode] = await Promise.all([proc.exited, stdoutPump, stderrPump])

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error("Subagent was aborted")
    return currentResult
}

const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
})

const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
})

const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
    task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
    chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
})
type SubagentInput = Static<typeof SubagentParams>

export function createSubagentTool(subagentList: PromptFile[]): ToolDefinition {
    const subagentPrompts = new Map(subagentList.map((prompt) => [prompt.name, prompt]))
    const availableSubagents =
        subagentList.length === 0
            ? "(none)"
            : [
                  "<available_subagents>",
                  ...subagentList.flatMap((prompt) => [
                      "  <subagent>",
                      `    <name>${escapeXml(prompt.name)}</name>`,
                      `    <description>${escapeXml(prompt.meta.description ?? "No description")}</description>`,
                      "  </subagent>",
                  ]),
                  "</available_subagents>",
              ].join("\n")
    return defineTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
            "Detailed subagent session artifacts live under the current main agent workspace at .subagents/<agent>-<toolCallId>[-step]/ (for example session/ and startup.json) if you need to inspect the full run.",
            availableSubagents,
        ].join(" "),
        parameters: SubagentParams,

        async execute(toolCallId: string, params: SubagentInput, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined, ctx: ExtensionContext) {
            const hasChain = (params.chain?.length ?? 0) > 0
            const hasTasks = (params.tasks?.length ?? 0) > 0
            const hasSingle = Boolean(params.agent && params.task)
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle)

            const makeDetails =
                (mode: "single" | "parallel" | "chain") =>
                (results: SingleResult[]): SubagentDetails => ({
                    mode,
                    results,
                })

            if (modeCount !== 1) {
                const available = [...subagentPrompts.keys()].join(", ") || "none"
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([]),
                }
            }

            if (params.chain && params.chain.length > 0) {
                const results: SingleResult[] = []
                let previousOutput = ""

                for (let i = 0; i < params.chain.length; i++) {
                    const step = params.chain[i]
                    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)

                    // Create update callback that includes all previous results
                    const chainUpdate: OnUpdateCallback | undefined = onUpdate
                        ? (partial) => {
                              // Combine completed results with current streaming result
                              const currentResult = partial.details?.results[0]
                              if (currentResult) {
                                const allResults = [...results, currentResult]
                                onUpdate({
                                    content: partial.content,
                                    details: makeDetails("chain")(allResults),
                                })
                              }
                          }
                        : undefined

                    const result = await runSingleAgent(ctx.cwd, subagentPrompts, step.agent, taskWithContext, toolCallId, i + 1, signal, chainUpdate, makeDetails("chain"))
                    results.push(result)

                    const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
                    if (isError) {
                        const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
                        return {
                            content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                            details: makeDetails("chain")(results),
                            isError: true,
                        }
                    }
                    previousOutput = getFinalOutput(result.messages)
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
                    details: makeDetails("chain")(results),
                }
            }

            if (params.tasks && params.tasks.length > 0) {
                if (params.tasks.length > MAX_PARALLEL_TASKS)
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                            },
                        ],
                        details: makeDetails("parallel")([]),
                    }

                // Track all results for streaming updates
                const allResults: SingleResult[] = new Array(params.tasks.length)

                // Initialize placeholder results
                for (let i = 0; i < params.tasks.length; i++) {
                    allResults[i] = {
                        agent: params.tasks[i].agent,
                        task: params.tasks[i].task,
                        exitCode: -1, // -1 = still running
                        messages: [],
                        stderr: "",
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    }
                }

                const emitParallelUpdate = (changedIndex: number) => {
                    if (!onUpdate) return
                    const running = allResults.filter((r) => r.exitCode === -1).length
                    const done = allResults.filter((r) => r.exitCode !== -1).length
                    const partialResults = allResults.map((result, index) => {
                        if (index !== changedIndex) {
                            return {
                                ...result,
                                messages: [],
                            }
                        }
                        return result
                    })
                    onUpdate({
                        content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
                        details: makeDetails("parallel")(partialResults),
                    })
                }

                const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
                    const result = await runSingleAgent(
                        ctx.cwd,
                        subagentPrompts,
                        t.agent,
                        t.task,
                        toolCallId,
                        index + 1,
                        signal,
                        // Per-task update callback
                        (partial) => {
                            if (partial.details?.results[0]) {
                                allResults[index] = partial.details.results[0]
                                emitParallelUpdate(index)
                            }
                        },
                        makeDetails("parallel"),
                    )
                    allResults[index] = result
                    emitParallelUpdate(index)
                    return result
                })

                const successCount = results.filter((r) => r.exitCode === 0).length
                const summaries = results.map((r) => {
                    const output = getFinalOutput(r.messages)
                    const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "")
                    return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`
                })
                return {
                    content: [
                        {
                            type: "text",
                            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
                        },
                    ],
                    details: makeDetails("parallel")(results),
                }
            }

            if (params.agent && params.task) {
                const result = await runSingleAgent(ctx.cwd, subagentPrompts, params.agent, params.task, toolCallId, undefined, signal, onUpdate, makeDetails("single"))
                const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
                if (isError) {
                    const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
                    return {
                        content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                        details: makeDetails("single")([result]),
                        isError: true,
                    }
                }
                return {
                    content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
                    details: makeDetails("single")([result]),
                }
            }

            const available = [...subagentPrompts.keys()].join(", ") || "none"
            return {
                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                details: makeDetails("single")([]),
            }
        },

        renderCall(args: SubagentInput, theme: Theme, _context: unknown) {
            if (args.chain && args.chain.length > 0) {
                let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`)
                for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
                    const step = args.chain[i]
                    // Clean up {previous} placeholder for display
                    const cleanTask = step.task.replace(/\{previous\}/g, "").trim()
                    const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask
                    text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", step.agent) + theme.fg("dim", ` ${preview}`)
                }
                if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`
                return new Text(text, 0, 0)
            }
            if (args.tasks && args.tasks.length > 0) {
                let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`)
                for (const t of args.tasks.slice(0, 3)) {
                    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task
                    text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`
                }
                if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`
                return new Text(text, 0, 0)
            }
            const agentName = args.agent || "..."
            const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "..."
            let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName)
            text += `\n  ${theme.fg("dim", preview)}`
            return new Text(text, 0, 0)
        },

        renderResult(result: AgentToolResult<SubagentDetails>, { expanded }: ToolRenderResultOptions, theme: Theme, _context: unknown) {
            const details = result.details as SubagentDetails | undefined
            if (!details || details.results.length === 0) {
                const text = result.content[0]
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0)
            }

            const mdTheme = getMarkdownTheme()

            const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
                const toShow = limit ? items.slice(-limit) : items
                const skipped = limit && items.length > limit ? items.length - limit : 0
                let text = ""
                if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`)
                for (const item of toShow) {
                    if (item.type === "text") {
                        const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n")
                        text += `${theme.fg("toolOutput", preview)}\n`
                    } else {
                        text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`
                    }
                }
                return text.trimEnd()
            }

            if (details.mode === "single" && details.results.length === 1) {
                const r = details.results[0]
                const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted"
                const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓")
                const displayItems = getDisplayItems(r.messages)
                const finalOutput = getFinalOutput(r.messages)

                if (expanded) {
                    const container = new Container()
                    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`
                    if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`
                    container.addChild(new Text(header, 0, 0))
                    if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0))
                    container.addChild(new Spacer(1))
                    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0))
                    container.addChild(new Text(theme.fg("dim", r.task), 0, 0))
                    container.addChild(new Spacer(1))
                    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0))
                    if (displayItems.length === 0 && !finalOutput) {
                        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0))
                    } else {
                        for (const item of displayItems) {
                            if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0))
                        }
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }
                    }
                    const usageStr = formatUsageStats(r.usage, r.model)
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0))
                    }
                    return container
                }

                let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`
                if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`
                if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`
                else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`
                else {
                    text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`
                    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
                }
                const usageStr = formatUsageStats(r.usage, r.model)
                if (usageStr) text += `\n${theme.fg("dim", usageStr)}`
                return new Text(text, 0, 0)
            }

            const aggregateUsage = (results: SingleResult[]) => {
                const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
                for (const r of results) {
                    total.input += r.usage.input
                    total.output += r.usage.output
                    total.cacheRead += r.usage.cacheRead
                    total.cacheWrite += r.usage.cacheWrite
                    total.cost += r.usage.cost
                    total.turns += r.usage.turns
                }
                return total
            }

            if (details.mode === "chain") {
                const successCount = details.results.filter((r) => r.exitCode === 0).length
                const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗")

                if (expanded) {
                    const container = new Container()
                    container.addChild(new Text(icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`), 0, 0))

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")
                        const displayItems = getDisplayItems(r.messages)
                        const finalOutput = getFinalOutput(r.messages)

                        container.addChild(new Spacer(1))
                        container.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0))
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0))

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0))
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }

                        const stepUsage = formatUsageStats(r.usage, r.model)
                        if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0))
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0))
                    }
                    return container
                }

                // Collapsed view
                let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`)
                for (const r of details.results) {
                    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")
                    const displayItems = getDisplayItems(r.messages)
                    text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`
                    if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`
                    else text += `\n${renderDisplayItems(displayItems, 5)}`
                }
                const usageStr = formatUsageStats(aggregateUsage(details.results))
                if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`
                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
                return new Text(text, 0, 0)
            }

            if (details.mode === "parallel") {
                const running = details.results.filter((r) => r.exitCode === -1).length
                const successCount = details.results.filter((r) => r.exitCode === 0).length
                const failCount = details.results.filter((r) => r.exitCode > 0).length
                const isRunning = running > 0
                const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓")
                const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`

                if (expanded && !isRunning) {
                    const container = new Container()
                    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0))

                    for (const r of details.results) {
                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")
                        const displayItems = getDisplayItems(r.messages)
                        const finalOutput = getFinalOutput(r.messages)

                        container.addChild(new Spacer(1))
                        container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0))
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0))

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === "toolCall") {
                                container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0))
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }

                        const taskUsage = formatUsageStats(r.usage, r.model)
                        if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0))
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0))
                    }
                    return container
                }

                // Collapsed view (or still running)
                let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`
                for (const r of details.results) {
                    const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗")
                    const displayItems = getDisplayItems(r.messages)
                    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`
                    if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`
                    else text += `\n${renderDisplayItems(displayItems, 5)}`
                }
                if (!isRunning) {
                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`
                }
                if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
                return new Text(text, 0, 0)
            }

            const text = result.content[0]
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0)
        },
    })
}
