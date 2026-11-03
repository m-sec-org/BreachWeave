import type { TaricCompatibility } from "./types"
import type { TaricRegistryOperation } from "./operation-registry"
import { TARIC_OPERATION_REGISTRY, TARIC_OPERATION_REGISTRY_DIGEST, TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "./operation-registry"

export const TARIC_COMPATIBILITY_BASELINE = {
    sourceCommit: "1c466f4d8ad8f775f98bf867453b81230469287a",
    apiContractVersion: "1.4.0",
    adapterContractVersion: "1.1",
    schemaVersion: "1.0.0",
    coreVersion: "1.0.4",
    storageContract: "authority-storage/4",
    sqlContract: "authority-sql/4",
    policyVersion: "1.0.0",
} as const

export const TARIC_UPSTREAM_COMMIT = "1c466f4d8ad8f775f98bf867453b81230469287a"

export const TARIC_DEFAULT_POLICY_DIGEST = "sha256:264736f0b5c561c870f9aa9a94a539123ffe0f80901d98c0944131d0b2a27e13"

export const TARIC_PACKAGE_ARTIFACTS = {
    "@taric/schemas": {
        version: "1.0.4",
        filename: "taric-schemas-1.0.4.tgz",
        integrity: "sha512-sNr6ZBew0Ffb78CvM9LTEmGubnMmjyIyX+Ui3G+wFLOCWuTf35SWPL9CgB8wvcPrBcvIn+Gk/Aw5VsPKAv+O8Q==",
    },
    "@taric/core": {
        version: "1.0.4",
        filename: "taric-core-1.0.4.tgz",
        integrity: "sha512-ggpm5/CiDerdlvmbXEmaILGPkeNwTnGY+vNtYPB6AH8AZq/07UQCgnB61xMGh79m/Xrl6zE+BBUnODxJywZPKQ==",
    },
    "@taric/driver-bun-sqlite": {
        version: "1.0.4",
        filename: "taric-driver-bun-sqlite-1.0.4.tgz",
        integrity: "sha512-RNh4SPWkQpStZ8xp6+RDQ2qKiUS2WPLoEFkGeIntPyK/OtPuM9KSwMtaslGWR2zGKzk4qab1/17JSxSMq65Q+g==",
    },
} as const

/** Tarballs packed from the same upstream revision; these are version references, not BreachWeave runtime imports. */
export const TARIC_UPSTREAM_COMPONENT_ARTIFACTS = {
    "@taric/cli": {
        version: "1.0.4",
        filename: "taric-cli-1.0.4.tgz",
        integrity: "sha512-HeQfSURmk5TMNp/Xj13NZzIdM5qAvievT8svuWKPInc4cHrU0bzLO6rSZ427rCRlqf4wmOicG4G8TNCVuxW6DQ==",
    },
    "@taric/mcp": {
        version: "1.0.4",
        filename: "taric-mcp-1.0.4.tgz",
        integrity: "sha512-Yr8SHAv1KpAeaNOv8LJz5PcmD/zng4I8Eb8dT++0+VAqq0rH3otIzrho4bPqfA8nD4GCpSUgh25JKoWDspAxoQ==",
    },
} as const

export const TARIC_BUN_DRIVER_PACKAGE = "@taric/driver-bun-sqlite"
export const TARIC_BUN_DRIVER_VERSION = TARIC_PACKAGE_ARTIFACTS[TARIC_BUN_DRIVER_PACKAGE].version
export const TARIC_BUN_DRIVER_INTEGRITY = TARIC_PACKAGE_ARTIFACTS[TARIC_BUN_DRIVER_PACKAGE].integrity

/**
 * Evidence captured by Taric's isolated clean-consumer run. The report is
 * intentionally represented as data here so validation does not depend on a
 * sibling checkout or a source/workspace path at runtime.
 */
export const TARIC_CLEAN_CONSUMER_PROFILE = {
    reportVersion: "taric-clean-consumer/1",
    sourceCommit: TARIC_UPSTREAM_COMMIT,
    workspaceLinked: false,
    packageImports: true,
    coreStartupAndMigration: true,
    coreCloseAndRestartRead: true,
    cliVersionAndPersistentDatabase: true,
    bunDriverImportAndQuery: true,
    packages: TARIC_PACKAGE_ARTIFACTS,
    limitations: ["Rebuilt from a clean committed Taric export under Bun; exact npm-packed artifacts verify package contents and dependency closure, not registry publication."],
} as const

// Exact pack integrity is known from the clean-consumer report; deployment
// supplies the approved registry URL and token through environment variables.
export const TARIC_ARTIFACT_MANIFEST = {
    status: "clean_consumer_verified",
    sourceCommit: TARIC_UPSTREAM_COMMIT,
    source: "TARIC_REGISTRY_URL",
    contract: TARIC_COMPATIBILITY_BASELINE,
    policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
    operationCount: 66,
    operationRegistryDigest: TARIC_OPERATION_REGISTRY_DIGEST,
    operationRegistrySourceDigest: TARIC_OPERATION_REGISTRY_SOURCE_DIGEST,
    operations: TARIC_OPERATION_REGISTRY,
    evidence: "taric-clean-consumer/1",
    evidenceScope: "locally packed artifacts; not a registry publication or BreachWeave integration claim",
    packages: TARIC_PACKAGE_ARTIFACTS,
    upstreamComponents: TARIC_UPSTREAM_COMPONENT_ARTIFACTS,
    cleanConsumer: TARIC_CLEAN_CONSUMER_PROFILE,
    bunDriver: {
        packageName: TARIC_BUN_DRIVER_PACKAGE,
        version: TARIC_BUN_DRIVER_VERSION,
        integrity: TARIC_BUN_DRIVER_INTEGRITY,
        status: "pinned_internal_registry_required",
    },
    breachWeaveProfile: "not_verified",
} as const

export type TaricReplayPolicy = "idempotent_replay" | "reconcile_before_replay" | "host_only"

export interface TaricOperationContract extends TaricRegistryOperation {
    replayPolicy: TaricReplayPolicy
    transientErrors: readonly string[]
    permanentErrors: readonly string[]
}

/**
 * Host-side copy of the operation contract required by this integration.
 * This is deliberately explicit: a stable client id does not make a
 * non-idempotent Taric operation safe to replay.
 */
export const TARIC_OPERATION_CONTRACTS: readonly TaricOperationContract[] = TARIC_OPERATION_REGISTRY.map((contract) => ({
    ...contract,
    replayPolicy: contract.idempotent ? "idempotent_replay" : "reconcile_before_replay",
    transientErrors: ["unavailable_host", "transport_error", "timeout"],
    permanentErrors: contract.errors.filter((code) => code !== "unavailable_host" && code !== "internal_error"),
}))

/** Taric's declared idempotency, not a host correlation ID, controls replay. */
export function getTaricOperationContract(operation: string): TaricOperationContract | undefined {
    return TARIC_OPERATION_CONTRACTS.find((contract) => contract.operation === operation)
}

export function validateTaricOperationContracts(contracts: readonly TaricOperationContract[] = TARIC_OPERATION_CONTRACTS): void {
    const seen = new Set<string>()
    for (const contract of contracts) {
        if (!contract.operation.trim() || seen.has(contract.operation)) throw new Error("Taric operation contract names must be unique and non-empty")
        seen.add(contract.operation)
        const expected = TARIC_OPERATION_REGISTRY.find((item) => item.operation === contract.operation)
        if (!expected) throw new Error("Taric operation contract contains an unsupported operation")
        for (const field of ["operation", "roles", "request", "response", "errors", "idempotent", "mutates_authority", "engagement_scoped", "capability"] as const) {
            if (JSON.stringify(contract[field]) !== JSON.stringify(expected[field])) throw new Error(`Taric operation contract mismatch: ${contract.operation}.${field}`)
        }
        const replayPolicy = expected.idempotent ? "idempotent_replay" : "reconcile_before_replay"
        if (contract.replayPolicy !== replayPolicy) throw new Error(`Taric operation replay policy mismatch: ${contract.operation}`)
        if (contract.transientErrors.length === 0 || contract.permanentErrors.length === 0) throw new Error("Taric operation must declare transient and permanent errors")
        if (contract.transientErrors.some((code) => contract.permanentErrors.includes(code))) throw new Error("Taric operation classifies one error as transient and permanent")
    }
    for (const { operation } of TARIC_OPERATION_REGISTRY) if (!seen.has(operation)) throw new Error(`Taric operation contract is missing ${operation}`)
    if (contracts.length !== 66) throw new Error("Taric 1.0.4 must declare exactly 66 operations")
    const actualDigest = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(TARIC_OPERATION_REGISTRY)).digest("hex")}`
    if (actualDigest !== TARIC_OPERATION_REGISTRY_DIGEST) throw new Error("Taric operation registry digest mismatch")
}

export function validateTaricArtifactManifest(): void {
    validateTaricOperationContracts()
    const packageNames = Object.keys(TARIC_PACKAGE_ARTIFACTS) as Array<keyof typeof TARIC_PACKAGE_ARTIFACTS>
    for (const packageName of packageNames) {
        const artifact = TARIC_PACKAGE_ARTIFACTS[packageName]
        const cleanConsumerArtifact = TARIC_CLEAN_CONSUMER_PROFILE.packages[packageName]
        if (cleanConsumerArtifact.version !== artifact.version || cleanConsumerArtifact.integrity !== artifact.integrity) {
            throw new Error(`Taric clean-consumer artifact mismatch for ${packageName}`)
        }
        if (artifact.filename.includes("/") || artifact.filename.includes("\\")) {
            throw new Error(`Taric artifact filename must be a package tarball: ${packageName}`)
        }
    }
    if (TARIC_CLEAN_CONSUMER_PROFILE.workspaceLinked) throw new Error("Taric clean consumer must not use workspace links")
    if (!TARIC_CLEAN_CONSUMER_PROFILE.packageImports || !TARIC_CLEAN_CONSUMER_PROFILE.bunDriverImportAndQuery) {
        throw new Error("Taric clean consumer did not verify package resolution")
    }
    for (const [packageName, artifact] of Object.entries(TARIC_UPSTREAM_COMPONENT_ARTIFACTS)) {
        if (!artifact.version.startsWith("1.0.")) throw new Error(`unsupported Taric upstream component version: ${packageName}`)
        if (artifact.filename.includes("/") || artifact.filename.includes("\\") || !artifact.integrity.startsWith("sha512-")) {
            throw new Error(`invalid Taric upstream component artifact: ${packageName}`)
        }
    }
}

export function compareTaricCompatibility(expected: TaricCompatibility, actual: TaricCompatibility): string[] {
    const mismatches: string[] = []
    for (const key of ["sourceCommit", "apiContractVersion", "adapterContractVersion", "schemaVersion", "coreVersion", "storageContract", "sqlContract", "policyVersion", "policyDigest"] as const) {
        if (expected[key] !== actual[key]) mismatches.push(`${key} mismatch`)
    }
    for (const key of ["packageName", "version", "integrity"] as const) {
        if (expected.bunDriver[key] !== actual.bunDriver[key]) mismatches.push(`bunDriver.${key} mismatch`)
    }
    return mismatches
}

export function validateExpectedTaricCompatibility(compatibility: TaricCompatibility): void {
    validateTaricArtifactManifest()
    const mismatches = compareTaricCompatibility(
        {
            ...compatibility,
            ...TARIC_COMPATIBILITY_BASELINE,
        },
        compatibility,
    )
    if (mismatches.length > 0) {
        throw new Error(`unsupported Taric contract: ${mismatches.join(", ")}`)
    }
    if (!compatibility.policyDigest.trim()) throw new Error("Taric policyDigest is required")
    if (compatibility.bunDriver.packageName !== TARIC_BUN_DRIVER_PACKAGE) {
        throw new Error(`unsupported Taric Bun driver: ${compatibility.bunDriver.packageName}`)
    }
    if (compatibility.bunDriver.version !== TARIC_BUN_DRIVER_VERSION || compatibility.bunDriver.integrity !== TARIC_BUN_DRIVER_INTEGRITY) {
        throw new Error("Taric Bun driver version and integrity must match the locked artifact manifest")
    }
}
