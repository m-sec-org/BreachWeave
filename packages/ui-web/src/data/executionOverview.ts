export type SegmentType = "normal" | "spawn" | "memory" | "idea" | "flag" | "empty"

export interface Segment {
    type: SegmentType
    start: number
    end: number
}

export interface AgentTimeline {
    name: string
    segments: Segment[]
}

export interface ExecutionOverviewData {
    startTime?: string
    endTime?: string
    columnCount: number
    times: string[]
    agents: AgentTimeline[]
    stats: {
        normal: number
        spawn: number
        memory: number
        idea: number
        flag: number
        total: number
    }
}
