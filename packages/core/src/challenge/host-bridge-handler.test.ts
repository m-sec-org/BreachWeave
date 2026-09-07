import { describe, expect, mock, test } from "bun:test"
import { createChallengeHostBridgeHandler } from "./host-bridge-handler"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type { ChallengeManager } from "./manager"
import type { HostBridgeHandleContext, SolverInstance } from "../runtime/types"

function createContext(overrides?: Partial<HostBridgeHandleContext>): HostBridgeHandleContext {
    const sendCommand = overrides?.sendCommand ?? mock(() => {})
    const solvers: SolverInstance[] = [
        { id: "solver-1", challengeId: "chal-1", status: "running", promptName: "p", task: "", containerId: "a", name: "a", createdAt: 0 },
        { id: "solver-2", challengeId: "chal-1", status: "running", promptName: "p", task: "", containerId: "b", name: "b", createdAt: 0 },
        { id: "solver-3", challengeId: "other", status: "running", promptName: "p", task: "", containerId: "c", name: "c", createdAt: 0 },
        { id: "solver-4", challengeId: "chal-1", status: "starting", promptName: "p", task: "", containerId: "d", name: "d", createdAt: 0 },
    ]
    return {
        solverId: "solver-1",
        action: "challenge_get_state" as const,
        params: {},
        getSolverEnvValue: (key: string) => (key === CHALLENGE_ENV_CHALLENGE_ID ? "chal-1" : undefined),
        listSolvers: () => solvers,
        sendCommand,
        ...overrides,
    }
}

describe("challenge host bridge notifications", () => {
    test("challenge_memory_add stores challenge scoped memory through the manager", async () => {
        const appendMemory = mock(async (input: unknown) => ({
            id: "mem_global",
            challengeId: "chal-1",
            kind: "fact" as const,
            content: "admin upload parser accepts png header",
            refs: ["tool:curl"],
            source: "observer:solver-1",
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T00:00:00.000Z",
            input,
        }))
        const handler = createChallengeHostBridgeHandler({ appendMemory } as unknown as ChallengeManager)

        const result = await handler.handle(
            createContext({
                action: "challenge_memory_add",
                params: {
                    kind: "fact",
                    content: "admin upload parser accepts png header",
                    refs: ["tool:curl"],
                },
            }),
        )

        expect(result.handled).toBe(true)
        expect(appendMemory).toHaveBeenCalledWith({
            challengeId: "chal-1",
            kind: "fact",
            content: "admin upload parser accepts png header",
            refs: ["tool:curl"],
            source: "observer:solver-1",
        })
        expect(result.data).toMatchObject({
            entry: {
                id: "mem_global",
                challengeId: "chal-1",
                kind: "fact",
            },
        })
    })

    test("challenge idea list and add use challenge scoped idea board", async () => {
        const listIdeas = mock(async () => [
            {
                id: "idea_global",
                content: "test upload parser differential",
                normalized: "test upload parser differential",
                status: "pending" as const,
                result: "",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
        ])
        const addIdea = mock(async () => ({
            created: true,
            item: {
                id: "idea_added",
                content: "check parser differential with png php polyglot",
                normalized: "check parser differential with png php polyglot",
                status: "testing" as const,
                result: "png header accepted",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
        }))
        const handler = createChallengeHostBridgeHandler({ listIdeas, addIdea } as unknown as ChallengeManager)

        const listResult = await handler.handle(createContext({ action: "challenge_idea_list", params: {} }))
        const addResult = await handler.handle(
            createContext({
                action: "challenge_idea_add",
                params: {
                    content: "check parser differential with png php polyglot",
                    status: "testing",
                    result: "png header accepted",
                },
            }),
        )

        expect(listResult).toMatchObject({ handled: true, data: { items: [{ id: "idea_global" }] } })
        expect(addResult).toMatchObject({ handled: true, data: { created: true, item: { id: "idea_added" } } })
        expect(listIdeas).toHaveBeenCalledWith("chal-1")
        expect(addIdea).toHaveBeenCalledWith("chal-1", {
            content: "check parser differential with png php polyglot",
            status: "testing",
            result: "png header accepted",
        })
    })

    test("report submission uses solver metadata and does not broadcast", async () => {
        const submitReport = mock(async () => ({
            submission: { id: "submission-1", asset_hash: "asset-md5", asset: "https://target.example", report: "### report" },
            challenge: { id: "chal-1" },
            assets_total: 1,
            assets_scanned: 1,
            assets_pending: 0,
            assets_completed: true,
        }))
        const handler = createChallengeHostBridgeHandler({ submitReport } as unknown as ChallengeManager)
        const sendCommand = mock(() => {})

        const result = await handler.handle(
            createContext({
                action: "challenge_submit_report",
                params: { asset_hash: "asset-md5", report: "### report" },
                sendCommand,
                getSolver: () => ({
                    id: "solver-1",
                    challengeId: "chal-1",
                    status: "running",
                    promptName: "p",
                    task: "",
                    containerId: "a",
                    name: "a",
                    createdAt: 0,
                }),
            }),
        )

        expect(result.handled).toBe(true)
        expect(submitReport).toHaveBeenCalledWith("chal-1", {
            assetHash: "asset-md5",
            report: "### report",
            solverId: "solver-1",
            promptName: "p",
            modelName: undefined,
        })
        expect(sendCommand).not.toHaveBeenCalled()
    })
})
