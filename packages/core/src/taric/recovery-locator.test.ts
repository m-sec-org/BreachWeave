import { describe, expect, test } from "bun:test"
import type { RecoveryPremise } from "./recovery-locator"
import { createAuthorityRecoveryCheckpoint, parseAuthorityRecoveryLocator, parseAuthorityRecoveryRun, validateAuthorityRecoveryPacket } from "./recovery-locator"

function uuid(number: number): string {
    return `019a0000-0000-7000-8000-${number.toString().padStart(12, "0")}`
}

const premise: RecoveryPremise = {
    binding: { projectId: "project-a", tenantId: "tenant-a", engagementId: uuid(1), hostPrincipalId: "host-a", modelPrincipalId: "model-a" },
    challengeId: "challenge-a", assetId: "asset-a", resourceId: uuid(2), resourceRevisionId: uuid(3),
    scopeId: uuid(4), scopeVersion: 2, scopeRevisionId: uuid(90), scopePolicyDigest: `sha256:${"a".repeat(64)}`, workItemId: uuid(5), workItemVersion: 3, targetVersion: 1,
}
const authorityRun = {
    run_id: uuid(6), work_item_id: uuid(5), attempt_ref: uuid(7), engagement_id: uuid(1),
    generation: 2, status: "checkpointed", owner: { host_id: "host-a", agent_id: "worker-a" },
    lease_expires_at: "2099-01-01T00:00:00.000Z", task_session_ref: "session-a",
    scope_ref: uuid(4), scope_version: 2, scope_revision_ref: uuid(90), policy_digest: `sha256:${"a".repeat(64)}`, work_item_version: 3, target_version: 1,
}

function fixture() {
    const checkpoint = createAuthorityRecoveryCheckpoint({ premise, authorityRun, piSessionId: "pi-session-a", contextSnapshotId: uuid(8), sourceReadSeq: 10, builderVersion: "bw-context-1", completedSteps: ["inspected approved metadata"], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [] })
    return {
        run: structuredClone(authorityRun), checkpoint, pending_actions: [], task_session_ref: "session-a", artifact_refs: [],
        checkpoint_read_seq: 10, current_read_seq: 12,
        premise_checks: { engagement: true, work_item: true, scope: true, scope_revision: true, checkpoint: true, attempt: true, source_sequence: true, lease: true, context_manifest: true, host_authorization_refs: true, action_results: true },
        blocked: false, replan_required: false, resume_advice: "resume_allowed",
    }
}

