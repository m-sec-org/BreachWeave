import { expect, test } from "bun:test"
import { Position } from "@xyflow/react"
import type { AttackTimelineEvent, IdeaRecord, MemoryEntry } from "../../lib/api"
import { buildCommunicationGraph, buildKnowledgeGraphContentKey, buildKnowledgeGraphFromBoard, buildKnowledgeGraphLayoutKey, knowledgeDisplayLabel, knowledgeNodeTextParts, layoutCollaborationFlowElements } from "./attack-flow"
import { SOLVER_AGENT_NODE_HEIGHT, SOLVER_AGENT_NODE_WIDTH } from "./solver-agent-card.constants"

const mockT = ((key: string) => key) as Parameters<typeof buildCommunicationGraph>[2]

function createSolverStartedEvent(solverId: string, promptName: string, timestamp: string): AttackTimelineEvent {
    return {
        id: `solver_started:${solverId}`,
        timestamp: Date.parse(timestamp),
        challengeId: "challenge_1",
        solverId,
        lane: "solver",
        kind: "solver_started",
        title: "Solver started",
        summary: solverId,
        payload: {
            attempt: {
                prompt_name: promptName,
            },
        },
    }
}

test("communication graph treats named solver base edges uniformly", () => {
    const discoverySolverId = "solver_discovery"
    const validationSolverId = "solver_validation"
    const events: AttackTimelineEvent[] = [
        createSolverStartedEvent(discoverySolverId, "资产发现智能体", "2026-04-13T00:00:00.000Z"),
        createSolverStartedEvent(validationSolverId, "漏洞验证智能体", "2026-04-13T00:01:00.000Z"),
    ]

    const graph = buildCommunicationGraph("challenge_1", events, mockT)
    const solverEdges = [discoverySolverId, validationSolverId].map((solverId) => graph.edges.find((edge) => edge.id === `base:${solverId}`))

    for (const edge of solverEdges) {
        expect(edge?.data?.active).toBe(false)
        expect(edge?.style?.stroke).toBe("var(--flow-edge-soft)")
        expect(edge?.style?.strokeDasharray).toBe("6 5")
    }
})

test("collaboration layout splits solver nodes above and below the root", () => {
    const events: AttackTimelineEvent[] = [
        createSolverStartedEvent("solver_a", "Agent A", "2026-04-13T00:00:00.000Z"),
        createSolverStartedEvent("solver_b", "Agent B", "2026-04-13T00:01:00.000Z"),
        createSolverStartedEvent("solver_c", "Agent C", "2026-04-13T00:02:00.000Z"),
        createSolverStartedEvent("solver_d", "Agent D", "2026-04-13T00:03:00.000Z"),
    ]

    const graph = buildCommunicationGraph("challenge_1", events, mockT)
    const layout = layoutCollaborationFlowElements(graph.nodes, graph.edges, {
        spacing: 44,
        layerSpacing: 128,
        nodeWidth: SOLVER_AGENT_NODE_WIDTH,
        nodeHeight: SOLVER_AGENT_NODE_HEIGHT,
    })

    const root = layout.nodes.find((node) => node.id === "topology:task")
    const above = layout.nodes.filter((node) => node.id.startsWith("topology:solver:") && (node.position.y ?? 0) < (root?.position.y ?? 0))
    const below = layout.nodes.filter((node) => node.id.startsWith("topology:solver:") && (node.position.y ?? 0) > (root?.position.y ?? 0))

    expect(above).toHaveLength(2)
    expect(below).toHaveLength(2)
    expect(Math.abs(above.length - below.length)).toBeLessThanOrEqual(1)
    expect(layout.edges.find((edge) => edge.target === "topology:solver:solver_a")?.sourceHandle).toBe("top")
    expect(layout.edges.find((edge) => edge.target === "topology:solver:solver_d")?.sourceHandle).toBe("bottom")
})

test("collaboration layout keeps a single solver above the root", () => {
    const events: AttackTimelineEvent[] = [createSolverStartedEvent("solver_a", "Agent A", "2026-04-13T00:00:00.000Z")]
    const graph = buildCommunicationGraph("challenge_1", events, mockT)
    const layout = layoutCollaborationFlowElements(graph.nodes, graph.edges, {
        spacing: 44,
        layerSpacing: 128,
        nodeWidth: SOLVER_AGENT_NODE_WIDTH,
        nodeHeight: SOLVER_AGENT_NODE_HEIGHT,
    })

    const root = layout.nodes.find((node) => node.id === "topology:task")
    const solver = layout.nodes.find((node) => node.id === "topology:solver:solver_a")

    expect((solver?.position.y ?? 0)).toBeLessThan(root?.position.y ?? 0)
    expect(solver?.targetPosition).toBe(Position.Bottom)
})

