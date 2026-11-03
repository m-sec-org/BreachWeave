import type { TaricHostModule } from "./host-module"
import { deriveStableHostRequestIdentity, requireOpaqueHostId, requireTaricUuid } from "./host-identity"
import { readGovernancePages } from "./governance-query-reader"
import { TaricOperationError } from "./types"

export interface AuthorityAssetIdentity {
    challengeId: string
    assetId: string
    origin: string
    path: string
}

export interface AuthorityResourceRevisionInput {
    challengeId: string
    assetId: string
    resourceId: string
    expectedVersion: number
    method: string
    path: string
    contentHash: string
    sourceObservationRefs: readonly string[]
    clientRequestId?: string
}

export interface AuthorityResourceServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
    policyDigest: string
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Resource authority returned an invalid record")
    return value as Record<string, unknown>
}

/** Canonical Resource identity is admitted once; no local identity ledger is required. */
export class TaricAuthorityResourceService {
    constructor(private readonly options: AuthorityResourceServiceOptions) {
        if (!/^sha256:[a-f0-9]{64}$/.test(options.policyDigest)) throw new TaricOperationError("validation_error", "Resource policy digest must be SHA-256")
    }

    async provision(input: AuthorityAssetIdentity): Promise<Record<string, unknown>> {
        if (Object.keys(input).some((key) => !["challengeId", "assetId", "origin", "path"].includes(key))) throw new TaricOperationError("validation_error", "Resource identity has an unapproved field")
        requireOpaqueHostId(input.challengeId, "challengeId")
        requireOpaqueHostId(input.assetId, "assetId")
        let origin: URL
        try { origin = new URL(input.origin) } catch { throw new TaricOperationError("validation_error", "Resource origin must be a valid HTTP origin") }
        if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new TaricOperationError("validation_error", "Resource origin must contain only scheme, host and port")
        if (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.length > 2048 || /[?#\r\n\0]/.test(input.path)) throw new TaricOperationError("validation_error", "Resource path must be bounded and contain no query or fragment")
        const binding = this.options.host.getBinding()
        const key = deriveStableHostRequestIdentity(binding, { kind: "resource", challengeId: input.challengeId, assetId: input.assetId }).clientRequestId
        const identity = { origin: origin.origin, path: input.path, breachweave_host_key: key }
        const proposal = record(await this.options.host.submitProposal({ eventId: key, subjectType: "resource", expectedVersion: 0, content: { kind: "resource", asset_type: "endpoint", identity, revision: 1 } }))
        const proposalId = requireTaricUuid(proposal.id, "proposalId")
        const result = record(await this.options.host.invokeHost("admission.commit", { proposal_id: proposalId, expected_version: 0, policy_digest: this.options.policyDigest, idempotency_key: `bw:resource-admit:${proposalId}` }))
        if (result.ok === false) throw new TaricOperationError("conflict", "Resource admission did not commit")
        const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? record(result.data) : result
        const canonical = record(data.record)
        this.assertIdentity(canonical, identity)
        return canonical
    }

    /** Create one ResourceRevision only after its source Observation references are known. */
    async provisionRevision(input: AuthorityResourceRevisionInput): Promise<{ resource: Record<string, unknown>; revision: Record<string, unknown>; readSeq: number }> {
        requireTaricUuid(input.resourceId, "resourceId")
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new TaricOperationError("validation_error", "expectedVersion must be a positive integer")
        if (typeof input.method !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(input.method)) throw new TaricOperationError("validation_error", "Resource revision method is invalid")
        if (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.length > 2048 || /[?#\r\n\0]/.test(input.path)) throw new TaricOperationError("validation_error", "Resource revision path is invalid")
        if (!/^sha256:[a-f0-9]{64}$/i.test(input.contentHash)) throw new TaricOperationError("validation_error", "Resource revision contentHash must be SHA-256")
        if (!Array.isArray(input.sourceObservationRefs) || input.sourceObservationRefs.length === 0 || input.sourceObservationRefs.length > 32) throw new TaricOperationError("validation_error", "Resource revision needs source Observation references")
        const sourceObservationRefs = input.sourceObservationRefs.map((id) => requireTaricUuid(id, "sourceObservationRef"))
        if (new Set(sourceObservationRefs).size !== sourceObservationRefs.length) throw new TaricOperationError("validation_error", "Resource revision source Observations must be unique")
        sourceObservationRefs.sort()
        const binding = this.options.host.getBinding()
        const pathDigest = new Bun.CryptoHasher("sha256").update(input.path).digest("hex")
        const identity = deriveStableHostRequestIdentity(binding, { kind: "resource_revision", challengeId: input.challengeId, assetId: input.assetId, dimensions: [String(input.expectedVersion), input.method, input.contentHash, pathDigest, ...sourceObservationRefs] })
        const resources = await this.queryKind("resource")
        const matches = resources.records.filter((entry) => entry.id === input.resourceId && entry.kind === "resource")
        if (matches.length !== 1) throw new TaricOperationError("resource_identity_unresolved", "Resource is unavailable or ambiguous")
        const resourceRecord = matches[0]!
        this.assertCanonicalRecord(resourceRecord, "resource")
        const observations = await this.queryKind("observation", resources.readSeq)
        const sourceObservations = sourceObservationRefs.map((id) => observations.records.find((entry) => entry.id === id))
        if (observations.diagnostics.status !== "complete" || observations.diagnostics.hasMore || sourceObservations.some((entry) => !entry || entry.kind !== "observation" || entry.resource_ref !== input.resourceId || !["L1", "L2"].includes(String(entry.trust_level)))) {
            throw new TaricOperationError("authorization_error", "ResourceRevision source Observations are incomplete or not bound to this Resource")
        }
        if (resourceRecord.version !== input.expectedVersion) {
            if (resourceRecord.version === input.expectedVersion + 1 && Number.isSafeInteger(resourceRecord.revision)) {
                const resolved = await this.resolveRevision(input.resourceId, Number(resourceRecord.revision))
                if (this.revisionMatches(resolved.revision, input, sourceObservationRefs)) return resolved
            }
            throw new TaricOperationError("stale_version", "Resource changed before the requested revision could be committed")
        }
        const request = {
            resource_id: input.resourceId,
            expected_version: input.expectedVersion,
            method: input.method,
            path: input.path,
            content_hash: input.contentHash,
            source_observation_refs: sourceObservationRefs,
            client_request_id: input.clientRequestId ?? identity.clientRequestId,
        }
        const result = record(await this.options.host.invokeHost("resource.revise", request))
        if (result.ok === false) throw new TaricOperationError("conflict", "ResourceRevision did not commit")
        const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? record(result.data) : result
        const revisedResource = record(data.resource)
        const revision = record(data.revision)
        this.assertCanonicalRecord(revisedResource, "resource")
        this.assertCanonicalRecord(revision, "resource_revision")
        if (revisedResource.id !== input.resourceId || !this.revisionMatches(revision, input, sourceObservationRefs)) throw new TaricOperationError("authorization_error", "ResourceRevision does not match its trusted Resource request")
        const resolved = await this.resolveRevision(input.resourceId, Number(revision.revision))
        if (!this.revisionMatches(resolved.revision, input, sourceObservationRefs)) throw new TaricOperationError("authorization_error", "Committed ResourceRevision does not match its host request")
        return resolved
    }

    async resolveRevision(resourceId: string, revisionNumber: number): Promise<{ resource: Record<string, unknown>; revision: Record<string, unknown>; readSeq: number }> {
        requireTaricUuid(resourceId, "resourceId")
        if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) throw new TaricOperationError("validation_error", "revision must be a positive integer")
        const result = await this.queryKind("resource_revision")
        if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore) throw new TaricOperationError("incomplete_authority_snapshot", "ResourceRevision authority query is incomplete")
        const revisions = result.records.filter((entry) => entry.kind === "resource_revision" && entry.resource_ref === resourceId && Number(entry.revision) === revisionNumber)
        if (revisions.length !== 1) throw new TaricOperationError("resource_revision_unresolved", "ResourceRevision is unavailable or ambiguous")
        const revision = revisions[0]!
        this.assertCanonicalRecord(revision, "resource_revision")
        const resourcePage = await this.queryKind("resource", result.readSeq)
        if (resourcePage.diagnostics.status !== "complete" || resourcePage.diagnostics.hasMore) throw new TaricOperationError("incomplete_authority_snapshot", "Resource authority query is incomplete")
        const resources = resourcePage.records.filter((entry) => entry.kind === "resource" && entry.id === resourceId)
        if (resources.length !== 1) throw new TaricOperationError("resource_identity_unresolved", "Resource for ResourceRevision is unavailable")
        const resource = resources[0]!
        this.assertCanonicalRecord(resource, "resource")
        return { resource, revision, readSeq: result.readSeq }
    }

    /** Resolve the same authority ID after all process maps have been discarded. */
    async resolve(input: Pick<AuthorityAssetIdentity, "challengeId" | "assetId">): Promise<{ resource: Record<string, unknown>; readSeq: number }> {
        const binding = this.options.host.getBinding()
        const key = deriveStableHostRequestIdentity(binding, { kind: "resource", challengeId: input.challengeId, assetId: input.assetId }).clientRequestId
        const result = await readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind: "resource", include_candidates: true }, pageSize: 50 }, limits: { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("resource.query", request) })
        if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore) throw new TaricOperationError("incomplete_authority_snapshot", "Resource identity query is incomplete")
        const matches = result.records.filter((entry) => entry.kind === "resource" && record(entry.identity).breachweave_host_key === key)
        if (matches.length !== 1) throw new TaricOperationError("resource_identity_unresolved", "Resource identity is unavailable or ambiguous")
        const resource = matches[0]!
        this.assertIdentity(resource, { breachweave_host_key: key })
        return { resource, readSeq: result.readSeq }
    }

    private assertIdentity(resource: Record<string, unknown>, expected: Record<string, string>): void {
        const binding = this.options.host.getBinding()
        requireTaricUuid(resource.id, "resourceId")
        const actual = record(resource.identity)
        if (resource.kind !== "resource" || resource.engagement_id !== binding.engagementId || !["L1", "L2"].includes(String(resource.trust_level)) || Object.entries(expected).some(([key, value]) => actual[key] !== value)) throw new TaricOperationError("authorization_error", "Canonical Resource does not match its host-derived project identity")
    }

    private assertCanonicalRecord(value: Record<string, unknown>, kind: string): void {
        const binding = this.options.host.getBinding()
        requireTaricUuid(value.id, `${kind}Id`)
        if (value.kind !== kind || value.engagement_id !== binding.engagementId || !["L1", "L2"].includes(String(value.trust_level))) throw new TaricOperationError("authorization_error", `Canonical ${kind} is outside the trusted Engagement`)
    }

    private async queryKind(kind: string, readSeq?: number) {
        const binding = this.options.host.getBinding()
        return readGovernancePages({ kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind, include_candidates: true }, pageSize: 50, ...(readSeq === undefined ? {} : { readSeq }) }, limits: { maxPages: 32, maxRecords: 1024, maxBytes: 2 * 1024 * 1024 }, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.options.host.invokeHost("resource.query", request) })
    }

    private revisionMatches(revision: Record<string, unknown>, input: AuthorityResourceRevisionInput, sourceObservationRefs: readonly string[]): boolean {
        const variant = revision.variant && typeof revision.variant === "object" && !Array.isArray(revision.variant) ? revision.variant as Record<string, unknown> : {}
        return revision.kind === "resource_revision"
            && revision.resource_ref === input.resourceId
            && revision.content_hash === input.contentHash
            && variant.method === input.method
            && variant.path_template === input.path
            && Array.isArray(revision.source_observation_refs)
            && [...revision.source_observation_refs].sort().join("\0") === [...sourceObservationRefs].sort().join("\0")
    }
}
