import type { TaricHostModule } from "./host-module"
import { readGovernancePages } from "./governance-query-reader"
import { requireTaricUuid } from "./host-identity"
import { TaricOperationError } from "./types"

export interface AuthorityScopePolicy {
    allowed_targets: string[]
    excluded_targets: string[]
    protocols: Array<"http" | "https" | "tcp" | "udp">
    ports: Array<{ from: number; to: number }>
    methods: string[]
    dns: { require_pinned_addresses: boolean; reject_private_addresses: boolean; max_addresses: number }
    redirects: { max_hops: number; same_scope_only: boolean }
    valid_from: string
    valid_until: string
}

export interface CanonicalScopeLocator {
    tenantId: string
    projectId: string
    engagementId: string
    scopeId: string
    scopeVersion: number
    scopeRevisionId: string
    revision: number
    readSeq: number
    policyDigest: string
    policy: AuthorityScopePolicy
    roeArtifactRef: string
    roeArtifactVersion: number
    roeContentHash: string
    source: "canonical_scope_revision"
    roeBinding: "committed_integrity_verified_artifact"
}

export interface AuthorityScopeServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator">
}

export interface AuthorityScopeRevisionInput {
    scopeId: string
    expectedVersion: number
    policy: AuthorityScopePolicy
    roeArtifactRef: string
    roeArtifactVersion: number
    idempotencyKey: string
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Scope authority returned an invalid record")
    return value as Record<string, unknown>
}

function data(value: unknown): Record<string, unknown> {
    const envelope = record(value)
    if (envelope.ok === false) {
        const error = record(envelope.error)
        throw new TaricOperationError(String(error.code), String(error.message).slice(0, 256))
    }
    return envelope.ok === true ? record(envelope.data) : envelope
}

/** Scope setup strings never authorize work; only a current, effective immutable revision does. */
export class TaricAuthorityScopeService {
    constructor(private readonly options: AuthorityScopeServiceOptions) {}

