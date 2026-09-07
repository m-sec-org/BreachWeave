import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core"
import type { AssistantMessage as AssistantMessageType, ToolResultMessage as ToolResultMessageType } from "@mariozechner/pi-ai"
import { html, LitElement, type TemplateResult } from "lit"
import { property } from "lit/decorators.js"
import { repeat } from "lit/directives/repeat.js"
import { renderMessage } from "./message-renderer-registry"
import "./messages"

interface SubagentInlineThread {
    id: string
    label: string
    promptName?: string
    task?: string
    createdAt?: number
    messages: Record<string, unknown>[]
}

export class RuntimeOfficialMessageListElement extends LitElement {
    @property({ type: Array }) messages: AgentMessage[] = []
    @property({ type: Array }) tools: AgentTool[] = []
    @property({ type: Object }) pendingToolCalls?: ReadonlySet<string>
    @property({ type: Boolean }) isStreaming = false
    @property({ type: Object }) subagentThreadsByToolCallId?: Record<string, SubagentInlineThread[]>
    @property({ attribute: false }) onCostClick?: () => void

    protected override createRenderRoot(): HTMLElement | DocumentFragment {
        return this
    }

    override connectedCallback(): void {
        super.connectedCallback()
        this.style.display = "block"
        this.style.width = "100%"
        this.style.maxWidth = "100%"
        this.style.minWidth = "0"
    }

    private buildRenderItems() {
        const resultByCallId = new Map<string, ToolResultMessageType>()
        for (const message of this.messages) {
            if (message.role === "toolResult") resultByCallId.set(message.toolCallId, message)
        }

        const items: Array<{ key: string; template: TemplateResult }> = []
        let index = 0
        for (const message of this.messages) {
            const customTemplate = renderMessage(message)
            if (customTemplate) {
                items.push({ key: `msg:${index}`, template: customTemplate })
                index += 1
                continue
            }

            if (message.role === "user") {
                items.push({
                    key: `msg:${index}`,
                    template: html`<user-message .message=${message}></user-message>`,
                })
            } else if (message.role === "assistant") {
                items.push({
                    key: `msg:${index}`,
                    template: html`<assistant-message
                        .message=${message as AssistantMessageType}
                        .tools=${this.tools}
                        .isStreaming=${this.isStreaming}
                        .pendingToolCalls=${this.pendingToolCalls}
                        .toolResultsById=${resultByCallId}
                        .hideToolCalls=${false}
                        .hidePendingToolCalls=${this.isStreaming}
                        .subagentThreadsByToolCallId=${this.subagentThreadsByToolCallId}
                        .onCostClick=${this.onCostClick}
                    ></assistant-message>`,
                })
            }
            index += 1
        }

        return items
    }

    override render() {
        const items = this.buildRenderItems()
        return html`<div class="flex flex-col gap-3">
            ${repeat(
                items,
                (item) => item.key,
                (item) => item.template,
            )}
        </div>`
    }
}

if (!customElements.get("runtime-official-message-list")) {
    customElements.define("runtime-official-message-list", RuntimeOfficialMessageListElement)
}
