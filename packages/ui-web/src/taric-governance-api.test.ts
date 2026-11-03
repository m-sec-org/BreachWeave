import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthorizedProjectSetup, CloseRequest, CoverageStatus, ReportSnapshot, ReviewSubmission, WorkRun } from "../../core/src/taric"
import type { TaricGovernanceRoutesOptions } from "./taric-governance-api"
import { deriveCompositeProjectKey } from "../../core/src/project/types"
import { assertTaricControlPlaneContract } from "../../core/src/taric/control-plane-contract"
import { authorityProposalProjection, createTaricGovernanceRoutes, loadLocalGovernanceArtifactKey } from "./taric-governance-api"

const setup: AuthorizedProjectSetup = {
    project: {
        mode: "authorized_pentest",
        tenant_id: "local",
        engagement_id: "engagement-local",
        taric_engagement_id: "engagement-local",
        scope_revision: 1,
        coverage_manifest_id: "manifest-local",
        memory_mode: "taric_required",
    },
    scope: { allowedTargets: [{ host: "127.0.0.1" }] },
    testWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" },
    manifest: [{ resourceId: "00000000-0000-4000-8000-000000000001", revision: 1, testCategories: ["authentication"] }],
    secretReferences: ["secret:local-test"],
    retentionDays: 30,
    policyDigest: "sha256:request-value-is-replaced",
}

function apiRequest(url: string, body?: unknown, params: Record<string, string> = {}) {
    return Object.assign(new Request(url, body === undefined ? undefined : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }), { params })
}

const reportSnapshot: ReportSnapshot = {
    reportDigest: "sha256:current-snapshot", manifestDigest: "sha256:manifest", scopeRevision: 1, resourceRevisions: [],
    gate: { canClose: true, readSeq: 9, gaps: [], cells: [] }, readSeq: 9, createdAt: "2026-11-02T00:00:00.000Z",
}

type ApiGovernance = Awaited<ReturnType<TaricGovernanceRoutesOptions["createGovernance"]>>

async function createApiFixture(overrides: Partial<ApiGovernance> = {}, isLocalFixtureVerification?: (proposal: Readonly<Record<string, unknown>>) => boolean) {
    const routes = createTaricGovernanceRoutes({
        resolvePolicyDigest: () => "sha256:configured-policy",
        isLocalFixtureVerification,
        async createGovernance(boundSetup) {
            return {
                setup: boundSetup,
                async assertActionAllowed() { throw new Error("unused fixture operation") },
                async createReportSnapshot() { return reportSnapshot },
                async claimWork() { throw new Error("unused fixture operation") },
                async transitionWork() { throw new Error("unused fixture operation") },
                async commitCheckpoint() { throw new Error("unused fixture operation") },
                async commitArtifact() { throw new Error("unused fixture operation") },
                async captureObservation() { throw new Error("unused fixture operation") },
                async submitCandidateProposal() { throw new Error("unused fixture operation") },
                async recordCoverage() { throw new Error("unused fixture operation") },
                async listProposals() { return { proposals: [], read_seq: 9 } },
                async submitReview() { throw new Error("unused fixture operation") },
                async admit() { throw new Error("unused fixture operation") },
                async close() { throw new Error("unused fixture operation") },
                ...overrides,
            }
        },
    })
    const created = await routes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", { setup }))
    expect(created.status).toBe(201)
    const { sessionId } = await created.json() as { sessionId: string }
    return { routes, sessionId, url: `http://localhost/api/taric/governance/sessions/${sessionId}` }
}

