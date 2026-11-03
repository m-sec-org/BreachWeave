import { TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, getTaricOperationContract, validateTaricArtifactManifest } from "./compatibility"
import { TARIC_OPERATION_REGISTRY_DIGEST } from "./operation-registry"

export type TaricCanonicalFact = "scope_roe_revision" | "resource_revision" | "action_intent" | "action_decision_result_reconcile" | "action_audit_query" | "checkpoint" | "evidence" | "report_artifact" | "report_snapshot" | "close_decision"

export interface TaricCanonicalMapping {
    fact: TaricCanonicalFact
    status: "mapped" | "partial" | "unsupported"
    operations: readonly string[]
    recordKinds: readonly string[]
    sourceReferences: readonly string[]
    limitation?: string
}

/** Reviewed against the locked source, not inferred from similarly named operations. */
export const TARIC_CANONICAL_MAPPINGS: readonly TaricCanonicalMapping[] = [
    {
        fact: "scope_roe_revision", status: "mapped",
        operations: ["engagement.init", "scope.revise", "scope.invalidate", "scope.query"], recordKinds: ["scope", "scope_revision", "scope_invalidation"],
        sourceReferences: ["packages/schemas/src/types.ts:Scope", "packages/core/src/validation.ts:proposalSubjectContracts", "packages/core/src/store.ts:initializeEngagement"],
        limitation: "Only an explicit operator can issue ScopeRevision approval; host configuration and historical Scope versions cannot grant this authority.",
    },
    {
        fact: "resource_revision", status: "mapped", operations: ["resource.revise", "resource.query"], recordKinds: ["resource", "resource_revision"],
        sourceReferences: ["packages/core/src/store.ts:createResourceRevision"],
    },
    {
        fact: "action_intent", status: "mapped", operations: ["action.recommend"], recordKinds: ["action_intent"],
        sourceReferences: ["packages/core/src/service.ts:actionRecommend", "packages/core/src/store.ts:recordActionIntent"],
        limitation: "Run-bound recommendations persist in action_intents; recommendations without a run remain proposals.",
    },
    {
        fact: "action_decision_result_reconcile", status: "mapped", operations: ["action.host-decision", "action.host-result", "action.reconcile"], recordKinds: ["action_intent"],
        sourceReferences: ["packages/core/src/store.ts:recordActionIntent", "packages/core/src/store.ts:reconcileAction"],
        limitation: "The registry declares these operations non-idempotent; durable references do not authorize automatic replay.",
    },
    {
        fact: "action_audit_query", status: "mapped", operations: ["action.audit.query"], recordKinds: ["action_intent", "action_event"],
        sourceReferences: ["packages/core/src/store.ts:pendingActionIntents", "packages/core/src/store.ts:recordsPage", "packages/core/src/store.ts:recordActionIntent"],
        limitation: "action.audit.query returns append-only ActionEvent history at a fixed authority sequence; pending WorkRun actions remain a separate current projection.",
    },
    {
        fact: "checkpoint", status: "mapped", operations: ["checkpoint.commit", "work.resume"], recordKinds: ["checkpoint"],
        sourceReferences: ["packages/core/src/store.ts:commitCheckpoint", "packages/core/src/store.ts:resumePacket"],
        limitation: "Checkpoint schema requires the active WorkItem/WorkRun/Attempt, owner, generation, scope_ref/scope_version and fixed context manifest; local checkpoint payloads are not equivalent.",
    },
    {
        fact: "evidence", status: "mapped", operations: ["proposal.submit", "review.pack", "review.submit", "admission.commit", "evidence.query"], recordKinds: ["evidence"],
        sourceReferences: ["packages/core/src/validation.ts:proposalSubjectContracts", "packages/schemas/src/registry.ts:operationContracts"],
        limitation: "capture.observation creates a candidate; an Artifact reference is not admitted Evidence. review.submit requires the reviewer role.",
    },
    {
        fact: "report_artifact", status: "mapped", operations: ["artifact.session.bind", "artifact.store.begin", "artifact.store.append", "artifact.store.commit", "artifact.metadata"], recordKinds: ["artifact"],
        sourceReferences: ["packages/core/src/artifact-content-store.ts"],
        limitation: "Committed report bytes do not by themselves create a canonical report snapshot or close decision.",
    },
    {
        fact: "report_snapshot", status: "mapped", operations: ["report.snapshot.commit", "resource.query"], recordKinds: ["report_snapshot"],
        sourceReferences: ["packages/core/src/validation.ts:proposalSubjectContracts", "packages/schemas/src/registry.ts:operationContracts"],
        limitation: "Report commit revalidates canonical Scope/Resource revisions, complete Coverage manifest/snapshot and report Artifact integrity at the authority watermark.",
    },
    {
        fact: "close_decision", status: "mapped", operations: ["engagement.close", "engagement.reopen", "resource.query"], recordKinds: ["close_decision"],
        sourceReferences: ["packages/core/src/validation.ts:proposalSubjectContracts", "packages/schemas/src/registry.ts:operationContracts"],
        limitation: "Close and reopen require an explicit operator; the transactional authority CAS checks current report, revisions and unfinished work/actions.",
    },
]

