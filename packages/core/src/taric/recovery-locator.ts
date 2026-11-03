import type { TaricHostBinding } from "./types"
import { assertBoundTaricIdentifiers, requireOpaqueHostId, requireTaricUuid } from "./host-identity"

/**
 * Contract source: Taric 1c466f4, schemas ContextManifest/Checkpoint and store.resumePacket.
 * The premise must be reconstructed from complete pinned authority queries. These
 * pure adapters do not establish query completeness, provision Scope, commit
 * a checkpoint, or launch a worker. Immutable ScopeRevision and policy digest
 * are required in the run, checkpoint, and locator.
 */
export interface RecoveryPremise {
    binding: TaricHostBinding
    challengeId: string
    assetId: string
    resourceId: string
    resourceRevisionId: string
    scopeId: string
    scopeVersion: number
    scopeRevisionId: string
    scopePolicyDigest: string
    workItemId: string
    workItemVersion: number
    targetVersion: number
}

export interface AuthorityRecoveryRun {
    runId: string
    workItemId: string
    attemptId: string
    engagementId: string
    generation: number
    owner: { host_id: string; agent_id: string }
    leaseExpiresAt: string
    taskSessionId: string
    scopeId: string
    scopeVersion: number
    scopeRevisionId: string
    scopePolicyDigest: string
    workItemVersion: number
    targetVersion: number
    targetResourceId: string
}

export interface AuthorityRecoveryLocator {
    format: "breachweave-recovery-locator/2"
    tenantId: string
    projectId: string
    challengeId: string
    assetId: string
    engagementId: string
    resourceId: string
    resourceRevisionId: string
    scopeId: string
    scopeVersion: number
    scopeRevisionId: string
    scopePolicyDigest: string
    workItemId: string
    workRunId: string
    attemptId: string
    generation: number
    taskSessionId: string
    piSessionId: string
}

/** Host builder provenance for the Core ctx_<hex> page, not a canonical UUID. */
export interface AuthorityCheckpointContextSource {
    snapshotId: string
    readSeq: number
    contentDigest: string
}

export class TaricRecoveryError extends Error {
    readonly code: "invalid_recovery" | "replan_required"

    constructor(message: string, code: "invalid_recovery" | "replan_required" = "invalid_recovery") {
        super(message)
        this.name = "TaricRecoveryError"
        this.code = code
    }
}

const LOCATOR_KEYS = ["format", "tenantId", "projectId", "challengeId", "assetId", "engagementId", "resourceId", "resourceRevisionId", "scopeId", "scopeVersion", "scopeRevisionId", "scopePolicyDigest", "workItemId", "workRunId", "attemptId", "generation", "taskSessionId", "piSessionId"] as const
const CHECKPOINT_KEYS = new Set(["work_item_ref", "work_run_ref", "attempt_ref", "generation", "target_version", "work_item_version", "scope_ref", "scope_version", "scope_revision_ref", "policy_digest", "owner", "lease_expires_at", "source_read_seq", "completed_steps", "next_steps", "observation_refs", "evidence_refs", "negative_results", "unresolved_work", "host_decision_refs", "external_action_state", "budget", "draft_refs", "handoff_refs", "action_refs", "tool_result_refs", "context_manifest", "task_session_ref", "checkpoint_id", "run_id", "base_read_seq", "id", "schema_version", "engagement_id", "created_at", "provenance", "kind"])
const PREMISE_CHECKS = ["engagement", "work_item", "scope", "scope_revision", "checkpoint", "attempt", "source_sequence", "lease", "context_manifest", "host_authorization_refs", "action_results"]
const SECRET_VALUE = /(?:Bearer\s+\S+|(?:password|secret|api[_-]?key|access[_-]?token|cookie|authorization)\s*[=:]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const SECRET_KEY = /(?:hidden[_-]?reasoning|chain[_-]?of[_-]?thought|password|credential|private[_-]?key|api[_-]?key|access[_-]?token|cookie|authorization)/i

function assertSafeCheckpointTree(value: unknown, depth = 0): void {
    if (depth > 8) throw new TaricRecoveryError("checkpoint nesting exceeds its bound")
    if (typeof value === "string" && SECRET_VALUE.test(value)) throw new TaricRecoveryError("checkpoint contains a sensitive value")
    if (Array.isArray(value)) {
        for (const item of value) assertSafeCheckpointTree(item, depth + 1)
    } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (SECRET_KEY.test(key)) throw new TaricRecoveryError("checkpoint contains a prohibited field")
            assertSafeCheckpointTree(item, depth + 1)
        }
    }
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricRecoveryError(`${field} must be an object`)
    return value as Record<string, unknown>
}

