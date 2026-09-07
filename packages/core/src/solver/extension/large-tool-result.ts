import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"

const DEFAULT_MAX_INLINE_CHARS = 32000
const PREVIEW_CHARS = 600

export interface LargeToolResultOptions {
    workspaceRoot: string
    maxInlineChars?: number
}

interface SerializedToolResult {
    text: string
    hasContent: boolean
}

interface ToolContentBlock {
    type: string
    text?: string
}

function formatNow(): string {
    return new Date().toISOString()
}

function sanitizeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-")
}

function serializeContentBlocks(content: ToolContentBlock[]): SerializedToolResult {
    if (!Array.isArray(content) || content.length === 0) {
        return { text: "", hasContent: false }
    }

    const chunks: string[] = []
    for (const block of content) {
        if (block.type === "text") {
            chunks.push(block.text ?? "")
            continue
        }
        chunks.push(JSON.stringify(block))
    }
    return { text: chunks.join("\n\n"), hasContent: true }
}

function shouldBypassForSkillMarkdown(toolName: string, input: unknown): boolean {
    if (toolName !== "read" || !input || typeof input !== "object") return false
    const payload = input as { path?: unknown; file_path?: unknown }
    const rawPath = (typeof payload.path === "string" ? payload.path : typeof payload.file_path === "string" ? payload.file_path : "").trim()
    if (!rawPath) return false
    return basename(rawPath) === "SKILL.md"
}

function buildSpillFileBody(toolName: string, toolCallId: string, input: unknown, serializedText: string): string {
    return [
        "# Tool Result Spill",
        "",
        `- time: ${formatNow()}`,
        `- tool: ${toolName}`,
        `- toolCallId: ${toolCallId}`,
        `- originalChars: ${serializedText.length}`,
        "",
        "## Input",
        "```json",
        JSON.stringify(input ?? {}, null, 2),
        "```",
        "",
        "## Full Content",
        "```text",
        serializedText,
        "```",
        "",
    ].join("\n")
}

function buildTruncatedMessage(relPath: string, serializedText: string): string {
    const preview = serializedText.slice(0, PREVIEW_CHARS)
    const suffix = serializedText.length > PREVIEW_CHARS ? "..." : ""
    return [
        `Tool result too large (${serializedText.length} chars).`,
        `Full result saved to: ${relPath}`,
        `This is a function-call spill file. Do not read the whole file blindly.`,
        `Use grep/find to locate relevant sections first, then read in chunks with offset/limit.`,
        `Examples: grep pattern in ${relPath}; read {"path":"${relPath}","offset":1,"limit":200}`,
        "",
        `Preview: ${preview}${suffix}`,
    ].join("\n")
}

export function largeToolResultExtension(options: LargeToolResultOptions): ExtensionFactory {
    const maxInlineChars = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS

    return (pi) => {
        console.log("Large Tool Result extension initialized")
        pi.on("tool_result", async (event) => {
            if (shouldBypassForSkillMarkdown(event.toolName, event.input)) return
            const serialized = serializeContentBlocks(event.content)
            if (!serialized.hasContent || serialized.text.length <= maxInlineChars) return

            const outputDir = join(options.workspaceRoot, ".tool-results")
            await mkdir(outputDir, { recursive: true })

            const fileName = `${Date.now()}-${sanitizeName(event.toolName)}-${sanitizeName(event.toolCallId)}.md`
            const absPath = join(outputDir, fileName)
            const relPath = `.tool-results/${fileName}`

            const fileBody = buildSpillFileBody(event.toolName, event.toolCallId, event.input, serialized.text)
            await Bun.write(absPath, fileBody)

            return {
                content: [{ type: "text", text: buildTruncatedMessage(relPath, serialized.text) }],
                details: {
                    type: "large_tool_result_spill",
                    truncated: true,
                    originalChars: serialized.text.length,
                    path: relPath,
                },
            }
        })
    }
}
