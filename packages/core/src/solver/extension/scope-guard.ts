import { appendFile } from "fs/promises"
import { isAbsolute, join, resolve } from "path"
import { isToolCallEventType } from "@mariozechner/pi-coding-agent"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { pathStartsWithPrefix, readRunPolicy } from "../../config/tools/pentest-workspace"

export type ScopeGuardMode = "audit" | "enforce"

export interface ScopeGuardOptions {
    workspaceRoot: string
    agentRole: "main" | "recon" | "targeted-pentest" | "payload-research" | "custom" | "subagent"
    mode?: ScopeGuardMode
    outputId?: string
    allowedWritePrefixes?: string[]
    maxToolCalls?: number
    mainDirectActionLimit?: number
}

const SHARED_STATE_FILES = [
    "assets.md",
    "findings.md",
    "findings.ndjson",
    "final-report.md",
    "state/run-state.json",
    "state/hypothesis-backlog.json",
]

const MAIN_MACHINE_OWNED_FILES = ["findings.md", "findings.ndjson", "state/run-state.json", "state/hypothesis-backlog.json"]

const MAIN_MONITORED_COMMAND_TOKENS = [
    "curl",
    "wget",
    "nmap",
    "masscan",
    "zmap",
    "rustscan",
    "naabu",
    "ffuf",
    "gobuster",
    "feroxbuster",
    "dirsearch",
    "nikto",
    "sqlmap",
    "wfuzz",
]

const DEFAULT_MAIN_DIRECT_ACTION_LIMIT = 6
const SUBMISSION_TOOL_NAME = "submit_sub_agent_output"
const PROBING_TOOL_NAMES = new Set(["bash", "grep", "find", "ls"])
const EXPLORATION_WARNING_THRESHOLD = 2

function resolveToolPath(workspaceRoot: string, rawPath: string): string {
    return isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath)
}

function commandContainsForbiddenToken(command: string, token: string): boolean {
    const pattern = new RegExp(`(^|\\s|[;&|()])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|[;&|()])`, "i")
    return pattern.test(command)
}

function commandTargetsSharedState(command: string): boolean {
    const lower = command.toLowerCase()
    if (!/[>|]|tee|sed\s+-i|perl\s+-i|truncate/.test(lower)) {
        return false
    }
    return SHARED_STATE_FILES.some((file) => lower.includes(file.toLowerCase()))
}

function commandContainsHttpUrl(command: string): boolean {
    return /\bhttps?:\/\/\S+/i.test(command)
}

function isMainMachineOwnedPath(resolvedPath: string, machineOwnedFiles: Set<string>, subAgentsDir: string): boolean {
    if (machineOwnedFiles.has(resolvedPath)) return true
    if (pathStartsWithPrefix(resolvedPath, subAgentsDir) && resolvedPath.endsWith(".json")) return true
    return false
}

function findMainMonitoredToken(command: string): string | undefined {
    for (const token of MAIN_MONITORED_COMMAND_TOKENS) {
        if (commandContainsForbiddenToken(command, token)) return token
    }
}

function commandTargetsAllowedTarget(command: string, allowedTargets: string[]): boolean {
    if (allowedTargets.length === 0) return false
    const lower = command.toLowerCase()
    return allowedTargets.some((target) => lower.includes(target.toLowerCase()))
}

function sanitizeCommandForLog(command: string): string {
    return command.replace(/\s+/g, " ").slice(0, 200)
}

function isProbingToolName(toolName: string): boolean {
    return PROBING_TOOL_NAMES.has(toolName)
}

