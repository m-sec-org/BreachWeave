import { describe, expect, test } from "bun:test"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION } from "./compatibility"
import { createEmbeddedTaricServiceAdapter } from "./embedded-adapter"
import type { EmbeddedTaricCoreModule, EmbeddedTaricPrincipal, EmbeddedTaricRuntimeDependencies, EmbeddedTaricStore } from "./embedded-adapter"
import { createTaricHostModule, TARIC_HOST_ONLY_OPERATIONS, TARIC_MODEL_PROPOSAL_OPERATIONS, TARIC_MODEL_QUERY_OPERATIONS } from "./host-module"
import { TARIC_OPERATION_REGISTRY } from "./operation-registry"

const binding = {
    projectId: "project-1",
    tenantId: "tenant-1",
    engagementId: "engagement-1",
    hostPrincipalId: "host-1",
    modelPrincipalId: "model-1",
} as const

class FakeStore implements EmbeddedTaricStore {
    closed = false

    async close(): Promise<void> {
        this.closed = true
    }
}

function createRuntime() {
    const calls: Array<{ operation: string; principal: EmbeddedTaricPrincipal; request: Record<string, unknown> }> = []
    let store: FakeStore | undefined
    let serviceClosed = false
    const core: EmbeddedTaricCoreModule = {
        AuthorityStore: class extends FakeStore {
            constructor(_driver: EmbeddedTaricStore) {
                super()
                store = this
            }
        },
        API_CONTRACT_VERSION: TARIC_COMPATIBILITY_BASELINE.apiContractVersion,
        AUTHORITY_STORAGE_CONTRACT_VERSION: TARIC_COMPATIBILITY_BASELINE.storageContract,
        ADMISSION_POLICY_VERSION: TARIC_COMPATIBILITY_BASELINE.policyVersion,
        policyDigest: () => "sha256:264736f0b5c561c870f9aa9a94a539123ffe0f80901d98c0944131d0b2a27e13",
        createCoreService: async () => ({
            async dispatch(operation, principal, request) {
                calls.push({ operation, principal: { ...principal }, request })
                return { ok: true, data: { accepted: true } }
            },
            async close() {
                serviceClosed = true
            },
        }),
        createPrincipal: (role, id, engagement_id, grants, _attestation, transportSessionId) => ({ id, role, engagement_id, transport_verified: true, ...(grants?.length ? { capabilities: [...grants] } : {}), ...(transportSessionId ? { transport_session_id: transportSessionId } : {}) }),
    }
    const dependencies: EmbeddedTaricRuntimeDependencies = {
        core,
        schemas: { SCHEMA_VERSION: TARIC_COMPATIBILITY_BASELINE.schemaVersion },
        driver: { BunSqliteAuthorityDriver: class extends FakeStore { constructor(_filename?: string) { super() } } },
    }
    return { dependencies, calls, getStore: () => store, isServiceClosed: () => serviceClosed }
}

function compatibility() {
    return {
        ...TARIC_COMPATIBILITY_BASELINE,
        policyDigest: "sha256:264736f0b5c561c870f9aa9a94a539123ffe0f80901d98c0944131d0b2a27e13",
        bunDriver: {
            packageName: TARIC_BUN_DRIVER_PACKAGE,
            version: TARIC_BUN_DRIVER_VERSION,
            integrity: TARIC_BUN_DRIVER_INTEGRITY,
        },
    }
}

