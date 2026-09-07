import type {
    AssistantMessage as AssistantMessageType,
    ToolCall,
    ToolResultMessage as ToolResultMessageType,
    UserMessage as UserMessageType,
} from "@mariozechner/pi-ai"
import type { AgentTool } from "@mariozechner/pi-agent-core"
import { icon } from "@mariozechner/mini-lit"
import "@mariozechner/mini-lit/dist/MarkdownBlock.js"
import "@mariozechner/mini-lit/dist/CodeBlock.js"
import { html, LitElement } from "lit"
import { customElement, property } from "lit/decorators.js"
import { FunctionSquare } from "lucide"
import { renderTool } from "./tools/index"
import "./thinking-block"

function formatMessageTime(value?: number) {
    if (!value) return ""
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function getMessageSource(message: unknown) {
    if (!message || typeof message !== "object") return ""
    const source = (message as { __threadLabel?: unknown }).__threadLabel
    return typeof source === "string" && source !== "Main" ? source : ""
}

function getRoleLabel(message: unknown, fallback: string) {
    return getMessageSource(message) || fallback
}

interface SubagentInlineThread {
    id: string
    label: string
    promptName?: string
    task?: string
    createdAt?: number
    messages: Record<string, unknown>[]
}

@customElement("user-message")
export class UserMessage extends LitElement {
    @property({ type: Object }) message!: UserMessageType

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

    override render() {
        const content =
            typeof this.message.content === "string"
                ? this.message.content
                : this.message.content.find((c) => c.type === "text")?.text || ""

        return html`
            <div class="mx-4 flex min-w-0 justify-start">
                <div class="user-message-container min-w-0 max-w-full rounded-xl px-4 py-2">
                    <markdown-block .content=${content}></markdown-block>
                    ${this.message.timestamp ? html`<div class="mt-2 text-[11px] text-muted-foreground">${formatMessageTime(this.message.timestamp)}</div>` : ""}
                </div>
            </div>
        `
    }
}

@customElement("assistant-message")
export class AssistantMessage extends LitElement {
    @property({ type: Object }) message!: AssistantMessageType
    @property({ type: Array }) tools?: AgentTool<any>[]
    @property({ type: Object }) pendingToolCalls?: ReadonlySet<string>
    @property({ type: Boolean }) hideToolCalls = false
    @property({ type: Object }) toolResultsById?: Map<string, ToolResultMessageType>
    @property({ type: Boolean }) isStreaming = false
    @property({ type: Boolean }) hidePendingToolCalls = false
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

    override render() {
        const orderedParts = []

        for (const chunk of this.message.content) {
            if (chunk.type === "text" && chunk.text.trim() !== "") {
                orderedParts.push(html`<markdown-block .content=${chunk.text}></markdown-block>`)
            } else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
                orderedParts.push(html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`)
            } else if (chunk.type === "toolCall" && !this.hideToolCalls) {
                const tool = this.tools?.find((t) => t.name === chunk.name)
                const pending = this.pendingToolCalls?.has(chunk.id) ?? false
                const result = this.toolResultsById?.get(chunk.id)
                if (this.hidePendingToolCalls && pending && !result) continue
                const aborted = this.message.stopReason === "aborted" && !result
                orderedParts.push(
                    html`<tool-message
                        .tool=${tool}
                        .toolCall=${chunk}
                        .result=${result}
                        .pending=${pending}
                        .aborted=${aborted}
                        .isStreaming=${this.isStreaming}
                        .subagentThreads=${this.subagentThreadsByToolCallId?.[chunk.id] ?? []}
                    ></tool-message>`,
                )
            }
        }

        return html`
            <div class="min-w-0 max-w-full">
                ${orderedParts.length
                    ? html`
                          <div class="flex min-w-0 flex-col gap-3 px-4">
                              ${orderedParts}
                          </div>
                      `
                    : ""}
                <div class="px-4 mt-2 text-xs text-muted-foreground">${this.message.timestamp ? formatMessageTime(this.message.timestamp) : ""}</div>
                ${
                    this.message.stopReason === "error" && this.message.errorMessage
                        ? html`<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden"><strong>Error:</strong> ${this.message.errorMessage}</div>`
                        : ""
                }
                ${this.message.stopReason === "aborted" ? html`<span class="text-sm text-destructive italic">Request aborted</span>` : ""}
            </div>
        `
    }
}

@customElement("tool-message")
export class ToolMessage extends LitElement {
    @property({ type: Object }) toolCall!: ToolCall
    @property({ type: Object }) tool?: AgentTool<any>
    @property({ type: Object }) result?: ToolResultMessageType
    @property({ type: Boolean }) pending = false
    @property({ type: Boolean }) aborted = false
    @property({ type: Boolean }) isStreaming = false
    @property({ type: Array }) subagentThreads: SubagentInlineThread[] = []

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

    override render() {
        const toolName = this.tool?.name || this.toolCall.name
        const result: ToolResultMessageType | undefined = this.aborted
            ? {
                  role: "toolResult" as const,
                  isError: true,
                  content: [],
                  toolCallId: this.toolCall.id,
                  toolName: this.toolCall.name,
                  timestamp: Date.now(),
              }
            : this.result
        const isIncomplete = !this.aborted && !this.result
        const renderResult = renderTool(toolName, this.toolCall.arguments, result, !this.aborted && (this.isStreaming || this.pending || isIncomplete))
        const openByDefault = true

        if (renderResult.isCustom) return renderResult.content

        const stateText = this.result ? (this.result.isError ? "error" : "done") : this.isStreaming || this.pending || isIncomplete ? "running" : "pending"

        return html`
            <details class="group min-w-0 max-w-full py-1 text-card-foreground" ?open=${openByDefault}>
                <summary class="list-none cursor-pointer select-none">
                    <div class="flex items-center justify-between gap-3 border-l-2 border-border/70 pl-3 pr-1 py-1.5">
                        <div class="min-w-0 flex items-center gap-2">
                            <span class="inline-flex items-center gap-1 text-sm font-medium">
                                ${icon(FunctionSquare, "xs")}
                                Tool Call
                            </span>
                            <span class="text-sm text-muted-foreground">${toolName}</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <span class="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">${stateText}</span>
                        </div>
                    </div>
                </summary>
                <div class="mt-2 min-w-0 max-w-full overflow-x-hidden border-l border-border/60 pl-4">
                    ${renderResult.content}
                    ${
                        toolName === "subagent" && this.subagentThreads.length > 0
                            ? html`
                                  <div class="mt-3 min-w-0 space-y-2">
                                      ${this.subagentThreads.map(
                                          (thread) => html`
                                              <details class="min-w-0 max-w-full rounded-lg border border-amber-200/80 bg-amber-50/40 p-2 dark:border-amber-900/40 dark:bg-amber-950/10" ?open=${this.isStreaming}>
                                                  <summary class="cursor-pointer list-none text-sm">
                                                      <div class="flex items-center justify-between gap-2">
                                                          <span class="font-medium text-amber-700 dark:text-amber-300">Subagent ${thread.promptName || thread.label}</span>
                                                          <span class="text-[11px] text-muted-foreground">${thread.createdAt ? formatMessageTime(thread.createdAt) : ""}</span>
                                                      </div>
                                                      ${thread.task ? html`<div class="mt-1 text-xs text-muted-foreground">${thread.task}</div>` : ""}
                                                  </summary>
                                                  <div class="mt-2 min-w-0 max-w-full overflow-x-hidden border-l border-border/60 pl-2">
                                                      <runtime-official-message-list
                                                          .messages=${thread.messages as unknown as AssistantMessageType[]}
                                                          .tools=${[]}
                                                          .isStreaming=${this.isStreaming}
                                                      ></runtime-official-message-list>
                                                  </div>
                                              </details>
                                          `,
                                      )}
                                  </div>
                              `
                            : ""
                    }
                    <div class="mt-2 text-[11px] text-muted-foreground">${this.result?.timestamp ? formatMessageTime(this.result.timestamp) : ""}</div>
                </div>
            </details>
        `
    }
}
