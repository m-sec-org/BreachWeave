import { describe, expect, test } from "bun:test"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_COMPATIBILITY_BASELINE, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION } from "./compatibility"
import { createTaricHostModule } from "./host-module"
import { TaricOperationError } from "./types"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "./types"

const binding: TaricHostBinding = {
    projectId: "project-1",
    tenantId: "tenant-1",
    engagementId: "engagement-1",
    hostPrincipalId: "host-1",
    modelPrincipalId: "model-1",
}

const compatibility: TaricCompatibility = {
    ...TARIC_COMPATIBILITY_BASELINE,
    policyDigest: "sha256:policy",
    bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
}

function createAdapter(overrides: Partial<TaricServiceAdapter> = {}): TaricServiceAdapter & { calls: Array<{ operation: string; input: Record<string, unknown> }>; closed: number } {
    const adapter = {
        calls: [] as Array<{ operation: string; input: Record<string, unknown> }>,
        closed: 0,
        async getProfile() {
            return { status: "verified" as const, compatibility }
        },
        async getBinding() {
            return binding
        },
        async invoke(operation: string, input: Record<string, unknown>) {
            adapter.calls.push({ operation, input })
            return { ok: true, data: { operation, input } }
        },
        async close() {
            adapter.closed += 1
        },
        ...overrides,
    }
    return adapter
}

