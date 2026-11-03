import { describe, expect, test } from "bun:test"
import type { CommittedTaricArtifact } from "./artifact-service"
import type { TaricEvidenceBinding, TaricEvidenceInput } from "./artifact-evidence"
import { adaptTaricToolEvidence, buildTaricEvidenceCandidate } from "./artifact-evidence"

const binding: TaricEvidenceBinding = { engagementId: "019a0000-0000-7000-8000-000000000001", hostPrincipalId: "evidence-host", sessionId: "evidence-session", resourceId: "019a0000-0000-7000-8000-000000000002", resourceRevisionId: "019a0000-0000-7000-8000-000000000003", resourceRevision: 2, workRunId: "019a0000-0000-7000-8000-000000000004", attemptId: "019a0000-0000-7000-8000-000000000005", generation: 3 }
const artifact: CommittedTaricArtifact = { engagementId: binding.engagementId, sessionId: binding.sessionId, contentRef: "019a0000-0000-7000-8000-000000000006@v1", artifactId: "019a0000-0000-7000-8000-000000000006", version: 1, category: "evidence", payloadKind: "text", mediaType: "text/plain", byteLength: 12, contentHash: `sha256:${"a".repeat(64)}`, manifestHash: `sha256:${"b".repeat(64)}`, storageMode: "taric_stored", contentStatus: "available", integrityStatus: "verified", workRunId: binding.workRunId, attemptId: binding.attemptId, generation: binding.generation, ownerHost: binding.hostPrincipalId }
const input: TaricEvidenceInput = { resourceRef: binding.resourceId, resourceRevision: 2, observedAt: "2026-10-31T01:00:00.000Z", statement: "Fixture service responded with the recorded status.", limitations: ["Local fixture only."], artifact }

describe("ordinary Artifact to Evidence boundary", () => {
    test("creates only an L0 candidate with actual immutable ResourceRevision and run provenance", () => {
        const result = buildTaricEvidenceCandidate(input, binding)
        expect(result).toMatchObject({ schema_version: "1.0.0", kind: "evidence", resource_ref: binding.resourceId, artifact_ref: { storage_mode: "taric_stored", content_ref: artifact.contentRef, provenance_ref: binding.workRunId }, provenance: { source_refs: [binding.resourceId, binding.resourceRevisionId], attempt_ref: binding.attemptId } })
        expect(result).not.toHaveProperty("id")
        expect(result).not.toHaveProperty("trust_level")
        expect(result).not.toHaveProperty("commit_seq")
    })

    test("rejects stale ResourceRevision, cross-Engagement, wrong Attempt, unavailable and target-auth Artifacts", () => {
        expect(() => buildTaricEvidenceCandidate({ ...input, resourceRevision: 1 }, binding)).toThrow("ResourceRevision")
        for (const patch of [{ engagementId: crypto.randomUUID() }, { sessionId: "other" }, { generation: 2 }, { attemptId: crypto.randomUUID() }, { workRunId: undefined }, { ownerHost: "forged-host" }, { category: "target-auth" }, { contentStatus: "staged" }, { contentHash: "invalid" }, { contentRef: "artifact:local" }]) {
            expect(() => buildTaricEvidenceCandidate({ ...input, artifact: { ...artifact, ...patch } as CommittedTaricArtifact }, binding)).toThrow()
        }
    })

    test("validates statements, limitations and unsupported events without fabricating canonical records", () => {
        expect(() => buildTaricEvidenceCandidate({ ...input, statement: "password=private-value" }, binding)).toThrow("sensitive")
        expect(() => buildTaricEvidenceCandidate({ ...input, limitations: ["x".repeat(513)] }, binding)).toThrow("limitation")
        expect(() => buildTaricEvidenceCandidate({ ...input, hidden: "field" } as never, binding)).toThrow("unapproved")
        expect(adaptTaricToolEvidence("shell.unknown", { raw: "token=private-value" }, binding)).toMatchObject({ disposition: "host_audit", diagnostic: "unsupported_tool_event" })
        const invalid = adaptTaricToolEvidence("evidence.observed", { raw: "token=private-value" }, binding)
        expect(invalid).toMatchObject({ disposition: "host_audit", diagnostic: "invalid_evidence" })
        expect(JSON.stringify(invalid)).not.toContain("private-value")
        expect(adaptTaricToolEvidence("evidence.observed", input, binding).disposition).toBe("candidate")
    })
})
