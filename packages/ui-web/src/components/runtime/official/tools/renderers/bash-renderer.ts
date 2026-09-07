import type { ToolResultMessage } from "@mariozechner/pi-ai"
import { html } from "lit"
import { SquareTerminal } from "lucide"
import { renderHeader } from "../renderer-registry"
import type { ToolRenderer, ToolRenderResult } from "../types"

interface BashParams {
    command: string
}

export class BashRenderer implements ToolRenderer<BashParams, undefined> {
    render(params: BashParams | undefined, result: ToolResultMessage<undefined> | undefined): ToolRenderResult {
        const state = result ? (result.isError ? "error" : "complete") : "inprogress"

        if (result && params?.command) {
            const output = result.content?.filter((c) => c.type === "text").map((c: any) => c.text).join("\n") || ""
            const combined = output ? `> ${params.command}\n\n${output}` : `> ${params.command}`
            return {
                content: html`
                    <div class="space-y-3">
                        ${renderHeader(state, SquareTerminal, "Running command...")}
                        <console-block .content=${combined} .variant=${result.isError ? "error" : "default"}></console-block>
                    </div>
                `,
                isCustom: false,
            }
        }

        if (params?.command) {
            return {
                content: html`
                    <div class="space-y-3">
                        ${renderHeader(state, SquareTerminal, "Running command...")}
                        <console-block .content=${`> ${params.command}`}></console-block>
                    </div>
                `,
                isCustom: false,
            }
        }

        return { content: renderHeader(state, SquareTerminal, "Waiting for command..."), isCustom: false }
    }
}