describe("TaricHostModule", () => {
    test("allows host snapshot reads including admitted records without exposing selectors to models", async () => {
        const calls: Array<{ operation: string; input: Record<string, unknown>; role: string }> = []
        const adapter = createAdapter({
            async invoke(operation, input, role) {
                calls.push({ operation, input, role: role ?? "model" })
                return { ok: true, data: { records: [], read_seq: 3 } }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await host.invokeHost("resource.query", { kind: "coverage", as_of: 3, include_candidates: true, page_size: 50 })
        expect(calls).toEqual([{ operation: "resource.query", role: "host", input: { kind: "coverage", as_of: 3, include_candidates: true, page_size: 50, engagement_id: binding.engagementId } }])
        await expect(host.query("resource.query", { include_candidates: true })).rejects.toThrow("host-owned")
        await expect(host.query("resource.query", { trust_level: "L1" })).rejects.toThrow("host-owned")
        expect(calls).toHaveLength(1)
        await host.close()
    })

    test("keeps observation capture at candidate trust without unsupported or verified status", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        const observation = { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: "2026-10-30T00:00:00.000Z", statement: "Fixture response metadata", artifact_refs: [] }
        for (const status of ["observed", "negative", "inconclusive", "verified", "active", ""]) {
            await expect(host.captureObservation({ eventId: "status-fixture", sourceKind: "host_event", observation: { ...observation, status } })).rejects.toThrow("must remain proposed")
        }
        expect(adapter.calls).toHaveLength(0)
        await host.captureObservation({ eventId: "candidate-fixture", sourceKind: "host_event", observation: { ...observation, status: "proposed" } })
        expect(adapter.calls[0]?.input.observation).toMatchObject({ status: "proposed", kind: "observation" })
        await host.close()
    })

    test("requires complete WorkRun fencing on host observations", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        const observation = { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: "2026-10-30T00:00:00.000Z", statement: "Fixture response metadata", artifact_refs: [] }
        await expect(host.captureObservation({ eventId: "partial-generation", sourceKind: "host_event", observation, generation: 2 })).rejects.toThrow("requires both")
        await expect(host.captureObservation({ eventId: "partial-run", sourceKind: "host_event", observation, workRunId: "00000000-0000-4000-8000-000000000010" })).rejects.toThrow("requires both")
        await expect(host.captureObservation({ eventId: "invalid-run", sourceKind: "host_event", observation, workRunId: "run-1", generation: 2 })).rejects.toThrow("fence is invalid")
        expect(adapter.calls).toHaveLength(0)
        await host.close()
    })

    test("a successful transport quarantine cannot be reported as an accepted capture", async () => {
        const adapter = createAdapter({ async invoke() { return { ok: true, data: { id: "00000000-0000-4000-8000-000000000022", status: "rejected" } } } })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await expect(host.captureObservation({ eventId: "late-capture", sourceKind: "host_event", workRunId: "00000000-0000-4000-8000-000000000010", generation: 1, observation: { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: "2026-10-30T00:00:00.000Z", statement: "Late response metadata", artifact_refs: [] } })).rejects.toMatchObject({ code: "stale_version" })
        await host.close()
    })

    test("keeps the host unavailable until a verified adapter matches contract and binding", async () => {
        const noAdapter = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required" })
        expect((await noAdapter.initialize()).status).toBe("unavailable")
        await expect(noAdapter.query("context.query", { budget: 400 })).rejects.toThrow("No verified Taric adapter")

        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        expect((await host.initialize()).status).toBe("healthy")
        await host.close()
        expect(adapter.closed).toBe(1)
    })

    test("rejects a contract mismatch and closes the failed adapter", async () => {
        const adapter = createAdapter({
            async getProfile() {
                return { status: "verified", compatibility: { ...compatibility, apiContractVersion: "1.1.0" } }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await expect(host.initialize()).rejects.toThrow("apiContractVersion mismatch")
        expect(host.health().status).toBe("unavailable")
        expect(adapter.closed).toBe(1)
    })

    test("rejects a different trusted authority binding and cleans up", async () => {
        const adapter = createAdapter({
            async getBinding() {
                return { ...binding, engagementId: "other-engagement" }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await expect(host.initialize()).rejects.toThrow("does not match the trusted project context")
        expect(adapter.closed).toBe(1)
    })

    test("dispatches exact Taric request shapes and leaves principal identity to the adapter", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
        await host.initialize()

        const queryResult = await host.query("context.query", { budget: 800, include_candidates: true })
        await host.query("resource.query", { limit: 8, kind: "claim" })
        await host.submitProposal({
            eventId: "bw-event-1",
            subjectType: "claim",
            expectedVersion: 0,
            content: { kind: "claim", proposition: "Check /login", status: "proposed", evidence_refs: [], limitations: [] },
        })
        await host.proposeCheckpoint({ eventId: "bw-checkpoint-1", workRunId: "00000000-0000-4000-8000-000000000010", generation: 2, checkpoint: { completed_steps: [] } })
        await host.captureObservation({
            eventId: "event-1",
            sourceKind: "tool_result",
            observation: {
                resource_ref: "00000000-0000-4000-8000-000000000001",
                observed_at: "2026-10-25T00:00:00.000Z",
                statement: "HTTP 200",
                artifact_refs: [],
                limitations: ["Captured by BreachWeave host; raw tool output remains host-controlled."],
            },
            workRunId: "00000000-0000-4000-8000-000000000010",
            generation: 2,
        })

        expect(queryResult).toMatchObject({ operation: "context.query" })
        expect(adapter.calls.map(({ operation }) => operation)).toEqual(["context.query", "resource.query", "proposal.submit", "checkpoint.propose", "capture.observation"])
        expect(adapter.calls[0].input).toEqual({ budget: 800, include_candidates: false, engagement_id: binding.engagementId })
        expect(adapter.calls[1].input).toEqual({ page_size: 8, kind: "claim", engagement_id: binding.engagementId })
        expect(adapter.calls[2].input).toEqual({
            subject_type: "claim",
            expected_version: 0,
            content: { kind: "claim", proposition: "Check /login", status: "proposed", evidence_refs: [], limitations: [], schema_version: "1.0.0", engagement_id: binding.engagementId },
            client_request_id: "bw-event-1",
            idempotency_key: "bw-event-1",
            engagement_id: binding.engagementId,
        })
        expect(adapter.calls[3].input).toEqual({ work_run_id: "00000000-0000-4000-8000-000000000010", generation: 2, checkpoint: { completed_steps: [] }, engagement_id: binding.engagementId })
        expect(adapter.calls[4].input).toEqual({
            observation: {
                kind: "observation",
                resource_ref: "00000000-0000-4000-8000-000000000001",
                observed_at: "2026-10-25T00:00:00.000Z",
                statement: "HTTP 200",
                artifact_refs: [],
                schema_version: "1.0.0",
                engagement_id: binding.engagementId,
                limitations: ["Captured by BreachWeave host; raw tool output remains host-controlled."],
                provenance: { host_id: binding.hostPrincipalId, producer_id: binding.hostPrincipalId, source_kind: "tool", dispatch_id: expect.stringMatching(/^bw-origin:solver:[a-f0-9]{64}$/) },
            },
            client_request_id: "event-1",
            idempotency_key: "event-1",
            work_run_id: "00000000-0000-4000-8000-000000000010",
            generation: 2,
            engagement_id: binding.engagementId,
        })
        expect(JSON.stringify(adapter.calls)).not.toContain("principal_id")
        expect(JSON.stringify(adapter.calls)).not.toContain("project_id")
    })

    test("allows the complete host Artifact operation surface", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await host.invokeHost("artifact.ingest_file", { session_id: "session-1", path: "/tmp/fixture", authorize_spool_access: true, payload_kind: "text", media_type: "text/plain" })
        await host.invokeHost("artifact.content.read", { session_id: "session-1", content_ref: "artifact://fixture", offset: 0, length: 8 })
        await host.invokeHost("artifact.session.output", { session_id: "session-1", page_size: 1 })
        expect(adapter.calls.map(({ operation }) => operation)).toEqual(["artifact.ingest_file", "artifact.content.read", "artifact.session.output"])
    })

    test("rejects fabricated Resource refs, unknown fields, and sensitive statement values before dispatch", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
        await host.initialize()
        const base = { eventId: "event-safe", sourceKind: "host_event" as const }
        await expect(host.captureObservation({
            eventId: "tool-event-without-resource",
            sourceKind: "tool_result",
            observation: {},
        })).rejects.toThrow("Resource UUID")
        await expect(host.captureObservation({ ...base, observation: { resource_ref: "host-event:event-safe", observed_at: new Date().toISOString(), statement: "test", artifact_refs: [] } })).rejects.toThrow("Resource UUID")
        await expect(host.captureObservation({ ...base, observation: { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: new Date().toISOString(), statement: "test", artifact_refs: [], raw_event: { password: "x" } } })).rejects.toThrow("not an approved")
        await expect(host.captureObservation({ ...base, observation: { resource_ref: "00000000-0000-4000-8000-000000000001", observed_at: new Date().toISOString(), statement: "Flag{secret}", artifact_refs: [] } })).rejects.toThrow("sensitive")
        expect(adapter.calls).toHaveLength(0)
    })

    test("preserves Taric business errors and degrades only on unavailable_host or transport failures", async () => {
        const adapter = createAdapter({
            async invoke(operation) {
                if (operation === "context.query") return { ok: false, error: { code: "validation_error", message: "invalid query" } }
                return { ok: false, error: { code: "unavailable_host", message: "authority offline" } }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await expect(host.query("resource.query", { page_size: 51 })).rejects.toThrow("page_size must be between 1 and 50")
        await expect(host.submitProposal({
            eventId: "too-large",
            subjectType: "claim",
            expectedVersion: 0,
            content: { proposition: "x".repeat(33 * 1024) },
        })).rejects.toThrow("exceeds")
        const businessError = await host.query("context.query", { budget: 400 })
            .catch((error: unknown) => error)
        expect(businessError).toBeInstanceOf(TaricOperationError)
        expect((businessError as TaricOperationError).code).toBe("validation_error")
        expect(host.health().status).toBe("healthy")
        const unavailableError = await host.query("resource.query", {})
            .catch((error: unknown) => error)
        expect(unavailableError).toBeInstanceOf(TaricOperationError)
        expect((unavailableError as TaricOperationError).code).toBe("unavailable_host")
        expect(host.health().status).toBe("degraded")
    })

    test("preserves adapter-thrown TaricOperationError without degrading business failures", async () => {
        const adapter = createAdapter({
            async invoke() {
                throw new TaricOperationError("conflict", "proposal conflicts with current state")
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        const error = await host.query("context.query", { budget: 400 }).catch((cause: unknown) => cause)
        expect(error).toBeInstanceOf(TaricOperationError)
        expect((error as TaricOperationError).code).toBe("conflict")
        expect(host.health().status).toBe("healthy")
    })

    test("preserves bounded structured diagnostics from an authority error", async () => {
        const adapter = createAdapter({
            async invoke() {
                return { ok: false, error: { code: "validation_error", message: "invalid request", details: { kind: "contract", contract_name: "proposal", violations: [{ instance_path: "/password", keyword: "required", params: { missingProperty: "password" }, message: "password is required" }] } } }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await expect(host.query("context.query", {})).rejects.toMatchObject({ code: "validation_error", details: { kind: "contract", contract_name: "proposal" } })
    })

    test("revalidates a degraded adapter after recovery", async () => {
        let failed = true
        const adapter = createAdapter({
            async invoke(operation, input) {
                if (failed) {
                    failed = false
                    throw new Error("temporary authority outage")
                }
                adapter.calls.push({ operation, input })
                return { ok: true, data: { recovered: true } }
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
        await host.initialize()
        await expect(host.query("context.query", { budget: 400 })).rejects.toThrow("temporary authority outage")
        expect(host.health().status).toBe("degraded")
        expect((await host.refreshHealth()).status).toBe("healthy")
        await expect(host.query("context.query", { budget: 400 })).resolves.toEqual({ recovered: true })
    })

    test("retries a transient health failure during initial startup", async () => {
        let checks = 0
        const adapter = createAdapter({
            async checkHealth() {
                checks += 1
                if (checks === 1) throw new Error("temporary authority outage")
            },
        })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_best_effort", adapter })
        expect((await host.initialize()).status).toBe("unavailable")
        expect(adapter.closed).toBe(0)
        expect((await host.refreshHealth()).status).toBe("healthy")
        expect(checks).toBe(2)
    })

    test("rejects principal, tenant, and cross-Engagement request overrides before dispatch", async () => {
        const adapter = createAdapter()
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
        await host.initialize()
        await expect(host.query("context.query", { principal_id: binding.hostPrincipalId })).rejects.toThrow("not accepted")
        await expect(host.query("resource.query", { tenant_id: "other" })).rejects.toThrow("not accepted")
        await expect(host.query("resource.query", { engagement_id: "other" })).rejects.toThrow("does not match")
        await expect(host.query("admission.evaluate" as "resource.query", {})).rejects.toThrow("unsupported Taric model query")
        expect(adapter.calls).toHaveLength(0)
    })
})

test("operator mutations require a separate configured adapter route", async () => {
    const adapter = createAdapter()
    const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter })
    await host.initialize()
    await expect(host.invokeOperator("engagement.close", { report_snapshot_ref: "snapshot", expected_authority_seq: 3, expected_engagement_version: 1, reason: "fixture", idempotency_key: "fixture-close" })).rejects.toThrow("No trusted")
    expect(adapter.calls).toHaveLength(0)
    expect(host.health().status).toBe("healthy")
    await host.close()
    const calls: Record<string, unknown>[] = []
    const configured = createAdapter({ async invokeOperator(operation, request) { calls.push({ operation, ...request }); return { ok: true, data: { approved: true } } } })
    const trustedHost = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: "taric_required", adapter: configured })
    await trustedHost.initialize()
    await trustedHost.invokeOperator("scope.revise", { scope_id: "scope", expected_version: 1, policy: {}, roe_artifact_ref: "artifact", roe_artifact_version: 1, idempotency_key: "scope-fixture" })
    expect(calls[0]).toMatchObject({ operation: "scope.revise", engagement_id: binding.engagementId })
    await expect(trustedHost.invokeOperator("scope.revise", { role: "operator" })).rejects.toThrow("not accepted")
    expect(calls).toHaveLength(1)
    await trustedHost.close()
})
