import type { ThinkingLevel } from "@mariozechner/pi-agent-core"

// ── Init payload (bootstrap only, not part of SDK RPC) ──

export interface SolverInitPayload {
    solverId: string
    promptName: string
    task: string
    challengeId?: string
}

// ── RPC types (mirrored from pi-coding-agent rpc-types.ts) ──

export type RpcCommand =
    // Prompting
    | { id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
    | { id?: string; type: "steer"; message: string }
    | { id?: string; type: "follow_up"; message: string }
    | { id?: string; type: "abort" }
    // State
    | { id?: string; type: "get_state" }
    // Model
    | { id?: string; type: "set_model"; provider: string; modelId: string }
    | { id?: string; type: "cycle_model" }
    | { id?: string; type: "get_available_models" }
    // Thinking
    | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
    | { id?: string; type: "cycle_thinking_level" }
    // Queue modes
    | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
    | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
    // Compaction
    | { id?: string; type: "compact"; customInstructions?: string }
    | { id?: string; type: "set_auto_compaction"; enabled: boolean }
    // Retry
    | { id?: string; type: "set_auto_retry"; enabled: boolean }
    | { id?: string; type: "abort_retry" }
    // Bash
    | { id?: string; type: "bash"; command: string }
    | { id?: string; type: "abort_bash" }
    // Session (read-only subset — no runtimeHost)
    | { id?: string; type: "get_session_stats" }
    | { id?: string; type: "export_html"; outputPath?: string }
    | { id?: string; type: "get_fork_messages" }
    | { id?: string; type: "get_last_assistant_text" }
    | { id?: string; type: "set_session_name"; name: string }
    // Messages
    | { id?: string; type: "get_messages" }
    // Internal bridge response (host -> solver process)
    | { id?: string; type: "host_bridge_response"; request_id: string; success: boolean; data?: unknown; error?: string }

export type RpcResponse = { id?: string; type: "response"; command: string; success: true; data?: unknown } | { id?: string; type: "response"; command: string; success: false; error: string }
