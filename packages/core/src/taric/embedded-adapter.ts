import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE, TARIC_PACKAGE_ARTIFACTS } from "./compatibility"
import { TARIC_OPERATION_REGISTRY } from "./operation-registry"
import { TaricOperationError } from "./types"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "./types"

const TARIC_CORE_PACKAGE = "@taric/core"
const TARIC_SCHEMA_PACKAGE = "@taric/schemas"
const TARIC_DRIVER_PACKAGE = "@taric/driver-bun-sqlite"

export interface EmbeddedTaricPrincipal {
    id: string
    role: "model" | "host" | "operator"
    engagement_id?: string
    capabilities?: readonly string[]
    transport_verified: true
    transport_session_id?: string
}

export interface EmbeddedTaricStore {
    close(): Promise<void>
}

export interface EmbeddedTaricCoreService {
    dispatch(operation: string, principal: EmbeddedTaricPrincipal, request: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}

export interface EmbeddedTaricCoreModule {
    AuthorityStore: new (driver: EmbeddedTaricStore) => EmbeddedTaricStore
    API_CONTRACT_VERSION: string
    AUTHORITY_STORAGE_CONTRACT_VERSION: string
    ADMISSION_POLICY_VERSION: string
    policyDigest(): string
    createCoreService(store: EmbeddedTaricStore, contentRoot?: string): Promise<EmbeddedTaricCoreService>
    createPrincipal(role: "model" | "host" | "operator", id: string, engagementId?: string, grants?: readonly string[], reviewerAttestation?: undefined, transportSessionId?: string): EmbeddedTaricPrincipal
}

export interface EmbeddedTaricSchemaModule {
    SCHEMA_VERSION: string
}

export interface EmbeddedTaricDriverModule {
    BunSqliteAuthorityDriver: new (filename?: string) => EmbeddedTaricStore
}

/** Runtime modules can be injected by conformance tests without installing Taric packages. */
export interface EmbeddedTaricRuntimeDependencies {
    core: EmbeddedTaricCoreModule
    schemas: EmbeddedTaricSchemaModule
    driver: EmbeddedTaricDriverModule
}

export interface EmbeddedTaricAdapterOptions {
    authorityPath: string
    contentRoot?: string
    binding: TaricHostBinding
    /** Trusted host configuration; never derived from an RPC request body. */
    hostCapabilities?: readonly ("admit" | "content_read")[]
    /** Stable transport identity required by run-bound task-session fencing. */
    hostSessionId?: string
    /** Explicit trusted local operator configuration. Omission disables operator dispatch. */
    operatorPrincipalId?: string
    dependencies?: EmbeddedTaricRuntimeDependencies
}

function requiredText(value: string, field: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${field} is required`)
    return text
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value))
}

function assertEmbeddedOperationRole(operation: string, role: "model" | "host"): void {
    if (role !== "model" && role !== "host") throw new TaricOperationError("authorization_error", "embedded Taric adapter only supports model and host principals")
    const contract = TARIC_OPERATION_REGISTRY.find((item) => item.operation === operation)
    if (!contract) throw new TaricOperationError("validation_error", `unsupported Taric operation: ${operation}`)
    if (!contract.roles.includes(role)) throw new TaricOperationError("authorization_error", `Taric operation ${operation} is not permitted for ${role} principal`)
}

async function loadRuntimeDependencies(): Promise<EmbeddedTaricRuntimeDependencies> {
    const [coreValue, schemaValue, driverValue] = await Promise.all([
        import(TARIC_CORE_PACKAGE),
        import(TARIC_SCHEMA_PACKAGE),
        import(TARIC_DRIVER_PACKAGE),
    ])
    return {
        core: coreValue as unknown as EmbeddedTaricCoreModule,
        schemas: schemaValue as unknown as EmbeddedTaricSchemaModule,
        driver: driverValue as unknown as EmbeddedTaricDriverModule,
    }
}

/**
 * Construct the Bun-native Taric service from the scoped registry dependencies.
 * Dynamic imports keep legacy_local installations usable when Taric is not
 * installed; Taric modes still fail closed in the provider factory.
 */
export async function createEmbeddedTaricServiceAdapter(options: EmbeddedTaricAdapterOptions): Promise<TaricServiceAdapter> {
    const authorityPath = requiredText(options.authorityPath, "authorityPath")
    const binding = { ...options.binding }
    const hostPrincipalId = requiredText(binding.hostPrincipalId, "hostPrincipalId")
    const modelPrincipalId = requiredText(binding.modelPrincipalId, "modelPrincipalId")
    const engagementId = requiredText(binding.engagementId, "engagementId")
    const hostCapabilities = [...(options.hostCapabilities ?? [])]
    if (hostCapabilities.some((capability) => capability !== "admit" && capability !== "content_read")) throw new Error("unsupported embedded host capability")
    const hostSessionId = options.hostSessionId === undefined ? undefined : requiredText(options.hostSessionId, "hostSessionId")
    let store: EmbeddedTaricStore | undefined
    try {
        const { core, schemas, driver } = options.dependencies ?? await loadRuntimeDependencies()
        store = new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath))
        const service = await core.createCoreService(store, options.contentRoot)
        const hostPrincipal = core.createPrincipal("host", hostPrincipalId, engagementId, hostCapabilities, undefined, hostSessionId)
        const modelPrincipal = core.createPrincipal("model", modelPrincipalId, engagementId)
        const operatorPrincipal = options.operatorPrincipalId === undefined ? undefined : core.createPrincipal("operator", requiredText(options.operatorPrincipalId, "operatorPrincipalId"), engagementId)
        const compatibility: TaricCompatibility = {
            ...TARIC_COMPATIBILITY_BASELINE,
            apiContractVersion: core.API_CONTRACT_VERSION,
            schemaVersion: schemas.SCHEMA_VERSION,
            storageContract: core.AUTHORITY_STORAGE_CONTRACT_VERSION,
            policyVersion: core.ADMISSION_POLICY_VERSION,
            policyDigest: core.policyDigest(),
            bunDriver: {
                packageName: TARIC_BUN_DRIVER_PACKAGE,
                version: TARIC_BUN_DRIVER_VERSION,
                integrity: TARIC_BUN_DRIVER_INTEGRITY,
            },
        }

        return {
            transportProfile: "bun_in_process",
            async getProfile() {
                return { status: "verified", compatibility }
            },
            async getBinding() {
                return { ...binding }
            },
            async checkHealth() {
                const response = await service.dispatch("engagement.status", hostPrincipal, { engagement_id: engagementId })
                if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
                    const error = response && typeof response === "object" ? (response as { error?: { message?: unknown } }).error : undefined
                    throw new Error(typeof error?.message === "string" ? error.message : "Taric authority health check failed")
                }
            },
            async invoke(operation, request, role = "model") {
                assertEmbeddedOperationRole(operation, role)
                if (request.engagement_id !== undefined && request.engagement_id !== engagementId) throw new TaricOperationError("authorization_error", "engagement_id does not match the trusted embedded Taric binding")
                return service.dispatch(operation, role === "host" ? hostPrincipal : modelPrincipal, request)
            },
            async invokeOperator(operation, request) {
                if (!operatorPrincipal) throw new TaricOperationError("authorization_error", "No trusted Taric operator identity is configured")
                const contract = TARIC_OPERATION_REGISTRY.find((item) => item.operation === operation)
                if (!contract?.roles.includes("operator")) throw new TaricOperationError("authorization_error", "Operation is not permitted for the Taric operator")
                if (request.engagement_id !== undefined && request.engagement_id !== engagementId) throw new TaricOperationError("authorization_error", "engagement_id does not match the trusted embedded Taric binding")
                return service.dispatch(operation, operatorPrincipal, request)
            },
            async close() {
                await service.close()
            },
        }
    } catch (error) {
        if (store) await store.close().catch(() => {})
        throw asError(error)
    }
}

export const TARIC_EMBEDDED_DEPENDENCIES = {
    core: TARIC_PACKAGE_ARTIFACTS["@taric/core"],
    schemas: TARIC_PACKAGE_ARTIFACTS["@taric/schemas"],
    driver: TARIC_PACKAGE_ARTIFACTS["@taric/driver-bun-sqlite"],
} as const
