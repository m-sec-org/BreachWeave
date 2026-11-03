import type { TaricHostModule } from "./host-module"
import type { TaricAuthorityBoard, AuthorityBoardRecord } from "./authority-board"
import type { TaricAuthorityWorkService } from "./authority-work-service"
import { TaricAuthorityClaimError } from "./authority-work-service"
import type { RecoveryPremise } from "./recovery-locator"
import { parseAuthorityRecoveryRun } from "./recovery-locator"
import { assertTaricControlPlaneContract } from "./control-plane-contract"
import { requireOpaqueHostId, requireTaricUuid } from "./host-identity"
import { TaricOperationError, TaricUnavailableError } from "./types"

export interface HostWorkerReservation {
    reservationId: string
    projectId: string
    workItemId: string
    workRunId?: string
    generation?: number
    resourceCount: number
    exclusiveTargetCount: number
    state: "claiming" | "claimed" | "lease_lost" | "claim_indeterminate"
}

interface ReservedWorker {
    metadata: HostWorkerReservation
    resources: string[]
    targets: string[]
}

/**
 * One shared instance per executing host, injected into every project scheduler.
 * These process-local worker reservations are independent of authority leases:
 * lease expiry never proves that a local worker stopped and never frees a slot.
 */
export class TaricHostWorkerReservations {
    readonly hostId: string
    readonly maxWorkerSlots: number
    private readonly reserved = new Map<string, ReservedWorker>()

    constructor(input: { hostId: string; maxWorkerSlots: number }) {
        this.hostId = requireOpaqueHostId(input.hostId, "hostId")
        if (!Number.isSafeInteger(input.maxWorkerSlots) || input.maxWorkerSlots < 1 || input.maxWorkerSlots > 1024) throw new TaricOperationError("validation_error", "Host worker slots must be between 1 and 1024")
        this.maxWorkerSlots = input.maxWorkerSlots
    }

    acquire(input: { projectId: string; engagementId: string; workItemId: string; resourceIds: readonly string[]; targetKeys: readonly string[] }): string {
        if (this.reserved.size >= this.maxWorkerSlots) throw new TaricOperationError("worker_slots_full", "Host worker slots are occupied")
        const resources = [...new Set(input.resourceIds.map((id) => `${requireTaricUuid(input.engagementId, "engagementId")}:${requireTaricUuid(id, "resourceId")}`))]
        const targets = [...new Set(input.targetKeys.map((key) => requireOpaqueHostId(key, "exclusive target key")))]
        if (resources.length === 0 || targets.length === 0 || resources.length > 256 || targets.length > 256) throw new TaricOperationError("validation_error", "Host worker reservation must have bounded Resources and exclusive targets")
        for (const entry of this.reserved.values()) {
            if (entry.resources.some((key) => resources.includes(key))) throw new TaricOperationError("resource_reserved", "A host worker already reserves this Resource")
            if (entry.targets.some((key) => targets.includes(key))) throw new TaricOperationError("target_reserved", "A host worker already reserves this exclusive target")
        }
        const reservationId = Bun.randomUUIDv7()
        this.reserved.set(reservationId, { resources, targets, metadata: { reservationId, projectId: requireOpaqueHostId(input.projectId, "projectId"), workItemId: requireTaricUuid(input.workItemId, "workItemId"), resourceCount: resources.length, exclusiveTargetCount: targets.length, state: "claiming" } })
        return reservationId
    }

    bind(reservationId: string, workRunId: string, generation: number): void {
        const entry = this.get(reservationId)
        if (!Number.isSafeInteger(generation) || generation < 1) throw new TaricOperationError("validation_error", "Reservation generation is invalid")
        entry.metadata = { ...entry.metadata, workRunId: requireTaricUuid(workRunId, "workRunId"), generation, state: "claimed" }
    }

    mark(reservationId: string, state: "lease_lost" | "claim_indeterminate"): void { const entry = this.get(reservationId); entry.metadata = { ...entry.metadata, state } }

    releaseConfirmedRejectedClaim(reservationId: string): void { this.reserved.delete(reservationId) }

    releaseAfterWorkerStopped(reservationId: string): void {
        const entry = this.get(reservationId)
        if (entry.metadata.state === "claiming" || entry.metadata.state === "claim_indeterminate") throw new TaricOperationError("claim_reconcile_required", "An indeterminate claim must be reconciled before its reservations are released")
        this.reserved.delete(reservationId)
    }

    snapshot(projectId: string): { maxWorkerSlots: number; occupiedWorkerSlots: number; projectReservations: HostWorkerReservation[] } {
        return { maxWorkerSlots: this.maxWorkerSlots, occupiedWorkerSlots: this.reserved.size, projectReservations: [...this.reserved.values()].filter((entry) => entry.metadata.projectId === projectId).map((entry) => ({ ...entry.metadata })) }
    }

    private get(id: string): ReservedWorker {
        const entry = this.reserved.get(id)
        if (!entry) throw new TaricOperationError("reservation_not_found", "Host worker reservation is unavailable")
        return entry
    }
}

export interface AuthorityScheduleRequest {
    premise: RecoveryPremise
    agentId: string
    taskSessionId: string
    ttlMs?: number
}

