import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readdir, rename, rm, stat } from "fs/promises"
import { join, resolve } from "path"
import type { AuthorizedPentestProject } from "../project/types"
import { TaricOperationError, TaricUnavailableError } from "./types"
import type { TaricHostModule } from "./host-module"
import type { TaricArtifactReferenceDto, TaricProposalInput } from "./types"
import type { CommittedTaricArtifact, TaricArtifactService } from "./artifact-service"
import type { TaricAuthorityReportService, AuthorityReportProjection } from "./authority-report-service"
import { TaricAuthorityCoverageService } from "./authority-coverage-service"
import { readGovernancePages } from "./governance-query-reader"
import type { GovernanceQueryLimits, GovernanceQueryResult } from "./governance-query-reader"
import { TARIC_COMPATIBILITY_BASELINE } from "./compatibility"
import { TaricAuthorityAdmissionService } from "./authority-admission-service"

export type GovernanceOutcome = "accepted" | "deferred" | "rejected_validation" | "rejected_authorization" | "indeterminate" | "failed_permanent"

export interface ScopeTarget {
    host?: string
    cidr?: string
    protocols?: readonly string[]
    ports?: readonly number[]
}

export interface ScopePolicy {
    allowedTargets: readonly ScopeTarget[]
    deniedTargets?: readonly ScopeTarget[]
    allowedProtocols?: readonly string[]
    allowedPorts?: readonly number[]
}

export interface TestWindow {
    startsAt: string
    endsAt: string
}

export interface ManifestItem {
    resourceId: string
    revision: number
    testCategories: readonly string[]
}

export interface AuthorizedProjectSetup {
    project: AuthorizedPentestProject
    scope: ScopePolicy
    testWindow: TestWindow
    manifest: readonly ManifestItem[]
    secretReferences: readonly string[]
    retentionDays: number
    policyDigest: string
}

export interface EgressRequest {
    url: string
    resolvedAddresses?: readonly string[]
    redirectChain?: readonly string[]
    at?: string
}

export interface PolicyDecision {
    allowed: boolean
    reason: string
    normalizedUrls: readonly string[]
}

export interface WorkRun {
    runId: string
    workItemId: string
    attemptId: string
    owner: string
    generation: number
    leaseExpiresAt: string
    targetResourceId: string
}

export interface RecoveredWorkRun {
    run: WorkRun
    checkpoint?: CheckpointState
}

export interface ArtifactMetadata {
    artifactId: string
    contentRef: string
    path: string
    bytes: number
    sha256: string
    manifestHash: string
    mediaType: string
    committedAt: string
    redacted: boolean
    contentStatus: "available" | "deleted"
    /** Storage is Taric-managed in the authority-critical path. */
    storageMode?: "taric_stored" | "local_encrypted"
    integrityStatus?: "verified"
    category?: string
    payloadKind?: "text" | "binary" | "manifest"
    version?: number
    sessionId?: string
    ownerHost?: string
    workRunId?: string
    attemptId?: string
    generation?: number
    resourceId?: string
    resourceRevision?: number
    scopeRevision?: number
}

export interface ReportSnapshot {
    reportDigest: string
    manifestDigest: string
    scopeRevision: number
    resourceRevisions: readonly { resourceId: string; revision: number }[]
    gate: CoverageGate
    readSeq: number
    createdAt: string
}

export type CoverageStatus = "not_tested" | "queued" | "in_progress" | "tested_no_observation" | "positive" | "inconclusive" | "blocked" | "blocked_by_control" | "not_applicable"

export interface CoverageCell {
    cellId: string
    authorityId?: string
    resourceId: string
    resourceRevision: number
    scopeRevision: number
    category: string
    status: CoverageStatus
    evidenceRefs: readonly string[]
    version: number
    justification?: string
}

export interface CoverageGate {
    canClose: boolean
    readSeq: number
    gaps: readonly string[]
    cells: readonly CoverageCell[]
}

export type ReviewVerdict = "pass" | "reject" | "needs_evidence" | "defer"

export interface ReviewSubmission {
    proposalId: string
    reviewerId?: string
    verdict: ReviewVerdict
    inputHash: string
    evidenceSnapshotHash: string
    policyDigest: string
}

export interface ReviewDecision extends ReviewSubmission {
    reviewerId: string
    reviewerKind: "reviewer" | "deterministic"
    evidenceClass: "authority_review" | "local_fixture"
    createdAt: string
}

export interface CloseRequest {
    operatorId?: string
    reportDigest?: string
    residualRisks?: readonly string[]
    disclosures?: readonly string[]
}

export interface CheckpointState {
    workRunId: string
    attemptId: string
    generation: number
    completedSteps: readonly string[]
    nextSteps: readonly string[]
    observationRefs: readonly string[]
    evidenceRefs: readonly string[]
    unresolvedWork: readonly string[]
    sourceReadSeq: number
}

export interface WorkRecoveryLocator {
    workRunId: string
    workItemId: string
    attemptId: string
    generation: number
    targetResourceId: string
}

export interface GovernanceDiagnostics {
    outcome: GovernanceOutcome
    code: string
    message: string
    operation?: string
    eventId?: string
}

export interface HostObservationInput {
    resourceRef: string
    statement: string
    artifactRefs?: readonly TaricArtifactReferenceDto[]
    limitations?: readonly string[]
    status?: "proposed"
    observedAt?: string
    workRunId: string
    generation: number
}

export class GovernanceError extends Error {
    readonly code: string
    readonly outcome: Exclude<GovernanceOutcome, "accepted"> 

    constructor(code: string, message: string, outcome: Exclude<GovernanceOutcome, "accepted"> = "rejected_validation") {
        super(message)
        this.name = "GovernanceError"
        this.code = code
        this.outcome = outcome
    }
}

const SENSITIVE_KEY = /(password|secret|token|cookie|authorization|credential|private[_-]?key|api[_-]?key|registry[_-]?key|outbox[_-]?key|database[_-]?url|connection[_-]?string)/i
const SENSITIVE_TEXT = /(?:password|secret|token|cookie|authorization|credential|api[_-]?key|private[_-]?key|connection[_-]?string|registry[_-]?key|outbox[_-]?key)\s*[:=]\s*\S+|Bearer\s+\S+|flag\{[^}]*\}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i
const CHECKPOINT_KEYS = new Set(["completed_steps", "next_steps", "observation_refs", "evidence_refs", "negative_results", "unresolved_work", "source_read_seq", "budget", "draft_refs", "handoff_refs", "action_refs", "tool_result_refs", "context_manifest", "work_item_ref", "work_run_ref", "attempt_ref", "generation", "target_resource_ref", "target_version", "work_item_version", "scope_version", "owner", "lease_expires_at", "host_decision_refs", "external_action_state"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requiredText(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new GovernanceError("invalid_input", `${field} is required`)
    return value.trim()
}

function validateLeaseTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new GovernanceError("invalid_lease_ttl", "lease TTL must be an integer between 1000 and 86400000 milliseconds")
}

function operationData(value: unknown): Record<string, unknown> {
    let current = value
    for (let depth = 0; depth < 3; depth += 1) {
        if (!current || typeof current !== "object" || Array.isArray(current)) break
        const object = current as Record<string, unknown>
        if (object.ok === false) throw new GovernanceError("authority_operation_failed", "Taric operation returned a rejected result", "failed_permanent")
        if (object.ok === true && object.data && typeof object.data === "object") current = object.data
        else if (object.data && typeof object.data === "object" && !Array.isArray(object.data)) current = object.data
        else return object
    }
    return current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {}
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GovernanceError("invalid_work_run", `${field} must be an object`, "failed_permanent")
    return value as Record<string, unknown>
}

function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new GovernanceError("invalid_checkpoint", `${field} must be an array of strings`, "failed_permanent")
    return value.map((item) => item as string)
}

function parseWorkRun(value: unknown, fallback: Partial<WorkRun> = {}): WorkRun {
    const data = recordValue(value, "work run")
    const nested = data.work_run && typeof data.work_run === "object" && !Array.isArray(data.work_run) ? data.work_run as Record<string, unknown> : data
    const runId = requiredText(nested.run_id ?? nested.work_run_id ?? fallback.runId, "run_id")
    const workItemId = requiredText(nested.work_item_id ?? nested.work_item_ref ?? fallback.workItemId, "work_item_id")
    const attemptId = requiredText(nested.attempt_ref ?? nested.attempt_id ?? fallback.attemptId, "attempt_ref")
    const owner = requiredText(nested.owner ?? nested.agent_id ?? fallback.owner, "owner")
    const generation = Number(nested.generation ?? fallback.generation)
    if (!Number.isSafeInteger(generation) || generation < 1) throw new GovernanceError("invalid_work_run", "Taric returned an invalid generation", "failed_permanent")
    const leaseExpiresAt = requiredText(nested.lease_expires_at ?? fallback.leaseExpiresAt, "lease_expires_at")
    if (!Number.isFinite(Date.parse(leaseExpiresAt))) throw new GovernanceError("invalid_work_run", "Taric returned an invalid lease expiry", "failed_permanent")
    const targetResourceId = requiredText(nested.target_resource_id ?? nested.target_resource_ref ?? fallback.targetResourceId, "target_resource_id")
    return { runId, workItemId, attemptId, owner, generation, leaseExpiresAt, targetResourceId }
}

function parseCheckpoint(value: unknown, run: WorkRun, scopeRevision: number, resourceRevision: number): CheckpointState | undefined {
    if (value === undefined || value === null) return undefined
    const checkpoint = recordValue(value, "checkpoint")
    const workRunId = requiredText(checkpoint.work_run_ref ?? checkpoint.work_run_id ?? run.runId, "work_run_ref")
    const attemptId = requiredText(checkpoint.attempt_ref ?? checkpoint.attempt_id ?? run.attemptId, "attempt_ref")
    const generation = Number(checkpoint.generation ?? run.generation)
    if (workRunId !== run.runId || attemptId !== run.attemptId || generation !== run.generation) throw new GovernanceError("stale_checkpoint", "checkpoint does not match the recovered WorkRun generation", "rejected_authorization")
    if (checkpoint.target_resource_ref !== run.targetResourceId || Number(checkpoint.target_version) !== resourceRevision || Number(checkpoint.scope_version) !== scopeRevision) throw new GovernanceError("stale_checkpoint", "checkpoint target or scope revision differs from the active project", "rejected_authorization")
    const sourceReadSeq = Number(checkpoint.source_read_seq ?? 0)
    if (!Number.isSafeInteger(sourceReadSeq) || sourceReadSeq < 0) throw new GovernanceError("invalid_checkpoint", "checkpoint source_read_seq must be a non-negative integer", "failed_permanent")
    return {
        workRunId,
        attemptId,
        generation,
        completedSteps: stringArray(checkpoint.completed_steps ?? [], "completed_steps"),
        nextSteps: stringArray(checkpoint.next_steps ?? [], "next_steps"),
        observationRefs: stringArray(checkpoint.observation_refs ?? [], "observation_refs"),
        evidenceRefs: stringArray(checkpoint.evidence_refs ?? [], "evidence_refs"),
        unresolvedWork: stringArray(checkpoint.unresolved_work ?? [], "unresolved_work"),
        sourceReadSeq,
    }
}

export function validateHostObservation(input: HostObservationInput): Record<string, unknown> {
    if (!UUID.test(requiredText(input.resourceRef, "resourceRef"))) throw new GovernanceError("invalid_resource_ref", "resourceRef must be a trusted Taric Resource UUID")
    if (!UUID.test(requiredText(input.workRunId, "workRunId"))) throw new GovernanceError("invalid_work_run", "workRunId must be a Taric WorkRun reference")
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new GovernanceError("invalid_generation", "generation must be positive")
    const statement = requiredText(input.statement, "statement")
    const artifactRefs = [...(input.artifactRefs ?? [])]
    if (artifactRefs.some((ref) => (!("host_ref" in ref && typeof ref.host_ref === "string" && ref.host_ref.trim()) && !("content_ref" in ref && typeof ref.content_ref === "string" && ref.content_ref.trim())) || (ref.artifact_id !== undefined && !UUID.test(ref.artifact_id)))) throw new GovernanceError("invalid_artifact_ref", "artifactRefs must reference committed Artifacts")
    if (input.observedAt && !Number.isFinite(Date.parse(input.observedAt))) throw new GovernanceError("invalid_observed_at", "observedAt must be an ISO timestamp")
    if (SENSITIVE_KEY.test(statement) || collectSensitive({ limitations: input.limitations })) throw new GovernanceError("sensitive_observation", "observation contains a sensitive value")
    return {
        resource_ref: input.resourceRef,
        observed_at: input.observedAt ?? new Date().toISOString(),
        statement: statement.slice(0, 16_384),
        artifact_refs: artifactRefs,
        limitations: [...(input.limitations ?? ["Captured by BreachWeave host; raw output is retained in host-managed storage."])].slice(0, 32),
        ...(input.status ? { status: input.status } : {}),
    }
}

function isIpv4(value: string): boolean {
    const parts = value.split(".")
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function ipv4InCidr(address: string, cidr: string): boolean {
    const [network, prefixText] = cidr.split("/")
    if (!isIpv4(address) || !isIpv4(network)) return false
    const prefix = Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
    const toInt = (value: string) => value.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0) >>> 0
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (toInt(address) & mask) === (toInt(network) & mask)
}