test("communication graph keeps goal achieved effect after the first marker event", () => {
    const solverId = "solver_goal"
    const events: AttackTimelineEvent[] = [
        createSolverStartedEvent(solverId, "Goal Agent", "2026-04-13T00:00:00.000Z"),
        memoryEvent(
            "memory_add:goal:first",
            createMemory("mem_goal_first", "攻击成功: 目标已达成：夺取办公网最高权限。", "2026-04-13T00:01:00.000Z"),
            "2026-04-13T00:01:00.000Z",
        ),
        memoryEvent(
            "memory_add:goal:second",
            createMemory("mem_goal_second", "最终验证结果 目标已达成：夺取办公网最高权限。", "2026-04-13T00:02:00.000Z"),
            "2026-04-13T00:02:00.000Z",
        ),
    ]

    const firstGoalGraph = buildCommunicationGraph("challenge_1", events.slice(0, 2), mockT, events[1], undefined, undefined, undefined, events[1]?.id)
    const secondGoalGraph = buildCommunicationGraph("challenge_1", events, mockT, events[2], undefined, undefined, undefined, events[1]?.id)
    const firstTask = firstGoalGraph.nodes.find((node) => node.id === "topology:task")
    const secondTask = secondGoalGraph.nodes.find((node) => node.id === "topology:task")

    expect(firstTask?.className).toContain("!border-none")
    expect(secondTask?.className).toContain("!border-none")
})

test("knowledge graph displays node kind and status labels in Chinese", () => {
    expect(knowledgeDisplayLabel("testing")).toBe("验证中")
    expect(knowledgeDisplayLabel("evidence")).toBe("证据")
    expect(knowledgeDisplayLabel("fact")).toBe("发现")
    expect(knowledgeDisplayLabel("failed")).toBe("已失败")
})

test("knowledge graph memory node title uses content instead of repeating kind", () => {
    expect(
        knowledgeNodeTextParts({
            entity: "memory",
            title: "图片资源管理系统: Apache/2.4.54",
            summary: "发现",
            detail: "observer",
        }),
    ).toEqual({
        heading: "图片资源管理系统: Apache/2.4.54",
        body: "observer",
    })
})

test("knowledge graph keeps the replay-time idea record on the node", () => {
    const currentIdea: IdeaRecord = {
        id: "idea_replay",
        content: "Explore route",
        normalized: "explore route",
        status: "failed",
        result: "final failed result",
        created_at: "2026-04-13T00:00:00.000Z",
        updated_at: "2026-04-14T00:00:00.000Z",
    }
    const replayEvent: AttackTimelineEvent = {
        id: "event_idea_replay",
        timestamp: Date.parse("2026-04-13T01:00:00.000Z"),
        challengeId: "challenge_1",
        solverId: "solver_1",
        lane: "board",
        kind: "idea_updated",
        title: "Idea updated",
        summary: "Explore route",
        payload: {
            item: {
                ...currentIdea,
                status: "testing",
                result: "old testing result",
                updated_at: "2026-04-13T01:00:00.000Z",
            },
        },
    }

    const graph = buildKnowledgeGraphFromBoard([], [currentIdea], [replayEvent], replayEvent.timestamp)
    const ideaNode = graph.nodes.find((node) => node.data.rawId === currentIdea.id)

    expect(ideaNode?.data.knowledgeRecord).toMatchObject({
        id: currentIdea.id,
        status: "testing",
        result: "old testing result",
    })
})

test("knowledge graph connects a new idea to the previous memory layer", () => {
    const rootMemory = createMemory("mem_root", "Initial recon", "2026-04-13T00:00:00.000Z")
    const oldIdea = createIdea("idea_old", "Read config with XXE", "verified", "2026-04-13T00:05:00.000Z")
    const nextMemory = createMemory("mem_next", "Config exposes admin key", "2026-04-13T00:10:00.000Z", [oldIdea.id])
    const newIdea = createIdea("idea_new", "Try admin debug endpoint", "pending", "2026-04-13T00:20:00.000Z")
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:root", rootMemory, "2026-04-13T00:00:00.000Z"),
        ideaEvent("idea_add:old", oldIdea, "2026-04-13T00:05:00.000Z"),
        memoryEvent("memory_add:next", nextMemory, "2026-04-13T00:10:00.000Z"),
        ideaEvent("idea_add:new", newIdea, "2026-04-13T00:20:00.000Z"),
    ]

    const graph = buildKnowledgeGraphFromBoard([rootMemory, nextMemory], [oldIdea, newIdea], events, Date.parse("2026-04-13T00:21:00.000Z"))

    expect(graph.edges.some((edge) => edge.source === "knowledge:memory:mem_next" && edge.target === "knowledge:idea:idea_new")).toBe(true)
    expect(graph.edges.find((edge) => edge.source === "knowledge:memory:mem_next" && edge.target === "knowledge:idea:idea_new")?.style?.strokeDasharray).toBe("6 5")
    expect(graph.edges.some((edge) => edge.source === "knowledge:memory:mem_root" && edge.target === "knowledge:idea:idea_new")).toBe(false)
    expect(graph.edges.some((edge) => edge.source === "knowledge:task-core" && edge.target === "knowledge:idea:idea_new")).toBe(false)
})