export interface AuthoritySchedulerOptions {
    host: Pick<TaricHostModule, "getBinding">
    board: Pick<TaricAuthorityBoard, "refreshForScheduling" | "assertProjectPremise">
    work: Pick<TaricAuthorityWorkService, "claim" | "renew" | "transition">
    /** Share this pool across all project schedulers on the same executing host. */
    reservations: TaricHostWorkerReservations
    /** Trusted host mapping; request bodies never choose target reservation keys. */
    exclusiveTargetsFor: (premise: RecoveryPremise, item: AuthorityBoardRecord) => readonly string[]
    /** Trusted connection/lifecycle authorization; mandatory before scheduling. */
    assertAuthorization?: (request: AuthorityScheduleRequest) => void | Promise<void>
}

interface ScheduledWorker {
    premise: RecoveryPremise
    run: Record<string, unknown>
}

export class TaricAuthorityScheduler {
    private readonly workers = new Map<string, ScheduledWorker>()

    constructor(private readonly options: AuthoritySchedulerOptions) {
        if (options.reservations.hostId !== options.host.getBinding().hostPrincipalId) throw new TaricOperationError("authorization_error", "Worker reservations belong to another host")
    }

    async schedule(request: AuthorityScheduleRequest): Promise<{ reservationId: string; run: Record<string, unknown> }> {
        const binding = this.options.host.getBinding()
        if (Object.keys(binding).some((key) => binding[key as keyof typeof binding] !== request.premise.binding[key as keyof typeof binding])) throw new TaricOperationError("authorization_error", "Scheduling premise is outside the trusted project")
        requireOpaqueHostId(request.agentId, "agentId")
        requireOpaqueHostId(request.taskSessionId, "taskSessionId")
        assertTaricControlPlaneContract()
        if (!this.options.assertAuthorization) throw new TaricOperationError("governance_not_ready", "Scheduling requires a trusted host authorization policy")
        await this.options.assertAuthorization(request)
        const snapshot = await this.options.board.refreshForScheduling()
        this.options.board.assertProjectPremise(request.premise)
        if (snapshot.projectId !== binding.projectId || snapshot.engagementId !== binding.engagementId || snapshot.status !== "healthy" || !snapshot.freshnessAllowsScheduling) throw new TaricOperationError("authority_board_stale", "Scheduling requires a fresh project authority snapshot")
        const item = snapshot.records.work.find((entry) => entry.id === request.premise.workItemId)
        if (!item || item.version !== request.premise.workItemVersion || !["queued", "claimed", "in_progress", "checkpointed", "blocked"].includes(String(item.status))) throw new TaricOperationError("stale_version", "Scheduling WorkItem premise is stale or terminal")
        const reservationId = this.options.reservations.acquire({ projectId: binding.projectId, engagementId: binding.engagementId, workItemId: item.id, resourceIds: item.resourceIds ?? [], targetKeys: this.options.exclusiveTargetsFor(request.premise, item) })
        try {
            const run = await this.options.work.claim(request)
            const parsed = parseAuthorityRecoveryRun(run, request.premise)
            this.options.reservations.bind(reservationId, parsed.runId, parsed.generation)
            this.workers.set(reservationId, { premise: request.premise, run })
            return { reservationId, run: structuredClone(run) }
        } catch (error) {
            const confirmedNotClaimed = error instanceof TaricAuthorityClaimError && error.claimOutcome !== "indeterminate"
            if (confirmedNotClaimed || error instanceof TaricUnavailableError && error.dispatchState === "pre_dispatch") this.options.reservations.releaseConfirmedRejectedClaim(reservationId)
            else this.options.reservations.mark(reservationId, "claim_indeterminate")
            throw error
        }
    }

    async renew(reservationId: string, ttlMs?: number): Promise<Record<string, unknown>> {
        const worker = this.worker(reservationId)
        try {
            worker.run = await this.options.work.renew(worker.premise, worker.run, ttlMs)
            return structuredClone(worker.run)
        } catch (error) {
            this.options.reservations.mark(reservationId, "lease_lost")
            throw error
        }
    }

    async transition(reservationId: string, status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled", requestId: string): Promise<Record<string, unknown>> {
        const worker = this.worker(reservationId)
        worker.run = await this.options.work.transition(worker.premise, worker.run, status, requestId)
        return structuredClone(worker.run)
    }

    /** Trusted host lifecycle acknowledgement; lease expiry alone never calls this. */
    releaseAfterWorkerStopped(reservationId: string): void {
        this.worker(reservationId)
        this.options.reservations.releaseAfterWorkerStopped(reservationId)
        this.workers.delete(reservationId)
    }

    snapshot(): { format: "breachweave-authority-scheduler/1"; projectId: string; authorityLeaseReplacesHostReservations: false; maxWorkerSlots: number; occupiedWorkerSlots: number; projectReservations: HostWorkerReservation[] } {
        const projectId = this.options.host.getBinding().projectId
        return { format: "breachweave-authority-scheduler/1", projectId, authorityLeaseReplacesHostReservations: false, ...this.options.reservations.snapshot(projectId) }
    }

    private worker(reservationId: string): ScheduledWorker {
        const worker = this.workers.get(requireTaricUuid(reservationId, "reservationId"))
        if (!worker) throw new TaricOperationError("reservation_not_found", "Scheduled host worker is unavailable")
        return worker
    }
}
