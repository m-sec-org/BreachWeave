import { icon } from "@mariozechner/mini-lit"
import { html, type TemplateResult } from "lit"
import { Loader } from "lucide"
import type { ToolRenderer } from "./types"

const toolRenderers = new Map<string, ToolRenderer>()

export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
    toolRenderers.set(toolName, renderer)
}

export function getToolRenderer(toolName: string): ToolRenderer | undefined {
    return toolRenderers.get(toolName)
}

export function renderHeader(state: "inprogress" | "complete" | "error", toolIcon: any, text: string | TemplateResult): TemplateResult {
    const statusIcon = (iconComponent: any, color: string) => html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`

    switch (state) {
        case "inprogress":
            return html`
                <div class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                    <div class="flex items-center gap-2">
                        ${statusIcon(toolIcon, "text-foreground")}
                        ${text}
                    </div>
                    ${statusIcon(Loader, "text-foreground animate-spin")}
                </div>
            `
        case "complete":
            return html`
                <div class="flex items-center gap-2 text-sm text-muted-foreground">
                    ${statusIcon(toolIcon, "text-green-600 dark:text-green-500")}
                    ${text}
                </div>
            `
        case "error":
            return html`
                <div class="flex items-center gap-2 text-sm text-muted-foreground">
                    ${statusIcon(toolIcon, "text-destructive")}
                    ${text}
                </div>
            `
    }
}
