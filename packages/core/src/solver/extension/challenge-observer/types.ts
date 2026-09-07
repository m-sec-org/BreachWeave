import type { IdeaStatus, MemoryKind } from "../../../challenge/memory"

export interface ObserverToolLog {
    tool_name: string
    args_summary: string
    result_summary: string
    is_error: boolean
}

export interface ObserverRoundPayload {
    round: number
    assistant_summary: string
    tool_logs: ObserverToolLog[]
}

export interface ObserverReviewPayload {
    reason: "periodic" | "hint" | "agent_end"
    rounds: ObserverRoundPayload[]
    session_context: string
    branch_entry_count: number
    message_count: number
}

export interface ObserverIdeaUpdate {
    id: string
    status: IdeaStatus
    result: string
    evidence_refs?: string[]
}

export interface ObserverMemoryAction {
    action: "add" | "update" | "delete"
    entry_id?: string
    kind?: MemoryKind
    content?: string
    refs?: string[]
    source?: string
}

export interface ObserverReviewResult {
    new_ideas: string[]
    idea_updates: ObserverIdeaUpdate[]
    memory_actions: ObserverMemoryAction[]
}
