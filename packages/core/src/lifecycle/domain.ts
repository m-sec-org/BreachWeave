import { Type, type Static } from "typebox"

const Id = Type.String({ minLength: 1 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const Revision = Type.Integer({ minimum: 0 })
const PositiveRevision = Type.Integer({ minimum: 1 })
const DateTime = Type.String({ format: "date-time" })
const IdList = Type.Array(Id)
const Ref = Type.Object({ id: Id, revision: Revision, contentHash: Digest }, { additionalProperties: false })
const Enum = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] })
const Watermarks = Type.Object({
    authorityReadSeq: Revision,
    executionReadSeq: Revision,
    artifactCatalogWatermark: Revision,
    artifactIndexWatermark: Revision,
    historyWatermark: Revision,
}, { additionalProperties: false })

export const SOLVER_RUN_STATES = ["starting", "running", "finalizing", "stopping", "stopped", "force_stopped", "crashed"] as const
export type SolverRunState = typeof SOLVER_RUN_STATES[number]
export const ASSIGNMENT_STATES = ["assigned", "executing", "report_submitted", "authority_commit_pending", "report_ingest_gap", "awaiting_evidence", "awaiting_audit", "audit_running", "audit_retryable", "awaiting_planner", "continuing", "verified_complete", "verified_blocked", "blocked_handoff", "deadline_expired", "cancelled", "manual_review"] as const
export type AssignmentState = typeof ASSIGNMENT_STATES[number]
export const REVIEW_JOB_STATES = ["queued", "leased", "running", "ready", "retryable", "audit_retryable", "failed", "manual_review", "stale"] as const
export type ReviewJobState = typeof REVIEW_JOB_STATES[number]
export const FINALIZATION_STATES = ["open", "sealing_requested", "execution_sealed", "source_set_frozen", "aggregating", "draft_ready", "qa_running", "ready_to_publish", "published", "retryable", "blocked", "manual_review", "stale", "reopened"] as const
export type FinalizationState = typeof FINALIZATION_STATES[number]

export const AssignmentSchema = Type.Object({
    assignmentId: Id,
    challengeId: Id,
    taskSnapshotHash: Digest,
    lineageId: Id,
    phase: Enum(ASSIGNMENT_STATES),
    revision: PositiveRevision,
    scopeRevision: PositiveRevision,
    managerEpoch: PositiveRevision,
    activeRunId: Type.Optional(Id),
    currentReportVersion: Revision,
    deadlineAt: Type.Optional(DateTime),
    createdAt: DateTime,
    updatedAt: DateTime,
}, { additionalProperties: false })
export type Assignment = Static<typeof AssignmentSchema>

export const SolverRunSchema = Type.Object({
    runId: Id,
    assignmentId: Id,
    generation: PositiveRevision,
    status: Enum(SOLVER_RUN_STATES),
    revision: PositiveRevision,
    managerEpoch: PositiveRevision,
    scopeRevision: PositiveRevision,
    leaseToken: Id,
    leaseExpiresAt: DateTime,
    runtimeId: Id,
    startedAt: DateTime,
    stoppedAt: Type.Optional(DateTime),
    stopReason: Type.Optional(Id),
}, { additionalProperties: false })
export type SolverRun = Static<typeof SolverRunSchema>

export const ReportRevisionSchema = Type.Object({
    reportId: Id,
    assignmentId: Id,
    runId: Id,
    generation: PositiveRevision,
    reportVersion: PositiveRevision,
    submissionKind: Type.Union([Type.Literal("incremental"), Type.Literal("final")]),
    payloadHash: Digest,
    taskSnapshotHash: Digest,
    scopeRevision: PositiveRevision,
    managerEpoch: PositiveRevision,
    operationKey: Id,
    evidenceSnapshotHash: Type.Optional(Digest),
    createdAt: DateTime,
}, { additionalProperties: false })
export type ReportRevision = Static<typeof ReportRevisionSchema>

