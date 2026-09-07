import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import {
    bashTool,
    readTool,
    editTool,
    writeTool,
    grepTool,
    findTool,
    lsTool,
    bashToolDefinition,
    readToolDefinition,
    editToolDefinition,
    writeToolDefinition,
    grepToolDefinition,
    findToolDefinition,
    lsToolDefinition,
} from "@mariozechner/pi-coding-agent"
import { documentFindingTool } from "./document-finding"
import { ingestSubAgentOutputTool } from "./ingest-sub-agent-output"
import { submitSubAgentOutputTool } from "./submit-sub-agent-output"
import { challengeTools } from "./challenge-tools"
import { securityKimiSearchTool } from "./security-kimi-search"

// ── 自定义工具 ──

/** 所有自定义工具定义 */
export const customTools: ToolDefinition[] = [
    securityKimiSearchTool,
    // submitSubAgentOutputTool,
    // ingestSubAgentOutputTool,
    // documentFindingTool,
    ...challengeTools,
]

// ── SDK 内置工具 ──

/** 所有内置工具定义（用于注册到 registeredTools） */
export const builtinToolDefinitions: Array<ToolDefinition<any, any, any>> = [
    bashToolDefinition,
    readToolDefinition,
    editToolDefinition,
    writeToolDefinition,
    grepToolDefinition,
    findToolDefinition,
    lsToolDefinition,
]

/** 内置工具运行时实例（用于 CreateAgentSessionOptions.tools） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const builtinToolMap: Record<string, any> = {
    read: readTool,
    bash: bashTool,
    edit: editTool,
    write: writeTool,
    grep: grepTool,
    find: findTool,
    ls: lsTool,
}

/** UI 展示用的工具摘要 */
export interface ToolEntry {
    name: string
    label: string
    description: string
    source: string
    parameters?: Record<string, unknown>
    /** MCP 工具所属的服务器名 */
    server?: string
    /** MCP 工具是否以 direct 模式注册（false = proxy） */
    direct?: boolean
}
