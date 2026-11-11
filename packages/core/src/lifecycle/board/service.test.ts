import { describe, expect, test } from "bun:test"
import { BoardContractError, BoardService, ContextRevisionStore, DiscoveryStore, HistoryIngestor } from "./service"

const item = { id: "idea-1", class: "candidate" as const, text: "检查登录边界", sourceRefs: ["event-1"], conditions: ["GET /login"], visibility: "assignment_private" as const, confidence: 0.5 }
describe("策略板与历史上下文", () => {
    test("CAS、NO_CHANGE 和幂等提交保持单一 revision", () => {
        const board = new BoardService(); const input = { scopeId: "scope-1", assignmentId: "assignment-1", baseRevision: 0, generation: 1, assignmentRevision: 1, leaseToken: "lease-1", eventRange: { from: 1, to: 2 }, processedWatermark: 2, operationKey: "op-1", mode: "PATCH" as const, items: [item] }; const first = board.patch(input); expect(first.revision).toBe(1); expect(board.patch({ ...input, mode: "PATCH" })).toEqual(first); expect(() => board.patch({ ...input, operationKey: "op-2" })).toThrow(BoardContractError); const noChange = board.patch({ ...input, baseRevision: 1, mode: "NO_CHANGE", operationKey: "op-3" }); expect(noChange.revision).toBe(2); expect(noChange.items).toEqual(first.items)
    })
    test("候选 intake 与 history watermark 独立阻断 seal/context", () => {
        const discovery = new DiscoveryStore(); discovery.register({ id: "candidate-1", scopeId: "scope-1", sourceRefs: ["event-1"], watermark: 1 }); expect(() => discovery.assertSealable("scope-1")).toThrow("candidate"); discovery.dispose("candidate-1", "deferred", "后续 run 处理"); expect(() => discovery.assertSealable("scope-1")).not.toThrow()
        const history = new HistoryIngestor(); history.ingest({ id: "artifact-1", kind: "event", contentHash: `sha256:${"a".repeat(64)}`, parentIds: [], sourceAddress: "seq:3", redacted: false }); const context = new ContextRevisionStore(); const blocked = context.prepare({ id: "context-1", scopeId: "scope-1", parentIds: [], sourceWatermark: 3, archiveWatermark: 0, mandatoryRefs: ["manifest"], itemRefs: ["artifact-1"], budget: 1000, history: history.snapshot() }); expect(blocked.status).toBe("blocked"); history.markIndexed(3); const prepared = context.prepare({ id: "context-2", scopeId: "scope-1", parentIds: [], sourceWatermark: 3, archiveWatermark: 3, mandatoryRefs: ["manifest"], itemRefs: ["artifact-1"], budget: 1000, history: history.snapshot() }); expect(context.commit(prepared.id, prepared.contentHash, history.snapshot()).status).toBe("committed")
    })
})