export const ReviewJobSchema = Type.Object({
    reviewJobId: Id,
    assignmentId: Id,
    reportId: Id,
    reportVersion: PositiveRevision,
    generation: PositiveRevision,
    status: Enum(REVIEW_JOB_STATES),
    attempt: Revision,
    managerEpoch: PositiveRevision,
    scopeRevision: PositiveRevision,
    evidenceSnapshotHash: Type.Optional(Digest),
    leaseOwner: Type.Optional(Id),
    leaseExpiresAt: Type.Optional(DateTime),
    createdAt: DateTime,
}, { additionalProperties: false })
export type ReviewJob = Static<typeof ReviewJobSchema>

export const PlannerDecisionSchema = Type.Object({
    decisionId: Id,
    assignmentId: Id,
    reviewJobId: Id,
    reportVersion: PositiveRevision,
    assignmentRevision: PositiveRevision,
    generation: PositiveRevision,
    managerEpoch: PositiveRevision,
    scopeRevision: PositiveRevision,
    action: Type.Union([Type.Literal("continue"), Type.Literal("stop"), Type.Literal("retry_review"), Type.Literal("manual_review")]),
    operationKey: Id,
    rationaleRef: Type.Optional(Ref),
    createdAt: DateTime,
    appliedAt: Type.Optional(DateTime),
}, { additionalProperties: false })
export type PlannerDecision = Static<typeof PlannerDecisionSchema>

export const RUNTIME_EFFECT_STATUSES = ["requested", "applying", "applied", "failed", "unknown"] as const
export type RuntimeEffectStatus = typeof RUNTIME_EFFECT_STATUSES[number]
export const RuntimeEffectSchema = Type.Object({
    effectId: Id,
    assignmentId: Id,
    runId: Id,
    generation: PositiveRevision,
    managerEpoch: PositiveRevision,
    scopeRevision: PositiveRevision,
    leaseToken: Id,
    kind: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("force_stop"), Type.Literal("close_asset"), Type.Literal("close_challenge"), Type.Literal("reopen"), Type.Literal("publish")]),
    status: Enum(RUNTIME_EFFECT_STATUSES),
    requestRevision: PositiveRevision,
    idempotencyKey: Id,
    createdAt: DateTime,
    appliedAt: Type.Optional(DateTime),
    errorCode: Type.Optional(Id),
}, { additionalProperties: false })
export type RuntimeEffect = Static<typeof RuntimeEffectSchema>

export const SOURCE_MANIFEST_INCLUSIONS = ["included", "superseded", "excluded", "unresolved"] as const
export const SourceManifestSchema = Type.Object({
    sourceManifestId: Id,
    challengeId: Id,
    finalizationGeneration: PositiveRevision,
    scopeRevision: PositiveRevision,
    taskManifestRevision: PositiveRevision,
    revision: PositiveRevision,
    entries: Type.Array(Type.Object({
        sourceId: Id,
        sourceKind: Type.Union([Type.Literal("assignment"), Type.Literal("run"), Type.Literal("report"), Type.Literal("review"), Type.Literal("evidence"), Type.Literal("admission"), Type.Literal("claim")]),
        sourceRevision: PositiveRevision,
        contentHash: Digest,
        inclusion: Enum(SOURCE_MANIFEST_INCLUSIONS),
        reason: Id,
        evidenceRefs: IdList,
    }, { additionalProperties: false })),
    watermarks: Watermarks,
    contentHash: Digest,
    createdAt: DateTime,
}, { additionalProperties: false })
export type SourceManifest = Static<typeof SourceManifestSchema>

export const FrozenReviewPackSchema = Type.Object({
    reviewPackId: Id,
    assignmentId: Id,
    runId: Id,
    reportId: Id,
    reportVersion: PositiveRevision,
    generation: PositiveRevision,
    evidenceSnapshotHash: Digest,
    sourceManifestHash: Digest,
    historyWatermark: Revision,
    artifactRefs: IdList,
    redactionPolicyDigest: Digest,
    contentManifestHash: Digest,
    reviewerPrincipalBinding: Id,
    status: Type.Union([Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("stale"), Type.Literal("blocked")]),
}, { additionalProperties: false })
export type FrozenReviewPack = Static<typeof FrozenReviewPackSchema>

