import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { createNetworkTaricServiceAdapter } from "../packages/core/src/taric/network-adapter"
import { createTaricHostModule } from "../packages/core/src/taric/host-module"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION } from "../packages/core/src/taric/compatibility"
import type { TaricHostBinding } from "../packages/core/src/taric/types"

interface GatewayState {
    host: string
    port: number
    hostPrincipalId: string
    modelPrincipalId: string
    operatorPrincipalId: string
    engagementId: string
}

interface GatewayToken {
    token: string
    role: "host" | "model" | "operator"
    principal_id: string
}

function required(value: string | undefined, field: string): string {
    if (!value?.trim()) throw new Error(`${field} is required`)
    return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectRecords(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        for (const item of value) collectRecords(item, output)
    } else if (isRecord(value)) {
        output.push(value)
        for (const item of Object.values(value)) collectRecords(item, output)
    }
    return output
}

function findResourceId(value: unknown): string | undefined {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    for (const record of collectRecords(value)) {
        for (const key of ["resource_ref", "resource_id", "id"]) {
            if (typeof record[key] === "string" && uuid.test(record[key])) return record[key]
        }
    }
    return undefined
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const details = isRecord(error) && isRecord(error.details) ? error.details : undefined
    const violations = details && Array.isArray(details.violations)
        ? details.violations.slice(0, 8).map((item) => isRecord(item) ? { path: item.instance_path, message: item.message } : item)
        : undefined
    return message
        .replace(/((?:token|password|secret|credential|authorization|connection[_-]?string)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
        .slice(0, 256) + (violations ? ` (${JSON.stringify(violations)})` : "")
}

async function readJson<T>(path: string): Promise<T> {
    return (await Bun.file(path).json()) as T
}

async function writeUnavailableSmoke(blockerCode: string, message: string): Promise<void> {
    const output = process.env.TARIC_REAL_SMOKE_OUTPUT ?? "docs/artifacts/taric-real-integration-smoke.json"
    const report = {
        format: "breachweave-taric-integration-smoke/1",
        profile: "authenticated_proxy",
        status: "unavailable",
        evidenceClass: "real_gateway_smoke",
        targetContacted: false,
        validationPassed: false,
        blocker: { code: blockerCode, message: safeError(message) },
        secretMaterial: "omitted",
    }
    await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report))
    process.exitCode = 1
}

