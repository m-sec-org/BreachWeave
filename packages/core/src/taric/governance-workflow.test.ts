import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { AuthorizedPentestGovernance, GovernanceError } from "./governance"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE } from "./compatibility"
import { createTaricHostModule } from "./host-module"
import { TaricOperationError } from "./types"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "./types"

const compatibility: TaricCompatibility = {
    ...TARIC_COMPATIBILITY_BASELINE,
    policyDigest: "sha256:policy",
    bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
}

const binding: TaricHostBinding = {
    projectId: "project-authorized",
    tenantId: "tenant-a",
    engagementId: "engagement-a",
    hostPrincipalId: "host-a",
    modelPrincipalId: "model-a",
}

const setup = {
    project: { mode: "authorized_pentest" as const, tenant_id: "tenant-a", engagement_id: "engagement-a", scope_revision: 1, coverage_manifest_id: "manifest-a", memory_mode: "taric_required" as const, taric_engagement_id: "engagement-a" },
    scope: { allowedTargets: [{ host: "10.5.207.26" }] },
    testWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" },
    manifest: [{ resourceId: "00000000-0000-4000-8000-000000000001", revision: 1, testCategories: ["authentication"] }],
    secretReferences: ["secret:dvwa-admin"],
    retentionDays: 30,
    policyDigest: "sha256:policy",
}

const RUN_ID = "00000000-0000-4000-8000-000000000010"
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000011"
const AUTHORITY_ID = "00000000-0000-4000-8000-000000000099"
const CELL_ID = `${setup.manifest[0]!.resourceId}:1:1:authentication`

interface AdapterOptions {
    leaseExpiresAt?: string
    generation?: number
    onInvoke?: (operation: string, input: Record<string, unknown>) => unknown
}

function createAdapter(options: AdapterOptions = {}): TaricServiceAdapter & { calls: Array<{ operation: string; input: Record<string, unknown> }> } {
    const adapter = {
        calls: [] as Array<{ operation: string; input: Record<string, unknown> }>,
        async getProfile() { return { status: "verified" as const, compatibility } },
        async getBinding() { return binding },
        async invoke(operation: string, input: Record<string, unknown>) {
            adapter.calls.push({ operation, input })
            if (options.onInvoke) {
                const result = options.onInvoke(operation, input)
                if (result !== undefined) return result
            }
            if (operation === "work.claim") return { ok: true, data: { run_id: RUN_ID, attempt_ref: ATTEMPT_ID, generation: options.generation ?? 1, owner: "host-a", lease_expires_at: options.leaseExpiresAt ?? "2030-01-01T00:00:00.000Z", read_seq: 1 } }
            if (operation === "coverage.gate") return { ok: true, data: { can_close: true, read_seq: 5 } }
            if (operation === "coverage.record") return { ok: true, data: { id: AUTHORITY_ID } }
            return { ok: true, data: { operation, input, id: AUTHORITY_ID } }
        },
        async close() {},
    }
    return adapter
}

async function createWorkflow(options: { host?: AdapterOptions; reviewer?: AdapterOptions; reviewerKind?: "reviewer" | "deterministic"; allowDeterministicFixtureReviewer?: boolean; setup?: typeof setup } = {}) {
    const root = await mkdtemp(join(tmpdir(), "breachweave-governance-workflow-"))
    const hostAdapter = createAdapter(options.host)
    const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter: hostAdapter })
    await host.initialize()
    const reviewerAdapter = options.reviewer ? createAdapter(options.reviewer) : undefined
    const reviewer = reviewerAdapter
        ? createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter: reviewerAdapter })
        : undefined
    if (reviewer) await reviewer.initialize()
    const governance = new AuthorizedPentestGovernance({ host, reviewer, reviewerKind: options.reviewerKind, allowDeterministicFixtureReviewer: options.allowDeterministicFixtureReviewer, setup: options.setup ?? setup, artifactRoot: root, artifactKey: new Uint8Array(32).fill(4) })
    return { root, governance, hostAdapter, reviewerAdapter }
}