test("knowledge graph suppresses reverse context when memory distilled the same idea", () => {
    const memory = createMemory("mem_loop", "Original context", "2026-04-13T00:00:00.000Z")
    const idea = createIdea("idea_loop", "Explore upload endpoint", "testing", "2026-04-13T00:05:00.000Z")
    const updatedMemory = {
        ...memory,
        refs: [idea.id],
        content: "Original context updated from upload exploration",
        updated_at: "2026-04-13T00:10:00.000Z",
    }
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:loop", memory, "2026-04-13T00:00:00.000Z"),
        ideaEvent("idea_add:loop", idea, "2026-04-13T00:05:00.000Z"),
        memoryEvent("memory_update:loop", updatedMemory, "2026-04-13T00:10:00.000Z"),
    ]

    const graph = buildKnowledgeGraphFromBoard([updatedMemory], [idea], events, Date.parse("2026-04-13T00:11:00.000Z"))

    expect(graph.edges.some((edge) => edge.source === "knowledge:idea:idea_loop" && edge.target === "knowledge:memory:mem_loop")).toBe(true)
    expect(graph.edges.some((edge) => edge.source === "knowledge:memory:mem_loop" && edge.target === "knowledge:idea:idea_loop")).toBe(false)
})

test("knowledge graph keeps deleted ideas as muted historical nodes", () => {
    const memory = createMemory("mem_context", "Known exploit boundary", "2026-04-13T00:00:00.000Z")
    const deletedIdea = createIdea("idea_deleted", "Repeat exhausted SSRF route", "pending", "2026-04-13T00:05:00.000Z")
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:context", memory, "2026-04-13T00:00:00.000Z"),
        ideaEvent("idea_add:deleted", deletedIdea, "2026-04-13T00:05:00.000Z"),
        ideaEvent("idea_delete:deleted", { ...deletedIdea, status: "skipped", result: "Deleted by observer" }, "2026-04-13T00:06:00.000Z"),
    ]

    const graph = buildKnowledgeGraphFromBoard([memory], [], events, Date.parse("2026-04-13T00:07:00.000Z"))
    const ideaNode = graph.nodes.find((node) => node.data.rawId === deletedIdea.id)

    expect(ideaNode?.data.knowledgeRecord).toMatchObject({
        id: deletedIdea.id,
        status: "skipped",
        result: "Deleted by observer",
    })
    expect(ideaNode?.className).toContain("opacity-60")
    expect(ideaNode?.className).toContain("saturate-50")
    expect(graph.edges.find((edge) => edge.target === "knowledge:idea:idea_deleted")?.style?.strokeDasharray).toBe("6 6")
})

test("knowledge graph ignores incomplete memory mutation payloads", () => {
    const events: AttackTimelineEvent[] = [
        {
            id: "memory_update:empty",
            timestamp: Date.parse("2026-04-13T00:00:00.000Z"),
            challengeId: "challenge_1",
            solverId: "solver_1",
            lane: "board",
            kind: "memory_updated",
            title: "Memory updated",
            summary: "",
            payload: {
                entry: {
                    id: "mem_empty",
                },
            },
        },
    ]

    const graph = buildKnowledgeGraphFromBoard([], [], events, Date.parse("2026-04-13T00:01:00.000Z"))

    expect(graph.nodes.some((node) => node.data.rawId === "mem_empty")).toBe(false)
})

