import { compareTaricCompatibility, validateExpectedTaricCompatibility } from "./compatibility"
import type {
    TaricAdapterProfile,
    TaricHealth,
    TaricHostBinding,
    TaricHostModuleOptions,
    TaricHostObservationInput,
    TaricProposalInput,
    TaricCheckpointProposalInput,
    TaricQueryInput,
    TaricServiceAdapter,
} from "./types"
import { TaricOperationError, TaricUnavailableError } from "./types"
import { adaptCaptureDto } from "./capture-dto"

export const TARIC_MODEL_QUERY_OPERATIONS = ["context.query", "resource.query", "evidence.query", "coverage.query", "work.query"] as const
export const TARIC_MODEL_PROPOSAL_OPERATIONS = ["proposal.submit", "checkpoint.propose"] as const
export const TARIC_HOST_ONLY_OPERATIONS = [
    "context.query",
    "engagement.status",
    "scope.query",
    "coverage.snapshot",
    "action.audit.query",
    "report.snapshot.commit",
    "resource.query",
    "action.recommend",
    "action.host-decision",
    "action.host-result",
    "action.reconcile",
    "capture.observation",
    "resource.revise",
    "work.claim",
    "work.renew",
    "work.reclaim",
    "work.transition",
    "work.query",
    "coverage.record",
    "coverage.query",
    "coverage.gate",
    "proposal.list",
    "artifact.session.bind",
    "artifact.store.begin",
    "artifact.store.append",
    "artifact.store.commit",
    "artifact.metadata",
    "artifact.ingest_file",
    "artifact.content.read",
    "artifact.content.list",
    "artifact.session.output",
    "review.pack",
    "review.submit",
    "admission.evaluate",
    "admission.commit",
    "checkpoint.commit",
    "work.resume",
] as const
export const TARIC_OPERATOR_OPERATIONS = ["scope.revise","scope.invalidate","coverage.manifest.commit","engagement.close","engagement.reopen"] as const
const MAX_QUERY_LIMIT = 50
const MAX_PROPOSAL_BYTES = 32 * 1024
const MAX_OBSERVATION_BYTES = 1024 * 1024
const TARIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_FIELDS: Record<string, readonly string[]> = {
    "engagement.status": [],
    "scope.revise": ["scope_id","expected_version","policy","roe_artifact_ref","roe_artifact_version","idempotency_key","contract_version"],
    "scope.invalidate": ["scope_id","scope_revision_ref","expected_version","reason","idempotency_key","contract_version"],
    "scope.query": ["scope_id","as_of","cursor","page_size","contract_version"],
    "coverage.manifest.commit": ["scope_revision_ref","policy_digest","expected_cells","idempotency_key","contract_version"],
    "coverage.snapshot": ["manifest_ref","manifest_digest","resource_refs","scope_revision_ref","policy_digest","test_category","status","visibility_mode","include_candidates","page_size","cursor","as_of","contract_version"],
    "action.audit.query": ["action_id","work_run_id","attempt_id","generation","status","read_seq","cursor","page_size","contract_version"],
    "report.snapshot.commit": ["expected_authority_seq","manifest_ref","manifest_digest","scope_revision_ref","resource_revision_refs","coverage_read_seq","coverage_snapshot_digest","report_artifact_session_id","report_artifact_ref","idempotency_key","contract_version"],
    "engagement.close": ["expected_engagement_version","expected_authority_seq","report_snapshot_ref","reason","idempotency_key","contract_version"],
    "engagement.reopen": ["expected_engagement_version","expected_authority_seq","close_decision_ref","reason","idempotency_key","contract_version"],

    "action.recommend": ["scope_revision_ref", "policy_digest", "network_provenance", "work_run_id", "generation", "target", "method", "rationale", "uncertainty", "scope", "constraints", "limitations"],
    "action.host-decision": ["scope_revision_ref", "policy_digest", "network_provenance", "work_run_id", "generation", "action_id", "mode", "status", "host_decision_ref", "result_ref"],
    "action.host-result": ["scope_revision_ref", "policy_digest", "network_provenance", "work_run_id", "generation", "action_id", "mode", "status", "host_decision_ref", "result_ref"],
    "action.reconcile": ["scope_revision_ref", "policy_digest", "network_provenance", "work_run_id", "generation", "action_id", "status", "result_ref"],
    "context.query": ["work_run_id", "budget", "cursor", "read_seq", "filters", "ordering", "work_item_id", "worker_role", "policy_version", "include_candidates"],
    "resource.query": ["as_of", "cursor", "page_size", "kind", "include_candidates", "trust_level"],
    "evidence.query": ["as_of", "cursor", "page_size", "kind"],
    "proposal.list": ["cursor", "page_size"],
    "proposal.submit": ["subject_type", "expected_version", "content", "target_id", "subject_ref", "proposal_id", "client_request_id", "idempotency_key"],
    "checkpoint.propose": ["work_run_id", "generation", "checkpoint"],
    "resource.revise": ["resource_id", "expected_version", "content", "identity", "asset_type", "revision", "method", "path", "content_hash", "source_observation_refs", "client_request_id", "idempotency_key"],
    "work.query": ["resource_refs", "status", "include_active_runs", "page_size", "cursor", "contract_version"],
    "work.claim": ["work_item_id", "host_id", "agent_id", "ttl_ms", "task_session_ref"],
    "work.renew": ["work_run_id", "generation", "ttl_ms"],
    "work.reclaim": ["work_run_id", "agent_id", "ttl_ms"],
    "work.transition": ["work_run_id", "generation", "status", "idempotency_key"],
    "coverage.record": ["scope_revision_ref", "policy_digest", "cell_id", "expected_version", "status", "evidence_refs", "counter_evidence_refs", "not_applicable_reason", "limitations", "tested_at", "external_result_state", "origin_reached", "control_observation_ref", "resource_revision_ref", "resource_revision", "scope_revision", "resource_ref", "test_category", "identity_ref", "operation", "parameter", "conditions", "role", "tenant_ref", "path", "network_condition", "method", "idempotency_key"],
    "coverage.query": ["resource_ref", "test_category", "status", "include_candidates", "page_size", "cursor", "read_seq"],
    "coverage.gate": ["manifest_ref","manifest_digest","resource_refs","scope_revision_ref","policy_digest","test_category","status","visibility_mode","include_candidates","page_size","cursor","as_of","contract_version"],
    "artifact.session.bind": ["session_id", "root", "mode", "work_run_id", "attempt_id", "generation", "owner_host", "binding_id", "created_at", "manifest_hash"],
    "artifact.store.begin": ["session_id", "payload_kind", "media_type", "expected_bytes", "expected_hash", "storage_mode", "host_ref", "category", "captured_at", "work_run_id", "attempt_id", "generation", "idempotency_key"],
    "artifact.store.append": ["session_id", "upload_id", "ordinal", "chunk_hash", "data", "encoding", "idempotency_key"],
    "artifact.store.commit": ["session_id", "upload_id", "total_bytes", "chunk_count", "content_hash", "idempotency_key"],
    "artifact.metadata": ["session_id", "content_ref"],
    "artifact.ingest_file": ["session_id", "path", "authorize_spool_access", "payload_kind", "media_type", "expected_bytes", "expected_hash", "delete_source", "idempotency_key"],
    "artifact.content.read": ["session_id", "content_ref", "offset", "length", "chunk_cursor", "max_response_bytes"],
    "artifact.content.list": ["session_id", "cursor", "page_size"],
    "artifact.session.output": ["session_id", "cursor", "execution_cursor", "page_size", "work_run_id", "attempt_id", "include_content", "max_response_bytes"],
    "review.pack": ["proposal_id"],
    "review.submit": ["proposal_id", "reviewer_id", "reviewer_kind", "input_hash", "verdict", "policy_digest", "evidence_snapshot_hash", "expected_version", "rubric_hash", "limitations", "idempotency_key"],
    "admission.evaluate": ["proposal_id", "expected_version", "policy_digest", "evidence_snapshot_hash", "idempotency_key"],
    "admission.commit": ["proposal_id", "expected_version", "policy_digest", "evidence_snapshot_hash", "idempotency_key"],
    "checkpoint.commit": ["work_run_id", "generation", "checkpoint", "idempotency_key"],
    "work.resume": ["work_run_id", "generation"],
    "capture.observation": ["observation", "subject_type", "expected_version", "target_id", "work_run_id", "generation", "client_request_id", "idempotency_key"],
}

