import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { TemplateResult } from "lit"

export type MessageRole = AgentMessage["role"]

export interface MessageRenderer<TMessage extends AgentMessage = AgentMessage> {
    render(message: TMessage): TemplateResult
}

const messageRenderers = new Map<MessageRole, MessageRenderer>()

export function registerMessageRenderer<TRole extends MessageRole>(
    role: TRole,
    renderer: MessageRenderer<Extract<AgentMessage, { role: TRole }>>,
): void {
    messageRenderers.set(role, renderer)
}

export function renderMessage(message: AgentMessage): TemplateResult | undefined {
    return messageRenderers.get(message.role)?.render(message)
}
