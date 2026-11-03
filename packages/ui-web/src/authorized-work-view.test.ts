import { describe, expect, test } from "bun:test"
import { projectAuthorizedCoverage, projectAuthorizedReports, projectAuthorizedWorkItems } from "./authorized-work-view"

describe("projectAuthorizedWorkItems", () => {
    test("projects admitted Work lifecycle fields and omits authority internals", () => {
        expect(projectAuthorizedWorkItems([
            {
                id: "work-1",
                kind: "work_item",
                trust_level: "L1",
                status: "in_progress",
                resource_refs: ["resource-1", 5, "resource-2"],
                updated_at: "2026-11-02T00:00:00.000Z",
                owner: "private-principal",
                credential_ref: "secret-ref",
            },
            { id: "candidate-1", kind: "work_item", trust_level: "L0", status: "queued" },
            { id: "invalid-1", kind: "work_item", trust_level: "L1", status: "unknown" },
            { id: "other-1", kind: "resource", trust_level: "L1", status: "completed" },
        ])).toEqual([
            {
                id: "work-1",
                status: "in_progress",
                resourceRefs: ["resource-1", "resource-2"],
                updatedAt: "2026-11-02T00:00:00.000Z",
            },
        ])
    })
})

describe("projectAuthorizedCoverage", () => {
    test("projects canonical Coverage and Evidence refs while omitting candidates", () => {
        expect(projectAuthorizedCoverage([
            { id: "coverage-1", kind: "coverage", trust_level: "L1", resource_ref: "resource-1", resource_revision_ref: "revision-1", test_category: "authentication", status: "positive", evidence_refs: ["evidence-1"], limitations: ["fixture only"] },
            { id: "candidate-1", kind: "coverage", trust_level: "L0", resource_ref: "resource-1", resource_revision_ref: "revision-1", test_category: "authentication", status: "positive" },
        ])).toEqual([{
            id: "coverage-1",
            resourceRef: "resource-1",
            resourceRevisionRef: "revision-1",
            category: "authentication",
            status: "positive",
            evidenceRefs: ["evidence-1"],
            limitations: ["fixture only"],
        }])
    })
})

describe("projectAuthorizedReports", () => {
    test("projects canonical report Artifact indexes and skips candidates", () => {
        expect(projectAuthorizedReports([
            { id: "report-1", kind: "report_snapshot", trust_level: "L1", report_artifact_ref: "artifact-1@v2", report_artifact_digest: "sha256:abc", evidence_refs: ["evidence-1"], committed_at: "2026-11-03T00:00:00.000Z" },
            { id: "candidate-1", kind: "report_snapshot", trust_level: "L0", report_artifact_ref: "candidate@v1", report_artifact_digest: "sha256:def" },
            { id: "incomplete-1", kind: "report_snapshot", trust_level: "L1", report_artifact_ref: "artifact@v1" },
        ])).toEqual([{
            id: "report-1",
            artifactRef: "artifact-1@v2",
            artifactDigest: "sha256:abc",
            evidenceRefs: ["evidence-1"],
            committedAt: "2026-11-03T00:00:00.000Z",
        }])
    })
})