describe("authority-backed recovery checkpoint adapter", () => {
    test("a renewed same-generation authority lease resumes an older committed checkpoint", () => {
        const packet = fixture()
        packet.checkpoint.lease_expires_at = "2020-01-01T00:00:00.000Z"
        expect(validateAuthorityRecoveryPacket(packet, premise).run.generation).toBe(2)
        packet.checkpoint.lease_expires_at = "2100-01-01T00:00:00.000Z"
        expect(validateAuthorityRecoveryPacket(packet, premise).run.generation).toBe(2)
        packet.checkpoint.lease_expires_at = "not-a-date"
        expect(() => validateAuthorityRecoveryPacket(packet, premise)).toThrow("lease")
    })
    test("host UUID ContextManifest preserves actual Core ctx source provenance and validates its watermark", () => {
        const checkpoint = createAuthorityRecoveryCheckpoint({ premise, authorityRun, piSessionId: "pi-session-a", contextSnapshotId: uuid(8), sourceReadSeq: 10, builderVersion: "bw-context-1", sourceContext: { snapshotId: "ctx_0123456789abcdef", readSeq: 10, contentDigest: `sha256:${"a".repeat(64)}` }, completedSteps: [], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [] })
        const packet = { ...fixture(), checkpoint }
        expect(validateAuthorityRecoveryPacket(packet, premise).readSeq).toBe(12)
        const context = checkpoint.context_manifest as { adapter_manifest: { breachweave_context: Record<string, unknown> } }
        expect(context.adapter_manifest.breachweave_context.snapshot_id).toBe("ctx_0123456789abcdef")
        context.adapter_manifest.breachweave_context.read_seq = 11
        expect(() => validateAuthorityRecoveryPacket(packet, premise)).toThrow("watermark")
    })

    test("parses a locator independently after disposable projection deletion", () => {
        const packet = fixture()
        const checkpoint = packet.checkpoint.context_manifest as { adapter_manifest: { breachweave_recovery: unknown } }
        const run = parseAuthorityRecoveryRun(packet.run, premise)
        const locator = parseAuthorityRecoveryLocator(checkpoint.adapter_manifest.breachweave_recovery, premise, run)
        expect(locator).toMatchObject({ projectId: "project-a", workRunId: uuid(6), attemptId: uuid(7), generation: 2, piSessionId: "pi-session-a" })
        const serialized = JSON.parse(JSON.stringify(locator))
        expect(parseAuthorityRecoveryLocator(serialized, premise, run)).toEqual(locator)
        expect(() => parseAuthorityRecoveryLocator({ ...serialized, taskSessionId: "session-foreign" }, premise, run)).toThrow("provenance")
        expect(() => parseAuthorityRecoveryLocator({ ...serialized, extra: true }, premise, run)).toThrow("unsupported or missing")
        expect(() => parseAuthorityRecoveryLocator({ ...serialized, piSessionId: "not a host id" }, premise, run)).toThrow("opaque")
    })

    test("uses actual Taric checkpoint fields and reconstructs locator after local state deletion", () => {
        const packet = fixture()
        expect(packet.checkpoint.owner).toEqual({ host_id: "host-a", agent_id: "worker-a" })
        expect(packet.checkpoint.external_action_state).toBe("none")
        expect(packet.checkpoint.target_resource_ref).toBeUndefined()
        // Only the authority packet survives serialization; there is no local Map or checkpoint file.
        const restored = validateAuthorityRecoveryPacket(JSON.parse(JSON.stringify({ ok: true, data: packet })), premise)
        expect(restored.locator).toMatchObject({ projectId: "project-a", challengeId: "challenge-a", workItemId: uuid(5), workRunId: uuid(6), attemptId: uuid(7), generation: 2, taskSessionId: "session-a", piSessionId: "pi-session-a", scopeId: uuid(4), scopeVersion: 2 })
        expect(restored.readSeq).toBe(12)
    })

    test("rejects false or incomplete authority premises, missing checkpoint, and old envelope guesses", () => {
        for (const field of Object.keys(fixture().premise_checks)) {
            const packet = fixture()
            const checks = packet.premise_checks as Record<string, boolean>
            delete checks[field]
            expect(() => validateAuthorityRecoveryPacket(packet, premise)).toThrow("replanning")
        }
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), blocked: true }, premise)).toThrow("replanning")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), checkpoint: null }, premise)).toThrow("incomplete")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), run: undefined, work_run: authorityRun }, premise)).toThrow("run")
    })

    test("rejects generation, owner, scope, task-session and read-watermark substitution", () => {
        for (const [field, value] of [["generation", 1], ["attempt_ref", uuid(99)], ["scope_version", 1], ["source_read_seq", 13]] as const) {
            const packet = fixture()
            packet.checkpoint[field] = value
            expect(() => validateAuthorityRecoveryPacket(packet, premise)).toThrow()
        }
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), task_session_ref: "session-foreign" }, premise)).toThrow("session")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), checkpoint_read_seq: 11 }, premise)).toThrow("cursor")
        expect(() => validateAuthorityRecoveryPacket(fixture(), { ...premise, scopeVersion: 3 })).toThrow("versions changed")
        expect(() => parseAuthorityRecoveryRun({ ...authorityRun, owner: { host_id: "forged-host", agent_id: "worker-a" } }, premise)).toThrow("substitution")
        expect(() => parseAuthorityRecoveryRun({ ...authorityRun, status: "completed" }, premise)).toThrow("not active")
        const expired = fixture()
        expired.run.lease_expires_at = "2000-01-01T00:00:00.000Z"
        expect(() => validateAuthorityRecoveryPacket(expired, premise)).toThrow("expired")
    })

    test("immutable ScopeRevision and digest must agree across premise, run, checkpoint and locator", () => {
        const packet = fixture()
        expect(packet.checkpoint.scope_revision_ref).toBe(premise.scopeRevisionId)
        expect(packet.checkpoint.policy_digest).toBe(premise.scopePolicyDigest)
        expect(() => validateAuthorityRecoveryPacket(packet, { ...premise, scopeRevisionId: uuid(91) })).toThrow("versions changed")
        expect(() => validateAuthorityRecoveryPacket(packet, { ...premise, scopePolicyDigest: `sha256:${"b".repeat(64)}` })).toThrow("versions changed")
        expect(() => validateAuthorityRecoveryPacket({ ...packet, checkpoint: { ...packet.checkpoint, scope_revision_ref: uuid(91) } }, premise)).toThrow("generation")
        expect(() => validateAuthorityRecoveryPacket({ ...packet, checkpoint: { ...packet.checkpoint, policy_digest: `sha256:${"b".repeat(64)}` } }, premise)).toThrow("generation")
        expect(() => parseAuthorityRecoveryRun({ ...packet.run, scope_revision_ref: undefined }, premise)).toThrow()
    })

    test("rejects forged locator, unsupported fields and sensitive checkpoint content", () => {
        const forged = fixture()
        const context = forged.checkpoint.context_manifest as { adapter_manifest: { breachweave_recovery: Record<string, unknown> } }
        context.adapter_manifest.breachweave_recovery.projectId = "project-foreign"
        expect(() => validateAuthorityRecoveryPacket(forged, premise)).toThrow("provenance")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), checkpoint: { ...fixture().checkpoint, hidden_reasoning: "untrusted" } }, premise)).toThrow("unsupported")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), checkpoint: { ...fixture().checkpoint, provenance: { host_id: "host-a", producer_id: "worker-a", source_kind: "host", raw_payload: "unclassified" } } }, premise)).toThrow("provenance")
        const sensitive = fixture()
        sensitive.checkpoint.next_steps = ["Authorization: Bearer fixture-secret-value"]
        expect(() => validateAuthorityRecoveryPacket(sensitive, premise)).toThrow("sensitive")
        expect(() => createAuthorityRecoveryCheckpoint({ premise, authorityRun, piSessionId: "pi-a", contextSnapshotId: uuid(8), sourceReadSeq: 10, builderVersion: "bw-context-1", completedSteps: ["password=fixture-secret"], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [] })).toThrow("sensitive")
    })

    test("never silently resumes unknown or pending actions", () => {
        const pending = fixture()
        pending.checkpoint.external_action_state = "unknown"
        expect(() => validateAuthorityRecoveryPacket(pending, premise)).toThrow("reconciliation")
        expect(() => validateAuthorityRecoveryPacket({ ...fixture(), pending_actions: [{ action_id: uuid(9) }] }, premise)).toThrow("reconciliation")
    })
})