function ipv6Value(address: string): bigint | undefined {
    const normalized = address.toLowerCase().split("%")[0]!
    if (!normalized.includes(":")) return
    const halves = normalized.split("::")
    if (halves.length > 2) return
    const parse = (part: string) => part ? part.split(":").flatMap((word) => {
        if (word.includes(".")) {
            if (!isIpv4(word)) return []
            const octets = word.split(".").map(Number)
            return [((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16)]
        }
        return /^[0-9a-f]{1,4}$/.test(word) ? [word] : []
    }) : []
    const left = parse(halves[0]!)
    const right = parse(halves[1] ?? "")
    const missing = 8 - left.length - right.length
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return
    const words = [...left, ...Array(missing).fill("0"), ...right]
    if (words.length !== 8) return
    return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n)
}

function ipInCidr(address: string, cidr: string): boolean {
    if (!cidr.includes(":")) return ipv4InCidr(address, cidr)
    const [network, prefixText] = cidr.split("/")
    const addressValue = ipv6Value(address)
    const networkValue = ipv6Value(network!)
    const prefix = Number(prefixText)
    if (addressValue === undefined || networkValue === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix)
    return (addressValue & mask) === (networkValue & mask)
}

function targetMatches(target: string, candidate: ScopeTarget): boolean {
    const normalized = target.toLowerCase().replace(/\.$/, "")
    if (candidate.host) {
        const host = candidate.host.toLowerCase().replace(/\.$/, "")
        if (normalized !== host) return false
    } else if (candidate.cidr) {
        if (!ipInCidr(normalized, candidate.cidr)) return false
    } else return false
    return true
}

function matchesAny(target: string, candidates: readonly ScopeTarget[] | undefined): boolean {
    return Boolean(candidates?.some((candidate) => targetMatches(target, candidate)))
}

function parsePort(url: URL): number {
    if (url.port) return Number(url.port)
    return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : -1
}

export function validateAuthorizedProjectSetup(input: AuthorizedProjectSetup): AuthorizedProjectSetup {
    if (!input || typeof input !== "object" || Array.isArray(input) || !input.project || typeof input.project !== "object" || Array.isArray(input.project)) {
        throw new GovernanceError("invalid_project_setup", "authorized project setup must include a project object")
    }
    if (input.project.mode !== "authorized_pentest" || input.project.memory_mode !== "taric_required") {
        throw new GovernanceError("invalid_project_mode", "authorized projects require taric_required memory", "rejected_authorization")
    }
    requiredText(input.project.tenant_id, "tenant_id")
    requiredText(input.project.taric_engagement_id, "taric_engagement_id")
    requiredText(input.policyDigest, "policyDigest")
    if (!Number.isInteger(input.project.scope_revision) || input.project.scope_revision < 1) throw new GovernanceError("invalid_scope_revision", "scope_revision must be positive")
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) throw new GovernanceError("invalid_retention", "retentionDays must be between 1 and 3650")
    if (!input.scope || !Array.isArray(input.scope.allowedTargets) || input.scope.allowedTargets.length === 0) throw new GovernanceError("empty_scope", "authorized scope must contain at least one allowed target")
    validateScopeTargets(input.scope.allowedTargets, "scope.allowedTargets")
    validateScopeTargets(Array.isArray(input.scope.deniedTargets) ? input.scope.deniedTargets : [], "scope.deniedTargets")
    validateScopeProtocols(input.scope.allowedProtocols, "scope.allowedProtocols")
    validateScopePorts(input.scope.allowedPorts, "scope.allowedPorts")
    if (!Array.isArray(input.manifest) || input.manifest.length === 0) throw new GovernanceError("empty_manifest", "authorized manifest must contain at least one resource")
    const cells = new Set<string>()
    for (const item of input.manifest) {
        if (!UUID.test(requiredText(item.resourceId, "manifest.resourceId"))) throw new GovernanceError("invalid_manifest", "manifest.resourceId must be a Taric Resource UUID")
        if (!Number.isInteger(item.revision) || item.revision < 1 || !Array.isArray(item.testCategories) || item.testCategories.length === 0) throw new GovernanceError("invalid_manifest", "manifest items require a revision and test category")
        const categories = new Set<string>()
        for (const category of item.testCategories) {
            const normalized = requiredText(category, "manifest.testCategories[]")
            if (categories.has(normalized)) throw new GovernanceError("invalid_manifest", "manifest test categories must be unique per resource revision")
            categories.add(normalized)
            const cell = `${item.resourceId}:${item.revision}:${input.project.scope_revision}:${normalized}`
            if (cells.has(cell)) throw new GovernanceError("invalid_manifest", "manifest contains duplicate coverage cells")
            cells.add(cell)
        }
    }
    const start = Date.parse(input.testWindow?.startsAt ?? "")
    const end = Date.parse(input.testWindow?.endsAt ?? "")
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new GovernanceError("invalid_window", "test window must be a valid non-empty UTC interval")
    if (!Array.isArray(input.secretReferences) || input.secretReferences.length === 0 || input.secretReferences.some((ref) => !/^secret:[A-Za-z0-9._:-]+$/.test(ref))) throw new GovernanceError("invalid_secret_reference", "secretReferences must be opaque secret: references")
    if (new Set(input.secretReferences).size !== input.secretReferences.length) throw new GovernanceError("invalid_secret_reference", "secretReferences must be unique")
    return input
}

function validateScopeTargets(targets: readonly ScopeTarget[], field: string): void {
    for (const target of targets) {
        if (!target || (target.host === undefined && target.cidr === undefined) || (target.host !== undefined && target.cidr !== undefined)) {
            throw new GovernanceError("invalid_scope", `${field} entries must contain exactly one host or cidr target`)
        }
        if (target.host !== undefined) {
            const host = requiredText(target.host, `${field}.host`)
            if (/\s|[\u0000-\u001f\u007f]/.test(host) || host.includes("/")) throw new GovernanceError("invalid_scope", `${field}.host is invalid`)
        }
        if (target.cidr !== undefined) {
            const cidr = requiredText(target.cidr, `${field}.cidr`)
            const parts = cidr.split("/")
            const [address, prefix] = parts
            const maxPrefix = address?.includes(":") ? 128 : 32
            const addressValid = address?.includes(":") ? ipv6Value(address) !== undefined : isIpv4(address ?? "")
            if (parts.length !== 2 || !addressValid || !/^\d+$/.test(prefix ?? "") || Number(prefix) > maxPrefix) {
                throw new GovernanceError("invalid_scope", `${field}.cidr is invalid`)
            }
        }
    }
}

function validateScopeProtocols(protocols: readonly string[] | undefined, field: string): void {
    if (protocols === undefined) return
    if (!Array.isArray(protocols) || protocols.length === 0 || protocols.some((protocol) => !/^[a-z][a-z0-9+.-]{1,15}$/i.test(protocol))) {
        throw new GovernanceError("invalid_scope", `${field} must contain valid protocol names`)
    }
    if (new Set(protocols.map((protocol) => protocol.toLowerCase())).size !== protocols.length) throw new GovernanceError("invalid_scope", `${field} must be unique`)
}

function validateScopePorts(ports: readonly number[] | undefined, field: string): void {
    if (ports === undefined) return
    if (!Array.isArray(ports) || ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
        throw new GovernanceError("invalid_scope", `${field} must contain valid TCP/UDP ports`)
    }
    if (new Set(ports).size !== ports.length) throw new GovernanceError("invalid_scope", `${field} must be unique`)
}

export function evaluateEgress(scope: ScopePolicy, window: TestWindow, request: EgressRequest): PolicyDecision {
    const urls = [request.url, ...(request.redirectChain ?? [])]
    const at = Date.parse(request.at ?? new Date().toISOString())
    if (!Number.isFinite(at) || at < Date.parse(window.startsAt) || at > Date.parse(window.endsAt)) return { allowed: false, reason: "outside test window", normalizedUrls: urls }
    const normalized: string[] = []
    for (const raw of urls) {
        let url: URL
        try { url = new URL(raw) } catch { return { allowed: false, reason: "invalid target URL", normalizedUrls: normalized } }
        const protocol = url.protocol.slice(0, -1).toLowerCase()
        const port = parsePort(url)
        const hostname = url.hostname.replace(/^\[|\]$/g, "")
        const isIp = isIpv4(hostname) || hostname.includes(":")
        if (!isIp && (!request.resolvedAddresses || request.resolvedAddresses.length === 0)) return { allowed: false, reason: "DNS answers are required for host enforcement", normalizedUrls: normalized }
        const addressTargets = [hostname, ...(request.resolvedAddresses ?? [])]
        const denied = addressTargets.some((target) => matchesAny(target, scope.deniedTargets))
        const hostAllowed = matchesAny(hostname, scope.allowedTargets)
        const addressesAllowed = (request.resolvedAddresses ?? []).every((address) => matchesAny(address, scope.allowedTargets))
        const allowedTarget = hostAllowed && addressesAllowed && (isIp || (request.resolvedAddresses?.length ?? 0) > 0)
        const protocolAllowed = !scope.allowedProtocols || scope.allowedProtocols.includes(protocol)
        const portAllowed = !scope.allowedPorts || scope.allowedPorts.includes(port)
        if (denied || !allowedTarget || !protocolAllowed || !portAllowed) return { allowed: false, reason: denied ? "target is denied by scope" : !allowedTarget ? "target is outside scope" : !protocolAllowed ? "protocol is outside scope" : "port is outside scope", normalizedUrls: normalized }
        normalized.push(url.toString())
    }
    return { allowed: true, reason: "allowed by pinned scope and window", normalizedUrls: normalized }
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function sha256Digest(bytes: Uint8Array): string {
    return `sha256:${sha256(bytes)}`
}

function sha256Text(value: string): string {
    return sha256Digest(new TextEncoder().encode(value))
}

interface ArtifactDiskManifest {
    version: 1
    artifactId: string
    contentRef: string
    bytes: number
    sha256: string
    mediaType: string
    committedAt: string
    redacted: boolean
    contentStatus: "available" | "deleted"
    workRunId?: string
    attemptId?: string
    generation?: number
    resourceId?: string
    resourceRevision?: number
    scopeRevision?: number
    iv: string
    tag: string
    manifestHash: string
}

type ArtifactDiskManifestInput = Omit<ArtifactDiskManifest, "manifestHash">

function artifactDiskManifest(input: ArtifactDiskManifestInput): ArtifactDiskManifest {
    return { ...input, manifestHash: sha256Text(JSON.stringify(input)) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function artifactDiskInput(metadata: ArtifactMetadata, iv: string, tag: string): ArtifactDiskManifestInput {
    return {
        version: 1,
        artifactId: metadata.artifactId,
        contentRef: metadata.contentRef,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        mediaType: metadata.mediaType,
        committedAt: metadata.committedAt,
        redacted: metadata.redacted,
        contentStatus: metadata.contentStatus,
        ...(metadata.workRunId ? { workRunId: metadata.workRunId } : {}),
        ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
        ...(metadata.generation !== undefined ? { generation: metadata.generation } : {}),
        ...(metadata.resourceId ? { resourceId: metadata.resourceId } : {}),
        ...(metadata.resourceRevision !== undefined ? { resourceRevision: metadata.resourceRevision } : {}),
        ...(metadata.scopeRevision !== undefined ? { scopeRevision: metadata.scopeRevision } : {}),
        iv,
        tag,
    }
}

function parseArtifactDiskManifest(value: unknown, artifactId: string, path: string): { manifest: ArtifactDiskManifest; metadata: ArtifactMetadata } {
    if (!isRecord(value)) throw new GovernanceError("artifact_metadata_invalid", "artifact metadata must be an object", "failed_permanent")
    const data = value
    if (data.version !== 1 || data.artifactId !== artifactId || data.contentRef !== `artifact:${artifactId}`) throw new GovernanceError("artifact_metadata_invalid", "artifact metadata identity is invalid", "failed_permanent")
    if (!Number.isSafeInteger(data.bytes) || Number(data.bytes) < 1 || typeof data.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(data.sha256)) throw new GovernanceError("artifact_metadata_invalid", "artifact metadata digest or size is invalid", "failed_permanent")
    if (typeof data.mediaType !== "string" || !data.mediaType.trim() || typeof data.committedAt !== "string" || !Number.isFinite(Date.parse(data.committedAt))) throw new GovernanceError("artifact_metadata_invalid", "artifact metadata type or timestamp is invalid", "failed_permanent")
    if (typeof data.redacted !== "boolean" || (data.contentStatus !== "available" && data.contentStatus !== "deleted")) throw new GovernanceError("artifact_metadata_invalid", "artifact metadata status is invalid", "failed_permanent")
    if (typeof data.iv !== "string" || typeof data.tag !== "string" || typeof data.manifestHash !== "string") throw new GovernanceError("artifact_metadata_invalid", "artifact encryption metadata is incomplete", "failed_permanent")
    if ((data.workRunId !== undefined && (typeof data.workRunId !== "string" || !UUID.test(data.workRunId))) || (data.attemptId !== undefined && (typeof data.attemptId !== "string" || !UUID.test(data.attemptId)))) throw new GovernanceError("artifact_metadata_invalid", "artifact WorkRun provenance is invalid", "failed_permanent")
    for (const field of ["generation", "resourceRevision", "scopeRevision"] as const) {
        const item = data[field]
        if (item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 1)) throw new GovernanceError("artifact_metadata_invalid", `artifact ${field} is invalid`, "failed_permanent")
    }
    if (data.resourceId !== undefined && (typeof data.resourceId !== "string" || !UUID.test(data.resourceId))) throw new GovernanceError("artifact_metadata_invalid", "artifact Resource provenance is invalid", "failed_permanent")
    const metadataBase: ArtifactMetadata = {
        artifactId,
        contentRef: `artifact:${artifactId}`,
        path,
        bytes: Number(data.bytes),
        sha256: data.sha256,
        manifestHash: data.manifestHash,
        mediaType: data.mediaType,
        committedAt: data.committedAt,
        redacted: data.redacted,
        contentStatus: data.contentStatus,
        ...(typeof data.workRunId === "string" ? { workRunId: data.workRunId } : {}),
        ...(typeof data.attemptId === "string" ? { attemptId: data.attemptId } : {}),
        ...(typeof data.generation === "number" ? { generation: data.generation } : {}),
        ...(typeof data.resourceId === "string" ? { resourceId: data.resourceId } : {}),
        ...(typeof data.resourceRevision === "number" ? { resourceRevision: data.resourceRevision } : {}),
        ...(typeof data.scopeRevision === "number" ? { scopeRevision: data.scopeRevision } : {}),
    }
    const manifest = artifactDiskManifest(artifactDiskInput(metadataBase, data.iv, data.tag))
    if (manifest.manifestHash !== data.manifestHash) throw new GovernanceError("artifact_metadata_integrity", "artifact metadata digest does not match its contents", "failed_permanent")
    return { manifest, metadata: metadataBase }
}

interface TaricArtifactProjection {
    version: 2
    versionNumber: number
    storageMode: "taric_stored"
    artifactId: string
    contentRef: string
    sessionId: string
    category: string
    payloadKind: "text" | "binary" | "manifest"
    bytes: number
    sha256: string
    manifestHash: string
    mediaType: string
    committedAt: string
    redacted: boolean
    contentStatus: "available" | "deleted"
    workRunId?: string
    attemptId?: string
    generation?: number
    resourceId?: string
    resourceRevision?: number
    scopeRevision?: number
    ownerHost?: string
}

function taricArtifactProjection(metadata: ArtifactMetadata): TaricArtifactProjection {
    if (metadata.storageMode !== "taric_stored" || !metadata.sessionId || !metadata.category || !metadata.payloadKind || metadata.version === undefined) {
        throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection is incomplete", "failed_permanent")
    }
    return {
        version: 2,
        versionNumber: metadata.version,
        storageMode: "taric_stored",
        artifactId: metadata.artifactId,
        contentRef: metadata.contentRef,
        sessionId: metadata.sessionId,
        category: metadata.category,
        payloadKind: metadata.payloadKind,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        manifestHash: metadata.manifestHash,
        mediaType: metadata.mediaType,
        committedAt: metadata.committedAt,
        redacted: metadata.redacted,
        contentStatus: metadata.contentStatus,
        ...(metadata.workRunId ? { workRunId: metadata.workRunId } : {}),
        ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
        ...(metadata.generation !== undefined ? { generation: metadata.generation } : {}),
        ...(metadata.resourceId ? { resourceId: metadata.resourceId } : {}),
        ...(metadata.resourceRevision !== undefined ? { resourceRevision: metadata.resourceRevision } : {}),
        ...(metadata.scopeRevision !== undefined ? { scopeRevision: metadata.scopeRevision } : {}),
        ...(metadata.ownerHost ? { ownerHost: metadata.ownerHost } : {}),
    }
}

function parseTaricArtifactProjection(value: unknown, path: string): ArtifactMetadata {
    if (!isRecord(value) || value.version !== 2 || value.storageMode !== "taric_stored") throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection is invalid", "failed_permanent")
    const artifactId = value.artifactId
    const contentRef = value.contentRef
    const sessionId = value.sessionId
    if (typeof artifactId !== "string" || !UUID.test(artifactId) || typeof contentRef !== "string" || contentRef !== `${artifactId}@v${value.versionNumber ?? 1}` || typeof sessionId !== "string" || !sessionId.trim()) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection identity is invalid", "failed_permanent")
    if (typeof value.category !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.category) || !["text", "binary", "manifest"].includes(String(value.payloadKind))) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection category is invalid", "failed_permanent")
    if (!Number.isSafeInteger(value.versionNumber) || Number(value.versionNumber) < 1 || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.sha256) || typeof value.manifestHash !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.manifestHash)) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection digest or size is invalid", "failed_permanent")
    if (typeof value.mediaType !== "string" || !value.mediaType.trim() || typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt)) || typeof value.redacted !== "boolean" || (value.contentStatus !== "available" && value.contentStatus !== "deleted")) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact projection metadata is invalid", "failed_permanent")
    const metadata: ArtifactMetadata = {
        artifactId,
        contentRef,
        path,
        bytes: Number(value.bytes),
        sha256: value.sha256,
        manifestHash: value.manifestHash,
        mediaType: value.mediaType,
        committedAt: value.committedAt,
        redacted: value.redacted,
        contentStatus: value.contentStatus,
        storageMode: "taric_stored",
        integrityStatus: "verified",
        category: value.category,
        payloadKind: value.payloadKind as ArtifactMetadata["payloadKind"],
        version: Number(value.versionNumber),
        sessionId,
        ...(typeof value.workRunId === "string" ? { workRunId: value.workRunId } : {}),
        ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
        ...(typeof value.generation === "number" ? { generation: value.generation } : {}),
        ...(typeof value.resourceId === "string" ? { resourceId: value.resourceId } : {}),
        ...(typeof value.resourceRevision === "number" ? { resourceRevision: value.resourceRevision } : {}),
        ...(typeof value.scopeRevision === "number" ? { scopeRevision: value.scopeRevision } : {}),
        ...(typeof value.ownerHost === "string" ? { ownerHost: value.ownerHost } : {}),
    }
    if (metadata.workRunId !== undefined && (!UUID.test(metadata.workRunId) || metadata.attemptId === undefined || !UUID.test(metadata.attemptId) || metadata.generation === undefined || !Number.isSafeInteger(metadata.generation) || metadata.generation < 1)) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact WorkRun provenance is invalid", "failed_permanent")
    return metadata
}

