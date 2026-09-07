import type { Node, NodeProps } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import type { AttackTimelineEventKind } from "../../lib/api"
import type { AgentEventCardEvent } from "../../lib/solver-event-card-data"
import { AgentEventCard } from "./agent-event-card"
export {
    SOLVER_AGENT_CARD_HEIGHT,
    SOLVER_AGENT_CARD_WIDTH,
    SOLVER_AGENT_EVENT_LIMIT,
    SOLVER_AGENT_NODE_HEIGHT,
    SOLVER_AGENT_NODE_WIDTH,
} from "./solver-agent-card.constants"

export type SolverAgentNodeData = {
    solverId: string
    promptName: string
    eventCount: number
    recentEvents: AgentEventCardEvent[]
    kindCounts: Partial<Record<AttackTimelineEventKind, number>>
    activityBuckets: number[]
    selected?: boolean
    onViewAll?: () => void
}

export type SolverAgentFlowNode = Node<SolverAgentNodeData, "solver-agent">

function handleIdForPosition(position: Position) {
    return position === Position.Top ? "top" : "bottom"
}

export function SolverAgentNode(props: NodeProps<SolverAgentFlowNode>) {
    const { data, sourcePosition = Position.Bottom, targetPosition = Position.Top } = props

    return (
        <div className="relative">
            <Handle
                type="target"
                id={handleIdForPosition(targetPosition)}
                position={targetPosition}
                className="!border-flow-default !bg-flow-default-bg"
            />
            <AgentEventCard
                promptName={data.promptName}
                eventCount={data.eventCount}
                recentEvents={data.recentEvents}
                kindCounts={data.kindCounts}
                activityBuckets={data.activityBuckets}
                selected={data.selected}
                onViewAll={data.onViewAll}
            />
            <Handle
                type="source"
                id={handleIdForPosition(sourcePosition)}
                position={sourcePosition}
                className="!border-flow-default !bg-flow-default-bg"
            />
        </div>
    )
}

export const SOLVER_AGENT_NODE_TYPES = {
    "solver-agent": SolverAgentNode,
}
