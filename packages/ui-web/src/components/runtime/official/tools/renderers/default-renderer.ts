import type { ToolResultMessage } from "@mariozechner/pi-ai"
import { html } from "lit"
import type { ToolRenderer, ToolRenderResult } from "../types"

export class DefaultRenderer implements ToolRenderer {
    render(params: any | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
        const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete"

        let paramsJson = ""
        if (params) {
            try {
                paramsJson = JSON.stringify(JSON.parse(params), null, 2)
            } catch {
                try {
                    paramsJson = JSON.stringify(params, null, 2)
                } catch {
                    paramsJson = String(params)
                }
            }
        }

        if (result) {
            let outputJson = result.content?.filter((c) => c.type === "text").map((c: any) => c.text).join("\n") || "(no output)"
            let outputLanguage = "text"

            try {
                const parsed = JSON.parse(outputJson)
                outputJson = JSON.stringify(parsed, null, 2)
                outputLanguage = "json"
            } catch {}

            return {
                content: html`
                    <div class="space-y-3">
                        ${
                            paramsJson
                                ? html`<div>
                                      <div class="text-xs font-medium mb-1 text-muted-foreground">Input</div>
                                      <div class="max-w-full min-w-0 overflow-x-auto">
                                          <code-block .code=${paramsJson} language="json"></code-block>
                                      </div>
                                  </div>`
                                : ""
                        }
                        <div>
                            <div class="text-xs font-medium mb-1 text-muted-foreground">Output</div>
                            <div class="max-w-full min-w-0 overflow-x-auto">
                                <code-block .code=${outputJson} language="${outputLanguage}"></code-block>
                            </div>
                        </div>
                    </div>
                `,
                isCustom: false,
            }
        }

        if (params) {
            if (isStreaming && (!paramsJson || paramsJson === "{}" || paramsJson === "null")) {
                return {
                    content: html`<div class="text-xs text-muted-foreground">Preparing tool parameters...</div>`,
                    isCustom: false,
                }
            }

            return {
                content: html`
                    <div class="space-y-3">
                        <div>
                            <div class="text-xs font-medium mb-1 text-muted-foreground">Input</div>
                            <div class="max-w-full min-w-0 overflow-x-auto">
                                <code-block .code=${paramsJson} language="json"></code-block>
                            </div>
                        </div>
                    </div>
                `,
                isCustom: false,
            }
        }

        return {
            content: html`<div class="text-xs text-muted-foreground">Preparing tool...</div>`,
            isCustom: false,
        }
    }
}
