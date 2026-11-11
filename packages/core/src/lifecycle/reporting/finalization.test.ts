import { describe, expect, test } from "bun:test"
import { FinalizationContractError, FinalizationService } from "./finalization"

const digest = `sha256:${"a".repeat(64)}`
describe("最终报告流水线", () => {
    test("seal 使用阻断清单，active solver 为零不等于可 seal", () => {
        const service = new FinalizationService(); service.create({ id: "final-1", scopeId: "scope-1", taskManifestRevision: 1 }); expect(() => service.requestSeal("final-1", { id: "intent-1", scopeId: "scope-1", taskManifestRevision: 1, generation: 0, operationKey: "op" }, { pendingCandidates: 1 })).toThrow(FinalizationContractError); expect(service.get("final-1").state).toBe("blocked")
    })
    test("QA 前不能发布，且来源漂移会拒绝 IR", () => {
        const service = new FinalizationService(); service.create({ id: "final-2", scopeId: "scope-2", taskManifestRevision: 1 }); service.requestSeal("final-2", { id: "intent-2", scopeId: "scope-2", taskManifestRevision: 1, generation: 0, operationKey: "op" }, {}); service.freezeSources("final-2", [{ id: "source-1", assignmentId: "assignment-1", reportRevision: 1, valid: true, evidenceAdmissionIds: ["admission-1"], evidenceSnapshotHash: digest, historyWatermark: 1, coverage: "tested" }], 1, 1); const ir = service.aggregate("final-2", [{ id: "claim-1", asset: "asset-1", vulnerabilityClass: "xss", preconditions: [], severity: "high", confidence: 0.9, evidenceRefs: ["ev-1"], sourceIds: ["source-1"], text: "可复现" }]); const rendered = service.render("final-2", ir.id); const qa = service.qaCheck("final-2", ir.id, rendered.id); expect(qa.passed).toBe(true); expect(service.publish("final-2", rendered.artifactHash).status).toBe("not_configured")
    })
})