function integer(value: unknown, field: string, minimum = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TaricRecoveryError(`${field} must be a bounded integer`)
    return value
}

function strings(value: unknown, field: string, uuid = false): string[] {
    if (!Array.isArray(value) || value.length > 256) throw new TaricRecoveryError(`${field} must be a bounded array`)
    return value.map((item) => {
        if (typeof item !== "string" || item.length > 2048 || SECRET_VALUE.test(item)) throw new TaricRecoveryError(`${field} contains an invalid or sensitive value`)
        return uuid ? requireTaricUuid(item, field) : item
    })
}

function assertPremise(premise: RecoveryPremise): void {
    for (const field of ["resourceId", "resourceRevisionId", "scopeId", "scopeRevisionId", "workItemId"] as const) requireTaricUuid(premise[field], field)
    requireTaricUuid(premise.binding.engagementId, "engagementId")
    for (const field of ["projectId", "tenantId", "hostPrincipalId"] as const) requireOpaqueHostId(premise.binding[field], field)
    requireOpaqueHostId(premise.challengeId, "challengeId")
    requireOpaqueHostId(premise.assetId, "assetId")
    if (!/^sha256:[a-f0-9]{64}$/.test(premise.scopePolicyDigest)) throw new TaricRecoveryError("Scope policy digest is invalid")
    integer(premise.scopeVersion, "scopeVersion", 1)
    integer(premise.workItemVersion, "workItemVersion", 1)
    integer(premise.targetVersion, "targetVersion")
}

function assertParsedRecoveryRun(run: AuthorityRecoveryRun, premise: RecoveryPremise): void {
    if (!run || typeof run !== "object" || Array.isArray(run)) throw new TaricRecoveryError("authority WorkRun must be an object")
    if (!run.owner || typeof run.owner !== "object" || Array.isArray(run.owner)) throw new TaricRecoveryError("authority WorkRun owner must be an object")
    requireTaricUuid(run.runId, "run_id")
    requireTaricUuid(run.workItemId, "work_item_id")
    requireTaricUuid(run.attemptId, "attempt_ref")
    requireTaricUuid(run.engagementId, "engagement_id")
    integer(run.generation, "generation", 1)
    requireOpaqueHostId(run.owner.host_id, "host_id")
    requireOpaqueHostId(run.owner.agent_id, "agent_id")
    requireOpaqueHostId(run.taskSessionId, "task_session_ref")
    requireTaricUuid(run.scopeId, "scope_ref")
    requireTaricUuid(run.scopeRevisionId, "scope_revision_ref")
    if (!/^sha256:[a-f0-9]{64}$/.test(run.scopePolicyDigest)) throw new TaricRecoveryError("Scope policy digest is invalid")
    integer(run.scopeVersion, "scope_version", 1)
    integer(run.workItemVersion, "work_item_version", 1)
    integer(run.targetVersion, "target_version")
    if (!Number.isFinite(Date.parse(run.leaseExpiresAt))) throw new TaricRecoveryError("lease_expires_at must be a timestamp")
    assertBoundTaricIdentifiers({ engagementId: premise.binding.engagementId, workItemId: premise.workItemId, scopeId: premise.scopeId, hostId: premise.binding.hostPrincipalId }, { engagementId: run.engagementId, workItemId: run.workItemId, scopeId: run.scopeId, hostId: run.owner.host_id })
    if (run.scopeRevisionId !== premise.scopeRevisionId || run.scopePolicyDigest !== premise.scopePolicyDigest || run.scopeVersion !== premise.scopeVersion || run.workItemVersion !== premise.workItemVersion || run.targetVersion !== premise.targetVersion) throw new TaricRecoveryError("canonical recovery versions changed", "replan_required")
}