async function main(): Promise<void> {
    if (!process.argv.includes("--live")) throw new Error("pass --live to run the real Taric integration smoke")
    const stateDir = resolve(process.env.TARIC_GATEWAY_STATE_DIR ?? "/tmp/breachweave-dvwa-home/.tch-agent/taric-gateway")
    const resourceValue = process.env.TARIC_REAL_SMOKE_RESOURCE_ID
    if (!resourceValue?.trim()) {
        await writeUnavailableSmoke("missing_trusted_resource", "TARIC_REAL_SMOKE_RESOURCE_ID (trusted provisioned Resource UUID) is required")
        return
    }
    let state: GatewayState
    let gateway: { tokens: GatewayToken[] }
    let ca: Uint8Array
    try {
        state = await readJson<GatewayState>(resolve(stateDir, "state.json"))
        gateway = await readJson<{ tokens: GatewayToken[] }>(resolve(stateDir, "gateway.json"))
        ca = new Uint8Array(await Bun.file(resolve(stateDir, "ca.crt")).arrayBuffer())
    } catch (error) {
        await writeUnavailableSmoke("gateway_prerequisite_unavailable", safeError(error))
        return
    }
    const token = (role: GatewayToken["role"]) => required(gateway.tokens.find((entry) => entry.role === role)?.token, `${role} token`)
    const resourceId = resourceValue.trim()
    const binding: TaricHostBinding = {
        projectId: `taric-real-smoke:${randomUUID()}`,
        tenantId: "breachweave-real-smoke",
        engagementId: required(state.engagementId, "engagement id"),
        hostPrincipalId: required(state.hostPrincipalId, "host principal id"),
        modelPrincipalId: required(state.modelPrincipalId, "model principal id"),
    }
    const adapter = createNetworkTaricServiceAdapter({
        binding,
        expectedCompatibility: {
            ...TARIC_COMPATIBILITY_BASELINE,
            policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
            bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
        },
        transport: {
            kind: "tls_tcp",
            host: state.host,
            port: state.port,
            hostToken: token("host"),
            modelToken: token("model"),
            ca,
            servername: "taric-local-gateway",
        },
    })
    const host = createTaricHostModule({
        binding,
        expectedCompatibility: {
            ...TARIC_COMPATIBILITY_BASELINE,
            policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
            bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
        },
        mode: "taric_required",
        adapter,
    })
    const startedAt = performance.now()
    const health = await host.initialize()
    const statements = [
        ["solver", "BreachWeave Taric integration smoke captured a sanitized solver event; no target traffic was generated."],
        ["attempt", "BreachWeave Taric integration smoke captured a sanitized attempt event; no target traffic was generated."],
        ["report", "BreachWeave Taric integration smoke captured a sanitized report event; no target traffic was generated."],
    ] as const
    const operations: Array<{ kind: string; outcome: "accepted" | "failed"; durationMs: number; error?: string }> = []
    const acceptedEventIds = new Set<string>()
    for (const [kind, statement] of statements) {
        const operationStarted = performance.now()
        const eventId = `real-smoke:${kind}:${randomUUID()}`
        try {
            await host.captureObservation({
                eventId,
                sourceKind: kind === "report" ? "platform_result" : kind === "attempt" ? "host_event" : "tool_result",
                targetId: resourceId,
                observation: {
                    resource_ref: resourceId,
                    observed_at: new Date().toISOString(),
                    statement,
                    artifact_refs: [],
                    limitations: ["Taric integration smoke only; no target traffic or raw response was generated."],
                },
            })
            acceptedEventIds.add(eventId)
            operations.push({ kind, outcome: "accepted", durationMs: Math.round(performance.now() - operationStarted) })
        } catch (error) {
            operations.push({ kind, outcome: "failed", durationMs: Math.round(performance.now() - operationStarted), error: safeError(error) })
        }
    }
    let redactionRejected = false
    try {
        await host.captureObservation({
            eventId: `real-smoke:redaction:${randomUUID()}`,
            sourceKind: "tool_result",
            targetId: resourceId,
            observation: {
                resource_ref: resourceId,
                observed_at: new Date().toISOString(),
                statement: "authorization=Bearer secret-value",
                artifact_refs: [],
            },
        })
    } catch {
        redactionRejected = true
    }
    const query = await host.invokeHost("proposal.list", { page_size: 50 })
    const records = collectRecords(query)
    const queryBackCount = records.filter((record) => {
        const content = record.content
        const provenance = isRecord(content) && isRecord(content.provenance) ? content.provenance : undefined
        return isRecord(content) && content.resource_ref === resourceId && typeof provenance?.dispatch_id === "string" && acceptedEventIds.has(provenance.dispatch_id)
    }).length
    const resourceQuery = await host.query("resource.query", { page_size: 50 })
    const resourceQueryBack = JSON.stringify(resourceQuery).includes(resourceId)
    const acceptedOperations = operations.filter((operation) => operation.outcome === "accepted").length
    const validationPassed = health.status === "healthy" && acceptedOperations === statements.length && queryBackCount === acceptedOperations && redactionRejected
    const result = {
        format: "breachweave-taric-integration-smoke/1",
        profile: "authenticated_proxy",
        targetContacted: false,
        engagementId: binding.engagementId,
        resourceId,
        resourceProvisioning: "trusted_operator_bootstrap",
        resourceResolved: true,
        queryBack: { proposalCount: queryBackCount, resourceVisibleToModelProjection: resourceQueryBack },
        health,
        operations,
        acceptedOperations,
        queryBackCount,
        redactionRejected,
        validationPassed,
        durationMs: Math.round(performance.now() - startedAt),
        secretMaterial: "omitted",
    }
    await Bun.write(process.env.TARIC_REAL_SMOKE_OUTPUT ?? "docs/artifacts/taric-real-integration-smoke.json", `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
    await host.close()
    if (!validationPassed) process.exitCode = 1
}

await main()