export interface TaricControlPlaneContractDiagnostic {
    format: "breachweave-taric-control-plane-contract/1"
    status: "available" | "blocked"
    sourceCommit: string
    contract: typeof TARIC_COMPATIBILITY_BASELINE
    policyDigest: string
    operationCount: 66
    operationRegistryDigest: string
    missingFacts: readonly TaricCanonicalFact[]
    mappings: readonly TaricCanonicalMapping[]
}

/** Pure preflight. It performs no authority calls, file writes or object creation. */
export function inspectTaricControlPlaneContract(): TaricControlPlaneContractDiagnostic {
    validateTaricArtifactManifest()
    for (const mapping of TARIC_CANONICAL_MAPPINGS) {
        for (const operation of mapping.operations) {
            if (!getTaricOperationContract(operation)) throw new Error("Canonical mapping references an operation absent from the locked Taric registry")
        }
    }
    return {
        format: "breachweave-taric-control-plane-contract/1",
        status: TARIC_CANONICAL_MAPPINGS.every((mapping) => mapping.status === "mapped") ? "available" : "blocked",
        sourceCommit: TARIC_COMPATIBILITY_BASELINE.sourceCommit,
        contract: { ...TARIC_COMPATIBILITY_BASELINE },
        policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
        operationCount: 66,
        operationRegistryDigest: TARIC_OPERATION_REGISTRY_DIGEST,
        missingFacts: TARIC_CANONICAL_MAPPINGS.filter((mapping) => mapping.status !== "mapped").map((mapping) => mapping.fact),
        mappings: TARIC_CANONICAL_MAPPINGS.map((mapping) => ({ ...mapping, operations: [...mapping.operations], recordKinds: [...mapping.recordKinds], sourceReferences: [...mapping.sourceReferences] })),
    }
}

export class TaricControlPlaneContractError extends Error {
    readonly code = "TARIC_CONTROL_PLANE_CONTRACT_BLOCKED"
    readonly diagnostic: TaricControlPlaneContractDiagnostic

    constructor(diagnostic: TaricControlPlaneContractDiagnostic) {
        super(`Taric control plane contract is blocked: ${diagnostic.missingFacts.join(", ")}`)
        this.name = "TaricControlPlaneContractError"
        this.diagnostic = diagnostic
    }
}

/** Must run before governed setup mutates authority or disposable host state. */
export function assertTaricControlPlaneContract(): void {
    const diagnostic = inspectTaricControlPlaneContract()
    if (diagnostic.status === "blocked") throw new TaricControlPlaneContractError(diagnostic)
}