export function parseAuthorityRecoveryRun(value: unknown, premise: RecoveryPremise): AuthorityRecoveryRun {
    assertPremise(premise)
    const run = record(value, "run")
    const owner = record(run.owner, "owner")
    if (!["claimed", "running", "checkpointed", "blocked"].includes(String(run.status))) throw new TaricRecoveryError("authority WorkRun is not active", "replan_required")
    const result: AuthorityRecoveryRun = {
        runId: requireTaricUuid(run.run_id, "run_id"),
        workItemId: requireTaricUuid(run.work_item_id, "work_item_id"),
        attemptId: requireTaricUuid(run.attempt_ref, "attempt_ref"),
        engagementId: requireTaricUuid(run.engagement_id, "engagement_id"),
        generation: integer(run.generation, "generation", 1),
        owner: { host_id: requireOpaqueHostId(owner.host_id, "host_id"), agent_id: requireOpaqueHostId(owner.agent_id, "agent_id") },
        leaseExpiresAt: typeof run.lease_expires_at === "string" ? run.lease_expires_at : "",
        taskSessionId: requireOpaqueHostId(run.task_session_ref, "task_session_ref"),
        scopeId: requireTaricUuid(run.scope_ref, "scope_ref"),
        scopeVersion: integer(run.scope_version, "scope_version", 1),
        scopeRevisionId: requireTaricUuid(run.scope_revision_ref, "scope_revision_ref"),
        scopePolicyDigest: typeof run.policy_digest === "string" ? run.policy_digest : "",
        workItemVersion: integer(run.work_item_version, "work_item_version", 1),
        targetVersion: integer(run.target_version, "target_version"),
        targetResourceId: premise.resourceId,
    }
    assertParsedRecoveryRun(result, premise)
    return result
}

function locatorFor(premise: RecoveryPremise, run: AuthorityRecoveryRun, piSessionId: string): AuthorityRecoveryLocator {
    return { format: "breachweave-recovery-locator/2", tenantId: premise.binding.tenantId, projectId: premise.binding.projectId, challengeId: premise.challengeId, assetId: premise.assetId, engagementId: run.engagementId, resourceId: premise.resourceId, resourceRevisionId: premise.resourceRevisionId, scopeId: run.scopeId, scopeVersion: run.scopeVersion, scopeRevisionId: run.scopeRevisionId, scopePolicyDigest: run.scopePolicyDigest, workItemId: run.workItemId, workRunId: run.runId, attemptId: run.attemptId, generation: run.generation, taskSessionId: run.taskSessionId, piSessionId: requireOpaqueHostId(piSessionId, "piSessionId") }
}

/**
 * Parse a locator returned inside an authority checkpoint.
 *
 * The locator is metadata for joining authority records. It does not resolve
 * or provision any Taric object, and a successful parse is not a persistence
 * or resume attestation.
 */
export function parseAuthorityRecoveryLocator(value: unknown, premise: RecoveryPremise, run: AuthorityRecoveryRun): AuthorityRecoveryLocator {
    assertPremise(premise)
    assertParsedRecoveryRun(run, premise)
    const locator = record(value, "recovery locator")
    if (Object.keys(locator).length !== LOCATOR_KEYS.length || Object.keys(locator).some((key) => !LOCATOR_KEYS.includes(key as typeof LOCATOR_KEYS[number]))) throw new TaricRecoveryError("recovery locator contains unsupported or missing fields")
    if (locator.format !== "breachweave-recovery-locator/2") throw new TaricRecoveryError("recovery locator format is invalid")
    const expected = locatorFor(premise, run, requireOpaqueHostId(locator.piSessionId, "piSessionId"))
    if (LOCATOR_KEYS.some((key) => locator[key] !== expected[key])) throw new TaricRecoveryError("recovery locator does not match authority provenance", "replan_required")
    return expected
}

/**
 * The locator becomes durable only after a successful real checkpoint.commit;
 * constructing this payload is not a persistence or authority attestation.
 * The namespace fits Taric's existing ContextManifest.adapter_manifest extension.
 */
export function createAuthorityRecoveryCheckpoint(input: {
    premise: RecoveryPremise
    authorityRun: unknown
    piSessionId: string
    contextSnapshotId: string
    sourceReadSeq: number
    builderVersion: string
    sourceContext?: AuthorityCheckpointContextSource
    completedSteps: readonly string[]
    nextSteps: readonly string[]
    observationRefs: readonly string[]
    evidenceRefs: readonly string[]
    unresolvedWork: readonly string[]
}): Record<string, unknown> {
    const run = parseAuthorityRecoveryRun(input.authorityRun, input.premise)
    const readSeq = integer(input.sourceReadSeq, "sourceReadSeq")
    const sourceContext = input.sourceContext === undefined ? undefined : checkpointContextSource(input.sourceContext, readSeq)
    return {
        work_item_ref: run.workItemId, work_run_ref: run.runId, attempt_ref: run.attemptId, generation: run.generation,
        target_version: run.targetVersion, work_item_version: run.workItemVersion, scope_ref: run.scopeId, scope_version: run.scopeVersion, scope_revision_ref: run.scopeRevisionId, policy_digest: run.scopePolicyDigest,
        owner: run.owner, lease_expires_at: run.leaseExpiresAt, source_read_seq: readSeq,
        completed_steps: strings(input.completedSteps, "completed_steps"), next_steps: strings(input.nextSteps, "next_steps"),
        observation_refs: strings(input.observationRefs, "observation_refs", true), evidence_refs: strings(input.evidenceRefs, "evidence_refs", true),
        unresolved_work: strings(input.unresolvedWork, "unresolved_work"), negative_results: [], host_decision_refs: [],
        external_action_state: "none", budget: {}, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [],
        context_manifest: { context_snapshot_id: requireTaricUuid(input.contextSnapshotId, "contextSnapshotId"), read_seq: readSeq, builder_version: requireOpaqueHostId(input.builderVersion, "builderVersion"), adapter_manifest: { breachweave_recovery: locatorFor(input.premise, run, input.piSessionId), ...(sourceContext ? { breachweave_context: sourceContext } : {}) } },
    }
}