    async history(scopeId: string, readSeq?: number) {
        requireTaricUuid(scopeId, "scopeId")
        const binding = this.options.host.getBinding()
        const result = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { scope_id: scopeId }, pageSize: 50, ...(readSeq === undefined ? {} : { readSeq }) }, limits: { maxPages: 32, maxRecords: 4096, maxBytes: 4 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("scope.query", request) })
        if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore) throw new TaricOperationError("incomplete_authority_snapshot", "Scope history is incomplete")
        return result
    }

    async resolve(input: { scopeId: string; scopeVersion?: number; scopeRevisionId?: string; policyDigest?: string }): Promise<CanonicalScopeLocator> {
        requireTaricUuid(input.scopeId, "scopeId")
        const binding = this.options.host.getBinding()
        const scopes = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind: "scope", include_candidates: true }, pageSize: 50 }, limits: { maxPages: 32, maxRecords: 4096, maxBytes: 4 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("resource.query", request) })
        if (scopes.diagnostics.status !== "complete" || scopes.diagnostics.hasMore) throw new TaricOperationError("incomplete_authority_snapshot", "Scope projection is incomplete")
        const matches = scopes.records.filter((entry) => entry.id === input.scopeId)
        if (matches.length !== 1) throw new TaricOperationError("scope_unresolved", "Canonical Scope is unavailable or ambiguous")
        const scope = matches[0]!
        this.assertCanonical(scope, "scope")
        if (input.scopeVersion !== undefined && scope.version !== input.scopeVersion) throw new TaricOperationError("stale_scope", "Scope version changed")
        if (scope.revision_state !== "approved" || typeof scope.current_revision_ref !== "string") throw new TaricOperationError("scope_unresolved", "Scope has no current approved ScopeRevision")
        const history = await this.history(input.scopeId, scopes.readSeq)
        const revision = history.records.find((entry) => entry.id === scope.current_revision_ref)
        if (!revision) throw new TaricOperationError("scope_unresolved", "Current ScopeRevision is absent from canonical history")
        this.assertCanonical(revision, "scope_revision")
        if (revision.scope_ref !== scope.id || revision.approval_status !== "approved" || revision.policy_digest !== scope.policy_digest || history.records.some((entry) => entry.kind === "scope_invalidation" && entry.scope_revision_ref === revision.id)) throw new TaricOperationError("stale_scope", "ScopeRevision is invalidated or mismatched")
        if ((input.scopeRevisionId !== undefined && revision.id !== input.scopeRevisionId) || (input.policyDigest !== undefined && revision.policy_digest !== input.policyDigest)) throw new TaricOperationError("stale_scope", "Saved ScopeRevision premise changed")
        const policy = record(revision.policy)
        const now = Date.now()
        if (!Number.isFinite(Date.parse(String(policy.valid_from))) || !Number.isFinite(Date.parse(String(policy.valid_until))) || now < Date.parse(String(policy.valid_from)) || now >= Date.parse(String(policy.valid_until))) throw new TaricOperationError("stale_scope", "ScopeRevision is outside its effective time window")
        if (!/^sha256:[a-f0-9]{64}$/.test(String(revision.policy_digest)) || !/^sha256:[a-f0-9]{64}$/.test(String(revision.roe_content_hash)) || typeof revision.roe_artifact_ref !== "string" || !Number.isSafeInteger(revision.roe_artifact_version) || Number(revision.roe_artifact_version) < 1 || !Number.isSafeInteger(scope.version) || !Number.isSafeInteger(revision.revision)) throw new TaricOperationError("scope_unresolved", "ScopeRevision lacks its verified ROE binding")
        return { tenantId: binding.tenantId, projectId: binding.projectId, engagementId: binding.engagementId, scopeId: input.scopeId, scopeVersion: Number(scope.version), scopeRevisionId: String(revision.id), revision: Number(revision.revision), readSeq: scopes.readSeq, policyDigest: String(revision.policy_digest), policy: policy as unknown as AuthorityScopePolicy, roeArtifactRef: revision.roe_artifact_ref, roeArtifactVersion: Number(revision.roe_artifact_version), roeContentHash: String(revision.roe_content_hash), source: "canonical_scope_revision", roeBinding: "committed_integrity_verified_artifact" }
    }

    async assertCurrent(locator: CanonicalScopeLocator): Promise<CanonicalScopeLocator> {
        const binding = this.options.host.getBinding()
        if (locator.tenantId !== binding.tenantId || locator.projectId !== binding.projectId || locator.engagementId !== binding.engagementId) throw new TaricOperationError("authorization_error", "ScopeRevision belongs to another host project binding")
        return this.resolve(locator)
    }

    async revise(input: AuthorityScopeRevisionInput): Promise<CanonicalScopeLocator> {
        requireTaricUuid(input.scopeId, "scopeId")
        const result = data(await this.options.host.invokeOperator("scope.revise", { scope_id: input.scopeId, expected_version: input.expectedVersion, policy: input.policy, roe_artifact_ref: input.roeArtifactRef, roe_artifact_version: input.roeArtifactVersion, idempotency_key: input.idempotencyKey }))
        const scope = record(result.scope)
        const revision = record(result.revision)
        return this.resolve({ scopeId: input.scopeId, scopeVersion: Number(scope.version), scopeRevisionId: String(revision.id), policyDigest: String(revision.policy_digest) })
    }

    async invalidate(input: { scope: CanonicalScopeLocator; reason: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
        const result = data(await this.options.host.invokeOperator("scope.invalidate", { scope_id: input.scope.scopeId, scope_revision_ref: input.scope.scopeRevisionId, expected_version: input.scope.scopeVersion, reason: input.reason, idempotency_key: input.idempotencyKey }))
        const invalidation = record(result.invalidation)
        this.assertCanonical(invalidation, "scope_invalidation")
        return invalidation
    }

    private assertCanonical(value: Record<string, unknown>, kind: string): void {
        requireTaricUuid(value.id, `${kind}Id`)
        if (value.kind !== kind || value.engagement_id !== this.options.host.getBinding().engagementId || !["L1", "L2"].includes(String(value.trust_level))) throw new TaricOperationError("authorization_error", `Canonical ${kind} is outside the trusted Engagement`)
    }
}
