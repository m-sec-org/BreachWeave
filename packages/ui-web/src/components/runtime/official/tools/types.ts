import type { ToolResultMessage } from "@earendil-works/pi-ai"
import type { TemplateResult } from "lit"

export interface ToolRenderResult {
    content: TemplateResult
    isCustom: boolean
}

export interface ToolRenderer<TParams = any> {
    render(params: TParams | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult
}