export function scopeGuardExtension(options: ScopeGuardOptions): ExtensionFactory {
    const { workspaceRoot, agentRole, outputId, allowedWritePrefixes, maxToolCalls, mainDirectActionLimit } = options
    const mode = options.mode ?? "audit"
    const auditLogPath = join(workspaceRoot, "audit.log")
    const sharedStateAbsolute = new Set(SHARED_STATE_FILES.map((file) => resolve(workspaceRoot, file)))
    const mainMachineOwnedAbsolute = new Set(MAIN_MACHINE_OWNED_FILES.map((file) => resolve(workspaceRoot, file)))
    const subAgentsAbsolute = resolve(workspaceRoot, "sub-agents")
    const writePrefixes = allowedWritePrefixes?.map((path) => resolve(workspaceRoot, path)) ?? []
    const directActionLimit = Math.max(1, Math.floor(mainDirectActionLimit ?? DEFAULT_MAIN_DIRECT_ACTION_LIMIT))
    let mainDirectActions = 0
    let probingToolCalls = 0
    let lastWarnedRemainingBudget: number | null = null

    async function writeLog(line: string): Promise<void> {
        await appendFile(auditLogPath, line, "utf-8").catch(() => {})
    }

    return (pi) => {
        pi.on("tool_call", async (event) => {
            if (mode === "enforce" && agentRole !== "main" && maxToolCalls !== undefined) {
                if (event.toolName === SUBMISSION_TOOL_NAME) {
                    return
                }

                if (isProbingToolName(event.toolName)) {
                    probingToolCalls += 1
                    const remainingBudget = maxToolCalls - probingToolCalls
                    const shouldWarn =
                        remainingBudget <= EXPLORATION_WARNING_THRESHOLD &&
                        (lastWarnedRemainingBudget === null || remainingBudget < lastWarnedRemainingBudget)
                    if (shouldWarn) {
                        lastWarnedRemainingBudget = remainingBudget
                        await writeLog(
                            `[${new Date().toISOString()}] BUDGET_WARN role=${agentRole} output_id=${outputId ?? "-"} probing=${probingToolCalls}/${maxToolCalls}\n`,
                        )
                        pi.sendMessage(
                            {
                                customType: "subagent-exploration-budget-warning",
                                content: [
                                    {
                                        type: "text",
                                        text:
                                            `Exploration budget is near exhaustion (${probingToolCalls}/${maxToolCalls}). ` +
                                            `Stop new probing and switch to consolidation + submit_sub_agent_output.`,
                                    },
                                ],
                                display: false,
                                details: {
                                    role: agentRole,
                                    output_id: outputId ?? null,
                                    probing_calls: probingToolCalls,
                                    max_tool_calls: maxToolCalls,
                                    remaining_budget: remainingBudget,
                                },
                            },
                            { deliverAs: remainingBudget <= 0 ? "steer" : "nextTurn" },
                        )
                    }

                    if (probingToolCalls > maxToolCalls) {
                        const reason = `exploration budget exceeded (${probingToolCalls}/${maxToolCalls}); stop probing and call submit_sub_agent_output`
                        await writeLog(
                            `[${new Date().toISOString()}] TOOL_BLOCK ${event.toolName} role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                        )
                        return { block: true, reason }
                    }
                }
            }

            if (agentRole === "main") {
                if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
                    const requestedPath = event.input.path
                    const resolvedPath = resolveToolPath(workspaceRoot, requestedPath)
                    if (isMainMachineOwnedPath(resolvedPath, mainMachineOwnedAbsolute, subAgentsAbsolute)) {
                        const reason = `path "${requestedPath}" is machine-owned canonical state; use spawn_sub_agent/ingest_sub_agent_output/document_finding instead`
                        await writeLog(
                            `[${new Date().toISOString()}] TOOL_BLOCK ${event.toolName} role=main output_id=${outputId ?? "-"} reason=${reason}\n`,
                        )
                        pi.sendMessage(
                            {
                                customType: "orchestrator-owned-file-reminder",
                                content: [
                                    {
                                        type: "text",
                                        text:
                                            `Main orchestrator can edit coordination docs, but not machine-owned files.\n` +
                                            `Blocked: \`${requestedPath}\`\n` +
                                            `Use tools to update canonical state: spawn_sub_agent -> ingest_sub_agent_output -> document_finding.`,
                                    },
                                ],
                                display: false,
                                details: { role: "main", tool: event.toolName, path: requestedPath },
                            },
                            { deliverAs: "steer" },
                        )
                        return { block: true, reason }
                    }
                }

                if (event.toolName === "spawn_sub_agent") {
                    if (mainDirectActions > 0) {
                        await writeLog(
                            `[${new Date().toISOString()}] MAIN_DIRECT_ACTION_RESET role=main count_before_reset=${mainDirectActions} reason=spawn_sub_agent\n`,
                        )
                    }
                    mainDirectActions = 0
                }

                if (isToolCallEventType("bash", event)) {
                    const command = event.input.command.trim()
                    const policy = await readRunPolicy(workspaceRoot)
                    const monitoredToken = findMainMonitoredToken(command)
                    const isDirectPentestAction =
                        commandContainsHttpUrl(command) || Boolean(monitoredToken) || commandTargetsAllowedTarget(command, policy.allowed_targets)

                    if (isDirectPentestAction) {
                        mainDirectActions += 1
                        const commandSnippet = sanitizeCommandForLog(command)
                        const limitReached = mainDirectActions >= directActionLimit
                        const stageHint = monitoredToken === "sqlmap" || monitoredToken === "wfuzz" ? "test" : "recon"
                        const linePrefix = limitReached ? "MAIN_DIRECT_ACTION_BLOCK" : "MAIN_DIRECT_ACTION_WARN"
                        await writeLog(
                            `[${new Date().toISOString()}] ${linePrefix} role=main count=${mainDirectActions}/${directActionLimit} tool=bash stage_hint=${stageHint} command=${JSON.stringify(commandSnippet)}\n`,
                        )
                        pi.sendMessage(
                            {
                                customType: "orchestrator-boundary-reminder",
                                content: [
                                    {
                                        type: "text",
                                        text:
                                            `Orchestrator boundary reminder: main agent should delegate recon/test execution to sub-agents while keeping shared-state edits local.\n` +
                                            `Detected direct bash command: \`${commandSnippet}\`.\n` +
                                            `Current boundary count: ${mainDirectActions}/${directActionLimit}.`,
                                    },
                                ],
                                display: false,
                                details: { role: "main", count: mainDirectActions, limit: directActionLimit, tool: event.toolName },
                            },
                            { deliverAs: limitReached ? "steer" : "nextTurn" },
                        )
                        if (limitReached) {
                            const reason = `main agent direct recon/test command budget reached (${mainDirectActions}/${directActionLimit}); delegate via spawn_sub_agent`
                            return { block: true, reason }
                        }
                    }
                }
            }

            if (mode !== "enforce" || agentRole === "main") {
                return
            }

            const policy = await readRunPolicy(workspaceRoot)
            if (isToolCallEventType("bash", event)) {
                const command = event.input.command.trim()
                if (policy.no_scan) {
                    for (const token of policy.forbidden_commands) {
                        if (commandContainsForbiddenToken(command, token)) {
                            const reason = `command "${token}" is forbidden by run policy`
                            await writeLog(
                                `[${new Date().toISOString()}] TOOL_BLOCK bash role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                            )
                            return { block: true, reason }
                        }
                    }
                }

                if (commandTargetsSharedState(command)) {
                    const reason = "bash command attempts to mutate shared state files"
                    await writeLog(
                        `[${new Date().toISOString()}] TOOL_BLOCK bash role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                    )
                    return { block: true, reason }
                }

                if (policy.allowed_targets.length > 0 && /https?:\/\//i.test(command)) {
                    const hitsAllowedTarget = policy.allowed_targets.some((target) => command.includes(target))
                    if (!hitsAllowedTarget) {
                        const reason = "command target is outside allowed_targets in run policy"
                        await writeLog(
                            `[${new Date().toISOString()}] TOOL_BLOCK bash role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                        )
                        return { block: true, reason }
                    }
                }
            }

            if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
                const requestedPath = event.input.path
                const resolvedPath = resolveToolPath(workspaceRoot, requestedPath)
                if (sharedStateAbsolute.has(resolvedPath)) {
                    const reason = `path "${requestedPath}" is shared state and not writable by ${agentRole}`
                    await writeLog(
                        `[${new Date().toISOString()}] TOOL_BLOCK ${event.toolName} role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                    )
                    return { block: true, reason }
                }
                if (writePrefixes.length > 0) {
                    const withinAllowedPrefix = writePrefixes.some((prefix) => pathStartsWithPrefix(resolvedPath, prefix))
                    if (!withinAllowedPrefix) {
                        const reason = `path "${requestedPath}" is outside allowed write prefixes for ${agentRole}`
                        await writeLog(
                            `[${new Date().toISOString()}] TOOL_BLOCK ${event.toolName} role=${agentRole} output_id=${outputId ?? "-"} reason=${reason}\n`,
                        )
                        return { block: true, reason }
                    }
                }
            }
        })

        pi.on("tool_execution_start", async (event) => {
            await writeLog(
                `[${new Date().toISOString()}] TOOL_START role=${agentRole} output_id=${outputId ?? "-"} tool=${event.toolName} args=${JSON.stringify(event.args)}\n`,
            )
        })

        pi.on("tool_execution_end", async (event) => {
            const status = event.isError ? "ERROR" : "OK"
            await writeLog(
                `[${new Date().toISOString()}] TOOL_END role=${agentRole} output_id=${outputId ?? "-"} tool=${event.toolName} status=${status}\n`,
            )
        })
    }
}