const reviewInput = {
    proposalId: "proposal-1",
    reviewerId: "reviewer-a",
    verdict: "pass" as const,
    inputHash: `sha256:${"a".repeat(64)}`,
    evidenceSnapshotHash: `sha256:${"b".repeat(64)}`,
    policyDigest: setup.policyDigest,
}

describe("authorized pentest governance workflow", () => {
    test("fails closed on project binding mismatch before launching governed work", async () => {
        const mismatched = await createWorkflow({ setup: { ...setup, project: { ...setup.project, tenant_id: "tenant-b" } } })
        try {
            await expect(mismatched.governance.claimWork("work-cross-tenant", "host-a", setup.manifest[0]!.resourceId)).rejects.toMatchObject({ code: "engagement_binding", outcome: "rejected_authorization" })
            expect(mismatched.hostAdapter.calls.some(({ operation }) => operation === "work.claim")).toBe(false)
        } finally { await rm(mismatched.root, { recursive: true, force: true }) }
    })

    test("enforces health-gated egress and manifest membership before host action dispatch", async () => {
        const { root, governance, hostAdapter } = await createWorkflow()
        try {
            await expect(governance.assertActionAllowed({ url: "http://10.5.207.26:4280/", resolvedAddresses: ["10.5.207.26"] })).resolves.toMatchObject({ allowed: true })
            await expect(governance.assertActionAllowed({ url: "http://10.5.208.26:4280/", resolvedAddresses: ["10.5.208.26"] })).rejects.toMatchObject({ code: "egress_denied", outcome: "rejected_authorization" })
            await expect(governance.claimWork("work-outside-manifest", "host-a", "00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({ code: "resource_out_of_manifest", outcome: "rejected_authorization" })
            expect(hostAdapter.calls.some(({ operation }) => operation === "work.claim")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("redacts private-key and credential bytes from capture diagnostics", async () => {
        const privateKey = "-----BEGIN PRIVATE KEY-----\nfixture-private-key-bytes\n-----END PRIVATE KEY-----"
        const secret = `capture failed token=fixture-gateway-token database_url=postgres://fixture:fixture-db-password@db.invalid/app ${privateKey}`
        const { root, governance } = await createWorkflow({ host: { onInvoke(operation) {
            if (operation === "capture.observation") return { ok: false, error: { code: "validation_error", message: secret } }
        } } })
        try {
            const run = await governance.claimWork("work-secret-diagnostic", binding.hostPrincipalId, setup.manifest[0]!.resourceId)
            const result = await governance.captureObservation({
                resourceRef: run.targetResourceId,
                statement: "Test response observed",
                workRunId: run.runId,
                generation: run.generation,
            })
            const serialized = JSON.stringify(result)
            for (const value of ["fixture-gateway-token", "fixture-db-password", "fixture-private-key-bytes"]) expect(serialized).not.toContain(value)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("binds the coverage gate query to the approved manifest and scope revision", async () => {
        const { root, governance, hostAdapter } = await createWorkflow()
        try {
            await governance.coverageGate()
            expect(hostAdapter.calls.find(({ operation }) => operation === "coverage.gate")?.input).toEqual({
                engagement_id: binding.engagementId,
                contract_version: "1.3.0",
            })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("requires an explicit reviewer authority and never falls back to the host", async () => {
        const { root, governance, hostAdapter } = await createWorkflow()
        try {
            await expect(governance.submitReview({ ...reviewInput, reviewerId: undefined })).rejects.toMatchObject({ code: "reviewer_unavailable", outcome: "rejected_authorization" })
            expect(hostAdapter.calls.some(({ operation }) => operation === "review.submit")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("records a defer verdict but blocks admission until review passes", async () => {
        const { root, governance, hostAdapter, reviewerAdapter } = await createWorkflow({ reviewer: {} })
        try {
            const decision = await governance.submitReview({ ...reviewInput, verdict: "defer" })
            expect(decision).toMatchObject({ proposalId: reviewInput.proposalId, reviewerId: reviewInput.reviewerId, verdict: "defer" })
            expect(reviewerAdapter?.calls.map(({ operation }) => operation)).toEqual(["review.submit"])
            await expect(governance.admit(reviewInput.proposalId, setup.policyDigest)).rejects.toMatchObject({ code: "admission_review", outcome: "rejected_authorization" })
            expect(hostAdapter.calls.some(({ operation }) => operation === "admission.evaluate")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("labels deterministic fixture reviews and keeps them at the review boundary", async () => {
        const { root, governance, hostAdapter, reviewerAdapter } = await createWorkflow({ reviewer: {}, reviewerKind: "deterministic", allowDeterministicFixtureReviewer: true })
        try {
            const decision = await governance.submitReview(reviewInput)
            expect(decision).toMatchObject({ reviewerKind: "deterministic", evidenceClass: "local_fixture", reviewerId: reviewInput.reviewerId })
            expect(reviewerAdapter?.calls).toContainEqual({
                operation: "review.submit",
                input: expect.objectContaining({ reviewer_id: reviewInput.reviewerId, reviewer_kind: "deterministic" }),
            })

            await governance.admit(reviewInput.proposalId, setup.policyDigest)
            expect(hostAdapter.calls.find(({ operation }) => operation === "admission.commit")?.input).toMatchObject({ proposal_id: reviewInput.proposalId })
            expect(hostAdapter.calls.some(({ operation }) => operation === "admission.promote_l2")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("surfaces an authority conflict while admitting a reviewed proposal", async () => {
        const { root, governance, hostAdapter } = await createWorkflow({
            reviewer: {},
            host: { onInvoke(operation) {
                if (operation === "admission.commit") throw new TaricOperationError("conflict", "proposal is no longer pending")
                return undefined
            } },
        })
        try {
            await governance.submitReview(reviewInput)
            await expect(governance.admit(reviewInput.proposalId, setup.policyDigest)).rejects.toMatchObject({ code: "conflict" })
            expect(hostAdapter.calls.filter(({ operation }) => operation === "admission.commit")).toHaveLength(1)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("recomputes the coverage gate after a coverage version change", async () => {
        let gateReadSeq = 5
        const { root, governance } = await createWorkflow({
            host: { onInvoke(operation) {
                if (operation === "coverage.gate") return { ok: true, data: { can_close: true, read_seq: gateReadSeq++ } }
                return undefined
            } },
        })
        try {
            const first = await governance.recordCoverage(CELL_ID, { expectedVersion: 0, status: "positive", evidenceRefs: ["00000000-0000-4000-8000-000000000012"] })
            expect(first.version).toBe(1)
            const openGate = await governance.coverageGate()
            expect(openGate.canClose).toBe(true)

            const changed = await governance.recordCoverage(CELL_ID, { expectedVersion: 1, status: "blocked" })
            expect(changed.version).toBe(2)
            await expect(governance.recordCoverage(CELL_ID, { expectedVersion: 1, status: "positive", evidenceRefs: ["00000000-0000-4000-8000-000000000012"] })).rejects.toMatchObject({ code: "coverage_conflict" })
            const currentGate = await governance.coverageGate()
            expect(currentGate.readSeq).toBeGreaterThan(openGate.readSeq)
            expect(currentGate).toMatchObject({ canClose: false, gaps: [`${CELL_ID}:blocked`], cells: [{ version: 2, status: "blocked" }] })
            await expect(governance.close({ operatorId: "operator-a", reportDigest: "sha256:report", residualRisks: [], disclosures: ["blocked test"] })).rejects.toMatchObject({ code: "coverage_incomplete" })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("does not close when the authority gate rejects otherwise complete local coverage", async () => {
        const { root, governance, hostAdapter } = await createWorkflow({
            host: { onInvoke(operation) {
                if (operation === "coverage.gate") return { ok: true, data: { can_close: false, read_seq: 8 } }
                return undefined
            } },
        })
        try {
            await governance.recordCoverage(CELL_ID, { expectedVersion: 0, status: "positive", evidenceRefs: ["00000000-0000-4000-8000-000000000012"] })

            const gate = await governance.coverageGate()
            expect(gate).toMatchObject({ canClose: false, gaps: [], cells: [{ status: "positive" }] })
            await expect(governance.close({ operatorId: "operator-a", reportDigest: "sha256:report", residualRisks: [], disclosures: [] })).rejects.toMatchObject({ code: "coverage_incomplete", outcome: "rejected_authorization" })
            expect(hostAdapter.calls.filter(({ operation }) => operation === "coverage.gate")).toHaveLength(2)
            expect(hostAdapter.calls.some(({ operation }) => operation === "work.query")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("rejects expired leases and stale work generations before host dispatch", async () => {
        const expired = await createWorkflow({ host: { leaseExpiresAt: "2000-01-01T00:00:00.000Z" } })
        try {
            await expect(expired.governance.claimWork("work-expired", "host-a", setup.manifest[0]!.resourceId)).rejects.toMatchObject({ code: "invalid_work_run", outcome: "failed_permanent" })
            expect(expired.hostAdapter.calls.some(({ operation }) => operation === "checkpoint.commit")).toBe(false)
        } finally { await rm(expired.root, { recursive: true, force: true }) }

        const current = await createWorkflow({ host: { generation: 2 } })
        try {
            const run = await current.governance.claimWork("work-current", "host-a", setup.manifest[0]!.resourceId)
            await expect(current.governance.transitionWork(run.runId, "host-a", 1, "completed")).rejects.toMatchObject({ code: "stale_generation", outcome: "rejected_authorization" })
            expect(current.hostAdapter.calls.some(({ operation }) => operation === "work.transition")).toBe(false)
        } finally { await rm(current.root, { recursive: true, force: true }) }
    })

    test("renews a live lease and restores only the reclaimed generation checkpoint", async () => {
        const checkpoint = {
            work_item_ref: "work-item-1",
            work_run_ref: RUN_ID,
            attempt_ref: ATTEMPT_ID,
            generation: 2,
            target_resource_ref: setup.manifest[0]!.resourceId,
            target_version: 1,
            work_item_version: 1,
            scope_version: 1,
            owner: "host-b",
            lease_expires_at: "2035-01-01T00:00:00.000Z",
            source_read_seq: 8,
            completed_steps: ["enumerate-login"],
            next_steps: ["verify-session"],
            observation_refs: [],
            evidence_refs: ["artifact:evidence-1"],
            negative_results: [],
            unresolved_work: [],
            host_decision_refs: [],
            external_action_state: {},
            budget: {},
            draft_refs: [],
            handoff_refs: [],
            action_refs: [],
            tool_result_refs: [],
            context_manifest: {},
        }
        const { root, governance, hostAdapter } = await createWorkflow({ host: { onInvoke(operation) {
            if (operation === "work.renew") return { ok: true, data: { lease_expires_at: "2035-01-01T00:00:00.000Z" } }
            if (operation === "work.reclaim") return { ok: true, data: { run_id: RUN_ID, work_item_id: "work-item-1", attempt_ref: ATTEMPT_ID, generation: 2, owner: "host-b", lease_expires_at: "2035-01-01T00:00:00.000Z", target_resource_id: setup.manifest[0]!.resourceId } }
            if (operation === "work.resume") return { ok: true, data: { checkpoint, read_seq: 9 } }
            return undefined
        } } })
        try {
            const original = await governance.claimWork("work-item-1", "host-a", setup.manifest[0]!.resourceId)
            const renewed = await governance.renewWork(original.runId, original.owner, original.generation, 120_000)
            expect(renewed.leaseExpiresAt).toBe("2035-01-01T00:00:00.000Z")
            expect(hostAdapter.calls.find(({ operation }) => operation === "work.renew")?.input).toMatchObject({ work_run_id: RUN_ID, generation: 1, ttl_ms: 120_000 })

            await governance.transitionWork(original.runId, original.owner, original.generation, "completed")
            const restartHost = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter: hostAdapter })
            await restartHost.initialize()
            const restarted = new AuthorizedPentestGovernance({ host: restartHost, setup, artifactRoot: root, artifactKey: new Uint8Array(32).fill(4) })
            const recovered = await restarted.recoverWork({ workRunId: RUN_ID, workItemId: "work-item-1", attemptId: ATTEMPT_ID, generation: 1, targetResourceId: setup.manifest[0]!.resourceId }, "host-b")
            expect(recovered.run).toMatchObject({ runId: RUN_ID, attemptId: ATTEMPT_ID, generation: 2, owner: "host-b" })
            expect(recovered.checkpoint).toMatchObject({ generation: 2, completedSteps: ["enumerate-login"], nextSteps: ["verify-session"], sourceReadSeq: 8 })
            await expect(restarted.commitCheckpoint({ workRunId: RUN_ID, attemptId: ATTEMPT_ID, generation: 1, completedSteps: [], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [], sourceReadSeq: 8 }, "host-b")).rejects.toMatchObject({ code: "stale_generation" })
            expect(hostAdapter.calls.map(({ operation }) => operation)).toContain("work.reclaim")
            expect(hostAdapter.calls.map(({ operation }) => operation)).toContain("work.resume")
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("rejects recovery checkpoints from stale scope or resource revisions", async () => {
        const checkpoint = { work_item_ref: "work-item-1", work_run_ref: RUN_ID, attempt_ref: ATTEMPT_ID, generation: 2, target_resource_ref: setup.manifest[0]!.resourceId, target_version: 1, scope_version: 2, source_read_seq: 8, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], unresolved_work: [] }
        const { root, hostAdapter } = await createWorkflow({ host: { onInvoke(operation) {
            if (operation === "work.reclaim") return { ok: true, data: { run_id: RUN_ID, work_item_id: "work-item-1", attempt_ref: ATTEMPT_ID, generation: 2, owner: "host-b", lease_expires_at: "2035-01-01T00:00:00.000Z", target_resource_id: setup.manifest[0]!.resourceId } }
            if (operation === "work.resume") return { ok: true, data: { checkpoint } }
            return undefined
        } } })
        try {
            const restartHost = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter: hostAdapter })
            await restartHost.initialize()
            const restarted = new AuthorizedPentestGovernance({ host: restartHost, setup, artifactRoot: root, artifactKey: new Uint8Array(32).fill(4) })
            await expect(restarted.recoverWork({ workRunId: RUN_ID, workItemId: "work-item-1", attemptId: ATTEMPT_ID, generation: 1, targetResourceId: setup.manifest[0]!.resourceId }, "host-b")).rejects.toMatchObject({ code: "stale_checkpoint", outcome: "rejected_authorization" })
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("rejects checkpoint secrets before writing to the host adapter", async () => {
        const { root, governance, hostAdapter } = await createWorkflow()
        try {
            const run = await governance.claimWork("work-secret", "host-a", setup.manifest[0]!.resourceId)
            await expect(governance.commitCheckpoint({
                workRunId: run.runId,
                attemptId: run.attemptId,
                generation: run.generation,
                completedSteps: ["password=super-secret"],
                nextSteps: [],
                observationRefs: [],
                evidenceRefs: [],
                unresolvedWork: [],
                sourceReadSeq: 1,
            }, "host-a")).rejects.toMatchObject({ code: "checkpoint_sensitive", outcome: "rejected_validation" })
            expect(hostAdapter.calls.some(({ operation }) => operation === "checkpoint.commit")).toBe(false)
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})