export const BoardRevisionSchema = Type.Object({
    boardScopeId: Id,
    visibilityScope: Type.Union([Type.Literal("assignment_private"), Type.Literal("challenge_shared")]),
    finalizationGeneration: PositiveRevision,
    revision: PositiveRevision,
    baseRevision: Revision,
    assignmentRevision: Type.Optional(PositiveRevision),
    sourceWatermark: Revision,
    sourceRefs: IdList,
    items: Type.Array(Type.Unknown()),
    pinnedConstraintRefs: IdList,
    supersessionMap: Type.Array(Type.Object({ fromId: Id, toId: Id }, { additionalProperties: false })),
    tokenCount: Revision,
    budgetPolicyVersion: PositiveRevision,
    freshness: Type.Union([Type.Literal("current"), Type.Literal("stale"), Type.Literal("gap")]),
    createdAt: DateTime,
}, { additionalProperties: false })
export type BoardRevision = Static<typeof BoardRevisionSchema>

export const ContextRevisionSchema = Type.Object({
    sessionId: Id,
    branchId: Id,
    revision: PositiveRevision,
    parentRevision: Type.Optional(PositiveRevision),
    resourceManifestHash: Digest,
    canonicalSourceManifestHash: Digest,
    summaryRefs: IdList,
    retainedEventRefs: IdList,
    pinnedConstraintRefs: IdList,
    historyWatermark: Revision,
    omissions: Type.Array(Type.Object({ sourceRef: Id, disposition: Type.Union([Type.Literal("omitted"), Type.Literal("redacted"), Type.Literal("not_archived"), Type.Literal("deleted"), Type.Literal("unavailable"), Type.Literal("corrupt")]) }, { additionalProperties: false })),
    contextDigest: Digest,
}, { additionalProperties: false })
export type ContextRevision = Static<typeof ContextRevisionSchema>

export const ToolEffectSchema = Type.Object({
    effectId: Id,
    toolCallId: Id,
    parentEffectId: Type.Optional(Id),
    runId: Id,
    runGeneration: PositiveRevision,
    managerEpoch: PositiveRevision,
    leaseFencingToken: Id,
    scopeRevision: PositiveRevision,
    policyDigest: Digest,
    rawArgsRef: Id,
    normalizedArgsHash: Digest,
    resourceManifestHash: Digest,
    executionIdentity: Id,
    replayPolicy: Type.Union([Type.Literal("never_replay"), Type.Literal("idempotent_reconcile"), Type.Literal("read_only_reconcile")]),
    dispatchDisposition: Type.Union([Type.Literal("denied"), Type.Literal("admitted"), Type.Literal("in_flight")]),
    gateRevision: PositiveRevision,
    status: Type.Union([Type.Literal("intended"), Type.Literal("dispatched"), Type.Literal("result_pending"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("unknown")]),
    rawResultRefs: IdList,
    modelProjectionRef: Type.Optional(Id),
    receiptRef: Type.Optional(Id),
    errorCode: Type.Optional(Id),
    admittedAt: Type.Optional(DateTime),
}, { additionalProperties: false })
export type ToolEffect = Static<typeof ToolEffectSchema>

export const FinalizationSchema = Type.Object({
    finalizationId: Id,
    challengeId: Id,
    finalizationGeneration: PositiveRevision,
    status: Enum(FINALIZATION_STATES),
    revision: PositiveRevision,
    scopeRevision: PositiveRevision,
    taskManifestRevision: PositiveRevision,
    expectedEngagementRevision: PositiveRevision,
    watermarks: Watermarks,
    sourceManifestHash: Type.Optional(Digest),
    sourceWatermark: Revision,
    reportIrRevision: Type.Optional(PositiveRevision),
    qaRecordId: Type.Optional(Id),
    createdAt: DateTime,
    sealedAt: Type.Optional(DateTime),
    publishedAt: Type.Optional(DateTime),
}, { additionalProperties: false })
export type Finalization = Static<typeof FinalizationSchema>

export interface CompletionFacts {
    reportCoverageComplete: boolean
    runPhysicallyStopped: boolean
    assignmentAccepted: boolean
    engagementClosed: boolean
}

export const AppendReportPayloadSchema = Type.Object({
    reportId: Id,
    payloadHash: Digest,
    submissionKind: Type.Union([Type.Literal("incremental"), Type.Literal("final")]),
}, { additionalProperties: false })
export type AppendReportPayload = Static<typeof AppendReportPayloadSchema>
