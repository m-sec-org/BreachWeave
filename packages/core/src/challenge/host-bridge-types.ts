export type HostBridgeAction =
    | "challenge_get_state"
    | "challenge_get_hint"
    | "challenge_submit_report"
    | "challenge_is_completed"
    | "challenge_get_solver_review_context"
    | "challenge_submit_solver_review"
    | "challenge_memory_list"
    | "challenge_board_refresh"
    | "challenge_memory_add"
    | "challenge_idea_list"
    | "challenge_idea_search"
    | "challenge_idea_add"
    | "challenge_authorized_http"
    | "authorized_work_renew"
    | "authorized_work_finish"
    | "authorized_model_fetch"
    | "authorized_model_read"
    | "authorized_model_cancel"

export interface HostBridgeRequestEvent {
    type: "host_bridge_request"
    request_id: string
    action: HostBridgeAction
    params: unknown
}
