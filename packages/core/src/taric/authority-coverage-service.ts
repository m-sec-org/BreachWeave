import type { TaricHostModule } from "./host-module"
import type { GovernanceQueryLimits } from "./governance-query-reader"
import { readGovernancePages } from "./governance-query-reader"
import { requireTaricUuid } from "./host-identity"
import { TaricOperationError } from "./types"

export interface AuthorityCoverageDimension {
    resource_ref: string
    resource_revision_ref: string
    test_category: string
    conditions: string[]
    identity_ref?: string
    role?: string
    tenant_ref?: string
    operation?: string
    path?: string
    parameter?: string
    method?: string
    network_condition?: string
}

export interface AuthorityCoverageServiceOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator">
}

export type AuthorityCoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable"

export interface AuthorityCoverageManifestInput {
    scopeRevisionId: string
    policyDigest: string
    expectedCells: readonly AuthorityCoverageDimension[]
    idempotencyKey: string
}

export interface AuthorityCoverageRecordInput {
    dimension: AuthorityCoverageDimension
    scopeRevisionId: string
    policyDigest: string
    expectedVersion: number
    cellId?: string
    status: AuthorityCoverageStatus
    evidenceRefs?: readonly string[]
    counterEvidenceRefs?: readonly string[]
    notApplicableReason?: string
    limitations?: readonly string[]
    idempotencyKey: string
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", "Coverage authority returned an invalid record")
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

function validateDigest(value: string): void {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new TaricOperationError("validation_error", "Coverage digest must be SHA-256")
}

function dimensionKey(value: Record<string, unknown>): string {
    const keys = ["resource_ref", "resource_revision_ref", "test_category", "identity_ref", "role", "tenant_ref", "operation", "path", "parameter", "method", "network_condition"]
    return JSON.stringify([...keys.map((key) => value[key] ?? null), [...new Set(Array.isArray(value.conditions) ? value.conditions as string[] : [])].sort()])
}

/** Complete Coverage is read from its manifest snapshot, never inferred from recall-visible context. */
export class TaricAuthorityCoverageService {
    constructor(private readonly options: AuthorityCoverageServiceOptions) {}

    async commitManifest(input: AuthorityCoverageManifestInput): Promise<Record<string, unknown>> {
        requireTaricUuid(input.scopeRevisionId, "scopeRevisionId")
        validateDigest(input.policyDigest)
        if (!Array.isArray(input.expectedCells) || !input.expectedCells.length || input.expectedCells.length > 4096) throw new TaricOperationError("empty_manifest", "Coverage manifest must contain bounded expected dimensions")
        const manifest = data(await this.options.host.invokeOperator("coverage.manifest.commit", { scope_revision_ref: input.scopeRevisionId, policy_digest: input.policyDigest, expected_cells: input.expectedCells, idempotency_key: input.idempotencyKey }))
        this.assertCanonical(manifest, "coverage_manifest")
        if (manifest.scope_revision_ref !== input.scopeRevisionId || manifest.policy_digest !== input.policyDigest) throw new TaricOperationError("authorization_error", "Coverage manifest ScopeRevision binding changed")
        if (!Array.isArray(manifest.expected_cells) || JSON.stringify(manifest.expected_cells.map((cell) => dimensionKey(record(cell))).sort()) !== JSON.stringify(input.expectedCells.map((cell) => dimensionKey({ ...cell })).sort())) throw new TaricOperationError("authorization_error", "Coverage manifest expected dimensions changed")
        validateDigest(String(manifest.manifest_digest))
        return manifest
    }

    async record(input: AuthorityCoverageRecordInput): Promise<Record<string, unknown>> {
        requireTaricUuid(input.scopeRevisionId, "scopeRevisionId")
        requireTaricUuid(input.dimension.resource_ref, "resourceRef")
        requireTaricUuid(input.dimension.resource_revision_ref, "resourceRevisionRef")
        validateDigest(input.policyDigest)
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || (input.expectedVersion === 0) !== (input.cellId === undefined)) throw new TaricOperationError("validation_error", "Coverage updates require cellId and a positive expectedVersion")
        if (input.cellId !== undefined) requireTaricUuid(input.cellId, "cellId")
        if (input.status === "not_applicable" && !input.notApplicableReason?.trim()) throw new TaricOperationError("validation_error", "not_applicable requires a bounded reason")
        const response = data(await this.options.host.invokeHost("coverage.record", { ...input.dimension, scope_revision_ref: input.scopeRevisionId, policy_digest: input.policyDigest, expected_version: input.expectedVersion, ...(input.cellId === undefined ? {} : { cell_id: input.cellId }), status: input.status, evidence_refs: input.evidenceRefs ?? [], counter_evidence_refs: input.counterEvidenceRefs ?? [], limitations: input.limitations ?? [], ...(input.notApplicableReason === undefined ? {} : { not_applicable_reason: input.notApplicableReason }), idempotency_key: input.idempotencyKey }))
        const cell = record(response.record ?? response)
        this.assertCanonical(cell, "coverage")
        if (dimensionKey(cell) !== dimensionKey({ ...input.dimension }) || cell.scope_revision_ref !== input.scopeRevisionId || cell.policy_digest !== input.policyDigest) throw new TaricOperationError("authorization_error", "Coverage response dimensions changed")
        return cell
    }

