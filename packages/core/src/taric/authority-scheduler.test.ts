import { describe, expect, test } from "bun:test"
import type { AuthorityBoardSnapshot } from "./authority-board"
import type { RecoveryPremise } from "./recovery-locator"
import { TaricAuthorityScheduler, TaricHostWorkerReservations } from "./authority-scheduler"
import { TaricAuthorityClaimError } from "./authority-work-service"
import { TaricOperationError, TaricUnavailableError } from "./types"

function uuid(number: number): string { return `019a0000-0000-7000-8000-${number.toString().padStart(12, "0")}` }

function fixture(input: { maxSlots?: number; gate?: boolean; sameResource?: boolean; claimError?: Error } = {}) {
    const binding = { projectId: "project-a", tenantId: "tenant", engagementId: uuid(1), hostPrincipalId: "host", modelPrincipalId: "model" }
    const first: RecoveryPremise = { binding, challengeId: "challenge", assetId: "asset-a", resourceId: uuid(2), resourceRevisionId: uuid(3), scopeId: uuid(4), scopeVersion: 1, scopeRevisionId: uuid(90), scopePolicyDigest: `sha256:${"a".repeat(64)}`, workItemId: uuid(5), workItemVersion: 1, targetVersion: 1 }
    const second: RecoveryPremise = { ...first, assetId: "asset-b", resourceId: input.sameResource ? first.resourceId : uuid(6), resourceRevisionId: input.sameResource ? first.resourceRevisionId : uuid(7), workItemId: uuid(8) }
    const reservations = new TaricHostWorkerReservations({ hostId: "host", maxWorkerSlots: input.maxSlots ?? 2 })
    const calls = { authorization: 0, refresh: 0, claim: 0, renew: 0 }
    const view: AuthorityBoardSnapshot = {
        format: "breachweave-authority-board/1", projectId: binding.projectId, engagementId: binding.engagementId, status: "healthy", revision: 1, readSeq: 10,
        connectionStale: false, freshnessAllowsScheduling: true, launchAuthorized: false, authorizationGate: "external_control_plane_contract_required", projectManifestBound: true,
        completeness: { recordVersions: "same_watermark", visibility: "current_recall_visible_projection", workTrust: "host_L1_and_L2", contextTrust: "model_L2_only", coverageGate: "not_read_or_inferred", entireEngagementReconstructed: false, budget: "aggregate_across_four_raw_query_surfaces" },
        records: { context: [], work: [first, second].map((premise) => ({ id: premise.workItemId, kind: "work_item", version: 1, status: "queued", resourceIds: [premise.resourceId] })), resources: [], revisions: [] },
    }
    const scheduler = new TaricAuthorityScheduler({
        host: { getBinding() { return { ...binding } } },
        board: { async refreshForScheduling() { calls.refresh += 1; return structuredClone(view) }, assertProjectPremise(premise) { if (![first.workItemId, second.workItemId].includes(premise.workItemId)) throw new TaricOperationError("authorization_error", "foreign WorkItem") } },
        work: {
            async claim(request) {
                calls.claim += 1
                if (input.claimError) throw input.claimError
                return { run_id: uuid(calls.claim + 20), attempt_ref: uuid(calls.claim + 40), work_item_id: request.premise.workItemId, engagement_id: binding.engagementId, generation: 1, status: "claimed", owner: { host_id: "host", agent_id: request.agentId }, task_session_ref: request.taskSessionId, scope_ref: first.scopeId, scope_version: 1, scope_revision_ref: uuid(90), policy_digest: `sha256:${"a".repeat(64)}`, work_item_version: 1, target_version: 1, lease_expires_at: "2099-01-01T00:00:00.000Z" }
            },
            async renew() { calls.renew += 1; throw new TaricOperationError("stale_version", "expired lease") },
            async transition(_premise, run, status) { return { ...run as Record<string, unknown>, status } },
        },
        reservations, exclusiveTargetsFor: () => ["shared-exclusive-target"],
        ...(input.gate ? {} : { async assertAuthorization() { calls.authorization += 1 } }),
    })
    return { scheduler, reservations, calls, first, second }
}