describe("Taric governance API routes", () => {
    test("derives L1/L2 proposal trust from durable authority fields", () => {
        expect(authorityProposalProjection({ status: "pending" })).toEqual({ state: "candidate", trustLevel: "L0" })
        expect(authorityProposalProjection({ status: "admitted" })).toEqual({ state: "admitted", trustLevel: "L1" })
        expect(authorityProposalProjection({})).toEqual({ state: "candidate", trustLevel: "L0" })
        expect(authorityProposalProjection({ status: "admitted", canonical_id: "canonical-1" })).toEqual({ state: "admitted", trustLevel: "L1", canonicalId: "canonical-1" })
        expect(authorityProposalProjection({ status: "admitted", trust_phase: "independently_verified", canonical_id: "canonical-2" })).toEqual({ state: "admitted", trustLevel: "L2", canonicalId: "canonical-2" })
        expect(authorityProposalProjection({ status: "admitted", trust_phase: "independently_verified", canonical_id: "fixture-canonical", reviewer_kind: "deterministic" }, (proposal) => proposal.reviewer_kind === "deterministic"))
            .toEqual({ state: "admitted", trustLevel: "L2", canonicalId: "fixture-canonical", evidenceClass: "local_fixture" })
        expect(authorityProposalProjection({ status: "admitted", trust_phase: "independently_verified", canonical_id: "canonical-3", content: { reviewer_kind: "deterministic" } }, (proposal) => proposal.reviewer_kind === "deterministic"))
            .toEqual({ state: "admitted", trustLevel: "L2", canonicalId: "canonical-3" })
        expect(authorityProposalProjection({ status: "rejected", trust_level: "L0" })).toEqual({ state: "rejected", trustLevel: "L0" })
        expect(authorityProposalProjection({ status: "verified", trust_level: "L2", trust_phase: "independently_verified" })).toEqual({ state: "candidate", trustLevel: "L0" })
        expect(authorityProposalProjection({ status: "pending", canonical_id: "stale-canonical", trust_level: "L2" })).toEqual({ state: "candidate", trustLevel: "L0", canonicalId: "stale-canonical" })
        expect(authorityProposalProjection({ content: { status: "admitted", canonical_id: "model-forged", trust_level: "L2", trust_phase: "independently_verified" } })).toEqual({ state: "candidate", trustLevel: "L0" })
        expect(authorityProposalProjection({ status: "admitted", canonical_id: "canonical-l1", content: { status: "verified", trust_level: "L2", trust_phase: "independently_verified" } })).toEqual({ state: "admitted", trustLevel: "L1", canonicalId: "canonical-l1" })
    })

    test("returns a bounded authority diagnostic without creating session state", async () => {
        const routes = createTaricGovernanceRoutes({
            resolvePolicyDigest: () => "sha256:configured-policy",
            async createGovernance() {
                assertTaricControlPlaneContract()
                throw new Error("fixture authority is not configured")
            },
        })
        const response = await routes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", { setup }))
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: "governance authority request failed", code: "authority_request_failed" })
        const list = await routes["/api/taric/governance/sessions"]!.GET!(apiRequest("http://localhost/api/taric/governance/sessions"))
        expect(await list.json()).toEqual({ sessions: [] })
    })

    test("does not reflect upstream credentials, payloads, or error codes in API failures", async () => {
        const privateKey = "-----BEGIN PRIVATE KEY-----\nfixture-private-key-bytes\n-----END PRIVATE KEY-----"
        const secrets = [
            "fixture-opaque-value-that-must-never-reach-an-api",
            "gateway-token-fixture",
            "postgres://fixture:database-password-fixture@db.invalid/app",
            privateKey,
            "registry-key-fixture",
            "outbox-key-fixture",
            "cookie-fixture",
        ]
        for (const secret of secrets) {
            for (const outcome of [undefined, "rejected_validation", "rejected_authorization"]) {
                const routes = createTaricGovernanceRoutes({
                    resolvePolicyDigest: () => "sha256:configured-policy",
                    async createGovernance() {
                        throw Object.assign(new Error(secret), { code: secret, outcome, details: { payload: secret } })
                    },
                })
                const response = await routes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", { setup }))
                expect(response.status).toBe(outcome === "rejected_validation" ? 400 : outcome === "rejected_authorization" ? 503 : 502)
                expect(await response.text()).not.toContain(secret)
            }
        }
    })

    test("keeps review and close actors host-bound and filters proposals by project", async () => {
        const projectKey = deriveCompositeProjectKey(setup.project)
        const reviewCalls: ReviewSubmission[] = []
        const admissionCalls: Array<{ proposalId: string; policyDigest: string }> = []
        let proposalAuthorityStatus: "proposed" | "rejected" | undefined = "proposed"
        const closeCalls: CloseRequest[] = []
        const coverageCalls: Array<{ cellId: string; expectedVersion: number; status: CoverageStatus; actor?: "host" | "operator" }> = []
        const actionCalls: Array<{ url: string; resolvedAddresses?: readonly string[] }> = []
        const run: WorkRun = {
            runId: "00000000-0000-4000-8000-000000000010",
            workItemId: "work-item-local",
            attemptId: "00000000-0000-4000-8000-000000000011",
            owner: "configured-host",
            generation: 1,
            leaseExpiresAt: "2030-01-01T00:00:00.000Z",
            targetResourceId: setup.manifest[0]!.resourceId,
        }
        const routes = createTaricGovernanceRoutes({
            resolvePolicyDigest: () => "sha256:configured-policy",
            async createGovernance(boundSetup) {
                return {
                    setup: boundSetup,
                    async assertActionAllowed(input) {
                        actionCalls.push(input)
                        return { allowed: true, reason: "allowed", normalizedUrls: [input.url] }
                    },
                    async coverageGate() {
                        return { canClose: true, readSeq: 9, gaps: [], cells: [] }
                    },
                    async createReportSnapshot() {
                        return {
                            reportDigest: "sha256:snapshot",
                            manifestDigest: "sha256:manifest",
                            scopeRevision: 1,
                            resourceRevisions: [],
                            gate: { canClose: true, readSeq: 9, gaps: [], cells: [] },
                            readSeq: 9,
                            createdAt: "2026-10-28T00:00:00.000Z",
                        }
                    },
                    async claimWork() { return run },
                    async transitionWork() {},
                    async commitCheckpoint(state) { return state },
                    async commitArtifact(input) {
                        return {
                            artifactId: "00000000-0000-4000-8000-000000000012",
                            contentRef: "artifact:artifact-local",
                            path: "/private/local/path",
                            bytes: input.bytes.byteLength,
                            sha256: "sha256:content",
                            manifestHash: "sha256:manifest",
                            mediaType: input.mediaType,
                            committedAt: "2026-10-28T00:00:00.000Z",
                            redacted: false,
                            contentStatus: "available",
                        }
                    },
                    async captureObservation(input) {
                        return { outcome: "accepted", result: input, diagnostics: { outcome: "accepted", code: "accepted", message: "accepted" } }
                    },
                    async submitCandidateProposal(input) { return { id: "proposal-created", content: input.content } },
                    async recordCoverage(cellId, input, actor) {
                        coverageCalls.push({ cellId, expectedVersion: input.expectedVersion, status: input.status, actor })
                        return { cellId, resourceId: setup.manifest[0]!.resourceId, resourceRevision: 1, scopeRevision: 1, category: "authentication", status: input.status, evidenceRefs: input.evidenceRefs ?? [], version: input.expectedVersion + 1 }
                    },
                    async listProposals() {
                        return {
                            read_seq: 9,
                            proposals: [
                                { id: "proposal-local", title: `BreachWeave [${projectKey}] memory (fact): local`, status: proposalAuthorityStatus },
                                { id: "proposal-other", title: "BreachWeave [bwpk_v1_other] memory (fact): other", status: "proposed" },
                            ],
                        }
                    },
                    async submitReview(input) {
                        reviewCalls.push(input)
                        return { ...input, reviewerId: "configured-host", reviewerKind: "reviewer", evidenceClass: "authority_review", createdAt: "2026-10-28T00:00:00.000Z" }
                    },
                    async admit(proposalId, policyDigest) {
                        admissionCalls.push({ proposalId, policyDigest })
                        // Simulate a subsequent authority-side rejection. The
                        // API must reflect this durable status even though its
                        // process-local admission hint is still "admitted".
                        proposalAuthorityStatus = "rejected"
                        return { accepted: true }
                    },
                    async close(input) {
                        closeCalls.push(input)
                        const reportDigest = input.reportDigest ?? "sha256:snapshot"
                        return {
                            closed: true,
                            reportDigest,
                            readSeq: 9,
                            snapshot: {
                                reportDigest,
                                manifestDigest: "sha256:manifest",
                                scopeRevision: 1,
                                resourceRevisions: [],
                                gate: { canClose: true, readSeq: 9, gaps: [], cells: [] },
                                readSeq: 9,
                                createdAt: "2026-10-28T00:00:00.000Z",
                            },
                        }
                    },
                }
            },
        })

        const created = await routes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", { setup }))
        expect(created.status).toBe(201)
        const { sessionId } = await created.json() as { sessionId: string }

        const preflightRejected = await routes["/api/taric/governance/sessions/:sessionId/authorize-action"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/authorize-action`,
            { url: "http://127.0.0.1", at: "2000-01-01T00:00:00.000Z" },
            { sessionId },
        ))
        expect(preflightRejected.status).toBe(400)
        const preflight = await routes["/api/taric/governance/sessions/:sessionId/authorize-action"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/authorize-action`,
            { url: "http://127.0.0.1", resolvedAddresses: ["127.0.0.1"] },
            { sessionId },
        ))
        expect(preflight.status).toBe(200)
        expect(actionCalls).toEqual([{ url: "http://127.0.0.1", resolvedAddresses: ["127.0.0.1"] }])

        const claimed = await routes["/api/taric/governance/sessions/:sessionId/work-runs"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/work-runs`,
            { workItemId: run.workItemId, targetResourceId: run.targetResourceId, owner: "untrusted-owner" },
            { sessionId },
        ))
        expect(claimed.status).toBe(201)
        expect(await claimed.json()).not.toHaveProperty("owner")

        const checkpoint = await routes["/api/taric/governance/sessions/:sessionId/checkpoints"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/checkpoints`,
            { workRunId: run.runId, generation: 1, sourceReadSeq: 4, nextSteps: ["verify"] },
            { sessionId },
        ))
        expect(checkpoint.status).toBe(200)

        const artifact = await routes["/api/taric/governance/sessions/:sessionId/artifacts"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/artifacts`,
            { dataBase64: Buffer.from("evidence").toString("base64"), mediaType: "text/plain", path: "/spoofed" },
            { sessionId },
        ))
        expect(artifact.status).toBe(201)
        expect(await artifact.json()).not.toHaveProperty("path")

        const observation = await routes["/api/taric/governance/sessions/:sessionId/observations"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/observations`,
            { resourceRef: run.targetResourceId, statement: "Login form observed", artifactRefs: ["artifact:artifact-local"], workRunId: run.runId, generation: 1 },
            { sessionId },
        ))
        expect(observation.status).toBe(200)
        expect(await observation.json()).toMatchObject({ outcome: "accepted" })

        const candidate = await routes["/api/taric/governance/sessions/:sessionId/proposals"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/proposals`,
            { subjectType: "claim", expectedVersion: 0, content: { title: "local candidate", proposition: "A candidate claim" } },
            { sessionId },
        ))
        expect(candidate.status).toBe(201)
        expect(await candidate.json()).toMatchObject({ proposalId: "proposal-created", state: "candidate", result: { content: { title: `BreachWeave [${projectKey}] local candidate` } } })

        const transition = await routes["/api/taric/governance/sessions/:sessionId/work-runs/:runId/transition"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/work-runs/${run.runId}/transition`,
            { status: "completed", owner: "untrusted-owner", generation: 99 },
            { sessionId, runId: run.runId },
        ))
        expect(transition.status).toBe(200)

        const review = await routes["/api/taric/governance/sessions/:sessionId/proposals/:proposalId/review"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/proposals/proposal-local/review`,
            { verdict: "pass", inputHash: `sha256:${"a".repeat(64)}`, evidenceSnapshotHash: `sha256:${"b".repeat(64)}`, reviewerId: "untrusted-reviewer" },
            { sessionId, proposalId: "proposal-local" },
        ))
        expect(review.status).toBe(200)
        expect(reviewCalls).toEqual([{
            proposalId: "proposal-local",
            verdict: "pass",
            inputHash: `sha256:${"a".repeat(64)}`,
            evidenceSnapshotHash: `sha256:${"b".repeat(64)}`,
            policyDigest: "sha256:configured-policy",
        }])

        const state = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}`,
            undefined,
            { sessionId },
        ))
        const stateBody = await state.json() as { reportSnapshot: { reportDigest: string }; proposals: Array<{ id: string; title: string; authority_status: string; state: string; trustLevel: string }> }
        expect(stateBody.reportSnapshot.reportDigest).toBe("sha256:snapshot")
        expect(stateBody.proposals).toEqual([{ id: "proposal-local", title: `BreachWeave [${projectKey}] memory (fact): local`, authority_status: "proposed", state: "candidate", trustLevel: "L0" }])

        const admission = await routes["/api/taric/governance/sessions/:sessionId/proposals/:proposalId/admit"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/proposals/proposal-local/admit`,
            { operatorId: "untrusted-operator", policyDigest: "sha256:untrusted-policy" },
            { sessionId, proposalId: "proposal-local" },
        ))
        expect(admission.status).toBe(200)
        expect(admissionCalls).toEqual([{ proposalId: "proposal-local", policyDigest: "sha256:configured-policy" }])
        expect(await admission.json()).toMatchObject({ proposalId: "proposal-local", state: "rejected", authorityStatus: "rejected" })

        const refreshed = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}`,
            undefined,
            { sessionId },
        ))
        const refreshedBody = await refreshed.json() as { proposals: Array<{ id: string; title: string; authority_status: string; state: string; trustLevel?: string }> }
        expect(refreshedBody.proposals).toEqual([{ id: "proposal-local", title: `BreachWeave [${projectKey}] memory (fact): local`, authority_status: "rejected", state: "rejected", trustLevel: "L0" }])

        proposalAuthorityStatus = undefined
        const sessionList = await routes["/api/taric/governance/sessions"]!.GET!(apiRequest("http://localhost/api/taric/governance/sessions"))
        const sessionListBody = await sessionList.json() as { sessions: Array<{ proposals: Array<{ id: string; title: string; state: string; trustLevel?: string }> }> }
        expect(sessionListBody.sessions[0]?.proposals).toEqual([{ id: "proposal-local", title: `BreachWeave [${projectKey}] memory (fact): local`, state: "candidate", trustLevel: "L0" }])

        const coverage = await routes["/api/taric/governance/sessions/:sessionId/coverage/:cellId"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/coverage/${encodeURIComponent(`${setup.manifest[0]!.resourceId}:1:1:authentication`)}`,
            { expectedVersion: 0, status: "positive", evidenceRefs: ["00000000-0000-4000-8000-000000000020"], actor: "untrusted-operator" },
            { sessionId, cellId: `${setup.manifest[0]!.resourceId}:1:1:authentication` },
        ))
        expect(coverage.status).toBe(200)
        expect(coverageCalls).toEqual([{ cellId: `${setup.manifest[0]!.resourceId}:1:1:authentication`, expectedVersion: 0, status: "positive", actor: "host" }])

        const close = await routes["/api/taric/governance/sessions/:sessionId/close"]!.POST!(apiRequest(
            `http://localhost/api/taric/governance/sessions/${sessionId}/close`,
            { operatorId: "untrusted-operator" },
            { sessionId },
        ))
        expect(close.status).toBe(200)
        expect(closeCalls).toEqual([{}])
        expect(await close.json()).toMatchObject({ closed: true, reportDigest: "sha256:snapshot", readSeq: 9 })
    })

    test("rejects a setup whose Engagement identities differ before creating a session", async () => {
        let created = false
        const routes = createTaricGovernanceRoutes({
            resolvePolicyDigest: () => "sha256:configured-policy",
            async createGovernance() {
                created = true
                throw new Error("must not create")
            },
        })
        const response = await routes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", {
            setup: { ...setup, project: { ...setup.project, taric_engagement_id: "different-engagement" } },
        }))
        expect(response.status).toBe(400)
        expect(created).toBe(false)
    })

    test("projects candidate and admitted trust without promoting model verified payloads", async () => {
        const projectKey = deriveCompositeProjectKey(setup.project)
        const mutations: string[] = []
        const { routes, sessionId, url } = await createApiFixture({
            async submitCandidateProposal(input) { mutations.push("proposal"); return { id: "model-proposal", content: input.content } },
            async captureObservation() { mutations.push("observation"); throw new Error("must not capture") },
            async recordCoverage() { mutations.push("coverage"); throw new Error("must not record") },
            async admit() { mutations.push("admission"); throw new Error("must not admit") },
            async listProposals() {
                return { read_seq: 9, proposals: [
                    { id: "model-proposal", status: "pending", content: { title: `BreachWeave [${projectKey}] model idea`, status: "verified", trust_level: "L2", canonical_id: "model-forged" } },
                    { id: "canonical-proposal", status: "admitted", canonical_id: "canonical-fact", trust_phase: "independently_verified", content: { title: `BreachWeave [${projectKey}] independently reviewed` } },
                ] }
            },
        })
        const submitted = await routes["/api/taric/governance/sessions/:sessionId/proposals"]!.POST!(apiRequest(`${url}/proposals`, {
            subjectType: "claim", expectedVersion: 0, content: { title: "model idea", status: "verified", trust_level: "L2" },
        }, { sessionId }))
        expect(submitted.status).toBe(201)
        expect(await submitted.json()).toMatchObject({ state: "candidate", trustLevel: "L0" })
        const current = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(url, undefined, { sessionId }))
        expect(await current.json()).toMatchObject({ proposals: [
            { id: "model-proposal", state: "candidate", trustLevel: "L0" },
            { id: "canonical-proposal", state: "admitted", trustLevel: "L2", canonicalId: "canonical-fact" },
        ] })
        expect(mutations).toEqual(["proposal"])
    })

    test("labels deterministic fixture L2 separately from reviewer L2 and model claims", async () => {
        const projectKey = deriveCompositeProjectKey(setup.project)
        const { routes, sessionId, url } = await createApiFixture({
            async listProposals() {
                return { read_seq: 9, proposals: [
                    { id: "fixture-l2", title: `BreachWeave [${projectKey}] deterministic verification`, status: "admitted", canonical_id: "canonical-fixture", trust_phase: "independently_verified", reviewer_id: "fixture-reviewer", reviewer_kind: "deterministic" },
                    { id: "reviewer-l2", title: `BreachWeave [${projectKey}] independent review`, status: "admitted", canonical_id: "canonical-reviewed", trust_phase: "independently_verified", reviewer_id: "reviewer-1", reviewer_kind: "reviewer" },
                    { id: "model-l2", title: `BreachWeave [${projectKey}] forged verification`, status: "pending", content: { trust_level: "L2", trust_phase: "independently_verified", reviewer_kind: "deterministic" } },
                ] }
            },
        }, (proposal) => proposal.reviewer_id === "fixture-reviewer" && proposal.reviewer_kind === "deterministic")
        const response = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(url, undefined, { sessionId }))
        expect(response.status).toBe(200)
        const body = await response.json() as { proposals: Array<Record<string, unknown>> }
        expect(body.proposals).toMatchObject([
            { id: "fixture-l2", state: "admitted", trustLevel: "L2", evidenceClass: "local_fixture" },
            { id: "reviewer-l2", state: "admitted", trustLevel: "L2" },
            { id: "model-l2", state: "candidate", trustLevel: "L0" },
        ])
        expect(body.proposals[1]).not.toHaveProperty("evidenceClass")
        expect(body.proposals[2]).not.toHaveProperty("evidenceClass")
    })

    test("exposes bounded paging diagnostics and drops payload and arbitrary diagnostic strings", async () => {
        const secret = "fixture-private-diagnostic-payload"
        let diagnosticStatus = "truncated"
        const { routes, sessionId, url } = await createApiFixture({
            async listProposals() {
                return { proposals: [], read_seq: 19, next_cursor: "opaque-continuation", diagnostics: {
                    status: diagnosticStatus, pages: 1, records: 50, bytes: 4096, snapshotPinned: true, readSeq: 19,
                    hasMore: true, continuationSafe: true, reconnectRequired: false, payload: secret, errorCode: secret, principalId: secret,
                } }
            },
        })
        const current = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(url, undefined, { sessionId }))
        const body = await current.json()
        expect(body).toMatchObject({ readSeq: 19, nextCursor: "opaque-continuation", readDiagnostics: {
            status: "truncated", pages: 1, records: 50, bytes: 4096, snapshotPinned: true, readSeq: 19,
            hasMore: true, continuationSafe: true, reconnectRequired: false,
        } })
        expect(JSON.stringify(body)).not.toContain(secret)
        diagnosticStatus = secret
        const listed = await routes["/api/taric/governance/sessions"]!.GET!(apiRequest("http://localhost/api/taric/governance/sessions"))
        expect(await listed.text()).not.toContain(secret)
    })

    test("does not cache a rejected stale close and returns the current gate watermark", async () => {
        const currentSnapshot = { ...reportSnapshot, reportDigest: "sha256:after-scope-revision", scopeRevision: 2, readSeq: 20, gate: { ...reportSnapshot.gate, readSeq: 20 } }
        const calls: CloseRequest[] = []
        const { routes, sessionId, url } = await createApiFixture({
            async createReportSnapshot() { return currentSnapshot },
            async close(input) {
                calls.push(input)
                if (input.reportDigest !== currentSnapshot.reportDigest) throw { code: "report_snapshot_stale", outcome: "rejected_authorization", payload: "private-close-premise" }
                return { closed: true, reportDigest: currentSnapshot.reportDigest, readSeq: currentSnapshot.readSeq, snapshot: currentSnapshot }
            },
        })
        const stale = await routes["/api/taric/governance/sessions/:sessionId/close"]!.POST!(apiRequest(`${url}/close`, { reportDigest: reportSnapshot.reportDigest }, { sessionId }))
        expect(stale.status).toBe(409)
        expect(await stale.json()).toEqual({ error: "governance state changed; refresh before retrying", code: "report_snapshot_stale" })
        const refreshed = await routes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(url, undefined, { sessionId }))
        expect(await refreshed.json()).toMatchObject({ closed: false, reportSnapshot: { scopeRevision: 2, readSeq: 20, gate: { readSeq: 20 } } })
        const closed = await routes["/api/taric/governance/sessions/:sessionId/close"]!.POST!(apiRequest(`${url}/close`, { reportDigest: currentSnapshot.reportDigest }, { sessionId }))
        expect(closed.status).toBe(200)
        expect(calls).toEqual([{ reportDigest: reportSnapshot.reportDigest }, { reportDigest: currentSnapshot.reportDigest }])
    })

    test("returns stale generation conflicts across transition, capture and Artifact publication", async () => {
        const run: WorkRun = { runId: "00000000-0000-4000-8000-000000000010", workItemId: "canonical-work-item", attemptId: "00000000-0000-4000-8000-000000000011", owner: "configured-host", generation: 1, leaseExpiresAt: "2030-01-01T00:00:00.000Z", targetResourceId: setup.manifest[0]!.resourceId }
        const calls: Array<{ surface: string; generation: number | undefined }> = []
        function stale(surface: string, generation: number | undefined): never {
            calls.push({ surface, generation })
            throw { code: "stale_generation", outcome: "rejected_authorization", details: { payload: "private-stale-payload" } }
        }
        const { routes, sessionId, url } = await createApiFixture({
            async claimWork() { return run },
            async transitionWork(_runId, _owner, generation) { stale("transition", generation) },
            async commitCheckpoint(input) { stale("checkpoint", input.generation) },
            async captureObservation(input) { stale("capture", input.generation) },
            async commitArtifact(input) { stale("artifact", input.generation) },
        })
        const claimed = await routes["/api/taric/governance/sessions/:sessionId/work-runs"]!.POST!(apiRequest(`${url}/work-runs`, { workItemId: run.workItemId, targetResourceId: run.targetResourceId }, { sessionId }))
        expect(claimed.status).toBe(201)
        const requests: Array<{ path: string; suffix: string; body: Record<string, unknown>; params: Record<string, string> }> = [
            { path: "work-runs/:runId/transition", suffix: `work-runs/${run.runId}/transition`, body: { status: "completed" }, params: { sessionId, runId: run.runId } },
            { path: "checkpoints", suffix: "checkpoints", body: { workRunId: run.runId, generation: 1, sourceReadSeq: 4 }, params: { sessionId } },
            { path: "observations", suffix: "observations", body: { resourceRef: run.targetResourceId, statement: "retained fixture observation", workRunId: run.runId, generation: 1 }, params: { sessionId } },
            { path: "artifacts", suffix: "artifacts", body: { dataBase64: Buffer.from("retained fixture evidence").toString("base64"), mediaType: "text/plain", workRunId: run.runId, attemptId: run.attemptId, generation: 1 }, params: { sessionId } },
        ]
        for (const request of requests) {
            const response = await routes[`/api/taric/governance/sessions/:sessionId/${request.path}`]!.POST!(apiRequest(`${url}/${request.suffix}`, request.body, request.params))
            expect(response.status).toBe(409)
            expect(await response.json()).toEqual({ error: "governance state changed; refresh before retrying", code: "stale_generation" })
        }
        expect(calls).toEqual(["transition", "checkpoint", "capture", "artifact"].map((surface) => ({ surface, generation: 1 })))
    })

    test("rebuilds the projection per request and validates its context budget", async () => {
        const calls: Array<number | undefined> = []
        let readSeq = 21
        const { routes, sessionId, url } = await createApiFixture({
            async rebuildProjection(options) {
                calls.push(options?.contextBudget)
                return { format: "breachweave-authorized-projection/1", source: "canonical_taric_records", readSeq: readSeq++, diagnostics: { status: "complete", reconciliation: "required", profile: "local_development" } }
            },
        })
        const projectionRoute = routes["/api/taric/governance/sessions/:sessionId/projection"]!.GET!
        const invalid = await projectionRoute(apiRequest(`${url}/projection?context_budget=50001`, undefined, { sessionId }))
        expect(invalid.status).toBe(400)
        expect(calls).toEqual([])
        const first = await projectionRoute(apiRequest(`${url}/projection?context_budget=1024`, undefined, { sessionId }))
        expect(await first.json()).toMatchObject({ source: "canonical_taric_records", readSeq: 21, diagnostics: { status: "complete", reconciliation: "required", profile: "local_development" } })
        const second = await projectionRoute(apiRequest(`${url}/projection`, undefined, { sessionId }))
        expect(await second.json()).toMatchObject({ readSeq: 22 })
        expect(calls).toEqual([1024, undefined])
    })

    test("rehydrates a governance session and active WorkRun after the route cache is discarded", async () => {
        const sessionId = "00000000-0000-4000-8000-000000000098"
        const run: WorkRun = { runId: "00000000-0000-4000-8000-000000000010", workItemId: "work-item-rehydrated", attemptId: "00000000-0000-4000-8000-000000000011", owner: "configured-host", generation: 2, leaseExpiresAt: "2030-01-01T00:00:00.000Z", targetResourceId: setup.manifest[0]!.resourceId }
        let transitions = 0
        const governance: ApiGovernance = {
            setup,
            async assertActionAllowed() { return { allowed: true, reason: "allowed", normalizedUrls: [] } },
            async createReportSnapshot() { return reportSnapshot },
            async claimWork() { return run },
            async transitionWork() { transitions += 1 },
            async commitCheckpoint() { return {} },
            async commitArtifact() { throw new Error("unused") },
            async captureObservation() { throw new Error("unused") },
            async submitCandidateProposal() { throw new Error("unused") },
            async recordCoverage() { throw new Error("unused") },
            async listProposals() { return { proposals: [], read_seq: 9 } },
            async submitReview() { throw new Error("unused") },
            async admit() { throw new Error("unused") },
            async close() { throw new Error("unused") },
        }
        const makeRoutes = (loadSession?: TaricGovernanceRoutesOptions["loadSession"]) => createTaricGovernanceRoutes({
            resolvePolicyDigest: () => "sha256:configured-policy",
            async createGovernance() { return governance },
            ...(loadSession ? { loadSession } : {}),
        })
        const firstRoutes = makeRoutes()
        const created = await firstRoutes["/api/taric/governance/sessions"]!.POST!(apiRequest("http://localhost/api/taric/governance/sessions", { setup }))
        expect(created.status).toBe(201)
        const secondRoutes = makeRoutes(async (id) => id === sessionId ? { setup, governance, activeRuns: [run], createdAt: "2026-11-02T00:00:00.000Z" } : undefined)
        const restored = await secondRoutes["/api/taric/governance/sessions/:sessionId"]!.GET!(apiRequest(`http://localhost/api/taric/governance/sessions/${sessionId}`, undefined, { sessionId }))
        expect(restored.status).toBe(200)
        const transition = await secondRoutes["/api/taric/governance/sessions/:sessionId/work-runs/:runId/transition"]!.POST!(apiRequest(`http://localhost/api/taric/governance/sessions/${sessionId}/work-runs/${run.runId}/transition`, { status: "completed" }, { sessionId, runId: run.runId }))
        expect(transition.status).toBe(200)
        expect(transitions).toBe(1)
    })

    test("persists the local artifact key with owner-only file permissions", async () => {
        const root = await mkdtemp(join(tmpdir(), "taric-governance-key-"))
        const sessionId = "00000000-0000-4000-8000-000000000099"
        try {
            const firstKey = await loadLocalGovernanceArtifactKey(root, sessionId)
            const secondKey = await loadLocalGovernanceArtifactKey(root, sessionId)
            const keyFile = await stat(join(root, "taric", "governance-keys", `${sessionId}.key`))
            expect(firstKey).toEqual(secondKey)
            expect(firstKey.byteLength).toBe(32)
            expect(keyFile.mode & 0o777).toBe(0o600)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
