import { describe, expect, test } from "bun:test"
import { admitEvidence, assembleFrozenReviewPack, ReviewContractError, ReviewJobStore, runMechanicalReview, validatePlannerDecision } from "./review"

const digest = `sha256:${"a".repeat(64)}`
function pack() { return assembleFrozenReviewPack({ id: "pack-1", binding: { assignmentId: "assignment-1", reportId: "report-1", reportRevision: 1, assignmentRevision: 2, generation: 1, scopeRevision: 3, historyWatermark: 9, evidenceSnapshotHash: digest }, report: { claims: [{ id: "claim-1" }] }, evidence: [{ id: "ev-1", contentHash: digest, kind: "screenshot", redacted: true }], reviewerPrincipal: "reviewer-1", acl: ["reviewer-1"] }) }

describe("生命周期独立审查", () => {
    test("FrozenReviewPack 篡改会阻断机械审查", () => {
        const original = pack(); const tampered = { ...original, report: { claims: [] } }
        expect(() => runMechanicalReview({ pack: tampered, reviewerPrincipal: "reviewer-1", checklist: [] })).toThrow("摘要")
    })
    test("ReviewJob 只允许当前版本且租约过期会重试", () => {
        const store = new ReviewJobStore(); const created = store.create({ id: "job-1", pack: pack() }); const leased = store.lease(created.id, "reviewer-1", 100, 10); expect(store.expire(111)[0]?.state).toBe("retryable"); expect(() => store.start(created.id, leased.leaseToken!, 111)).toThrow(ReviewContractError)
    })
    test("Planner stop 需要当前 ready 审查，Evidence admission 需要审查引用", () => {
        const frozen = pack(); const store = new ReviewJobStore(); const created = store.create({ id: "job-2", pack: frozen }); const leased = store.lease(created.id, "reviewer-1", 100, 1000); const review = store.complete(created.id, leased.leaseToken!, [{ itemId: "item-1", verdict: "verified", evidenceRefs: ["ev-1"], concerns: [] }], 200).result!
        const decision = validatePlannerDecision({ id: "decision-1", action: "stop", binding: frozen, reviewJobId: created.id, reviewVerdict: "verified", reason: "证据充分" }, { binding: frozen, reviewJobId: created.id, verdict: "verified", state: "ready" }); expect(decision.action).toBe("stop")
        expect(admitEvidence({ id: "admission-1", assignmentId: "assignment-1", review, findingId: "claim-1", evidenceRefs: ["ev-1"], contentHash: digest }).status).toBe("admitted")
    })
})
