import type { Edge, Node } from "@xyflow/react"
import { Position } from "@xyflow/react"
import ELK from "elkjs/lib/elk.bundled"
import type { ELK as ElkInstance, ElkNode } from "elkjs"

let elk: ElkInstance | undefined

function getElk() {
    elk ??= new ELK()
    return elk
}

export type ElkDirection = "DOWN" | "RIGHT" | "UP" | "LEFT"

interface LayoutFlowOptions {
    direction?: ElkDirection
    nodeWidth?: number
    nodeHeight?: number
    spacing?: number
    layerSpacing?: number
    padding?: number
}

function sourcePosition(direction: ElkDirection) {
    if (direction === "RIGHT") return Position.Right
    if (direction === "LEFT") return Position.Left
    if (direction === "UP") return Position.Top
    return Position.Bottom
}

function targetPosition(direction: ElkDirection) {
    if (direction === "RIGHT") return Position.Left
    if (direction === "LEFT") return Position.Right
    if (direction === "UP") return Position.Bottom
    return Position.Top
}

export async function layoutFlowElements<N extends Node, E extends Edge>(nodes: N[], edges: E[], options: LayoutFlowOptions = {}) {
    const direction = options.direction ?? "DOWN"
    const nodeWidth = options.nodeWidth ?? 260
    const nodeHeight = options.nodeHeight ?? 112
    const spacing = options.spacing ?? 72
    const layerSpacing = options.layerSpacing ?? 112
    const padding = options.padding ?? 48

    const measuredNodes = nodes.map((node) => {
        const styleWidth = typeof node.style?.width === "number" ? node.style.width : undefined
        const styleHeight = typeof node.style?.height === "number" ? node.style.height : undefined
        return {
            id: node.id,
            width: node.width ?? styleWidth ?? nodeWidth,
            height: node.height ?? styleHeight ?? nodeHeight,
        }
    })

    const graph: ElkNode = {
        id: "root",
        layoutOptions: {
            "elk.algorithm": "layered",
            "elk.direction": direction,
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.padding": `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,
            "elk.spacing.nodeNode": String(spacing),
            "elk.spacing.edgeNode": String(Math.max(20, Math.floor(spacing / 2))),
            "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
            "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
            "elk.layered.cycleBreaking.strategy": "GREEDY",
        },
        children: measuredNodes,
        edges: edges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        })),
    }

    try {
        const layoutedGraph = await getElk().layout(graph)
        return {
            nodes: nodes.map((node) => {
                const layoutedNode = layoutedGraph.children?.find((item) => item.id === node.id)
                const measuredNode = measuredNodes.find((item) => item.id === node.id)
                return {
                    ...node,
                    style: {
                        ...node.style,
                        width: measuredNode?.width ?? nodeWidth,
                        height: measuredNode?.height ?? nodeHeight,
                    },
                    sourcePosition: sourcePosition(direction),
                    targetPosition: targetPosition(direction),
                    position: {
                        x: layoutedNode?.x ?? node.position.x,
                        y: layoutedNode?.y ?? node.position.y,
                    },
                }
            }),
            edges,
        }
    } catch (error) {
        console.error("ELK layout error:", error)
        return { nodes, edges }
    }
}