function mapCommittedTaricArtifact(value: CommittedTaricArtifact, path: string, redacted: boolean, committedAt = new Date().toISOString()): ArtifactMetadata {
    if (value.storageMode !== "taric_stored" || value.contentStatus !== "available" || value.integrityStatus !== "verified" || value.category !== "evidence") throw new GovernanceError("artifact_not_committed", "Taric did not return a committed authority-critical evidence Artifact", "rejected_authorization")
    if (value.contentRef !== `${value.artifactId}@v${value.version}` || !/^sha256:[0-9a-f]{64}$/i.test(value.contentHash) || !/^sha256:[0-9a-f]{64}$/i.test(value.manifestHash) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1) throw new GovernanceError("artifact_integrity", "Taric committed Artifact identity or integrity is invalid", "failed_permanent")
    return {
        artifactId: value.artifactId,
        contentRef: value.contentRef,
        path,
        bytes: value.byteLength,
        sha256: value.contentHash,
        manifestHash: value.manifestHash,
        mediaType: value.mediaType,
        committedAt,
        redacted,
        contentStatus: "available",
        storageMode: "taric_stored",
        integrityStatus: "verified",
        category: value.category,
        payloadKind: value.payloadKind,
        version: value.version,
        sessionId: value.sessionId,
        ...(value.workRunId ? { workRunId: value.workRunId } : {}),
        ...(value.attemptId ? { attemptId: value.attemptId } : {}),
        ...(value.generation !== undefined ? { generation: value.generation } : {}),
        ...(value.ownerHost ? { ownerHost: value.ownerHost } : {}),
    }
}

function encrypt(bytes: Uint8Array, key: Uint8Array): { iv: string; tag: string; data: Uint8Array } {
    if (key.byteLength !== 32) throw new GovernanceError("artifact_key_unavailable", "artifact encryption key must be 32 bytes", "failed_permanent")
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv)
    const data = Buffer.concat([cipher.update(bytes), cipher.final()])
    return { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: new Uint8Array(data) }
}

function collectSensitive(value: unknown, depth = 0): boolean {
    if (depth > 8) return true
    if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([key, item]) => SENSITIVE_KEY.test(key) || collectSensitive(item, depth + 1))
    return false
}

export interface AuthorizedPentestGovernanceOptions {
    host: TaricHostModule
    reviewer?: TaricHostModule
    /** Deterministic reviewer identities are restricted to explicitly configured local fixtures. */
    reviewerKind?: "reviewer" | "deterministic"
    allowDeterministicFixtureReviewer?: boolean
    setup: AuthorizedProjectSetup
    artifactRoot: string
    artifactKey: Uint8Array
    /** Taric-managed Artifact transport. Omit only for legacy local fixtures. */
    artifactService?: Pick<TaricArtifactService, "bindSession" | "storeArtifact" | "metadata" | "consumeArtifact">
    /** Stable task-session identity supplied by the host/session boundary. */
    artifactSessionId?: string
    /** Taric content root used when binding the task session. */
    artifactSessionRoot?: string
    maxArtifactBytes?: number
    workLeaseTtlMs?: number
    readLimits?: Partial<GovernanceQueryLimits>
    /** Optional canonical report reader used when disposable report indexes are absent. */
    reportService?: Pick<TaricAuthorityReportService, "reconstruct">
}

export type AuthorizedLifecycleMode = "dual_write" | "taric_projection"

export interface AuthorizedProjection {
    format: "breachweave-authorized-projection/1"
    source: "canonical_taric_records"
    readSeq: number
    refreshedAt: string
    lifecycleMode: AuthorizedLifecycleMode
    diagnostics: { status: "complete"; reconciliation: "required" | "matched"; evidenceClass: "authority_projection" }
    scope: Record<string, unknown>[]
    scopeRevisions: Record<string, unknown>[]
    resources: Record<string, unknown>[]
    resourceRevisions: Record<string, unknown>[]
    work: Record<string, unknown>[]
    context: Record<string, unknown>[]
    coverage: Record<string, unknown>[]
    coverageGate: Record<string, unknown>
    evidence: Record<string, unknown>[]
    actionAudit: Record<string, unknown>[]
    report?: AuthorityReportProjection
}

export interface ProjectionReconciliation {
    reconciled: boolean
    lifecycleMode: AuthorizedLifecycleMode
    readSeq: number
    differences: string[]
    projection: AuthorizedProjection
}

export interface GovernanceReadOptions {
    cursor?: string
    readSeq?: number
    limits?: Partial<GovernanceQueryLimits>
}

const DEFAULT_GOVERNANCE_READ_LIMITS: GovernanceQueryLimits = {
    maxPages: 20,
    maxRecords: 500,
    maxBytes: 2 * 1024 * 1024,
}

/** Host-owned workflow boundary for authorized pentest projects. */
export class AuthorizedPentestGovernance {
    readonly setup: AuthorizedProjectSetup
    private readonly host: TaricHostModule
    private readonly reviewer?: TaricHostModule
    private readonly reviewerKind: "reviewer" | "deterministic"
    private readonly artifactRoot: string
    private readonly artifactKey: Uint8Array
    private readonly artifactService?: AuthorizedPentestGovernanceOptions["artifactService"]
    private readonly artifactSessionId?: string
    private readonly artifactSessionRoot: string
    private readonly maxArtifactBytes: number
    private readonly workLeaseTtlMs: number
    private readonly readLimits: GovernanceQueryLimits
    private readonly reportService?: Pick<TaricAuthorityReportService, "reconstruct">
    private readonly engagementArtifactRoot: string
    private readonly runs = new Map<string, WorkRun>()
    private readonly reservations = new Set<string>()
    private readonly recoveringRuns = new Set<string>()
    private readonly artifacts = new Map<string, ArtifactMetadata>()
    private readonly boundArtifactSessions = new Set<string>()
    private readonly coverage = new Map<string, CoverageCell>()
    private readonly reviews = new Map<string, ReviewDecision>()
    private artifactRecovery?: Promise<void>
    private readSeq = 0
    private closed = false
    private lifecycleMode: AuthorizedLifecycleMode = "dual_write"

    constructor(options: AuthorizedPentestGovernanceOptions) {
        this.setup = validateAuthorizedProjectSetup(options.setup)
        this.host = options.host
        this.reviewer = options.reviewer
        this.reviewerKind = options.reviewerKind ?? "reviewer"
        if (this.reviewerKind === "deterministic" && options.allowDeterministicFixtureReviewer !== true) throw new GovernanceError("reviewer_configuration", "deterministic reviewer requires an explicit local fixture allowance", "rejected_authorization")
        this.artifactRoot = resolve(options.artifactRoot)
        this.engagementArtifactRoot = join(this.artifactRoot, this.setup.project.taric_engagement_id)
        this.artifactKey = options.artifactKey
        this.artifactService = options.artifactService
        this.artifactSessionId = options.artifactSessionId?.trim() || undefined
        this.artifactSessionRoot = resolve(options.artifactSessionRoot ?? this.artifactRoot)
        if (this.artifactService && !this.artifactSessionId) throw new GovernanceError("artifact_session_missing", "Taric-managed Artifacts require an explicit task-session identity", "rejected_authorization")
        this.maxArtifactBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024
        this.workLeaseTtlMs = options.workLeaseTtlMs ?? 60_000
        this.readLimits = { ...DEFAULT_GOVERNANCE_READ_LIMITS, ...options.readLimits }
        this.reportService = options.reportService
        validateLeaseTtl(this.workLeaseTtlMs)
        for (const item of this.setup.manifest) for (const category of item.testCategories) {
            const cellId = `${item.resourceId}:${item.revision}:${this.setup.project.scope_revision}:${category}`
            this.coverage.set(cellId, { cellId, resourceId: item.resourceId, resourceRevision: item.revision, scopeRevision: this.setup.project.scope_revision, category, status: "not_tested", evidenceRefs: [], version: 0 })
        }
    }

