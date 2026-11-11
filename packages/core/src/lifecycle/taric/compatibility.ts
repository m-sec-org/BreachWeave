/** 生命周期引擎使用的 Taric/Pi 兼容性与注册表。 */

export type LifecycleProfile = "development" | "test" | "governed-production"
export type LifecycleAdapterKind = "in_memory" | "fixture_gateway" | "local_sqlite" | "taric_authority"

export const LIFECYCLE_TARIC_BASELINE = Object.freeze({ taricCommit: "b2542a0", piVersion: "1.5.0", apiVersion: "2.0.0", schemaVersion: "lifecycle/1", registryVersion: "1", storageVersion: "authority-storage/5" })

export interface CompatibilityTuple {
    taricCommit: string
    piVersion: string
    apiVersion: string
    schemaVersion: string
    registryVersion: string
    storageVersion: string
    packageDigests?: Readonly<Record<string, string>>
}

export interface CompatibilityStatus { profile: LifecycleProfile; adapter: LifecycleAdapterKind; expected: CompatibilityTuple; actual: CompatibilityTuple; compatible: boolean; diagnostics: readonly string[]; writable: boolean }

export const LIFECYCLE_OPERATION_REGISTRY = Object.freeze([
    { operation: "lifecycle.assignment.commit", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.report.commit", roles: ["host", "model"], idempotent: true, mutates: true },
    { operation: "lifecycle.review.create", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.review.readPack", roles: ["reviewer"], idempotent: false, mutates: false },
    { operation: "lifecycle.review.commit", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.planner.decide", roles: ["host", "model"], idempotent: true, mutates: true },
    { operation: "lifecycle.board.patch", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.board.read", roles: ["host", "model", "reviewer"], idempotent: false, mutates: false },
    { operation: "lifecycle.history.ingest", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.context.prepare", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.finalization.seal", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.finalization.source", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.finalization.publish", roles: ["writer"], idempotent: true, mutates: true },
    { operation: "lifecycle.close.asset", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.close.challenge", roles: ["host"], idempotent: true, mutates: true },
    { operation: "lifecycle.model.request", roles: ["model", "host"], idempotent: false, mutates: false },
    { operation: "lifecycle.tool.dispatch", roles: ["host"], idempotent: false, mutates: true },
] as const)

export const LIFECYCLE_REGISTRY_DIGEST = "sha256:9e3beba2bbbd661005adc53387c576a988a24051ade81dc3ccf561dbc53d86f1"

export type LifecycleOperation = typeof LIFECYCLE_OPERATION_REGISTRY[number]["operation"]

export function compareLifecycleCompatibility(expected: CompatibilityTuple, actual: CompatibilityTuple): string[] {
    const mismatches: string[] = []; for (const key of Object.keys(expected) as Array<keyof CompatibilityTuple>) { if (key === "packageDigests") continue; if (expected[key] !== actual[key]) mismatches.push(`${key} mismatch`) }
    for (const [name, digest] of Object.entries(expected.packageDigests ?? {})) if (actual.packageDigests?.[name] !== digest) mismatches.push(`package.${name} digest mismatch`)
    return mismatches
}

export function checkLifecycleCompatibility(input: { profile: LifecycleProfile; adapter: LifecycleAdapterKind; actual?: Partial<CompatibilityTuple>; packageDigests?: Readonly<Record<string, string>> }): CompatibilityStatus {
    validateLifecycleRegistry()
    const actual = { ...LIFECYCLE_TARIC_BASELINE, packageDigests: input.packageDigests ?? {}, ...input.actual }; const expected = { ...LIFECYCLE_TARIC_BASELINE, packageDigests: input.packageDigests ?? {} }; const diagnostics = compareLifecycleCompatibility(expected, actual); const compatible = diagnostics.length === 0; const writable = compatible || input.profile !== "governed-production"
    return { profile: input.profile, adapter: input.adapter, expected, actual, compatible, diagnostics, writable }
}

export function assertLifecycleCompatibility(status: CompatibilityStatus): void { if (!status.writable) throw new LifecycleCompatibilityError("compatibility_mismatch", `Taric/Pi 兼容性不满足 governed-production: ${status.diagnostics.join("; ")}`) }

export function operationContract(operation: string) { const contract = LIFECYCLE_OPERATION_REGISTRY.find((entry) => entry.operation === operation); if (!contract) throw new LifecycleCompatibilityError("unsupported_operation", `未注册生命周期操作: ${operation}`); return contract }

export function validateLifecycleRegistry(): void { const actual = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(LIFECYCLE_OPERATION_REGISTRY)).digest("hex")}`; if (actual !== LIFECYCLE_REGISTRY_DIGEST || LIFECYCLE_OPERATION_REGISTRY.length !== 17) throw new LifecycleCompatibilityError("registry_mismatch", "生命周期操作注册表摘要不匹配") }

export function rejectLegacyLifecycleWrite(operation: string, input?: Record<string, unknown>): never {
    const legacy = /(?:sidecar|rpc|local-store|challenge_is_completed|solver-review|legacy)/i.test(operation) || Boolean(input && ("localStore" in input || "rpcMethod" in input || "sidecar" in input))
    throw new LifecycleCompatibilityError(legacy ? "legacy_write_rejected" : "write_authority_rejected", `生命周期写操作必须通过 Manager/Taric authority: ${operation}`)
}

export class LifecycleCompatibilityError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "LifecycleCompatibilityError"; this.code = code } }