describe("authority scheduler host reservations", () => {
    test("missing host authorization blocks before any query, claim or slot reservation even with supported contracts", async () => {
        const { scheduler, calls, first } = fixture({ gate: true })
        await expect(scheduler.schedule({ premise: first, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ code: "governance_not_ready" })
        expect(calls.refresh).toBe(0)
        expect(calls.claim).toBe(0)
        expect(scheduler.snapshot().occupiedWorkerSlots).toBe(0)
    })

    test("concurrent different WorkItems sharing an exclusive target produce one local owner", async () => {
        const { scheduler, calls, first, second } = fixture()
        const results = await Promise.allSettled([first, second].map((premise) => scheduler.schedule({ premise, agentId: "worker", taskSessionId: "task-session" })))
        expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1)
        const rejected = results.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")!
        expect(rejected.reason.code).toBe("target_reserved")
        expect(calls.refresh).toBe(2)
        expect(calls.claim).toBe(1)
        expect(scheduler.snapshot().occupiedWorkerSlots).toBe(1)
    })

    test("worker slots and Resource reservations are enforced separately from authority ownership", async () => {
        const limited = fixture({ maxSlots: 1 })
        await limited.scheduler.schedule({ premise: limited.first, agentId: "worker", taskSessionId: "task-session" })
        await expect(limited.scheduler.schedule({ premise: limited.second, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ code: "worker_slots_full" })
        const resource = fixture({ sameResource: true })
        await resource.scheduler.schedule({ premise: resource.first, agentId: "worker", taskSessionId: "task-session" })
        await expect(resource.scheduler.schedule({ premise: resource.second, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ code: "resource_reserved" })
        expect(resource.calls.claim).toBe(1)
    })

    test("lease loss retains host capacity until the host acknowledges its worker stopped", async () => {
        const { scheduler, first } = fixture()
        const scheduled = await scheduler.schedule({ premise: first, agentId: "worker", taskSessionId: "task-session" })
        await expect(scheduler.renew(scheduled.reservationId)).rejects.toMatchObject({ code: "stale_version" })
        expect(scheduler.snapshot().occupiedWorkerSlots).toBe(1)
        expect(scheduler.snapshot().projectReservations[0]!.state).toBe("lease_lost")
        scheduler.releaseAfterWorkerStopped(scheduled.reservationId)
        expect(scheduler.snapshot().occupiedWorkerSlots).toBe(0)
    })

    test("confirmed rejected claims release reservations while indeterminate claims keep them", async () => {
        const confirmed = fixture({ claimError: new TaricAuthorityClaimError("rejected", "conflict", "already leased") })
        await expect(confirmed.scheduler.schedule({ premise: confirmed.first, agentId: "worker", taskSessionId: "task-session" })).rejects.toThrow()
        expect(confirmed.scheduler.snapshot().occupiedWorkerSlots).toBe(0)
        const unknown = fixture({ claimError: new TaricUnavailableError("reply lost", "taric_required", "after_dispatch") })
        await expect(unknown.scheduler.schedule({ premise: unknown.first, agentId: "worker", taskSessionId: "task-session" })).rejects.toThrow()
        expect(unknown.scheduler.snapshot().occupiedWorkerSlots).toBe(1)
        expect(unknown.scheduler.snapshot().projectReservations[0]!.state).toBe("claim_indeterminate")
        const malformed = fixture({ claimError: new TaricOperationError("validation_error", "successful dispatch returned invalid data") })
        await expect(malformed.scheduler.schedule({ premise: malformed.first, agentId: "worker", taskSessionId: "task-session" })).rejects.toThrow()
        expect(malformed.scheduler.snapshot().occupiedWorkerSlots).toBe(1)
        expect(malformed.scheduler.snapshot().projectReservations[0]!.state).toBe("claim_indeterminate")
    })

    test("foreign project and unlisted Work premises never reach authority claim", async () => {
        const { scheduler, first, calls } = fixture()
        await expect(scheduler.schedule({ premise: { ...first, binding: { ...first.binding, projectId: "project-b" } }, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ code: "authorization_error" })
        await expect(scheduler.schedule({ premise: { ...first, workItemId: uuid(99) }, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ code: "authorization_error" })
        expect(calls.claim).toBe(0)
    })
})
