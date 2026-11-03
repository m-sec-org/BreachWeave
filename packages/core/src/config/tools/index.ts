import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent"
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
    createBashToolDefinition(process.cwd()),
    createReadToolDefinition(process.cwd()),
    createEditToolDefinition(process.cwd()),
    createWriteToolDefinition(process.cwd()),
    createGrepToolDefinition(process.cwd()),
    createFindToolDefinition(process.cwd()),
    createLsToolDefinition(process.cwd()),
]

/** Built-in names are passed to the SDK as a session tool allowlist. */
export const builtinToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"])

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