describe("embedded Bun Taric adapter", () => {
    test("binds explicit trusted capabilities and task session without granting them to the model", async () => {
        const runtime = createRuntime()
        const grants: ("admit" | "content_read")[] = ["admit", "content_read"]
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies, hostCapabilities: grants, hostSessionId: "host-session-a" })
        grants.length = 0
        await adapter.invoke("work.claim", { task_session_ref: "forged-body-session", capabilities: ["operator"] }, "host")
        await adapter.invoke("context.query", { transport_session_id: "forged-body-session" }, "model")
        expect(runtime.calls[0]?.principal).toMatchObject({ id: binding.hostPrincipalId, capabilities: ["admit", "content_read"], transport_session_id: "host-session-a" })
        expect(runtime.calls[1]?.principal.capabilities).toBeUndefined()
        expect(runtime.calls[1]?.principal.transport_session_id).toBeUndefined()
        await adapter.close()
    })

    test("uses a single-host in-process profile and binds health to the host principal", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })

        expect(adapter.transportProfile).toBe("bun_in_process")
        await adapter.checkHealth?.()
        expect(runtime.calls).toEqual([{ operation: "engagement.status", principal: { id: binding.hostPrincipalId, role: "host", engagement_id: binding.engagementId, transport_verified: true }, request: { engagement_id: binding.engagementId } }])
        await expect(adapter.getProfile()).resolves.toMatchObject({ status: "verified", compatibility: compatibility() })
        await expect(adapter.getBinding()).resolves.toEqual(binding)
        await adapter.close()
        expect(runtime.isServiceClosed()).toBe(true)
        expect(runtime.getStore()?.closed).toBe(false)
    })

    test("routes every currently exposed local governance operation according to the registry", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })
        const modelOperations = new Set<string>([...TARIC_MODEL_QUERY_OPERATIONS, ...TARIC_MODEL_PROPOSAL_OPERATIONS])
        const hostOperations = new Set<string>(TARIC_HOST_ONLY_OPERATIONS)
        const localOperations = new Set([...modelOperations, ...hostOperations])
        let expectedDispatches = 0

        for (const operation of localOperations) {
            const registryEntry = TARIC_OPERATION_REGISTRY.find((item) => item.operation === operation)
            expect(registryEntry, `${operation} is missing from the locked operation registry`).toBeDefined()
            const localRoles = new Set<"model" | "host">()
            if (modelOperations.has(operation)) localRoles.add("model")
            if (hostOperations.has(operation)) localRoles.add("host")
            for (const role of localRoles) {
                if (registryEntry?.roles.includes(role)) {
                    await expect(adapter.invoke(operation, { engagement_id: binding.engagementId }, role)).resolves.toMatchObject({ ok: true })
                    expectedDispatches += 1
                } else {
                    await expect(adapter.invoke(operation, { engagement_id: binding.engagementId }, role)).rejects.toThrow(`not permitted for ${role}`)
                }
            }
        }

        expect(runtime.calls).toHaveLength(expectedDispatches)
        expect(runtime.calls.every(({ principal }) => principal.id === (principal.role === "host" ? binding.hostPrincipalId : binding.modelPrincipalId) && principal.engagement_id === binding.engagementId && principal.transport_verified)).toBe(true)
        await adapter.close()
    })

    test("checks both supported principal roles against all 66 registry operations", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })
        let expectedDispatches = 0

        expect(TARIC_OPERATION_REGISTRY).toHaveLength(66)
        for (const entry of TARIC_OPERATION_REGISTRY) {
            for (const role of ["model", "host"] as const) {
                const before = runtime.calls.length
                if (entry.roles.includes(role)) {
                    await adapter.invoke(entry.operation, { engagement_id: binding.engagementId }, role)
                    expect(runtime.calls[before]?.principal).toEqual({ id: role === "host" ? binding.hostPrincipalId : binding.modelPrincipalId, role, engagement_id: binding.engagementId, transport_verified: true })
                    expectedDispatches += 1
                } else {
                    await expect(adapter.invoke(entry.operation, { engagement_id: binding.engagementId }, role)).rejects.toThrow(`not permitted for ${role}`)
                    expect(runtime.calls).toHaveLength(before)
                }
            }
        }
        expect(runtime.calls).toHaveLength(expectedDispatches)
        expect(expectedDispatches).toBe(65)
        await adapter.close()
    })

    test("keeps host and model Work query routes explicit without reading identity from the body", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })
        const forgedRequest = { engagement_id: binding.engagementId, principal_id: "forged-id", role: "host", capabilities: ["content_read"] }

        await adapter.invoke("work.query", { ...forgedRequest, include_active_runs: true }, "host")
        await adapter.invoke("work.query", forgedRequest, "model")
        await adapter.invoke("context.query", forgedRequest)
        expect(runtime.calls.map(({ principal }) => principal)).toEqual([
            { id: binding.hostPrincipalId, role: "host", engagement_id: binding.engagementId, transport_verified: true },
            { id: binding.modelPrincipalId, role: "model", engagement_id: binding.engagementId, transport_verified: true },
            { id: binding.modelPrincipalId, role: "model", engagement_id: binding.engagementId, transport_verified: true },
        ])
        await expect(adapter.invoke("artifact.content.read", forgedRequest)).rejects.toThrow("not permitted for model")
        expect(runtime.calls).toHaveLength(3)
        await adapter.close()
    })

    test("preserves a pre-dispatch authorization rejection without degrading host health", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })
        const host = createTaricHostModule({ binding, expectedCompatibility: compatibility(), mode: "taric_required", adapter })
        await host.initialize()
        const dispatchesBefore = runtime.calls.length

        await expect(host.invokeHost("review.submit", { proposal_id: "proposal-1", reviewer_id: "host-1" })).rejects.toMatchObject({ code: "authorization_error" })
        expect(runtime.calls).toHaveLength(dispatchesBefore)
        expect(host.health().status).toBe("healthy")
        await host.close()
    })

    test("retains the trusted binding when caller-owned setup objects change", async () => {
        const runtime = createRuntime()
        const callerBinding = { ...binding, engagementId: String(binding.engagementId) }
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding: callerBinding, dependencies: runtime.dependencies })
        callerBinding.engagementId = "forged-engagement"
        const returnedBinding = await adapter.getBinding()
        returnedBinding.engagementId = "other-forged-engagement"

        await expect(adapter.getBinding()).resolves.toEqual(binding)
        await adapter.checkHealth?.()
        expect(runtime.calls[0]?.principal.engagement_id).toBe(binding.engagementId)
        expect(runtime.calls[0]?.request.engagement_id).toBe(binding.engagementId)
        await adapter.close()
    })

    test("rejects unsupported operations, wrong local roles, and forged Engagements before dispatch", async () => {
        const runtime = createRuntime()
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies })

        await expect(adapter.invoke("not-a-taric-operation", { engagement_id: binding.engagementId }, "host")).rejects.toThrow("unsupported Taric operation")
        await expect(adapter.invoke("work.claim", { engagement_id: binding.engagementId }, "model")).rejects.toThrow("not permitted for model")
        await expect(adapter.invoke("work.claim", { engagement_id: binding.engagementId })).rejects.toThrow("not permitted for model")
        await expect(adapter.invoke("review.submit", { engagement_id: binding.engagementId }, "host")).rejects.toThrow("not permitted for host")
        await expect(adapter.invoke("admission.promote_l2", { engagement_id: binding.engagementId }, "host")).rejects.toThrow("not permitted for host")
        const invokeUntypedRole = adapter.invoke as (operation: string, request: Record<string, unknown>, role: string) => Promise<unknown>
        await expect(invokeUntypedRole("engagement.status", { engagement_id: binding.engagementId }, "operator")).rejects.toThrow("only supports model and host principals")
        await expect(adapter.invoke("context.query", { engagement_id: "other-engagement" }, "model")).rejects.toThrow("does not match the trusted embedded Taric binding")
        expect(runtime.calls).toHaveLength(0)
        await adapter.close()
    })
})

test("operator dispatch requires explicit trusted configuration and never promotes host/model routes", async () => {
    const deniedRuntime = createRuntime()
    const disabled = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: deniedRuntime.dependencies })
    await expect(disabled.invokeOperator!("scope.revise", {})).rejects.toThrow("No trusted")
    expect(deniedRuntime.calls).toHaveLength(0)
    await disabled.close()
    const runtime = createRuntime()
    const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: ":memory:", binding, dependencies: runtime.dependencies, operatorPrincipalId: "trusted-local-operator" })
    await adapter.invokeOperator!("scope.revise", { engagement_id: binding.engagementId })
    expect(runtime.calls[0]?.principal).toMatchObject({ role: "operator", id: "trusted-local-operator", engagement_id: binding.engagementId })
    await expect(adapter.invoke("scope.revise", { role: "operator" }, "host")).rejects.toThrow("not permitted")
    await expect(adapter.invoke("engagement.close", { role: "operator" }, "model")).rejects.toThrow("not permitted")
    await expect(adapter.invokeOperator!("scope.revise", { engagement_id: "other" })).rejects.toThrow("binding")
    expect(runtime.calls).toHaveLength(1)
    await adapter.close()
})