    /**
     * Select the lifecycle read mode only after a successful authority
     * reconciliation. During migration, dual-write keeps the legacy writer
     * available while all trusted reads come from this projection.
     */
    private setLifecycleMode(mode: AuthorizedLifecycleMode): void { this.lifecycleMode = mode }

    getLifecycleMode(): AuthorizedLifecycleMode { return this.lifecycleMode }

    /**
     * Rebuild all authorized Planner/Solver and Web inputs from Taric at one
     * pinned watermark. No process-local run, coverage, report or session map
     * participates in this read. An incomplete page or watermark mismatch
     * blocks the projection instead of producing an empty fallback.
     */
    async rebuildProjection(options: { contextBudget?: number } = {}): Promise<AuthorizedProjection> {
        await this.assertReady()
        const contextBudget = options.contextBudget ?? 50_000
        if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 50_000) throw new GovernanceError("projection_budget", "projection context budget is invalid")
        const binding = this.host.getBinding()
        const readKinds = async (kind: string, readSeq?: number): Promise<GovernanceQueryResult<Record<string, unknown>>> => {
            const result = await readGovernancePages({
                kind: "resource", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: { kind, include_candidates: true }, pageSize: 50, ...(readSeq === undefined ? {} : { readSeq }) },
                limits: this.readLimits, snapshotPinned: true, pageKey: "records", readSeqInput: "as_of", query: (request) => this.host.invokeHost("resource.query", request),
                parseRecord: (value) => {
                    const item = recordValue(value, "projection record")
                    if (item.kind !== kind || item.engagement_id !== binding.engagementId || !["L1", "L2"].includes(String(item.trust_level))) throw new GovernanceError("projection_untrusted_record", "projection requires canonical records in the bound Engagement", "rejected_authorization")
                    return item
                },
            })
            if (result.diagnostics.status !== "complete" || result.diagnostics.hasMore || result.nextCursor !== undefined || result.readSeq === undefined) throw new GovernanceError("incomplete_authority_snapshot", `Taric ${kind} projection is incomplete`, "rejected_authorization")
            return result
        }
        const scopeResult = await readKinds("scope")
        const readSeq = scopeResult.readSeq!
        const [scopeRevisions, resources, resourceRevisions, work, context, manifests, evidence] = await Promise.all([
            readKinds("scope_revision", readSeq),
            readKinds("resource", readSeq),
            readKinds("resource_revision", readSeq),
            this.readWork({}, { readSeq }),
            this.readContext({ budget: contextBudget, includeAdmitted: true }, { readSeq }),
            readKinds("coverage_manifest", readSeq),
            readKinds("evidence", readSeq),
        ])
        // Active WorkRun discovery is a live join in Taric. Keep the complete
        // pinned WorkItem snapshot as the authority for identity and attach
        // only the live locator; startup still validates it through work.resume.
        const activeWork = await this.readWork({ includeActiveRuns: true })
        if (activeWork.diagnostics.status !== "unpinned" || activeWork.diagnostics.hasMore || activeWork.nextCursor !== undefined) throw new GovernanceError("incomplete_authority_snapshot", "Taric active WorkRun locator query is incomplete", "rejected_authorization")
        const activeRunsByWorkItem = new Map(activeWork.records.map((item) => [String(item.id), item.active_run]))
        const all = [scopeRevisions, resources, resourceRevisions, work, context, manifests, evidence]
        if (all.some((result) => result.diagnostics.status !== "complete" || result.diagnostics.hasMore || result.nextCursor !== undefined || result.readSeq !== readSeq)) throw new GovernanceError("incomplete_authority_snapshot", "Taric projection queries do not share one complete watermark", "rejected_authorization")
        const manifest = manifests.records.find((entry) => entry.id === this.setup.project.coverage_manifest_id)
        if (!manifest || typeof manifest.manifest_digest !== "string") throw new GovernanceError("incomplete_authority_snapshot", "Canonical project Coverage manifest is unavailable", "rejected_authorization")
        const scopeRevision = scopeRevisions.records.find((entry) => entry.id === manifest.scope_revision_ref)
        const scope = scopeResult.records.find((entry) => entry.id === scopeRevision?.scope_ref)
        if (!scopeRevision || !scope || scope.current_revision_ref !== scopeRevision.id || scope.revision_state !== "approved" || scopeRevision.approval_status !== "approved" || scope.policy_digest !== scopeRevision.policy_digest || manifest.policy_digest !== scopeRevision.policy_digest || !scopeRevision.roe_artifact_ref || !scopeRevision.roe_content_hash) throw new GovernanceError("incomplete_authority_snapshot", "Canonical Scope/ROE does not resolve the project manifest", "rejected_authorization")
        const policy = recordValue(scopeRevision.policy, "ScopeRevision policy")
        if (!Number.isFinite(Date.parse(String(policy.valid_from))) || !Number.isFinite(Date.parse(String(policy.valid_until))) || Date.now() < Date.parse(String(policy.valid_from)) || Date.now() >= Date.parse(String(policy.valid_until))) throw new GovernanceError("stale_scope", "Canonical ScopeRevision is outside its effective window", "rejected_authorization")
        const coverage = await new TaricAuthorityCoverageService({ host: this.host }).snapshot({ manifestId: String(manifest.id), manifestDigest: manifest.manifest_digest, readSeq })
        if (coverage.readSeq !== readSeq || !coverage.diagnostics.completeDomain || coverage.diagnostics.status !== "complete" || coverage.diagnostics.hasMore) throw new GovernanceError("incomplete_authority_snapshot", "Taric Coverage projection is incomplete", "rejected_authorization")
        const actionAudit = await readGovernancePages<Record<string, unknown>>({ kind: "action", binding: { principalId: binding.hostPrincipalId, engagementId: binding.engagementId, filters: {}, pageSize: 50, readSeq }, limits: this.readLimits, snapshotPinned: true, pageKey: "events", readSeqInput: "read_seq", query: (request) => this.host.invokeHost("action.audit.query", request), parseRecord: (value) => { const event = recordValue(value, "action audit event"); return { ...event, id: requiredText(String(event.event_id), "action event id") } } })
        if (actionAudit.readSeq !== readSeq || actionAudit.diagnostics.status !== "complete" || actionAudit.diagnostics.hasMore) throw new GovernanceError("incomplete_authority_snapshot", "Taric Action audit projection is incomplete", "rejected_authorization")
        if (!Array.isArray(manifest.expected_cells) || !manifest.expected_cells.length) throw new GovernanceError("incomplete_authority_snapshot", "Canonical manifest dimensions are unavailable", "rejected_authorization")
        const expectedCells = manifest.expected_cells.map((value) => recordValue(value, "manifest dimension"))
        const resourceIds = new Set(expectedCells.map((cell) => String(cell.resource_ref)))
        const revisionIds = new Set(expectedCells.map((cell) => String(cell.resource_revision_ref)))
        const scopedResources = resources.records.filter((item) => resourceIds.has(String(item.id)))
        const scopedRevisions = resourceRevisions.records.filter((item) => revisionIds.has(String(item.id)) && resourceIds.has(String(item.resource_ref)))
        if (scopedResources.length !== resourceIds.size || scopedRevisions.length !== revisionIds.size) throw new GovernanceError("incomplete_authority_snapshot", "Canonical manifest Resource/Revision membership is unresolved", "rejected_authorization")
        const memberIds = new Set([...resourceIds, ...revisionIds])
        const admittedWork = work.records
            .filter((item) => item.scope_ref === scope.id && Array.isArray(item.resource_refs) && item.resource_refs.some((id) => memberIds.has(String(id))) && item.resource_refs.every((id) => memberIds.has(String(id))))
        const scopedWork: Record<string, unknown>[] = admittedWork.map((item): Record<string, unknown> => {
            const activeRun = activeRunsByWorkItem.get(String(item.id))
            return { ...item, ...(activeRun && typeof activeRun === "object" ? { active_run: activeRun } : {}) }
        })
        const workIds = new Set(scopedWork.map((item) => String(item.id)))
        const scopedEvidence = evidence.records.filter((item) => resourceIds.has(String(item.resource_ref)) && (!item.resource_revision_ref || revisionIds.has(String(item.resource_revision_ref))))
        scopedEvidence.forEach((item) => memberIds.add(String(item.id)))
        workIds.forEach((id) => memberIds.add(id))
        const scopedContext = context.records.filter((item) => memberIds.has(String(item.id)) || resourceIds.has(String(item.resource_ref)) || workIds.has(String(item.work_item_ref)) || ["resource_refs", "evidence_refs", "subject_refs", "observation_refs"].some((field) => Array.isArray(item[field]) && (item[field] as unknown[]).some((id) => memberIds.has(String(id)))))
        const auditRunIds = [...new Set(actionAudit.records.map((event: Record<string, unknown>) => String(event.work_run_id)))].filter((id) => UUID.test(id))
        if (auditRunIds.length > 128) throw new GovernanceError("incomplete_authority_snapshot", "Action audit run inventory exceeds its projection bound", "rejected_authorization")
        const scopedRunIds = new Set<string>()
        for (const runId of auditRunIds) {
            const packet = operationData(await this.host.invokeHost("work.resume", { work_run_id: runId }))
            const run = recordValue(packet.run, "audit WorkRun")
            if (run.run_id === runId && run.engagement_id === binding.engagementId && workIds.has(String(run.work_item_ref ?? run.work_item_id))) scopedRunIds.add(runId)
        }
        const projection: AuthorizedProjection = {
            format: "breachweave-authorized-projection/1", source: "canonical_taric_records", readSeq, refreshedAt: new Date().toISOString(), lifecycleMode: this.lifecycleMode,
            diagnostics: { status: "complete", reconciliation: this.lifecycleMode === "taric_projection" ? "matched" : "required", evidenceClass: "authority_projection" },
            scope: [scope], scopeRevisions: [scopeRevision], resources: scopedResources, resourceRevisions: scopedRevisions,
            work: scopedWork, context: scopedContext, coverage: coverage.cells, coverageGate: coverage.gate, evidence: scopedEvidence, actionAudit: actionAudit.records.filter((event: Record<string, unknown>) => scopedRunIds.has(String(event.work_run_id))),
        }
        if (this.reportService) {
            projection.report = await this.reportService.reconstruct(readSeq)
        }
        return projection
    }

    /** Compare a disposable local projection with canonical Taric metadata. */
    async reconcileProjection(localProjection?: Record<string, unknown>): Promise<ProjectionReconciliation> {
        const projection = await this.rebuildProjection()
        const differences: string[] = []
        if (localProjection !== undefined) {
            const compare = (field: keyof AuthorizedProjection): void => {
                const local = localProjection[field]
                if (local === undefined) return
                if (JSON.stringify(local) !== JSON.stringify(projection[field])) differences.push(field)
            }
            for (const field of ["scope", "scopeRevisions", "resources", "resourceRevisions", "work", "context", "coverage", "coverageGate"] as const) compare(field)
        }
        if (differences.length > 0 && this.lifecycleMode === "taric_projection") this.lifecycleMode = "dual_write"
        return { reconciled: differences.length === 0, lifecycleMode: this.lifecycleMode, readSeq: projection.readSeq, differences, projection }
    }

    /** Cut over only after a complete legacy projection matches Taric. */
    async cutoverToTaricProjection(localProjection: Record<string, unknown>): Promise<ProjectionReconciliation> {
        const required = ["scope", "scopeRevisions", "resources", "resourceRevisions", "work", "context", "coverage", "coverageGate"]
        if (required.some((field) => !Object.hasOwn(localProjection, field))) throw new GovernanceError("projection_reconciliation_required", "cutover requires a complete local projection for comparison", "rejected_authorization")
        this.setLifecycleMode("dual_write")
        const reconciliation = await this.reconcileProjection(localProjection)
        if (!reconciliation.reconciled) throw new GovernanceError("projection_reconciliation_mismatch", `authorized projection differs in: ${reconciliation.differences.join(", ")}`, "rejected_authorization")
        this.setLifecycleMode("taric_projection")
        return { ...reconciliation, lifecycleMode: this.lifecycleMode, projection: { ...reconciliation.projection, lifecycleMode: this.lifecycleMode } }
    }

    async assertReady(): Promise<void> {
        if (this.closed) throw new GovernanceError("engagement_closed", "authorized Engagement is closed", "rejected_authorization")
        const health = await this.host.initialize()
        if (health.status !== "healthy") throw new GovernanceError("taric_unavailable", health.reason ?? "Taric authority unavailable", "rejected_authorization")
        const binding = this.host.getBinding()
        if (binding.tenantId !== this.setup.project.tenant_id || binding.engagementId !== this.setup.project.taric_engagement_id) {
            throw new GovernanceError("engagement_binding", "Taric authority binding does not match the authorized project", "rejected_authorization")
        }
    }

    authorizeAction(request: EgressRequest): PolicyDecision {
        if (this.closed) return { allowed: false, reason: "authorized Engagement is closed", normalizedUrls: [] }
        return evaluateEgress(this.setup.scope, this.setup.testWindow, request)
    }

    /** Enforce the host egress policy after checking live Taric authority health. */
    async assertActionAllowed(request: EgressRequest): Promise<PolicyDecision> {
        await this.assertReady()
        const decision = this.authorizeAction(request)
        if (!decision.allowed) throw new GovernanceError("egress_denied", decision.reason, "rejected_authorization")
        return decision
    }

    private artifactSession(run?: WorkRun): { sessionId: string; root: string; mode: "host-session" | "run-bound" } {
        if (!this.artifactService || !this.artifactSessionId) throw new GovernanceError("artifact_service_unavailable", "Taric Artifact service is not configured", "rejected_authorization")
        // A run-bound session is immutable for one WorkRun generation. The
        // deterministic suffix keeps retries on the same fence idempotent and
        // prevents a later run from reusing a completed task session.
        const sessionId = run ? `${this.artifactSessionId}-run-${run.runId}` : `${this.artifactSessionId}-host`
        return { sessionId, root: join(this.artifactSessionRoot, sessionId), mode: run ? "run-bound" : "host-session" }
    }

    private async bindArtifactSession(run?: WorkRun): Promise<{ sessionId: string; root: string }> {
        const session = this.artifactSession(run)
        if (this.boundArtifactSessions.has(session.sessionId)) return session
        if (session.mode === "run-bound") {
            await this.artifactService!.bindSession({
                sessionId: session.sessionId,
                root: session.root,
                mode: session.mode,
                workRunId: run!.runId,
                attemptId: run!.attemptId,
                generation: run!.generation,
                ownerHost: this.host.getBinding().hostPrincipalId,
            })
        } else {
            await this.artifactService!.bindSession({ sessionId: session.sessionId, root: session.root, mode: session.mode })
        }
        this.boundArtifactSessions.add(session.sessionId)
        return session
    }

    private async writeTaricProjection(metadata: ArtifactMetadata): Promise<void> {
        const folder = join(this.engagementArtifactRoot, metadata.artifactId)
        const pendingFolder = join(this.engagementArtifactRoot, `.pending-${metadata.artifactId}`)
        await mkdir(pendingFolder, { recursive: true })
        try {
            await Bun.write(join(pendingFolder, "metadata.json"), `${JSON.stringify(taricArtifactProjection(metadata), null, 2)}\n`)
            if (await Bun.file(join(folder, "metadata.json")).exists()) {
                const existing = parseTaricArtifactProjection(await Bun.file(join(folder, "metadata.json")).json(), folder)
                if (existing.contentRef !== metadata.contentRef || existing.sha256 !== metadata.sha256 || existing.manifestHash !== metadata.manifestHash || existing.sessionId !== metadata.sessionId) throw new GovernanceError("artifact_reference_mismatch", "local Taric Artifact projection conflicts with the committed reference", "failed_permanent")
                await rm(pendingFolder, { recursive: true, force: true })
            } else {
                await rename(pendingFolder, folder)
            }
            metadata.path = folder
        } catch (error) {
            await rm(pendingFolder, { recursive: true, force: true })
            throw error
        }
    }

    private async refreshTaricMetadata(metadata: ArtifactMetadata): Promise<ArtifactMetadata> {
        if (!this.artifactService || metadata.storageMode !== "taric_stored" || !metadata.sessionId) return metadata
        const committed = await this.artifactService.metadata(metadata.sessionId, metadata.contentRef)
        if (committed.artifactId !== metadata.artifactId || committed.version !== metadata.version || committed.contentRef !== metadata.contentRef || committed.contentHash !== metadata.sha256 || committed.manifestHash !== metadata.manifestHash || committed.byteLength !== metadata.bytes || committed.mediaType !== metadata.mediaType || committed.category !== metadata.category || committed.payloadKind !== metadata.payloadKind || committed.workRunId !== metadata.workRunId || committed.attemptId !== metadata.attemptId || committed.generation !== metadata.generation) throw new GovernanceError("artifact_reference_mismatch", "Taric committed Artifact metadata differs from the local reference", "failed_permanent")
        return metadata
    }

    private async commitManagedArtifact(input: { bytes: Uint8Array; mediaType: string; redacted: boolean; run?: WorkRun }): Promise<ArtifactMetadata> {
        const session = await this.bindArtifactSession(input.run)
        const requestDigest = sha256(input.bytes).slice(0, 32)
        const requestId = `bw-artifact-${requestDigest}-${(input.run?.runId ?? "host").slice(0, 8)}`
        const committed = await this.artifactService!.storeArtifact({ sessionId: session.sessionId, requestId, category: "evidence", payloadKind: "binary", mediaType: input.mediaType, payload: input.bytes, storageMode: "taric_stored" })
        const metadata = mapCommittedTaricArtifact(committed, "", input.redacted)
        if (input.run && (metadata.workRunId !== input.run.runId || metadata.attemptId !== input.run.attemptId || metadata.generation !== input.run.generation || metadata.ownerHost !== this.host.getBinding().hostPrincipalId)) throw new GovernanceError("artifact_provenance_mismatch", "Taric committed Artifact does not match the active WorkRun fence", "rejected_authorization")
        if (input.run) {
            metadata.resourceId = input.run.targetResourceId
            metadata.resourceRevision = this.manifestRevision(input.run.targetResourceId)
            metadata.scopeRevision = this.setup.project.scope_revision
        }
        await this.refreshTaricMetadata(metadata)
        await this.writeTaricProjection(metadata)
        this.artifacts.set(metadata.contentRef, metadata)
        return { ...metadata }
    }

    private async ensureArtifactMetadata(): Promise<void> {
        if (!this.artifactRecovery) this.artifactRecovery = this.loadArtifactMetadata()
        try {
            await this.artifactRecovery
        } catch (error) {
            this.artifactRecovery = undefined
            throw error
        }
    }

    private async loadArtifactMetadata(): Promise<void> {
        await mkdir(this.engagementArtifactRoot, { recursive: true })
        const entries = await readdir(this.engagementArtifactRoot, { withFileTypes: true })
        const recovered = new Map<string, ArtifactMetadata>()
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const folder = join(this.engagementArtifactRoot, entry.name)
            if (entry.name.startsWith(".pending-")) {
                await rm(folder, { recursive: true, force: true })
                continue
            }
            if (!UUID.test(entry.name)) continue
            let raw: unknown
            try {
                raw = await Bun.file(join(folder, "metadata.json")).json()
            } catch {
                throw new GovernanceError("artifact_metadata_missing", `artifact ${entry.name} has no readable committed metadata`, "failed_permanent")
            }
            if (isRecord(raw) && raw.storageMode === "taric_stored") {
                const metadata = parseTaricArtifactProjection(raw, folder)
                recovered.set(metadata.contentRef, metadata)
                continue
            }
            const { manifest, metadata } = parseArtifactDiskManifest(raw, entry.name, folder)
            const payloadPath = join(folder, "payload.enc")
            if (manifest.contentStatus === "available") {
                const payload = Bun.file(payloadPath)
                if (!(await payload.exists()) || payload.size !== metadata.bytes) throw new GovernanceError("artifact_payload_missing", `artifact ${entry.name} payload is unavailable`, "failed_permanent")
            } else {
                await rm(payloadPath, { force: true })
            }
            recovered.set(metadata.contentRef, metadata)
        }
        this.artifacts.clear()
        for (const [contentRef, metadata] of recovered) this.artifacts.set(contentRef, metadata)
        await this.removeExpiredArtifacts(Date.now())
    }

    private async writeArtifactManifest(metadata: ArtifactMetadata, iv: string, tag: string): Promise<void> {
        const manifest = artifactDiskManifest(artifactDiskInput(metadata, iv, tag))
        const temporaryPath = join(metadata.path, "metadata.json.next")
        await Bun.write(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
        await rename(temporaryPath, join(metadata.path, "metadata.json"))
        metadata.manifestHash = manifest.manifestHash
    }

    private async removeExpiredArtifacts(now: number): Promise<number> {
        // Taric owns the managed payload. Until a host retention adapter can
        // authorize deletion through Taric, never pretend a local tombstone
        // removed those bytes.
        if (this.artifactService) return 0
        const retentionMs = this.setup.retentionDays * 24 * 60 * 60 * 1000
        let deleted = 0
        for (const metadata of this.artifacts.values()) {
            if (metadata.contentStatus !== "available" || now - Date.parse(metadata.committedAt) < retentionMs) continue
            await this.markArtifactDeleted(metadata)
            deleted += 1
        }
        return deleted
    }

    private async markArtifactDeleted(metadata: ArtifactMetadata): Promise<void> {
        const current = await Bun.file(join(metadata.path, "metadata.json")).json() as ArtifactDiskManifest
        const updated = { ...metadata, contentStatus: "deleted" as const }
        await this.writeArtifactManifest(updated, current.iv, current.tag)
        await rm(join(metadata.path, "payload.enc"), { force: true })
        this.artifacts.set(updated.contentRef, updated)
    }

    async recoverArtifacts(): Promise<void> {
        await this.ensureArtifactMetadata()
    }

    async purgeExpiredArtifacts(now = Date.now()): Promise<number> {
        if (!Number.isFinite(now)) throw new GovernanceError("invalid_retention_time", "retention sweep time must be a finite timestamp")
        await this.ensureArtifactMetadata()
        return this.removeExpiredArtifacts(now)
    }

    async claimWork(workItemId: string, ownerOrTargetResourceId: string, targetResourceId?: string): Promise<WorkRun> {
        await this.assertReady()
        const owner = targetResourceId ? ownerOrTargetResourceId : this.host.getBinding().hostPrincipalId
        const target = targetResourceId ?? ownerOrTargetResourceId
        requiredText(workItemId, "workItemId"); requiredText(owner, "owner"); requiredText(target, "targetResourceId")
        if (!this.setup.manifest.some((item) => item.resourceId === target)) throw new GovernanceError("resource_out_of_manifest", "work target is not present in the approved manifest", "rejected_authorization")
        if (this.reservations.has(target)) throw new GovernanceError("resource_busy", "target resource is already reserved", "rejected_authorization")
        this.reservations.add(target)
        try {
            const result = await this.host.invokeHost("work.claim", { work_item_id: workItemId, host_id: this.host.getBinding().hostPrincipalId, agent_id: owner, ttl_ms: this.workLeaseTtlMs })
            const data = operationData(result)
            const run = parseWorkRun(data, { workItemId, owner, targetResourceId: target })
            if (run.owner !== owner || Date.parse(run.leaseExpiresAt) <= Date.now()) throw new GovernanceError("invalid_work_run", "Taric returned a WorkRun with an invalid owner or expired lease", "failed_permanent")
            this.runs.set(run.runId, run); this.readSeq = Math.max(this.readSeq, Number(data.read_seq) || 0)
            return { ...run }
        } catch (error) {
            this.reservations.delete(target)
            throw error
        }
    }

    async captureObservation(input: HostObservationInput): Promise<{ outcome: GovernanceOutcome; result?: unknown; diagnostics: GovernanceDiagnostics }> {
        try {
            const run = this.requireRun(input.workRunId, this.runs.get(input.workRunId)?.owner ?? "", input.generation)
            await this.assertReady()
            await this.ensureArtifactMetadata()
            await this.removeExpiredArtifacts(Date.now())
            const resourceRevision = this.manifestRevision(input.resourceRef)
            if (run.targetResourceId !== input.resourceRef) throw new GovernanceError("observation_resource", "observation Resource must match the active WorkRun target", "rejected_authorization")
            const limitations = [
                ...(input.limitations ?? []),
                `Captured against Resource revision ${input.resourceRef}@${resourceRevision} and Scope revision ${this.setup.project.scope_revision}.`,
            ]
            const artifactRefs: TaricArtifactReferenceDto[] = []
            for (const ref of input.artifactRefs ?? []) {
                if (!("content_ref" in ref)) {
                    artifactRefs.push(ref)
                    continue
                }
                const metadata = this.artifacts.get(requiredText(ref.content_ref, "artifact content_ref"))
                if (!metadata || metadata.contentStatus !== "available") throw new GovernanceError("artifact_not_committed", "observation must reference an available committed artifact")
                if (this.artifactService) await this.refreshTaricMetadata(metadata)
                if (ref.artifact_id !== undefined && ref.artifact_id !== metadata.artifactId) throw new GovernanceError("artifact_reference_mismatch", "artifact_id does not match the committed artifact")
                if (metadata.workRunId && (metadata.workRunId !== run.runId || metadata.attemptId !== run.attemptId || metadata.generation !== run.generation)) throw new GovernanceError("artifact_provenance_mismatch", "artifact WorkRun provenance does not match the active observation")
                if (metadata.resourceId && (metadata.resourceId !== input.resourceRef || metadata.resourceRevision !== resourceRevision || metadata.scopeRevision !== this.setup.project.scope_revision)) throw new GovernanceError("artifact_provenance_mismatch", "artifact Resource or Scope revision does not match the active observation")
                if (metadata.redacted) limitations.push(`Artifact ${metadata.artifactId} was redacted before storage.`)
                artifactRefs.push({
                    content_ref: metadata.contentRef,
                    artifact_id: metadata.artifactId,
                    content_hash: metadata.sha256,
                    manifest_hash: metadata.manifestHash,
                    storage_mode: metadata.storageMode === "taric_stored" ? "taric_stored" : "external",
                    content_status: "available",
                    integrity_status: "verified",
                    media_type: metadata.mediaType,
                    byte_length: metadata.bytes,
                })
            }
            const observation = validateHostObservation({ ...input, artifactRefs, limitations })
            const result = await this.host.captureObservation({ eventId: `bw-observation:${run.runId}:${input.generation}:${this.readSeq + 1}`, sourceKind: "host_event", observation, workRunId: run.runId, generation: run.generation })
            this.readSeq += 1
            return { outcome: "accepted", result, diagnostics: { outcome: "accepted", code: "accepted", message: "observation accepted", operation: "capture.observation" } }
        } catch (error) {
            const diagnostics = classifyGovernanceError(error, "capture.observation")
            return { outcome: diagnostics.outcome, diagnostics }
        }
    }

    private requireRun(runId: string, owner: string, generation: number): WorkRun {
        const run = this.runs.get(runId)
        if (!run || run.owner !== owner || run.generation !== generation || Date.parse(run.leaseExpiresAt) <= Date.now()) throw new GovernanceError("stale_generation", "WorkRun owner or generation is stale", "rejected_authorization")
        return run
    }

    async transitionWork(runId: string, owner: string, generation: number, status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled"): Promise<void> {
        const run = this.requireRun(runId, owner, generation)
        await this.assertReady()
        await this.host.invokeHost("work.transition", { work_run_id: run.runId, generation: run.generation, status, idempotency_key: `bw:${run.runId}:${run.generation}:${status}` })
        if (["completed", "failed", "cancelled"].includes(status)) { this.runs.delete(run.runId); this.reservations.delete(run.targetResourceId) }
    }

    async renewWork(runId: string, owner: string, generation: number, ttlMs = this.workLeaseTtlMs): Promise<WorkRun> {
        const run = this.requireRun(runId, owner, generation)
        validateLeaseTtl(ttlMs)
        await this.assertReady()
        const result = await this.host.invokeHost("work.renew", { work_run_id: run.runId, generation: run.generation, ttl_ms: ttlMs })
        const data = operationData(result)
        const renewed = parseWorkRun(data, run)
        if (renewed.runId !== run.runId || renewed.workItemId !== run.workItemId || renewed.attemptId !== run.attemptId || renewed.targetResourceId !== run.targetResourceId || renewed.owner !== run.owner || renewed.generation !== run.generation || Date.parse(renewed.leaseExpiresAt) <= Date.now()) {
            throw new GovernanceError("invalid_lease_renewal", "Taric returned a lease renewal that changed WorkRun identity or is already expired", "failed_permanent")
        }
        this.runs.set(run.runId, renewed)
        return { ...renewed }
    }

    /**
     * Reclaim and resume a WorkRun after a process restart. The locator is
     * operator-supplied state from the previous process; Taric remains the
     * authority and must grant a strictly newer generation before any state is
     * restored locally.
     */
    async recoverWork(locator: WorkRecoveryLocator, owner = this.host.getBinding().hostPrincipalId, ttlMs = this.workLeaseTtlMs): Promise<RecoveredWorkRun> {
        await this.assertReady()
        validateLeaseTtl(ttlMs)
        requiredText(owner, "owner")
        if (!UUID.test(requiredText(locator.workRunId, "workRunId")) || !Number.isSafeInteger(locator.generation) || locator.generation < 1) throw new GovernanceError("invalid_recovery_locator", "recovery locator must include a Taric WorkRun and positive generation")
        requiredText(locator.workItemId, "workItemId"); requiredText(locator.attemptId, "attemptId"); requiredText(locator.targetResourceId, "targetResourceId")
        if (!this.setup.manifest.some((item) => item.resourceId === locator.targetResourceId)) throw new GovernanceError("resource_out_of_manifest", "recovered WorkRun target is not present in the approved manifest", "rejected_authorization")
        if (this.runs.has(locator.workRunId) || this.recoveringRuns.has(locator.workRunId)) throw new GovernanceError("work_already_loaded", "WorkRun is already loaded or being recovered", "rejected_authorization")
        if (this.reservations.has(locator.targetResourceId)) throw new GovernanceError("resource_busy", "target resource is already reserved", "rejected_authorization")
        this.recoveringRuns.add(locator.workRunId)
        this.reservations.add(locator.targetResourceId)
        let reclaimDispatched = false
        try {
            reclaimDispatched = true
            const reclaimedResult = await this.host.invokeHost("work.reclaim", { work_run_id: locator.workRunId, agent_id: owner, ttl_ms: ttlMs })
            const reclaimedData = operationData(reclaimedResult)
            const run = parseWorkRun(reclaimedData, {
                runId: locator.workRunId,
                workItemId: locator.workItemId,
                attemptId: locator.attemptId,
                targetResourceId: locator.targetResourceId,
            })
            if (run.owner !== owner || run.generation <= locator.generation || Date.parse(run.leaseExpiresAt) <= Date.now()) throw new GovernanceError("stale_recovery", "Taric did not grant a live newer WorkRun generation to this owner", "rejected_authorization")
            if (run.runId !== locator.workRunId || run.workItemId !== locator.workItemId || run.attemptId !== locator.attemptId || run.targetResourceId !== locator.targetResourceId) throw new GovernanceError("stale_recovery", "Taric WorkRun identity differs from the recovery locator", "rejected_authorization")

            const resumedResult = await this.host.invokeHost("work.resume", { work_run_id: run.runId, generation: run.generation })
            const resumedData = operationData(resumedResult)
            const resumedRun = resumedData.work_run && typeof resumedData.work_run === "object" ? parseWorkRun(resumedData, run) : run
            if (resumedRun.runId !== run.runId || resumedRun.owner !== owner || resumedRun.generation !== run.generation || resumedRun.attemptId !== run.attemptId || Date.parse(resumedRun.leaseExpiresAt) <= Date.now()) throw new GovernanceError("stale_recovery", "Taric resume returned a stale WorkRun", "rejected_authorization")
            if (!resumedData.checkpoint) throw new GovernanceError("checkpoint_unavailable", "Taric did not return an authoritative checkpoint for WorkRun recovery", "rejected_authorization")
            const checkpoint = parseCheckpoint(resumedData.checkpoint, resumedRun, this.setup.project.scope_revision, this.manifestRevision(resumedRun.targetResourceId))
            if (!checkpoint) throw new GovernanceError("checkpoint_unavailable", "Taric did not return an authoritative checkpoint for WorkRun recovery", "rejected_authorization")
            if (containsDisallowedCheckpoint(resumedData.checkpoint)) throw new GovernanceError("checkpoint_sensitive", "checkpoint contains a secret or hidden reasoning field")
            this.runs.set(resumedRun.runId, resumedRun)
            this.readSeq = Math.max(this.readSeq, Number(resumedData.read_seq) || Number(reclaimedData.read_seq) || 0)
            return { run: { ...resumedRun }, checkpoint }
        } catch (error) {
            if (!reclaimDispatched) this.reservations.delete(locator.targetResourceId)
            throw error
        } finally {
            this.recoveringRuns.delete(locator.workRunId)
        }
    }

    async commitArtifact(input: { bytes: Uint8Array; mediaType: string; redacted?: boolean; workRunId?: string; attemptId?: string; generation?: number }): Promise<ArtifactMetadata> {
        await this.assertReady()
        await this.ensureArtifactMetadata()
        await this.removeExpiredArtifacts(Date.now())
        if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxArtifactBytes) throw new GovernanceError("artifact_size", "artifact size is outside the configured bound")
        const mediaType = requiredText(input.mediaType, "mediaType")
        if (collectSensitive({ mediaType })) throw new GovernanceError("artifact_sensitive_metadata", "artifact metadata contains a sensitive field")
        let run: WorkRun | undefined
        if (input.workRunId) {
            run = this.requireRun(input.workRunId, this.runs.get(input.workRunId)?.owner ?? "", input.generation ?? 0)
            if (input.attemptId !== undefined && input.attemptId !== run.attemptId) throw new GovernanceError("artifact_provenance_mismatch", "artifact attempt does not match the active WorkRun")
        } else if (input.attemptId !== undefined || input.generation !== undefined) {
            throw new GovernanceError("artifact_provenance_mismatch", "artifact attempt and generation require a WorkRun")
        }

        if (this.artifactService) return this.commitManagedArtifact({ bytes: input.bytes, mediaType, redacted: input.redacted === true, ...(run ? { run } : {}) })

        const digest = sha256Digest(input.bytes)
        const artifactId = crypto.randomUUID()
        const contentRef = `artifact:${artifactId}`
        const folder = join(this.engagementArtifactRoot, artifactId)
        const pendingFolder = join(this.engagementArtifactRoot, `.pending-${artifactId}`)
        await mkdir(pendingFolder, { recursive: true })
        try {
            const encrypted = encrypt(input.bytes, this.artifactKey)
            await Bun.write(join(pendingFolder, "payload.enc"), encrypted.data)
            const metadata: ArtifactMetadata = {
                artifactId,
                contentRef,
                path: folder,
                bytes: input.bytes.byteLength,
                sha256: digest,
                manifestHash: "",
                mediaType,
                committedAt: new Date().toISOString(),
                redacted: input.redacted === true,
                contentStatus: "available",
                ...(run ? {
                    workRunId: run.runId,
                    attemptId: run.attemptId,
                    generation: run.generation,
                    resourceId: run.targetResourceId,
                    resourceRevision: this.manifestRevision(run.targetResourceId),
                    scopeRevision: this.setup.project.scope_revision,
                } : {}),
            }
            const manifest = artifactDiskManifest(artifactDiskInput(metadata, encrypted.iv, encrypted.tag))
            metadata.manifestHash = manifest.manifestHash
            await Bun.write(join(pendingFolder, "metadata.json"), `${JSON.stringify(manifest, null, 2)}\n`)
            await rename(pendingFolder, folder)
            this.artifacts.set(contentRef, metadata)
            this.readSeq += 1
            return { ...metadata }
        } catch (error) {
            await rm(pendingFolder, { recursive: true, force: true })
            throw error
        }
    }

    async getArtifactMetadata(contentRef: string): Promise<ArtifactMetadata> {
        await this.ensureArtifactMetadata()
        await this.removeExpiredArtifacts(Date.now())
        const metadata = this.artifacts.get(requiredText(contentRef, "contentRef")); if (!metadata) throw new GovernanceError("artifact_not_found", "artifact metadata is unavailable")
        if (this.artifactService && metadata.contentStatus === "available") await this.refreshTaricMetadata(metadata)
        return { ...metadata }
    }

    async readArtifact(contentRef: string, capability: "content_read" | undefined): Promise<Uint8Array> {
        if (capability !== "content_read") throw new GovernanceError("artifact_content_denied", "raw artifact content requires an explicit host capability", "rejected_authorization")
        const metadata = await this.getArtifactMetadata(contentRef)
        if (metadata.contentStatus !== "available") throw new GovernanceError("artifact_deleted", "artifact content was removed by retention or explicit deletion")
        if (this.artifactService && metadata.storageMode === "taric_stored") {
            if (!metadata.sessionId) throw new GovernanceError("artifact_metadata_invalid", "Taric Artifact session binding is missing", "failed_permanent")
            let recovered: Uint8Array | undefined
            await this.artifactService.consumeArtifact({ sessionId: metadata.sessionId, contentRef: metadata.contentRef }, async (bytes) => { recovered = new Uint8Array(bytes) })
            if (!recovered || recovered.byteLength !== metadata.bytes || sha256Digest(recovered) !== metadata.sha256) throw new GovernanceError("artifact_integrity", "Taric Artifact content does not match the committed reference", "failed_permanent")
            return recovered
        }
        try {
            const payload = await Bun.file(join(metadata.path, "payload.enc")).arrayBuffer()
            const rawManifest = await Bun.file(join(metadata.path, "metadata.json")).json()
            const { manifest } = parseArtifactDiskManifest(rawManifest, metadata.artifactId, metadata.path)
            const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.artifactKey), Buffer.from(manifest.iv, "base64url"))
            decipher.setAuthTag(Buffer.from(manifest.tag, "base64url"))
            const bytes = new Uint8Array(Buffer.concat([decipher.update(Buffer.from(payload)), decipher.final()]))
            if (sha256Digest(bytes) !== manifest.sha256 || manifest.sha256 !== metadata.sha256) throw new GovernanceError("artifact_integrity", "artifact digest does not match committed metadata", "failed_permanent")
            return bytes
        } catch (error) {
            if (error instanceof GovernanceError) throw error
            throw new GovernanceError("artifact_integrity", "artifact payload failed authenticated integrity verification", "failed_permanent")
        }
    }

    private proposalArtifactReference(value: unknown): unknown {
        const contentRef = typeof value === "string"
            ? value
            : isRecord(value) && typeof value.content_ref === "string"
                ? value.content_ref
                : undefined
        if (!contentRef) return value
        const metadata = this.artifacts.get(contentRef)
        if (!metadata || metadata.contentStatus !== "available") throw new GovernanceError("artifact_not_committed", "candidate proposal references an unavailable artifact")
        if (isRecord(value)) {
            if (value.artifact_id !== undefined && value.artifact_id !== metadata.artifactId) throw new GovernanceError("artifact_reference_mismatch", "candidate artifact_id does not match the committed artifact")
            if (value.content_hash !== undefined && value.content_hash !== metadata.sha256) throw new GovernanceError("artifact_reference_mismatch", "candidate content_hash does not match the committed artifact")
        }
        return {
            ...(isRecord(value) ? value : {}),
            content_ref: metadata.contentRef,
            artifact_id: metadata.artifactId,
            ...(metadata.workRunId ? { provenance_ref: metadata.workRunId } : {}),
            content_hash: metadata.sha256,
            manifest_hash: metadata.manifestHash,
            storage_mode: "external",
            content_status: "available",
            integrity_status: "verified",
            media_type: metadata.mediaType,
            byte_length: metadata.bytes,
        }
    }

    private linkProposalArtifacts(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((item) => this.linkProposalArtifacts(item))
        if (!isRecord(value)) return value
        const linked: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
            if (key === "artifact_refs" && Array.isArray(item)) {
                linked[key] = item.map((ref) => this.proposalArtifactReference(ref))
                continue
            }
            if (key === "evidence_refs" && Array.isArray(item) && item.some((ref) => typeof ref === "string" && (ref.startsWith("artifact:") || ref.includes("@v")))) {
                throw new GovernanceError("candidate_artifact_field", "artifact content references belong in artifact_refs; evidence_refs must reference Taric Evidence records")
            }
            linked[key] = this.linkProposalArtifacts(item)
        }
        return linked
    }

    async submitCandidateProposal(input: TaricProposalInput): Promise<unknown> {
        await this.assertReady()
        await this.ensureArtifactMetadata()
        await this.removeExpiredArtifacts(Date.now())
        if (input.subjectType !== "claim" && input.subjectType !== "test_hypothesis") throw new GovernanceError("candidate_subject", "authorized candidates must be Claims or test hypotheses")
        const artifactRefs = Array.isArray(input.content.artifact_refs) ? input.content.artifact_refs : []
        if (this.artifactService) {
            for (const ref of artifactRefs) {
                const contentRef = typeof ref === "string" ? ref : isRecord(ref) && typeof ref.content_ref === "string" ? ref.content_ref : undefined
                const metadata = contentRef ? this.artifacts.get(contentRef) : undefined
                if (metadata) await this.refreshTaricMetadata(metadata)
            }
        }
        const content = this.linkProposalArtifacts(input.content) as Record<string, unknown>
        const artifactLimitations = artifactRefs.flatMap((ref) => {
            const contentRef = typeof ref === "string" ? ref : isRecord(ref) && typeof ref.content_ref === "string" ? ref.content_ref : undefined
            const metadata = contentRef ? this.artifacts.get(contentRef) : undefined
            if (!metadata) return []
            const provenance = metadata.workRunId
                ? ` WorkRun ${metadata.workRunId} generation ${metadata.generation} captured against Resource revision ${metadata.resourceId}@${metadata.resourceRevision} and Scope revision ${metadata.scopeRevision}.`
                : ""
            const redaction = metadata.redacted ? " It was redacted before storage." : " It is not marked as redacted."
            return [`Artifact ${metadata.artifactId}.${provenance}${redaction}`]
        })
        if (artifactLimitations.length > 0) {
            if (content.limitations !== undefined && !Array.isArray(content.limitations)) throw new GovernanceError("candidate_limitations", "candidate limitations must be an array")
            const limitations = Array.isArray(content.limitations) ? content.limitations : []
            content.limitations = [...new Set([...limitations, ...artifactLimitations])]
        }
        return this.host.submitProposal({ ...input, content })
    }

    async recordCoverage(cellId: string, input: { expectedVersion: number; status: CoverageStatus; evidenceRefs?: readonly string[]; justification?: string }, actor: "host" | "operator" = "host"): Promise<CoverageCell> {
        await this.assertReady(); if (actor !== "host" && actor !== "operator") throw new GovernanceError("coverage_actor", "only host/operator may write coverage", "rejected_authorization")
        const cell = this.coverage.get(requiredText(cellId, "cellId")); if (!cell) throw new GovernanceError("coverage_not_found", "coverage cell does not exist")
        if (cell.version !== input.expectedVersion) throw new GovernanceError("coverage_conflict", "coverage version is stale", "rejected_authorization")
        if (input.justification !== undefined && SENSITIVE_TEXT.test(input.justification)) throw new GovernanceError("coverage_sensitive", "coverage justification contains a sensitive value")
        const evidenceRefs = [...new Set(input.evidenceRefs ?? [])]
        if (evidenceRefs.some((ref) => !UUID.test(ref))) throw new GovernanceError("coverage_evidence_ref", "coverage evidenceRefs must reference Taric Evidence UUIDs; use artifact_refs on the Observation")
        if (input.status === "positive" && evidenceRefs.length === 0) throw new GovernanceError("coverage_evidence", "positive coverage requires evidence references")
        if (input.status === "not_applicable" && !input.justification?.trim()) throw new GovernanceError("coverage_justification", "not_applicable requires a justification")
        const result = await this.host.invokeHost("coverage.record", { ...(cell.authorityId ? { cell_id: cell.authorityId } : {}), expected_version: input.expectedVersion, resource_ref: cell.resourceId, test_category: cell.category, conditions: [], status: input.status, limitations: input.status === "not_applicable" ? [input.justification!] : [], evidence_refs: evidenceRefs, ...(input.justification && input.status === "not_applicable" ? { not_applicable_reason: input.justification } : {}), idempotency_key: `bw:coverage:${cell.cellId}:${input.expectedVersion}:${input.status}` })
        const data = operationData(result)
        const updated = { ...cell, ...(typeof data.id === "string" ? { authorityId: data.id } : {}), status: input.status, evidenceRefs, version: cell.version + 1, ...(input.justification ? { justification: input.justification } : {}) }; this.coverage.set(cell.cellId, updated); this.readSeq += 1; return updated
    }

    async coverageGate(): Promise<CoverageGate> {
        await this.assertReady(); const result = await this.host.invokeHost("coverage.gate", { contract_version: "1.3.0" }); const data = operationData(result); const gaps: string[] = []
        for (const cell of this.coverage.values()) if (["not_tested", "queued", "in_progress", "tested_no_observation", "blocked", "blocked_by_control", "inconclusive"].includes(cell.status)) gaps.push(`${cell.cellId}:${cell.status}`)
        if (this.coverage.size === 0) gaps.push("manifest has no coverage cells")
        const readSeq = Number(data.read_seq)
        if (!Number.isSafeInteger(readSeq) || readSeq < 0) throw new GovernanceError("coverage_read_seq", "Taric coverage gate returned an invalid read_seq", "failed_permanent")
        return { canClose: gaps.length === 0 && data.can_close !== false, readSeq, gaps, cells: [...this.coverage.values()].map((cell) => ({ ...cell })) }
    }

    async readContext(input: {
        budget: number
        /** Host product projection may include admitted L1 records; L0 stays excluded by Taric. */
        includeAdmitted?: boolean
        workRunId?: string
        workItemId?: string
        workerRole?: string
        policyVersion?: string
        ordering?: string
        filters?: Record<string, unknown>
    }, options: GovernanceReadOptions = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        await this.assertReady()
        const filters: Record<string, unknown> = {
            budget: input.budget,
            include_candidates: input.includeAdmitted === true,
            ...(input.workRunId ? { work_run_id: input.workRunId } : {}),
            ...(input.workItemId ? { work_item_id: input.workItemId } : {}),
            ...(input.workerRole ? { worker_role: input.workerRole } : {}),
            ...(input.policyVersion ? { policy_version: input.policyVersion } : {}),
            ...(input.ordering ? { ordering: input.ordering } : {}),
            ...(input.filters ? { filters: input.filters } : {}),
        }
        return readGovernancePages({
            kind: "context",
            binding: { ...this.queryBinding(filters, input.budget, options.readSeq), ...(input.includeAdmitted ? { principalId: this.host.getBinding().hostPrincipalId } : {}) },
            limits: { ...this.readLimits, ...options.limits },
            snapshotPinned: true,
            pageKey: "items",
            cursorKey: "cursor",
            initialCursor: options.cursor,
            pageSizeInput: false,
            readSeqInput: "read_seq",
            query: (request) => input.includeAdmitted ? this.host.invokeHost("context.query", request) : this.host.query("context.query", request),
        })
    }

    async readWork(input: {
        resourceRefs?: readonly string[]
        status?: readonly string[]
        includeActiveRuns?: boolean
        contractVersion?: string
    } = {}, options: GovernanceReadOptions = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        await this.assertReady()
        const includeActiveRuns = input.includeActiveRuns === true
        if (includeActiveRuns && options.readSeq !== undefined) throw new GovernanceError("query_unpinned", "Taric active WorkRun summaries are live and cannot use a pinned read_seq")
        if (input.contractVersion !== undefined && input.contractVersion !== TARIC_COMPATIBILITY_BASELINE.apiContractVersion) throw new GovernanceError("query_contract", "Taric Work query contract version does not match the pinned authority")
        if (input.resourceRefs && (input.resourceRefs.length === 0 || input.resourceRefs.length > 16 || input.resourceRefs.some((ref) => typeof ref !== "string" || !UUID.test(ref)))) throw new GovernanceError("query_filter", "Work resourceRefs must contain between 1 and 16 record identifiers")
        if (input.status && (input.status.length === 0 || input.status.length > 9 || input.status.some((status) => !["queued", "claimed", "in_progress", "checkpointed", "blocked", "completed", "failed", "cancelled", "lost"].includes(status)))) throw new GovernanceError("query_filter", "Work status must contain valid scheduling statuses")
        const filters: Record<string, unknown> = {
            ...(input.resourceRefs ? { resource_refs: [...input.resourceRefs] } : {}),
            ...(input.status ? { status: [...input.status] } : {}),
            ...(includeActiveRuns ? { include_active_runs: true } : { kind: "work_item", include_candidates: true }),
            ...(input.contractVersion ? { contract_version: input.contractVersion } : {}),
        }
        const result = await readGovernancePages({
            kind: "work",
            binding: this.queryBinding(filters, 50, options.readSeq, "host"),
            limits: { ...this.readLimits, ...options.limits },
            snapshotPinned: !includeActiveRuns,
            pageKey: includeActiveRuns ? "items" : "records",
            initialCursor: options.cursor,
            ...(includeActiveRuns ? {} : { readSeqInput: "as_of" as const }),
            query: (request) => {
                if (includeActiveRuns) return this.host.invokeHost("work.query", request)
                const { resource_refs: _resourceRefs, status: _status, contract_version: _contractVersion, ...authorityQuery } = request
                return this.host.invokeHost("resource.query", authorityQuery)
            },
            parseRecord: (value: unknown) => {
                const record = value as Record<string, unknown> | null
                if (!record || record.kind !== "work_item" || !["L1", "L2"].includes(String(record.trust_level))) throw new GovernanceError("query_untrusted_record", "Taric Work snapshot returned a non-admitted WorkItem")
                return record
            },
        })
        // Apply scheduling filters only after the bounded authority read. Its
        // diagnostics continue to count all scanned records and bytes.
        const diagnostics = { ...result.diagnostics, visibility: "complete" as const, completeDomain: !includeActiveRuns && result.diagnostics.status === "complete" }
        if (includeActiveRuns) return { ...result, diagnostics }
        return { ...result, diagnostics, records: result.records.filter((record) => (!input.status || input.status.includes(String(record.status))) && (!input.resourceRefs || (Array.isArray(record.resource_refs) && record.resource_refs.some((ref) => typeof ref === "string" && input.resourceRefs!.includes(ref))))) }
    }

    async readResources(input: { kind?: string } = {}, options: GovernanceReadOptions = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        await this.assertReady()
        const filters = input.kind ? { kind: input.kind } : {}
        return readGovernancePages({
            kind: "resource",
            binding: this.queryBinding(filters, 50, options.readSeq),
            limits: { ...this.readLimits, ...options.limits },
            snapshotPinned: true,
            pageKey: "records",
            initialCursor: options.cursor,
            readSeqInput: "as_of",
            query: (request) => this.host.query("resource.query", request),
        })
    }

    async readCoverage(input: { resourceRef?: string; testCategory?: string; status?: string } = {}, options: GovernanceReadOptions = {}): Promise<GovernanceQueryResult<Record<string, unknown>>> {
        await this.assertReady()
        if (input.resourceRef !== undefined && !UUID.test(input.resourceRef)) throw new GovernanceError("query_filter", "Coverage resourceRef must be a record identifier")
        if (input.testCategory !== undefined && input.testCategory.length > 128) throw new GovernanceError("query_filter", "Coverage testCategory must be bounded")
        if (input.status !== undefined && !["not_tested", "queued", "in_progress", "tested_no_observation", "positive", "inconclusive", "blocked", "blocked_by_control", "not_applicable"].includes(input.status)) throw new GovernanceError("query_filter", "Coverage status must be a valid coverage status")
        const filters = {
            kind: "coverage",
            ...(input.resourceRef ? { resource_ref: input.resourceRef } : {}),
            ...(input.testCategory ? { test_category: input.testCategory } : {}),
            ...(input.status ? { status: input.status } : {}),
            include_candidates: true,
        }
        const result = await readGovernancePages({
            kind: "coverage",
            binding: this.queryBinding(filters, 50, options.readSeq, "host"),
            limits: { ...this.readLimits, ...options.limits },
            // coverage.query reads the mutable current table in Taric 1.0.3;
            // the supported generic query reads immutable record_versions.
            snapshotPinned: true,
            pageKey: "records",
            initialCursor: options.cursor,
            readSeqInput: "as_of",
            query: (request) => {
                const { resource_ref: _resourceRef, test_category: _testCategory, status: _status, ...authorityQuery } = request
                return this.host.invokeHost("resource.query", authorityQuery)
            },
            parseRecord: (value: unknown) => {
                const record = value as Record<string, unknown> | null
                if (!record || record.kind !== "coverage" || !["L1", "L2"].includes(String(record.trust_level))) throw new GovernanceError("query_untrusted_record", "Taric Coverage snapshot returned a non-admitted Coverage cell")
                return record
            },
        })
        // recordsPage is immutable but applies recall exclusion, including the
        // valid Coverage status `inconclusive`. It cannot certify a complete
        // domain or replace coverage.gate, even when every visible page fits.
        const diagnostics = {
            ...result.diagnostics,
            status: result.diagnostics.status === "complete" ? "unpinned" as const : result.diagnostics.status,
            visibility: "recall_filtered" as const,
            completeDomain: false,
            errorCode: "coverage_recall_filtered",
        }
        return { ...result, diagnostics, records: result.records.filter((record) => (!input.resourceRef || record.resource_ref === input.resourceRef) && (!input.testCategory || record.test_category === input.testCategory) && (!input.status || record.status === input.status)) }
    }

    private queryBinding(filters: Record<string, unknown>, pageSize: number, readSeq?: number, role: "host" | "model" = "model") {
        const binding = this.host.getBinding()
        return {
            principalId: role === "host" ? binding.hostPrincipalId : binding.modelPrincipalId,
            engagementId: binding.engagementId,
            filters,
            pageSize,
            ...(readSeq === undefined ? {} : { readSeq }),
        }
    }

    async createReportSnapshot(): Promise<ReportSnapshot> {
        const gate = await this.coverageGate()
        const manifest = [...this.setup.manifest]
            .map((item) => ({ resourceId: item.resourceId, revision: item.revision, testCategories: [...item.testCategories].sort() }))
            .sort((left, right) => left.resourceId.localeCompare(right.resourceId) || left.revision - right.revision)
        const resourceRevisions = manifest.map(({ resourceId, revision }) => ({ resourceId, revision }))
        const manifestDigest = sha256Text(JSON.stringify(manifest))
        const normalizedGate: CoverageGate = {
            canClose: gate.canClose,
            readSeq: gate.readSeq,
            gaps: [...gate.gaps].sort(),
            cells: [...gate.cells]
                .map((cell) => ({ ...cell, evidenceRefs: [...cell.evidenceRefs].sort() }))
                .sort((left, right) => left.cellId.localeCompare(right.cellId)),
        }
        const binding = {
            manifestDigest,
            scopeRevision: this.setup.project.scope_revision,
            resourceRevisions,
            gate: normalizedGate,
            readSeq: gate.readSeq,
        }
        const snapshot: ReportSnapshot = {
            ...binding,
            reportDigest: sha256Text(JSON.stringify(binding)),
            createdAt: new Date().toISOString(),
        }
        const reportDir = join(this.engagementArtifactRoot, "reports")
        await mkdir(reportDir, { recursive: true })
        const reportPath = join(reportDir, `${snapshot.reportDigest.slice("sha256:".length)}.json`)
        const temporaryPath = `${reportPath}.next`
        await Bun.write(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        await rename(temporaryPath, reportPath)
        return snapshot
    }

    async getReportSnapshot(reportDigest: string): Promise<ReportSnapshot> {
        const digest = requiredText(reportDigest, "reportDigest")
        if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) throw new GovernanceError("invalid_report_digest", "reportDigest must be a SHA-256 digest")
        const path = join(this.engagementArtifactRoot, "reports", `${digest.slice("sha256:".length)}.json`)
        // Once the lifecycle has been cut over, a report index is only a
        // disposable cache. Recompute the binding from the current canonical
        // Coverage gate so deleting the cache cannot change the answer.
        if (this.lifecycleMode === "taric_projection") {
            const rebuilt = await this.createReportSnapshot()
            if (rebuilt.reportDigest !== digest) throw new GovernanceError("report_snapshot_stale", "report digest does not match the current authority snapshot", "rejected_authorization")
            return rebuilt
        }
        let value: unknown
        try {
            value = await Bun.file(path).json()
        } catch {
            const rebuilt = await this.createReportSnapshot()
            if (rebuilt.reportDigest !== digest) throw new GovernanceError("report_snapshot_not_found", "report snapshot is unavailable")
            return rebuilt
        }
        if (!isRecord(value) || value.reportDigest !== digest || typeof value.manifestDigest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.manifestDigest) || !Number.isSafeInteger(value.scopeRevision) || !Array.isArray(value.resourceRevisions) || !isRecord(value.gate) || !Number.isSafeInteger(value.readSeq) || typeof value.createdAt !== "string") {
            throw new GovernanceError("report_snapshot_invalid", "report snapshot fields are invalid", "failed_permanent")
        }
        const gate = value.gate
        if (typeof gate.canClose !== "boolean" || gate.readSeq !== value.readSeq || !Array.isArray(gate.gaps) || !Array.isArray(gate.cells)) throw new GovernanceError("report_snapshot_invalid", "report snapshot gate is invalid", "failed_permanent")
        const binding = {
            manifestDigest: value.manifestDigest,
            scopeRevision: value.scopeRevision,
            resourceRevisions: value.resourceRevisions,
            gate,
            readSeq: value.readSeq,
        }
        if (sha256Text(JSON.stringify(binding)) !== digest) throw new GovernanceError("report_snapshot_integrity", "report snapshot digest does not match its contents", "failed_permanent")
        return value as unknown as ReportSnapshot
    }

    async listProposals(input: { cursor?: string; pageSize?: number; maxPages?: number } = {}): Promise<unknown> {
        await this.assertReady()
        const pageSize = input.pageSize ?? 50
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new GovernanceError("invalid_page_size", "pageSize must be an integer between 1 and 50")
        const maxPages = input.maxPages ?? this.readLimits.maxPages
        if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > this.readLimits.maxPages) throw new GovernanceError("invalid_page_limit", `maxPages must be an integer between 1 and ${this.readLimits.maxPages}`)
        const binding = this.host.getBinding()
        const result = await readGovernancePages({
            kind: "proposal",
            binding: {
                principalId: binding.hostPrincipalId,
                engagementId: binding.engagementId,
                filters: {},
                pageSize,
            },
            limits: { ...this.readLimits, maxPages },
            snapshotPinned: true,
            pageKey: "proposals",
            initialCursor: input.cursor,
            query: (request) => this.host.invokeHost("proposal.list", request),
        })
        return {
            proposals: result.records,
            read_seq: result.readSeq,
            ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
            diagnostics: result.diagnostics,
        }
    }

    async submitReview(input: ReviewSubmission): Promise<ReviewDecision> {
        if (!this.reviewer) throw new GovernanceError("reviewer_unavailable", "an explicitly configured reviewer authority is required", "rejected_authorization")
        await this.assertReady()
        const reviewerId = input.reviewerId?.trim() || this.reviewer.getBinding().hostPrincipalId
        if (!input.evidenceSnapshotHash || !input.inputHash || !input.policyDigest) throw new GovernanceError("review_binding", "review must bind input, evidence snapshot and policy")
        await this.reviewer.invokeHost("review.submit", { proposal_id: input.proposalId, reviewer_id: reviewerId, reviewer_kind: this.reviewerKind, input_hash: input.inputHash, evidence_snapshot_hash: input.evidenceSnapshotHash, policy_digest: input.policyDigest, verdict: input.verdict })
        const decision: ReviewDecision = {
            ...input,
            reviewerId,
            reviewerKind: this.reviewerKind,
            evidenceClass: this.reviewerKind === "deterministic" ? "local_fixture" : "authority_review",
            createdAt: new Date().toISOString(),
        }
        this.reviews.set(input.proposalId, decision)
        return decision
    }

    async admit(proposalId: string, policyDigest: string): Promise<unknown> {
        await this.assertReady()
        const review = this.reviews.get(requiredText(proposalId, "proposalId"))
        if (review && review.verdict !== "pass") throw new GovernanceError("admission_review", "proposal requires a passing review", "rejected_authorization")
        if (review && review.policyDigest !== policyDigest) throw new GovernanceError("admission_policy", "admission policy differs from the reviewed policy", "rejected_authorization")
        const admission = new TaricAuthorityAdmissionService(this.host, requiredText(policyDigest, "policyDigest"))
        return admission.commitL1({ proposalId, expectedVersion: 0, ...(review ? { evidenceSnapshotHash: review.evidenceSnapshotHash } : {}) })
    }

    async close(input: CloseRequest): Promise<{ closed: true; reportDigest: string; readSeq: number; snapshot: ReportSnapshot }> {
        await this.assertReady()
        if (this.lifecycleMode === "taric_projection") await this.rebuildProjection()
        const snapshot = await this.createReportSnapshot()
        if (!snapshot.gate.canClose) throw new GovernanceError("coverage_incomplete", `coverage gate is not closable: ${snapshot.gate.gaps.join(", ")}`, "rejected_authorization")
        const activeWork = await this.readWork({ includeActiveRuns: true })
        if (activeWork.diagnostics.status !== "unpinned" || activeWork.diagnostics.hasMore || activeWork.records.some((item) => item.active_run !== undefined)) throw new GovernanceError("work_active", "all authority WorkRuns must be terminal or reconciled", "rejected_authorization")
        if (input.reportDigest !== undefined && requiredText(input.reportDigest, "reportDigest") !== snapshot.reportDigest) throw new GovernanceError("report_snapshot_stale", "report digest does not match the current coverage snapshot", "rejected_authorization")
        this.closed = true; return { closed: true, reportDigest: snapshot.reportDigest, readSeq: snapshot.readSeq, snapshot }
    }

    async commitCheckpoint(state: CheckpointState, owner = this.host.getBinding().hostPrincipalId): Promise<unknown> {
        const run = this.requireRun(state.workRunId, owner, state.generation); await this.assertReady()
        if (state.attemptId !== run.attemptId) throw new GovernanceError("stale_checkpoint", "checkpoint attempt does not match the active WorkRun", "rejected_authorization")
        if (!Number.isSafeInteger(state.sourceReadSeq) || state.sourceReadSeq < 0) throw new GovernanceError("invalid_checkpoint", "sourceReadSeq must be a non-negative integer")
        const checkpoint = { work_item_ref: run.workItemId, work_run_ref: run.runId, attempt_ref: run.attemptId, generation: run.generation, target_resource_ref: run.targetResourceId, target_version: this.manifestRevision(run.targetResourceId), work_item_version: 1, scope_version: this.setup.project.scope_revision, owner: run.owner, lease_expires_at: run.leaseExpiresAt, source_read_seq: state.sourceReadSeq, completed_steps: state.completedSteps, next_steps: state.nextSteps, observation_refs: state.observationRefs, evidence_refs: state.evidenceRefs, negative_results: [], unresolved_work: state.unresolvedWork, host_decision_refs: [], external_action_state: {}, budget: {}, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: {} }
        if (containsDisallowedCheckpoint(checkpoint)) throw new GovernanceError("checkpoint_sensitive", "checkpoint contains a secret or hidden reasoning field")
        return this.host.invokeHost("checkpoint.commit", { work_run_id: run.runId, generation: run.generation, checkpoint, idempotency_key: `bw:checkpoint:${run.runId}:${run.generation}:${state.sourceReadSeq}` })
    }

    private manifestRevision(resourceId: string): number {
        const item = this.setup.manifest.find((entry) => entry.resourceId === resourceId)
        if (!item) throw new GovernanceError("resource_out_of_manifest", "WorkRun target is not present in the approved manifest", "rejected_authorization")
        return item.revision
    }

    async deleteArtifact(contentRef: string): Promise<void> {
        await this.ensureArtifactMetadata()
        const metadata = this.artifacts.get(requiredText(contentRef, "contentRef"))
        if (!metadata) throw new GovernanceError("artifact_not_found", "artifact metadata is unavailable")
        if (metadata.contentStatus === "deleted") return
        if (this.artifactService) throw new GovernanceError("artifact_delete_unsupported", "Taric-managed Artifact deletion requires a configured host retention adapter", "rejected_authorization")
        await this.markArtifactDeleted(metadata)
    }
}

