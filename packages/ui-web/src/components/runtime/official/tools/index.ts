import type { ToolResultMessage } from "@mariozechner/pi-ai"
import { BashRenderer } from "./renderers/bash-renderer"
import { DefaultRenderer } from "./renderers/default-renderer"
import { getToolRenderer, registerToolRenderer } from "./renderer-registry"
import type { ToolRenderResult } from "./types"

registerToolRenderer("bash", new BashRenderer())

const defaultRenderer = new DefaultRenderer()

export function renderTool(
    toolName: string,
    params: any | undefined,
    result: ToolResultMessage | undefined,
    isStreaming?: boolean,
): ToolRenderResult {
    const renderer = getToolRenderer(toolName)
    if (renderer) return renderer.render(params, result, isStreaming)
    return defaultRenderer.render(params, result, isStreaming)
}
