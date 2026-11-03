import type { TaricCompatibility } from "./types"
import type { TaricHealth, TaricMemoryMode } from "./types"
import type { TaricOutboxReplaySummary, TaricSubscriptionRecoverySnapshot } from "./outbox"
import { TARIC_PACKAGE_ARTIFACTS, TARIC_UPSTREAM_COMPONENT_ARTIFACTS } from "./compatibility"

export type TaricSelectedProfile = "embedded_bun" | "authenticated_proxy" | "unavailable"

export type TaricDiagnosticCode =
    | "authority_unavailable"
    | "version_mismatch"
    | "memory_degraded"
    | "outbox_backlog"
    | "replay_conflict"
    | "recovery_stale"

export type TaricDiagnosticSeverity = "info" | "warning" | "error"

export interface TaricDiagnostic {
    code: TaricDiagnosticCode
    severity: TaricDiagnosticSeverity
    message: string
    remediation: string
    details: Readonly<Record<string, string | number | boolean>>
}

export interface TaricOutboxDiagnosticInput {
    pending: number
    conflicts?: number
    maxEvents?: number
    bytes?: number
    maxBytes?: number
    confirmedReadSeq?: number
}

export interface TaricDiagnosticsInput {
    mode: TaricMemoryMode
    selectedProfile?: Exclude<TaricSelectedProfile, "unavailable">
    health?: TaricHealth
    expectedCompatibility?: TaricCompatibility
    actualCompatibility?: TaricCompatibility
    compatibilityMismatches?: readonly string[]
    outbox?: TaricOutboxDiagnosticInput
    replay?: Pick<TaricOutboxReplaySummary, "conflicts" | "watermark" | "stopped">
    recovery?: TaricSubscriptionRecoverySnapshot
    staleRecoveryAfterMs?: number
    now?: Date
}

export interface TaricDiagnosticReport {
    generatedAt: string
    mode: TaricMemoryMode
    selectedProfile: TaricSelectedProfile
    artifactDigests: Readonly<Record<string, string>>
    status: "healthy" | "degraded" | "blocked"
    diagnostics: readonly TaricDiagnostic[]
    metrics: Readonly<{
        pendingOutbox: number
        replayConflicts: number
        confirmedReadSeq: number
    }>
}

const DEFAULT_STALE_RECOVERY_MS = 15 * 60 * 1000

const TARIC_ARTIFACT_DIGESTS: Readonly<Record<string, string>> = {
    ...Object.fromEntries(Object.entries(TARIC_PACKAGE_ARTIFACTS).map(([name, artifact]) => [name, artifact.integrity])),
    ...Object.fromEntries(Object.entries(TARIC_UPSTREAM_COMPONENT_ARTIFACTS).map(([name, artifact]) => [name, artifact.integrity])),
}

function selectedProfile(input: TaricDiagnosticsInput): TaricSelectedProfile {
    if (input.selectedProfile === "embedded_bun" || input.selectedProfile === "authenticated_proxy") return input.selectedProfile
    if (input.health?.profile === "bun_in_process") return "embedded_bun"
    if (input.health?.profile === "authenticated_proxy") return "authenticated_proxy"
    return "unavailable"
}