function classifyGovernanceError(error: unknown, operation: string): GovernanceDiagnostics {
    if (error instanceof GovernanceError) return { outcome: error.outcome, code: error.code, message: safeDiagnosticText(error.message), operation }
    if (error instanceof TaricOperationError) {
        const permanent = ["validation_error", "authorization_error", "forbidden", "stale_version", "conflict"].includes(error.code)
        return { outcome: permanent ? "failed_permanent" : "indeterminate", code: error.code, message: safeDiagnosticText(error.message), operation }
    }
    if (error instanceof TaricUnavailableError) return { outcome: "deferred", code: error.code, message: "Taric authority is unavailable", operation }
    return { outcome: "indeterminate", code: "transport_error", message: "Taric transport failed", operation }
}

function safeDiagnosticText(value: string): string {
    return value
        .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi, "[redacted private key]")
        .replace(/(authorization|api[-_ ]?key|token|password|secret|cookie|credential|database[_-]?url|connection[_-]?string|registry[_-]?key|outbox[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
        .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[redacted]@")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
        .slice(0, 512)
}

function containsDisallowedCheckpoint(value: unknown, depth = 0): boolean {
    if (depth > 12) return true
    if (typeof value === "string") return SENSITIVE_TEXT.test(value) || /bearer\s+\S+|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s]+@/i.test(value)
    if (Array.isArray(value)) return value.some((child) => containsDisallowedCheckpoint(child, depth + 1))
    if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([key, child]) => !CHECKPOINT_KEYS.has(key) || SENSITIVE_KEY.test(key) || key.toLowerCase().includes("reasoning") || containsDisallowedCheckpoint(child, depth + 1))
    return false
}