function checkpointContextSource(source: AuthorityCheckpointContextSource, readSeq: number): Record<string, unknown> {
    const snapshotId = requireOpaqueHostId(source.snapshotId, "source context snapshotId")
    if (integer(source.readSeq, "source context readSeq") !== readSeq || !/^sha256:[a-f0-9]{64}$/.test(source.contentDigest)) throw new TaricRecoveryError("source Context provenance does not match the checkpoint watermark", "replan_required")
    return { format: "breachweave-context-source/1", snapshot_id: snapshotId, read_seq: readSeq, content_digest: source.contentDigest }
}

/** Validate the actual Taric 1.0.4 resume packet; no local snapshot can grant resume. */
export function validateAuthorityRecoveryPacket(value: unknown, premise: RecoveryPremise, now = Date.now(), allowExpiredLease = false): { run: AuthorityRecoveryRun; locator: AuthorityRecoveryLocator; checkpoint: Record<string, unknown>; readSeq: number } {
    let packet = record(value, "resume packet")
    if (packet.ok === false) throw new TaricRecoveryError("authority rejected recovery", "replan_required")
    if (packet.ok === true) packet = record(packet.data, "resume data")
    if (!packet.premise_checks || !packet.run || !packet.checkpoint) throw new TaricRecoveryError("authority run, checkpoint or premises are incomplete", "replan_required")
    const checks = record(packet.premise_checks, "premise_checks")
    const run = parseAuthorityRecoveryRun(packet.run, premise)
    const leaseExpired = Date.parse(run.leaseExpiresAt) <= now
    const expiredLeaseReclaim = allowExpiredLease && leaseExpired && packet.blocked === true && packet.replan_required === true && packet.resume_advice === "replan_required" && checks.lease === false && PREMISE_CHECKS.filter((field) => field !== "lease").every((field) => checks[field] === true)
    if ((!expiredLeaseReclaim && (packet.blocked !== false || packet.replan_required !== false || packet.resume_advice !== "resume_allowed" || PREMISE_CHECKS.some((field) => checks[field] !== true))) || (expiredLeaseReclaim && PREMISE_CHECKS.filter((field) => field !== "lease").some((field) => checks[field] !== true))) throw new TaricRecoveryError("authority requires replanning", "replan_required")
    if (!Array.isArray(packet.pending_actions) || packet.pending_actions.length !== 0) throw new TaricRecoveryError("pending actions require reconciliation", "replan_required")
    if (leaseExpired && !expiredLeaseReclaim) throw new TaricRecoveryError("recovery lease is expired", "replan_required")
    const checkpoint = record(packet.checkpoint, "checkpoint")
    if (new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength > 64 * 1024 || Object.keys(checkpoint).some((key) => !CHECKPOINT_KEYS.has(key))) throw new TaricRecoveryError("checkpoint contains unsupported fields or exceeds its size bound")
    assertSafeCheckpointTree(checkpoint)
    if (checkpoint.task_session_ref !== undefined && checkpoint.task_session_ref !== run.taskSessionId) throw new TaricRecoveryError("checkpoint task session is stale", "replan_required")
    if (checkpoint.engagement_id !== undefined && checkpoint.engagement_id !== run.engagementId) throw new TaricRecoveryError("checkpoint Engagement is stale", "replan_required")
    if (checkpoint.run_id !== undefined && checkpoint.run_id !== run.runId) throw new TaricRecoveryError("checkpoint run is stale", "replan_required")
    for (const field of ["id", "checkpoint_id"] as const) if (checkpoint[field] !== undefined) requireTaricUuid(checkpoint[field], field)
    if (checkpoint.kind !== undefined && checkpoint.kind !== "checkpoint") throw new TaricRecoveryError("checkpoint kind is invalid")
    if (checkpoint.schema_version !== undefined && checkpoint.schema_version !== "1.0.0") throw new TaricRecoveryError("checkpoint schema version is invalid")
    if (checkpoint.provenance !== undefined) {
        const provenance = record(checkpoint.provenance, "provenance")
        if (Object.keys(provenance).some((key) => !["host_id", "producer_id", "source_kind"].includes(key)) || provenance.host_id !== run.owner.host_id || provenance.producer_id !== run.owner.agent_id || provenance.source_kind !== "host") throw new TaricRecoveryError("checkpoint provenance is invalid")
    }
    const owner = record(checkpoint.owner, "checkpoint owner")
    const context = record(checkpoint.context_manifest, "context_manifest")
    if (Object.keys(context).some((key) => !["context_snapshot_id", "read_seq", "builder_version", "adapter_manifest"].includes(key))) throw new TaricRecoveryError("checkpoint context contains unsupported fields")
    requireTaricUuid(context.context_snapshot_id, "context_snapshot_id")
    requireOpaqueHostId(context.builder_version, "builder_version")
    const adapterManifest = record(context.adapter_manifest, "adapter_manifest")
    if (Object.keys(adapterManifest).some((key) => !["breachweave_recovery", "breachweave_context"].includes(key))) throw new TaricRecoveryError("checkpoint adapter manifest contains unsupported fields")
    if (adapterManifest.breachweave_context !== undefined) {
        const source = record(adapterManifest.breachweave_context, "source Context")
        if (Object.keys(source).length !== 4 || Object.keys(source).some((key) => !["format", "snapshot_id", "read_seq", "content_digest"].includes(key)) || source.format !== "breachweave-context-source/1" || typeof source.content_digest !== "string") throw new TaricRecoveryError("checkpoint source Context contains unsupported fields")
        checkpointContextSource({ snapshotId: requireOpaqueHostId(source.snapshot_id, "source Context snapshot_id"), readSeq: integer(source.read_seq, "source Context read_seq"), contentDigest: source.content_digest }, integer(checkpoint.source_read_seq, "source_read_seq"))
    }
    const expectedLocator = parseAuthorityRecoveryLocator(adapterManifest.breachweave_recovery, premise, run)
    const binding = { work_item_ref: run.workItemId, work_run_ref: run.runId, attempt_ref: run.attemptId, generation: run.generation, target_version: run.targetVersion, work_item_version: run.workItemVersion, scope_ref: run.scopeId, scope_version: run.scopeVersion, scope_revision_ref: run.scopeRevisionId, policy_digest: run.scopePolicyDigest }
    if (Object.entries(binding).some(([key, expected]) => checkpoint[key] !== expected) || owner.host_id !== run.owner.host_id || owner.agent_id !== run.owner.agent_id || Object.keys(owner).some((key) => !["host_id", "agent_id"].includes(key))) throw new TaricRecoveryError("checkpoint does not match the active authority generation", "replan_required")
    // A legitimate renew can lengthen OR shorten the WorkRun/Attempt lease
    // without rewriting this historical attestation. Only the current active
    // same-generation authority lease grants resume; checkpoint expiry does not.
    const checkpointLease = typeof checkpoint.lease_expires_at === "string" ? Date.parse(checkpoint.lease_expires_at) : Number.NaN
    if (!Number.isFinite(checkpointLease)) throw new TaricRecoveryError("checkpoint historical lease is invalid", "replan_required")
    const readSeq = integer(packet.current_read_seq, "current_read_seq")
    const checkpointReadSeq = integer(checkpoint.source_read_seq, "source_read_seq")
    if (packet.checkpoint_read_seq !== checkpointReadSeq || context.read_seq !== checkpointReadSeq || checkpointReadSeq > readSeq || packet.task_session_ref !== run.taskSessionId) throw new TaricRecoveryError("checkpoint cursor or session binding is incomplete", "replan_required")
    for (const field of ["completed_steps", "next_steps", "negative_results", "unresolved_work", "host_decision_refs", "tool_result_refs"]) strings(checkpoint[field], field)
    for (const field of ["observation_refs", "evidence_refs", "draft_refs", "handoff_refs", "action_refs"]) strings(checkpoint[field], field, true)
    if (!["none", "executed", "failed", "blocked"].includes(String(checkpoint.external_action_state))) throw new TaricRecoveryError("checkpoint external action state requires reconciliation", "replan_required")
    const budget = record(checkpoint.budget, "budget")
    for (const [key, amount] of Object.entries(budget)) {
        if (!["actions", "tokens", "characters", "duration_seconds"].includes(key)) throw new TaricRecoveryError("checkpoint budget contains unsupported fields")
        integer(amount, "budget")
    }
    return { run, locator: expectedLocator, checkpoint, readSeq }
}
