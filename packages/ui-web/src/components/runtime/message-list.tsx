import { createElement, useEffect, useRef } from "react"
import type { AgentMessage } from "@mariozechner/pi-agent-core"
import "./official/message-list-element"
import "./official/console-block"
import type { RuntimeThreadView } from "./types"

interface RuntimeMessageListProps {
    thread?: {
        messages: Record<string, unknown>[]
    }
    isStreaming?: boolean
    subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]>
}

interface RuntimeOfficialMessageListElement extends HTMLElement {
    messages: AgentMessage[]
    tools: unknown[]
    pendingToolCalls?: ReadonlySet<string>
    isStreaming: boolean
    subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]>
}

export function RuntimeMessageList({ thread, isStreaming = false, subagentThreadsByToolCallId }: RuntimeMessageListProps) {
    const ref = useRef<RuntimeOfficialMessageListElement | null>(null)

    useEffect(() => {
        if (!ref.current) return
        ref.current.messages = (thread?.messages ?? []) as unknown as AgentMessage[]
        ref.current.tools = []
        ref.current.pendingToolCalls = undefined
        ref.current.isStreaming = isStreaming
        ref.current.subagentThreadsByToolCallId = subagentThreadsByToolCallId
    }, [isStreaming, subagentThreadsByToolCallId, thread?.messages])

    return createElement("runtime-official-message-list", { ref, className: "runtime-official-message-list-host" })
}
