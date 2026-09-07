export type HostBridgeAction =
    | "challenge_get_state"
    | "challenge_get_hint"
    | "challenge_submit_report"
    | "challenge_is_completed"
    | "challenge_memory_list"
    | "challenge_memory_add"
    | "challenge_idea_list"
    | "challenge_idea_search"
    | "challenge_idea_add"

export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    request_id: string
    action: HostBridgeAction
    params: unknown
}
