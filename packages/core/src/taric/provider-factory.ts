import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { ConfigManager } from "../config"
import { deriveCompositeProjectKey } from "../project/types"
import type { Project } from "../project/types"
import type { ChallengeMemoryProvider, ChallengeMemoryScope } from "../challenge/memory-provider"
import { TaricMemoryProvider } from "../challenge/taric-memory-provider"
import { EncryptedTaricOutbox } from "./outbox"
import { createTaricHostModule } from "./host-module"
import type { TaricHostModule } from "./host-module"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_DEFAULT_POLICY_DIGEST } from "./compatibility"
import { createEmbeddedTaricServiceAdapter } from "./embedded-adapter"
import { createNetworkTaricServiceAdapter } from "./network-adapter"
import { getLocalTaricGatewayRuntime } from "./local-gateway"
import { assertTaricVerificationReport } from "./verification"
import { assertTaricControlPlaneContract } from "./control-plane-contract"
import type { TaricMemoryMode } from "./types"
import { TaricUnavailableError } from "./types"

export type TaricMemoryProviderFactory = (scope: ChallengeMemoryScope) => Promise<ChallengeMemoryProvider>

function decodeOutboxKey(value: string | undefined): Uint8Array | undefined {
    const text = value?.trim()
    if (!text) return
    if (/^[0-9a-f]{64}$/i.test(text)) return new Uint8Array(Buffer.from(text, "hex"))
    try {
        const bytes = new Uint8Array(Buffer.from(text, "base64url"))
        return bytes.byteLength === 32 ? bytes : undefined
    } catch {
        return
    }
}

function requiredProjectScope(scope: ChallengeMemoryScope): asserts scope is ChallengeMemoryScope & { project: NonNullable<ChallengeMemoryScope["project"]>; projectKey: NonNullable<ChallengeMemoryScope["projectKey"]> } {
    if (!scope.project || !scope.projectKey) throw new Error("Taric provider requires a trusted project scope")
    if (deriveCompositeProjectKey(scope.project) !== scope.projectKey) throw new Error("Taric provider scope has an invalid project key")
}

/** Reject configurations that claim project isolation without project-scoped authority. */
export function assertEngagementBoundarySupported(project: Project, boundary: "shared_development" | "project_bound"): void {
    if (project.memory_mode === "legacy_local") throw new Error("legacy_local projects must use the local memory provider")
    if (boundary === "project_bound") {
        throw new TaricUnavailableError(
            "project_bound Taric bindings are unavailable: project-specific Engagement provisioning and principal/token rotation are not implemented",
            project.memory_mode,
        )
    }
}

/** Production acceptance is a deployment gate, not a transport setting. */
export function assertProductionActivationSupported(settings: {
    acceptanceProfile?: "local_development" | "production_hardened"
    authorityProfile?: "single_host_sqlite" | "multi_host_authority"
    engagementBoundary?: "shared_development" | "project_bound"
    profile?: "embedded_bun" | "authenticated_proxy"
} | undefined): void {
    if (settings?.acceptanceProfile !== "production_hardened") return
    if (settings.engagementBoundary !== "project_bound") throw new TaricUnavailableError("production_hardened refuses shared Engagement credentials", "taric_required")
    throw new TaricUnavailableError("production_hardened activation is blocked until project identities, revocation, TLS, persistent egress, reviewer roles and paired restore evidence are verified", "taric_required")
}

