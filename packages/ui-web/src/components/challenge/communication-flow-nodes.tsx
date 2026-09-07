import type { ReactNode } from "react"
import type { NodeTypes } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import { SOLVER_AGENT_NODE_TYPES } from "./solver-agent-node"

type CommunicationTaskNodeData = {
    label?: ReactNode
}

function CommunicationTaskNode(props: { data: CommunicationTaskNodeData }) {
    const { data } = props

    return (
        <>
            <Handle type="source" position={Position.Top} id="top" className="!border-flow-default !bg-flow-default-bg" />
            {data.label}
            <Handle type="source" position={Position.Bottom} id="bottom" className="!border-flow-default !bg-flow-default-bg" />
        </>
    )
}

export const COMMUNICATION_NODE_TYPES: NodeTypes = {
    ...SOLVER_AGENT_NODE_TYPES,
    "communication-task": CommunicationTaskNode,
}