function requiredText(value: string, field: string): string {
    const result = value.trim()
    if (!result) throw new Error(`${field} is required`)
    return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateBinding(binding: TaricHostBinding): void {
    requiredText(binding.projectId, "projectId")
    requiredText(binding.tenantId, "tenantId")
    requiredText(binding.engagementId, "engagementId")
    requiredText(binding.hostPrincipalId, "hostPrincipalId")
    requiredText(binding.modelPrincipalId, "modelPrincipalId")
}

function equalBinding(expected: TaricHostBinding, actual: TaricHostBinding): boolean {
    return (
        expected.projectId === actual.projectId &&
        expected.tenantId === actual.tenantId &&
        expected.engagementId === actual.engagementId &&
        expected.hostPrincipalId === actual.hostPrincipalId &&
        expected.modelPrincipalId === actual.modelPrincipalId
    )
}

function payloadBytes(input: Record<string, unknown>): number {
    try {
        return new TextEncoder().encode(JSON.stringify(input)).byteLength
    } catch {
        throw new Error("Taric request must be JSON serializable")
    }
}

function nowIso(): string {
    return new Date().toISOString()
}

function safeDetailsText(value: string, fallback = ""): string {
    return value
        .replace(/((?:token|password|secret|credential|authorization|connection[_-]?string)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
        .replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/gi, "<redacted-connection-string>")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 256) || fallback
}

function safeOperationDetails(value: unknown): unknown {
    if (!isRecord(value)) return undefined
    if (value.kind === "contract" && typeof value.contract_name === "string" && Array.isArray(value.violations)) {
        const violations = value.violations.slice(0, 16).flatMap((item) => {
            if (!isRecord(item)) return []
            const params: Record<string, string | number | boolean> = {}
            if (isRecord(item.params)) {
                const allowed = new Set(["missingProperty", "additionalProperty", "type", "format", "comparison", "limit", "exclusive", "pattern", "propertyName", "expected"])
                for (const [key, parameter] of Object.entries(item.params)) {
                    if (Object.keys(params).length >= 8 || !allowed.has(key)) continue
                    if (typeof parameter === "string") params[key] = /token|password|secret|credential|authorization|private[_-]?key/i.test(parameter) ? "<redacted>" : safeDetailsText(parameter)
                    else if (typeof parameter === "number" && Number.isFinite(parameter) || typeof parameter === "boolean") params[key] = parameter
                }
            }
            return [{
                instance_path: typeof item.instance_path === "string" ? item.instance_path.split("/").map((part) => /token|password|secret|credential|authorization|private[_-]?key/i.test(part) ? "<redacted>" : part).join("/").slice(0, 256) : "",
                keyword: typeof item.keyword === "string" ? safeDetailsText(item.keyword, "validation").slice(0, 64) : "validation",
                ...(Object.keys(params).length ? { params } : {}),
                message: typeof item.message === "string" ? safeDetailsText(item.message, "contract constraint failed") : "contract constraint failed",
            }]
        })
        return violations.length ? { kind: "contract", contract_name: value.contract_name.slice(0, 128), violations } : undefined
    }
    if (value.kind === "compatibility" && (value.backend === "sqlite" || value.backend === "postgresql" || value.backend === "unknown") && isRecord(value.expected)) {
        const safeMap = (map: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(map).slice(0, 8).flatMap(([key, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? [[key.slice(0, 64), /token|password|secret|credential|authorization|connection[_-]?string/i.test(key) ? "<redacted>" : safeDetailsText(String(item))]] : []))
        return { kind: "compatibility", backend: value.backend, expected: safeMap(value.expected), ...(isRecord(value.observed) ? { observed: safeMap(value.observed) } : {}), ...(typeof value.failed_marker === "string" ? { failed_marker: safeDetailsText(value.failed_marker) } : {}), ...(Array.isArray(value.missing) ? { missing: value.missing.filter((item): item is string => typeof item === "string").slice(0, 32).map((item) => /token|password|secret|credential|authorization|private[_-]?key/i.test(item) ? "<redacted>" : safeDetailsText(item)) } : {}) }
    }
    return undefined
}

export class TaricHostModule {
    private readonly options: TaricHostModuleOptions
    private adapter: TaricServiceAdapter | undefined
    private currentHealth: TaricHealth
    private initialized = false
    private closed = false

    constructor(options: TaricHostModuleOptions) {
        validateBinding(options.binding)
        if (options.mode !== "taric_best_effort" && options.mode !== "taric_required") {
            throw new Error(`invalid Taric memory mode: ${String(options.mode)}`)
        }
        validateExpectedTaricCompatibility(options.expectedCompatibility)
        this.options = options
        this.adapter = options.adapter
        this.currentHealth = {
            status: "unavailable",
            profile: options.adapter?.transportProfile ?? (options.adapter ? "bun_in_process" : "unavailable"),
            mode: options.mode,
            checkedAt: nowIso(),
            reason: options.adapter ? "Taric adapter has not been initialized" : "No verified Taric adapter is configured",
        }
    }

    async initialize(): Promise<TaricHealth> {
        this.assertOpen()
        if (this.initialized && (this.currentHealth.status === "healthy" || !this.adapter)) return this.health()
        const adapter = this.adapter
        if (!adapter) {
            this.currentHealth = { status: "unavailable", profile: "unavailable", mode: this.options.mode, checkedAt: nowIso(), reason: "No verified Taric adapter is configured" }
            this.initialized = true
            return this.health()
        }

        try {
            await adapter.checkHealth?.()
        } catch (error) {
            this.currentHealth = {
                status: "unavailable",
                profile: adapter.transportProfile ?? "bun_in_process",
                mode: this.options.mode,
                checkedAt: nowIso(),
                reason: error instanceof Error ? error.message : String(error),
            }
            this.initialized = false
            return this.health()
        }

        try {
            const [profile, binding] = await Promise.all([adapter.getProfile(), adapter.getBinding()])
            this.validateProfile(profile)
            if (!equalBinding(this.options.binding, binding)) throw new Error("Taric authority binding does not match the trusted project context")
            this.currentHealth = { status: "healthy", profile: adapter.transportProfile ?? "bun_in_process", mode: this.options.mode, checkedAt: nowIso() }
            this.initialized = true
            return this.health()
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.markDegraded(reason)
            this.currentHealth = { ...this.currentHealth, status: "unavailable", profile: "unavailable" }
            this.initialized = true
            await this.closeAdapterAfterStartupFailure(adapter)
            throw new TaricUnavailableError(reason || "Taric startup validation failed", this.options.mode)
        }
    }

    health(): TaricHealth {
        return { ...this.currentHealth }
    }

    getHealth(): TaricHealth {
        return this.health()
    }

    refreshHealth(): Promise<TaricHealth> {
        return this.initialize()
    }

    getBinding(): TaricHostBinding {
        return { ...this.options.binding }
    }

    assertAvailable(): void {
        this.requireReadyAdapter()
    }

    async query(operation: (typeof TARIC_MODEL_QUERY_OPERATIONS)[number], input: TaricQueryInput = {}): Promise<unknown> {
        if (!TARIC_MODEL_QUERY_OPERATIONS.includes(operation)) throw new Error(`unsupported Taric model query: ${operation}`)
        const payload: Record<string, unknown> = { ...input }
        if (payload.engagement_id !== undefined && payload.engagement_id !== this.options.binding.engagementId) {
            throw new Error("engagement_id is host-bound and does not match the trusted project context")
        }
        delete payload.engagement_id
        if (operation === "context.query") {
            if (payload.budget === undefined && payload.limit !== undefined) payload.budget = payload.limit
            delete payload.limit
            payload.include_candidates = false
            if (typeof payload.budget === "number" && (!Number.isInteger(payload.budget) || payload.budget < 1 || payload.budget > MAX_QUERY_LIMIT * 1000)) {
                throw new Error("budget must be an integer between 1 and 50000")
            }
        } else {
            if (payload.page_size === undefined && payload.limit !== undefined) payload.page_size = payload.limit
            delete payload.limit
            if (payload.page_size === undefined) payload.page_size = 20
            if (!Number.isInteger(payload.page_size) || Number(payload.page_size) < 1 || Number(payload.page_size) > MAX_QUERY_LIMIT) {
                throw new Error(`page_size must be between 1 and ${MAX_QUERY_LIMIT}`)
            }
            if (operation === "coverage.query") payload.include_candidates = false
        }
        return this.invoke(operation, payload, "model")
    }

    async submitProposal(input: TaricProposalInput): Promise<unknown> {
        const eventId = requiredText(input.eventId, "eventId")
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) throw new Error("eventId must be a valid Taric client_request_id")
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("expectedVersion must be a non-negative integer")
        const content = { ...input.content, schema_version: "1.0.0", engagement_id: this.options.binding.engagementId }
        const payload: Record<string, unknown> = {
            subject_type: input.subjectType,
            expected_version: input.expectedVersion,
            content,
            client_request_id: eventId,
            idempotency_key: eventId,
        }
        if (payloadBytes(payload) > MAX_PROPOSAL_BYTES) throw new Error(`proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`)
        return this.invoke("proposal.submit", payload, "model")
    }

    async proposeCheckpoint(input: TaricCheckpointProposalInput): Promise<unknown> {
        const payload: Record<string, unknown> = {
            work_run_id: requiredText(input.workRunId, "workRunId"),
            generation: input.generation,
            checkpoint: input.checkpoint,
        }
        requiredText(input.eventId, "eventId")
        if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error("generation must be a positive integer")
        if (payloadBytes(payload) > MAX_PROPOSAL_BYTES) throw new Error(`checkpoint proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`)
        return this.invoke("checkpoint.propose", payload, "model")
    }

    async captureObservation(input: TaricHostObservationInput): Promise<unknown> {
        if (input.sourceKind !== "tool_result" && input.sourceKind !== "platform_result" && input.sourceKind !== "host_event") throw new Error("invalid host observation sourceKind")
        const kind = input.captureKind ?? (input.sourceKind === "tool_result" ? "solver" : input.sourceKind === "platform_result" ? "report" : "platform")
        const adapted = adaptCaptureDto({ kind, hostPrincipalId: this.options.binding.hostPrincipalId, eventId: input.eventId, observation: input.observation })
        const observationInput = adapted.observation
        if (input.targetId && input.targetId !== observationInput.resource_ref) throw new Error("targetId must match the host-resolved Resource UUID")
        const sourceKind = input.sourceKind === "tool_result" ? "tool" : "host"
        const observationRecord = {
            schema_version: "1.0.0",
            engagement_id: this.options.binding.engagementId,
            kind: "observation",
            resource_ref: observationInput.resource_ref,
            observed_at: observationInput.observed_at,
            statement: observationInput.statement,
            artifact_refs: observationInput.artifact_refs,
            limitations: observationInput.limitations ?? ["Captured by BreachWeave host; raw tool output remains host-controlled."],
            ...(observationInput.status ? { status: observationInput.status } : {}),
            provenance: {
                host_id: this.options.binding.hostPrincipalId,
                producer_id: this.options.binding.hostPrincipalId,
                source_kind: sourceKind,
                dispatch_id: adapted.originRef,
            },
        }
        if ((input.workRunId === undefined) !== (input.generation === undefined)) throw new Error("observation WorkRun fencing requires both workRunId and generation")
        if (input.workRunId !== undefined && (input.generation === undefined || !TARIC_UUID.test(input.workRunId) || !Number.isSafeInteger(input.generation) || input.generation < 1)) throw new Error("observation WorkRun fence is invalid")
        const payload: Record<string, unknown> = {
            observation: observationRecord,
            client_request_id: input.eventId,
            idempotency_key: input.eventId,
            ...(input.workRunId ? { work_run_id: input.workRunId } : {}),
            ...(input.generation !== undefined ? { generation: input.generation } : {}),
        }
        if (input.generation !== undefined && (!Number.isInteger(input.generation) || input.generation < 1)) throw new Error("generation must be a positive integer")
        if (payloadBytes(payload) > MAX_OBSERVATION_BYTES) throw new Error(`observation exceeds ${MAX_OBSERVATION_BYTES} bytes`)
        const captured = await this.invoke("capture.observation", payload, "host")
        // Taric may durably quarantine a late capture as a rejected proposal
        // while returning a successful transport envelope. Do not report that
        // candidate as accepted or let callers advance Coverage from it.
        if (isRecord(captured) && captured.status === "rejected") throw new TaricOperationError("stale_version", "Observation capture was quarantined by Taric authority fencing")
        return captured
    }

    /**
     * Dispatch a host-owned Taric operation. Model query/proposal methods do
     * not expose this escape hatch; governance code is the only caller.
     */
    async invokeHost(operation: (typeof TARIC_HOST_ONLY_OPERATIONS)[number], input: Record<string, unknown>): Promise<unknown> {
        if (!TARIC_HOST_ONLY_OPERATIONS.includes(operation)) throw new Error(`unsupported Taric host operation: ${operation}`)
        return this.invoke(operation, input, "host")
    }

    /** Host-owned Action bridge; never exposed through the model query/proposal routes. */
    async invokeAction(operation: "action.recommend" | "action.host-decision" | "action.host-result" | "action.reconcile", input: Record<string, unknown>): Promise<unknown> {
        return this.invokeHost(operation, input)
    }

    /** Operator calls require a separately configured adapter capability. */
    async invokeOperator(operation: (typeof TARIC_OPERATOR_OPERATIONS)[number], input: Record<string, unknown>): Promise<unknown> {
        if (!TARIC_OPERATOR_OPERATIONS.includes(operation)) throw new TaricOperationError("authorization_error", "Unsupported Taric operator operation")
        return this.invoke(operation, input, "operator")
    }

    private async invoke(operation: string, input: Record<string, unknown>, role: "model" | "host" | "operator"): Promise<unknown> {
        const allowedFields = OPERATION_FIELDS[operation]
        if (!allowedFields) throw new Error(`unsupported Taric operation: ${operation}`)
        if (role === "model" && operation === "resource.query" && (input.include_candidates !== undefined || input.trust_level !== undefined)) throw new Error("candidate and trust-level selectors require a host-owned Taric query")
        for (const key of Object.keys(input)) {
            if (key !== "engagement_id" && !allowedFields.includes(key)) throw new Error(`${key} is not accepted by Taric ${operation}`)
        }
        if (input.engagement_id !== undefined && input.engagement_id !== this.options.binding.engagementId) {
            throw new Error("engagement_id is host-bound and does not match the trusted project context")
        }
        const request = { ...input, engagement_id: this.options.binding.engagementId }
        const maxBytes = operation === "capture.observation" ? MAX_OBSERVATION_BYTES : MAX_PROPOSAL_BYTES
        if (payloadBytes(request) > maxBytes) throw new Error(`request exceeds ${maxBytes} bytes`)
        const adapter = this.requireReadyAdapter()
        try {
            if (role === "operator" && !adapter.invokeOperator) throw new TaricOperationError("authorization_error", "No trusted Taric operator route is configured")
            const response = role === "operator" ? await adapter.invokeOperator!(operation, request) : await adapter.invoke(operation, request, role)
            if (!isRecord(response) || typeof response.ok !== "boolean") {
                throw new TaricUnavailableError("Taric adapter returned an invalid dispatch response", this.options.mode)
            }
            if (response.ok) return response.data
            const error = isRecord(response.error) ? response.error : {}
            const operationError = new TaricOperationError(String(error.code ?? "internal_error"), String(error.message ?? "Taric operation failed").slice(0, 256), safeOperationDetails(error.details))
            if (operationError.code === "unavailable_host") this.markDegraded(operationError.message)
            throw operationError
        } catch (error) {
            if (error instanceof TaricOperationError) {
                if (error.code === "unavailable_host") this.markDegraded(error.message)
                throw error
            }
            this.markDegraded(error instanceof Error ? error.message : String(error))
            if (error instanceof TaricUnavailableError) throw new TaricUnavailableError(error.message, this.options.mode, "after_dispatch")
            throw new TaricUnavailableError(this.currentHealth.reason ?? "Taric transport failed", this.options.mode, "after_dispatch")
        }
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        const adapter = this.adapter
        this.adapter = undefined
        this.currentHealth = { status: "closed", profile: "unavailable", mode: this.options.mode, checkedAt: nowIso() }
        if (adapter) await adapter.close()
    }

    private validateProfile(profile: TaricAdapterProfile): void {
        if (profile.status !== "verified") throw new Error("Taric adapter profile is unavailable or unverified")
        const mismatches = compareTaricCompatibility(this.options.expectedCompatibility, profile.compatibility)
        if (mismatches.length > 0) throw new Error(`Taric compatibility mismatch: ${mismatches.join(", ")}`)
    }

    private markDegraded(reason: string): void {
        this.currentHealth = {
            status: "degraded",
            profile: this.adapter?.transportProfile ?? "bun_in_process",
            mode: this.options.mode,
            checkedAt: nowIso(),
            reason,
        }
    }

    private requireReadyAdapter(): TaricServiceAdapter {
        this.assertOpen()
        if (!this.initialized || this.currentHealth.status !== "healthy" || !this.adapter) {
            throw new TaricUnavailableError(this.currentHealth.reason ?? "Taric authority is unavailable", this.options.mode)
        }
        return this.adapter
    }

    private assertOpen(): void {
        if (this.closed) throw new TaricUnavailableError("Taric host module is closed", this.options.mode)
    }

    private async closeAdapterAfterStartupFailure(adapter: TaricServiceAdapter): Promise<void> {
        this.adapter = undefined
        try {
            await adapter.close()
        } catch {
            // Preserve the startup validation error while still attempting resource cleanup.
        }
    }
}

export function createTaricHostModule(options: TaricHostModuleOptions): TaricHostModule {
    return new TaricHostModule(options)
}
