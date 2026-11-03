import type { TaricHostModule } from "./host-module"
import { TaricOperationError } from "./types"

/** Host-mediated L1 admission. Reviewer-only operations are deliberately absent. */
export class TaricAuthorityAdmissionService {
    constructor(private readonly host: Pick<TaricHostModule, "invokeHost" | "getBinding">, private readonly policyDigest: string) {
        if (!policyDigest.trim()) throw new TaricOperationError("validation_error", "policyDigest is required")
    }

    async commitL1(input: { proposalId: string; expectedVersion?: number; evidenceSnapshotHash?: string; idempotencyKey?: string }): Promise<unknown> {
        if (!input.proposalId.trim() || input.proposalId.length > 256) throw new TaricOperationError("validation_error", "proposalId is invalid")
        const expectedVersion = input.expectedVersion ?? 0
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TaricOperationError("validation_error", "expectedVersion must be non-negative")
        if (input.evidenceSnapshotHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.evidenceSnapshotHash)) throw new TaricOperationError("validation_error", "evidenceSnapshotHash must be SHA-256")
        return this.host.invokeHost("admission.commit", {
            proposal_id: input.proposalId,
            expected_version: expectedVersion,
            policy_digest: this.policyDigest,
            ...(input.evidenceSnapshotHash ? { evidence_snapshot_hash: input.evidenceSnapshotHash } : {}),
            idempotency_key: input.idempotencyKey ?? `bw:l1-admission:${input.proposalId}`,
        })
    }

    async reviewPack(proposalId: string): Promise<unknown> {
        if (!proposalId.trim() || proposalId.length > 256) throw new TaricOperationError("validation_error", "proposalId is invalid")
        return this.host.invokeHost("review.pack", { proposal_id: proposalId })
    }
}