test("knowledge graph layout key stays stable across non-board playback steps", () => {
    const memory = createMemory("mem_root", "Initial recon", "2026-04-13T00:00:00.000Z")
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:root", memory, "2026-04-13T00:00:00.000Z"),
        createSolverStartedEvent("solver_1", "Other Agent", "2026-04-13T00:01:00.000Z"),
        createSolverStartedEvent("solver_2", "Another Agent", "2026-04-13T00:02:00.000Z"),
    ]

    const firstGraph = buildKnowledgeGraphFromBoard([memory], [], events, Date.parse("2026-04-13T00:00:00.000Z"))
    const secondGraph = buildKnowledgeGraphFromBoard([memory], [], events, Date.parse("2026-04-13T00:01:00.000Z"))
    const thirdGraph = buildKnowledgeGraphFromBoard([memory], [], events, Date.parse("2026-04-13T00:02:00.000Z"))

    const firstLayoutKey = buildKnowledgeGraphLayoutKey(firstGraph)
    const secondLayoutKey = buildKnowledgeGraphLayoutKey(secondGraph)
    const thirdLayoutKey = buildKnowledgeGraphLayoutKey(thirdGraph)

    expect(firstLayoutKey).toBe(secondLayoutKey)
    expect(secondLayoutKey).toBe(thirdLayoutKey)
})

test("knowledge graph layout key changes when board topology changes", () => {
    const memory = createMemory("mem_root", "Initial recon", "2026-04-13T00:00:00.000Z")
    const idea = createIdea("idea_new", "Try admin debug endpoint", "pending", "2026-04-13T00:05:00.000Z")
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:root", memory, "2026-04-13T00:00:00.000Z"),
        ideaEvent("idea_add:new", idea, "2026-04-13T00:05:00.000Z"),
    ]

    const beforeIdea = buildKnowledgeGraphFromBoard([memory], [], events, Date.parse("2026-04-13T00:01:00.000Z"))
    const afterIdea = buildKnowledgeGraphFromBoard([memory], [idea], events, Date.parse("2026-04-13T00:06:00.000Z"))

    expect(buildKnowledgeGraphLayoutKey(beforeIdea)).not.toBe(buildKnowledgeGraphLayoutKey(afterIdea))
})

test("knowledge graph content key changes when node display state changes without topology changes", () => {
    const memory = createMemory("mem_root", "Initial recon", "2026-04-13T00:00:00.000Z")
    const idea = createIdea("idea_loop", "Explore upload endpoint", "testing", "2026-04-13T00:05:00.000Z")
    const failedIdea = { ...idea, status: "failed" as const, result: "route exhausted", updated_at: "2026-04-13T00:10:00.000Z" }
    const events: AttackTimelineEvent[] = [
        memoryEvent("memory_add:root", memory, "2026-04-13T00:00:00.000Z"),
        ideaEvent("idea_add:loop", idea, "2026-04-13T00:05:00.000Z"),
        ideaEvent("idea_update:loop", failedIdea, "2026-04-13T00:10:00.000Z"),
    ]

    const testingGraph = buildKnowledgeGraphFromBoard([memory], [idea], events, Date.parse("2026-04-13T00:06:00.000Z"))
    const failedGraph = buildKnowledgeGraphFromBoard([memory], [failedIdea], events, Date.parse("2026-04-13T00:11:00.000Z"))

    expect(buildKnowledgeGraphLayoutKey(testingGraph)).toBe(buildKnowledgeGraphLayoutKey(failedGraph))
    expect(buildKnowledgeGraphContentKey(testingGraph)).not.toBe(buildKnowledgeGraphContentKey(failedGraph))
})

function createMemory(id: string, content: string, createdAt: string, refs: string[] = []): MemoryEntry {
    return {
        id,
        challengeId: "challenge_1",
        kind: "fact",
        content,
        refs,
        source: "test",
        created_at: createdAt,
        updated_at: createdAt,
    }
}

function createIdea(id: string, content: string, status: IdeaRecord["status"], createdAt: string): IdeaRecord {
    return {
        id,
        content,
        normalized: content.toLowerCase(),
        status,
        result: "",
        created_at: createdAt,
        updated_at: createdAt,
    }
}

function memoryEvent(id: string, memory: MemoryEntry, timestamp: string): AttackTimelineEvent {
    return {
        id,
        timestamp: Date.parse(timestamp),
        challengeId: memory.challengeId,
        solverId: "solver_1",
        lane: "board",
        kind: id.startsWith("memory_add") ? "memory_added" : "memory_updated",
        title: "Memory changed",
        summary: memory.content,
        payload: { entry: memory },
    }
}

function ideaEvent(id: string, idea: IdeaRecord, timestamp: string): AttackTimelineEvent {
    return {
        id,
        timestamp: Date.parse(timestamp),
        challengeId: "challenge_1",
        solverId: "solver_1",
        lane: "board",
        kind: id.startsWith("idea_add") ? "idea_added" : "idea_updated",
        title: "Idea changed",
        summary: idea.content,
        payload: { item: idea },
    }
}