/** Build the same project-bound host used by the memory provider for governance APIs. */
export async function createTaricHostModuleForProject(
    config: ConfigManager,
    project: Project,
    projectKey = deriveCompositeProjectKey(project),
    runtime: { hostSessionId?: string } = {},
): Promise<TaricHostModule> {
    if (project.memory_mode === "legacy_local") throw new Error("legacy_local projects must use the local memory provider")
    if (deriveCompositeProjectKey(project) !== projectKey) throw new Error("Taric provider scope has an invalid project key")
    if (project.mode === "authorized_pentest") assertTaricControlPlaneContract()

    const mode: TaricMemoryMode = project.memory_mode
    if (!project.taric_engagement_id) throw new TaricUnavailableError("Taric Engagement binding is missing", mode)
    const settings = (await config.getHostSettings()).taric
    if (!settings?.enabled) throw new TaricUnavailableError("Taric is disabled in host settings", mode)
    const boundary = settings.engagementBoundary ?? "shared_development"
    assertProductionActivationSupported(settings)
    assertEngagementBoundarySupported(project, boundary)
    if (settings.profile && settings.profile !== "embedded_bun" && settings.profile !== "authenticated_proxy") {
        throw new TaricUnavailableError(`Taric profile ${settings.profile} is not available in the Taric provider`, mode)
    }
    const profile = settings.profile ?? "authenticated_proxy"
    if (mode === "taric_required" && settings.verificationRequired === true) {
        try {
            await assertTaricVerificationReport(settings.verificationReportPath ?? resolve(config.dir, "taric-verification.json"), profile)
        } catch (error) {
            throw new TaricUnavailableError(error instanceof Error ? error.message : String(error), mode)
        }
    }
    if (!settings.hostPrincipalId || !settings.modelPrincipalId) {
        throw new TaricUnavailableError("Taric hostPrincipalId and modelPrincipalId are required", mode)
    }

    const expectedCompatibility = {
        ...TARIC_COMPATIBILITY_BASELINE,
        policyDigest: settings.policyDigest ?? TARIC_DEFAULT_POLICY_DIGEST,
        bunDriver: {
            packageName: TARIC_BUN_DRIVER_PACKAGE,
            version: TARIC_BUN_DRIVER_VERSION,
            integrity: TARIC_BUN_DRIVER_INTEGRITY,
        },
    }
    const binding = {
        projectId: projectKey,
        tenantId: project.tenant_id,
        engagementId: project.taric_engagement_id,
        hostPrincipalId: settings.hostPrincipalId,
        modelPrincipalId: settings.modelPrincipalId,
    }

    let adapter
    try {
        const local = runtime.hostSessionId ? getLocalTaricGatewayRuntime() : undefined
        const localTaskAuthority = local && local.hostPrincipalId === binding.hostPrincipalId && local.modelPrincipalId === binding.modelPrincipalId && local.engagementId === binding.engagementId && local.host === settings.gatewayHost && local.port === settings.gatewayPort
        if (runtime.hostSessionId && profile === "authenticated_proxy") {
            if (!localTaskAuthority) throw new Error("authorized task sessions require embedded_bun or the locally supervised Taric authority")
            // The local supervisor owns this exact authority. The embedded
            // route binds a trusted session per task; gateway callers cannot
            // assign their own session through a request field.
            adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: local.dbPath, contentRoot: settings.contentRoot, binding, hostCapabilities: settings.embeddedHostCapabilities, hostSessionId: runtime.hostSessionId })
        } else if (profile === "authenticated_proxy") {
            const transport = settings.gatewayTransport ?? (settings.gatewayUrl ? "https" : "tls_tcp")
            const hostTokenEnv = settings.gatewayHostTokenEnv ?? settings.gatewayTokenEnv ?? "TARIC_GATEWAY_HOST_TOKEN"
            const modelTokenEnv = settings.gatewayModelTokenEnv ?? settings.gatewayTokenEnv ?? "TARIC_GATEWAY_MODEL_TOKEN"
            const operatorTokenEnv = settings.gatewayOperatorTokenEnv ?? "TARIC_GATEWAY_OPERATOR_TOKEN"
            const hostToken = process.env[hostTokenEnv]
            const modelToken = process.env[modelTokenEnv]
            if (!hostToken || !modelToken) throw new Error(`Taric gateway token environment variables ${hostTokenEnv} and ${modelTokenEnv} are required`)
            if (hostToken === modelToken) throw new Error("Taric gateway host and model tokens must be distinct principal credentials")
            let ca: Buffer | undefined
            if (settings.gatewayCaFile) {
                const caFile = Bun.file(settings.gatewayCaFile)
                if (!(await caFile.exists())) throw new Error(`Taric gateway CA file does not exist: ${settings.gatewayCaFile}`)
                ca = Buffer.from(await caFile.arrayBuffer())
            }
            if (transport === "https") {
                const url = settings.gatewayUrl ?? (settings.gatewayHost && settings.gatewayPort ? `https://${settings.gatewayHost}:${settings.gatewayPort}${settings.gatewayPath ?? "/rpc"}` : undefined)
                if (!url) throw new Error("authenticated_proxy HTTPS requires gatewayUrl or gatewayHost and gatewayPort")
                adapter = createNetworkTaricServiceAdapter({
                    binding,
                    expectedCompatibility,
                    transport: { kind: "https", url, hostToken, modelToken, operatorToken: process.env[operatorTokenEnv], operatorPrincipalId: settings.gatewayOperatorPrincipalId, ca, servername: settings.gatewayServerName, timeoutMs: settings.gatewayTimeoutMs },
                })
            } else {
                if (!settings.gatewayHost || !settings.gatewayPort) throw new Error("authenticated_proxy TLS TCP requires gatewayHost and gatewayPort")
                adapter = createNetworkTaricServiceAdapter({
                    binding,
                    expectedCompatibility,
                    transport: { kind: "tls_tcp", host: settings.gatewayHost, port: settings.gatewayPort, hostToken, modelToken, operatorToken: process.env[operatorTokenEnv], operatorPrincipalId: settings.gatewayOperatorPrincipalId, ca, servername: settings.gatewayServerName, timeoutMs: settings.gatewayTimeoutMs },
                })
            }
        } else {
            if (!settings.authorityPath) throw new Error("Taric authorityPath is required for embedded_bun profile")
            adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: settings.authorityPath, contentRoot: settings.contentRoot, binding, hostCapabilities: settings.embeddedHostCapabilities, hostSessionId: runtime.hostSessionId })
        }
    } catch (error) {
        if (mode === "taric_required") throw new TaricUnavailableError(error instanceof Error ? error.message : String(error), mode)
    }

    return createTaricHostModule({ binding, expectedCompatibility, mode, adapter })
}

/** Create one cached Taric provider per trusted project in a daemon. */
export function createTaricMemoryProviderFactory(config: ConfigManager): TaricMemoryProviderFactory {
    return async (scope) => {
        requiredProjectScope(scope)
        return (async (): Promise<ChallengeMemoryProvider> => {
            const project = scope.project
            if (project.memory_mode === "legacy_local") throw new Error("legacy_local projects must use the local memory provider")
            const mode: TaricMemoryMode = project.memory_mode
            const host = await createTaricHostModuleForProject(config, project, scope.projectKey)
            const settings = (await config.getHostSettings()).taric!
            const defaultOutboxName = `${createHash("sha256").update(scope.projectKey).digest("hex")}.jsonl`
            const outboxPath = settings.outboxPath ?? (settings.authorityPath ? `${settings.authorityPath}.outbox.jsonl` : resolve(config.dir, "taric", defaultOutboxName))
            const outboxKey = decodeOutboxKey(process.env.TARIC_OUTBOX_KEY)
            const outbox = new EncryptedTaricOutbox({
                path: outboxPath,
                key: outboxKey,
                maxBytes: settings.outboxMaxBytes,
                maxEvents: settings.outboxMaxEvents,
            })
            return new TaricMemoryProvider({ host, mode, outbox })
        })()
    }
}