function safeText(value: unknown, fallback: string): string {
    if (typeof value !== "string" || !value.trim()) return fallback
    return value
        .trim()
        .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi, "[redacted private key]")
        .replace(/(authorization|api[-_ ]?key|token|password|secret|cookie|credential|database[_-]?url|connection[_-]?string|registry[_-]?key|outbox[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
        .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[redacted]@")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
}

function safeCount(value: number | undefined): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function addDiagnostic(diagnostics: TaricDiagnostic[], diagnostic: TaricDiagnostic): void {
    if (!diagnostics.some((item) => item.code === diagnostic.code)) diagnostics.push(diagnostic)
}

function compatibilityMismatches(input: TaricDiagnosticsInput): readonly string[] {
    if (input.compatibilityMismatches && input.compatibilityMismatches.length > 0) return input.compatibilityMismatches.map((item) => safeText(item, "compatibility mismatch"))
    if (!input.expectedCompatibility || !input.actualCompatibility) return []
    const mismatches: string[] = []
    for (const key of ["apiContractVersion", "schemaVersion", "coreVersion", "storageContract", "policyVersion", "policyDigest"] as const) {
        if (input.expectedCompatibility[key] !== input.actualCompatibility[key]) mismatches.push(`${key} mismatch`)
    }
    if (
        input.expectedCompatibility.bunDriver.packageName !== input.actualCompatibility.bunDriver.packageName ||
        input.expectedCompatibility.bunDriver.version !== input.actualCompatibility.bunDriver.version ||
        input.expectedCompatibility.bunDriver.integrity !== input.actualCompatibility.bunDriver.integrity
    ) {
        mismatches.push("bunDriver mismatch")
    }
    return mismatches
}

/** Build a redacted, operator-facing snapshot from host-owned state only. */
export function buildTaricDiagnostics(input: TaricDiagnosticsInput): TaricDiagnosticReport {
    const now = input.now ?? new Date()
    const diagnostics: TaricDiagnostic[] = []
    const health = input.health
    const outbox = input.outbox
    const replayConflicts = safeCount(input.replay?.conflicts ?? outbox?.conflicts)
    const pendingOutbox = safeCount(outbox?.pending)
    const confirmedReadSeq = Math.max(safeCount(outbox?.confirmedReadSeq), safeCount(input.replay?.watermark), safeCount(input.recovery?.confirmedReadSeq))

    const mismatches = compatibilityMismatches(input)
    if (mismatches.length > 0) {
        addDiagnostic(diagnostics, {
            code: "version_mismatch",
            severity: "error",
            message: `Taric compatibility check failed: ${mismatches.join(", ")}`,
            remediation: "Install the pinned Taric artifacts and policy manifest, then restart the affected project.",
            details: { mismatchCount: mismatches.length },
        })
    }

    if (health?.status === "unavailable" || health?.status === "closed") {
        addDiagnostic(diagnostics, {
            code: "authority_unavailable",
            severity: input.mode === "taric_required" ? "error" : "warning",
            message: `Taric authority is ${health.status}: ${safeText(health.reason, "no health detail")}`,
            remediation: input.mode === "taric_required"
                ? "Restore the authority and rerun the health check before launching governed actions."
                : "Restore the authority; queued host events will remain in the encrypted outbox until replay succeeds.",
            details: { mode: input.mode, blocked: input.mode === "taric_required" },
        })
    }

    if (health?.status === "degraded") {
        addDiagnostic(diagnostics, {
            code: "memory_degraded",
            severity: input.mode === "taric_required" ? "error" : "warning",
            message: `Taric-backed memory is degraded: ${safeText(health.reason, "authority health is degraded")}`,
            remediation: "Inspect the authority health and replay status. Do not enable a local memory fallback for Taric mode.",
            details: { mode: input.mode, blocked: input.mode === "taric_required" },
        })
    }

    if (outbox && (pendingOutbox > 0 || replayConflicts > 0)) {
        const atEventLimit = outbox.maxEvents !== undefined && pendingOutbox >= outbox.maxEvents
        const atByteLimit = outbox.maxBytes !== undefined && outbox.bytes !== undefined && outbox.bytes >= outbox.maxBytes
        addDiagnostic(diagnostics, {
            code: "outbox_backlog",
            severity: atEventLimit || atByteLimit ? "error" : "warning",
            message: `Encrypted Taric outbox has ${pendingOutbox} pending event${pendingOutbox === 1 ? "" : "s"}.`,
            remediation: atEventLimit || atByteLimit
                ? "Restore Taric and replay or resolve pending events before accepting more deferred writes."
                : "Restore Taric and run ordered replay; keep the outbox key available across restarts.",
            details: {
                pending: pendingOutbox,
                ...(outbox.maxEvents !== undefined ? { maxEvents: outbox.maxEvents } : {}),
                ...(outbox.bytes !== undefined ? { bytes: outbox.bytes } : {}),
            },
        })
    }

    if (replayConflicts > 0) {
        addDiagnostic(diagnostics, {
            code: "replay_conflict",
            severity: "error",
            message: `${replayConflicts} Taric outbox event${replayConflicts === 1 ? " is" : "s are"} in conflict.`,
            remediation: "Inspect the preserved event and Taric request result, reconcile it with the current authority version, then submit an explicit correction.",
            details: { conflicts: replayConflicts },
        })
    }

    const recovery = input.recovery
    if (recovery && recovery.state === "degraded") {
        addDiagnostic(diagnostics, {
            code: "recovery_stale",
            severity: "warning",
            message: `Taric notification recovery is degraded at read_seq ${recovery.confirmedReadSeq}.`,
            remediation: "Reconnect the subscription and run an authoritative query from the confirmed read_seq.",
            details: { confirmedReadSeq: recovery.confirmedReadSeq },
        })
    } else if (recovery?.lastRefreshAt) {
        const ageMs = Math.max(0, now.getTime() - Date.parse(recovery.lastRefreshAt))
        if (Number.isFinite(ageMs) && ageMs > (input.staleRecoveryAfterMs ?? DEFAULT_STALE_RECOVERY_MS)) {
            addDiagnostic(diagnostics, {
                code: "recovery_stale",
                severity: "warning",
                message: `Taric notification recovery has not refreshed for ${Math.round(ageMs / 60_000)} minutes.`,
                remediation: "Reconnect or trigger a manual authoritative refresh; notifications are hints and cannot advance state by themselves.",
                details: { confirmedReadSeq: recovery.confirmedReadSeq, ageMs: Math.round(ageMs) },
            })
        }
    }

    const status = diagnostics.some((item) => item.severity === "error")
        ? "blocked"
        : diagnostics.some((item) => item.severity === "warning")
            ? "degraded"
            : "healthy"
    return {
        generatedAt: now.toISOString(),
        mode: input.mode,
        selectedProfile: selectedProfile(input),
        artifactDigests: TARIC_ARTIFACT_DIGESTS,
        status,
        diagnostics,
        metrics: { pendingOutbox, replayConflicts, confirmedReadSeq },
    }
}

