export interface AddResult {
    id: string
    rejected?: string
}

export interface HostRuntimeSettings {
    image?: string
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    binds?: string[]
    maxSolvers?: number
    networkMode?: "bridge" | "host"
}

export interface HostPlannerSettings {
    tickIntervalMs?: number
    staleTimeoutMs?: number
}

export interface HostAuthSettings {
    registrationEnabled?: boolean
    jwtSecret?: string
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    planner: HostPlannerSettings
    auth: HostAuthSettings
}
