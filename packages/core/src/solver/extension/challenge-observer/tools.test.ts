import { beforeEach, describe, expect, mock, test } from "bun:test"

const localMemory = {
    id: "mem_local",
    challengeId: "board",
    kind: "fact" as const,
    content: "local fact",
    refs: [],
    source: "observer",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
}

const globalMemory = {
    id: "mem_global",
    challengeId: "chal-1",
    kind: "evidence" as const,
    content: "global evidence",
    refs: ["tool:curl"],
    source: "observer:solver-a",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
}

const localIdea = {
    id: "idea_local",
    content: "local idea",
    normalized: "local idea",
    status: "pending" as const,
    result: "",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
}

const globalIdea = {
    id: "idea_global",
    content: "global idea",
    normalized: "global idea",
    status: "testing" as const,
    result: "shared result",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
}

const appendSolverBoardMemory = mock(async () => localMemory)
const listSolverBoardMemory = mock(async () => [localMemory])
const updateSolverBoardMemory = mock(async () => localMemory)
const deleteSolverBoardMemory = mock(async () => localMemory)
const listSolverBoardIdeas = mock(async () => [localIdea])
const searchSolverBoardIdeas = mock(async () => [localIdea])
const addSolverBoardIdea = mock(async () => ({ created: true, item: localIdea }))
const updateSolverBoardIdea = mock(async () => localIdea)

const requestHostBridge = mock(async (action: string) => {
    switch (action) {
        case "challenge_memory_list":
            return { items: [globalMemory] }
        case "challenge_board_refresh":
            return { challenge_id: "chal-1", authoritative: true, memory: [globalMemory], ideas: [globalIdea], diagnostics: { status: "complete", watermark: 9 } }
        case "challenge_memory_add":
            return { entry: globalMemory }
        case "challenge_idea_list":
            return { items: [globalIdea] }
        case "challenge_idea_search":
            return { items: [globalIdea] }
        case "challenge_idea_add":
            return { created: true, item: globalIdea }
        default:
            return {}
    }
})

mock.module("../../board-store", () => ({
    appendSolverBoardMemory,
    listSolverBoardMemory,
    updateSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    searchSolverBoardIdeas,
    addSolverBoardIdea,
    updateSolverBoardIdea,
}))

mock.module("../../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

const { createObserverSidecarToolsWithOptions } = await import("./tools")

interface TestTool {
    name: string
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

function getTool(name: string): TestTool {
    const tool = (createObserverSidecarToolsWithOptions() as unknown as TestTool[]).find((item) => item.name === name)
    if (!tool) throw new Error(`tool not found: ${name}`)
    return tool
}

beforeEach(() => {
    appendSolverBoardMemory.mockClear()
    listSolverBoardMemory.mockClear()
    updateSolverBoardMemory.mockClear()
    deleteSolverBoardMemory.mockClear()
    listSolverBoardIdeas.mockClear()
    searchSolverBoardIdeas.mockClear()
    addSolverBoardIdea.mockClear()
    updateSolverBoardIdea.mockClear()
    requestHostBridge.mockClear()
})

describe("challenge observer board tools", () => {
    test("board_refresh queries the host authority and returns the refreshed board", async () => {
        const tool = getTool("board_refresh")

        const result = await tool.execute("tool-1", {})

        expect(requestHostBridge).toHaveBeenCalledWith("challenge_board_refresh", {})
        expect(result.details).toMatchObject({ authoritative: true, diagnostics: { watermark: 9 } })
        expect(result.content[0].text).toContain("global evidence")
        expect(result.content[0].text).toContain("global idea")
    })

    test("memory_add writes solver local memory without publishing by default", async () => {
        const tool = getTool("memory_add")

        const result = await tool.execute("tool-1", {
            kind: "fact",
            content: "local fact",
        })

        expect(appendSolverBoardMemory).toHaveBeenCalledWith({
            kind: "fact",
            content: "local fact",
            refs: [],
            source: "observer",
        })
        expect(requestHostBridge).not.toHaveBeenCalled()
        expect(result.details.entry).toMatchObject({ id: "mem_local" })
    })

    test("memory_add publishes to challenge only when explicitly requested", async () => {
        const tool = getTool("memory_add")

        const result = await tool.execute("tool-1", {
            kind: "evidence",
            content: "global evidence",
            refs: ["tool:curl"],
            publish_to_challenge: true,
        })

        expect(appendSolverBoardMemory).toHaveBeenCalledTimes(1)
        expect(requestHostBridge).toHaveBeenCalledWith("challenge_memory_add", {
            kind: "evidence",
            content: "global evidence",
            refs: ["tool:curl"],
        })
        expect(result.details.entry).toMatchObject({ id: "mem_local" })
        expect(result.details.challenge_entry).toMatchObject({ id: "mem_global" })
    })

    test("memory_list returns solver local and challenge global layers", async () => {
        const tool = getTool("memory_list")

        const result = await tool.execute("tool-1", {})

        expect(requestHostBridge).toHaveBeenCalledWith("challenge_memory_list", {})
        expect(result.content[0].text).toContain("## Solver Local Memory")
        expect(result.content[0].text).toContain("mem_local")
        expect(result.content[0].text).toContain("## Challenge Memory")
        expect(result.content[0].text).toContain("mem_global")
    })

    test("idea_add writes local by default and publishes only on explicit request", async () => {
        const tool = getTool("idea_add")

        const localResult = await tool.execute("tool-1", {
            content: "local idea",
        })
        expect(addSolverBoardIdea).toHaveBeenCalledWith({
            content: "local idea",
            result: "",
        })
        expect(requestHostBridge).not.toHaveBeenCalled()
        expect(localResult.details.item).toMatchObject({ id: "idea_local" })

        requestHostBridge.mockClear()
        const publishedResult = await tool.execute("tool-2", {
            content: "global idea",
            status: "testing",
            result: "shared result",
            publish_to_challenge: true,
        })
        expect(requestHostBridge).toHaveBeenCalledWith("challenge_idea_add", {
            content: "global idea",
            status: "testing",
            result: "shared result",
        })
        expect(publishedResult.details.challenge_item).toMatchObject({ id: "idea_global" })
    })

    test("idea_list returns solver local and challenge global layers", async () => {
        const tool = getTool("idea_list")

        const result = await tool.execute("tool-1", {})

        expect(requestHostBridge).toHaveBeenCalledWith("challenge_idea_list", {})
        expect(result.content[0].text).toContain("## Solver Local Ideas")
        expect(result.content[0].text).toContain("idea_local")
        expect(result.content[0].text).toContain("## Challenge Ideas")
        expect(result.content[0].text).toContain("idea_global")
    })
})