    async snapshot(input: { manifestId: string; manifestDigest: string; pageSize?: number; readSeq?: number; limits?: Partial<GovernanceQueryLimits> }) {
        requireTaricUuid(input.manifestId, "manifestId")
        validateDigest(input.manifestDigest)
        const binding = this.options.host.getBinding()
        let metadata: Record<string, unknown> | undefined
        let responseBytes = 0
        const maxBytes = input.limits?.maxBytes ?? 8 * 1024 * 1024
        const filters = { manifest_ref: input.manifestId, manifest_digest: input.manifestDigest, include_candidates: true, visibility_mode: "complete" }
        const result = await readGovernancePages({ kind: "coverage", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters, pageSize: input.pageSize ?? 200, ...(input.readSeq === undefined ? {} : { readSeq: input.readSeq }) }, limits: { maxPages: 64, maxRecords: 4096, maxBytes: 8 * 1024 * 1024, ...input.limits }, snapshotPinned: true, pageKey: "cells", readSeqInput: "as_of", query: async (request) => {
            const page = data(await this.options.host.invokeHost("coverage.snapshot", request))
            responseBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength
            if (responseBytes > maxBytes) throw new TaricOperationError("incomplete_authority_snapshot", "Coverage snapshot response exceeds the bounded byte budget")
            if (page.engagement_id !== binding.engagementId || page.manifest_ref !== input.manifestId || page.manifest_digest !== input.manifestDigest) throw new TaricOperationError("authorization_error", "Coverage snapshot binding changed")
            if (!Array.isArray(page.cells)) throw new TaricOperationError("validation_error", "Coverage snapshot cells are invalid")
            for (const cell of page.cells) this.assertCanonical(record(cell), "coverage")
            if (metadata && ["snapshot_id", "snapshot_digest", "read_seq", "expected_cell_count", "domain_cell_count", "complete_domain", "manifest_binding_state"].some((key) => metadata![key] !== page[key])) throw new TaricOperationError("conflict", "Coverage snapshot metadata changed across pages")
            metadata ??= page
            return page
        } })
        if (!metadata) throw new TaricOperationError("incomplete_authority_snapshot", "Coverage snapshot metadata missing")
        const complete = result.diagnostics.status === "complete" && !result.diagnostics.hasMore && metadata.complete_domain === true && metadata.truncated === false && metadata.manifest_binding_verified === true && metadata.missing_items_complete === true && metadata.expected_cell_count_complete === true
        const gate = data(await this.options.host.invokeHost("coverage.gate", { manifest_ref: input.manifestId, manifest_digest: input.manifestDigest, as_of: result.readSeq }))
        if (gate.read_seq !== result.readSeq || gate.snapshot_digest !== metadata.snapshot_digest) throw new TaricOperationError("conflict", "Coverage gate and snapshot differ")
        if (!complete && gate.can_close === true) throw new TaricOperationError("incomplete_authority_snapshot", "Incomplete Coverage snapshot cannot authorize close")
        return { cells: result.records, readSeq: result.readSeq, snapshotDigest: String(metadata.snapshot_digest), gate, metadata, diagnostics: { ...result.diagnostics, bytes: responseBytes, visibility: "complete" as const, completeDomain: complete } }
    }

    private assertCanonical(value: Record<string, unknown>, kind: string): void {
        requireTaricUuid(value.id, `${kind}Id`)
        if (value.kind !== kind || value.engagement_id !== this.options.host.getBinding().engagementId || !["L1", "L2"].includes(String(value.trust_level))) throw new TaricOperationError("authorization_error", `Canonical ${kind} is outside the trusted Engagement`)
    }
}
