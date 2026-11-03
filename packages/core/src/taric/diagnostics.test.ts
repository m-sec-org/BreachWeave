import { describe, expect, test } from "bun:test"
import { TARIC_PACKAGE_ARTIFACTS, TARIC_UPSTREAM_COMPONENT_ARTIFACTS } from "./compatibility"
import { buildTaricDiagnostics } from "./diagnostics"

describe("Taric diagnostics", () => {
    test("reports required authority failures and redacts credential-shaped details", () => {
        const report = buildTaricDiagnostics({
            mode: "taric_required",
            selectedProfile: "authenticated_proxy",
            health: {
                status: "unavailable",
                profile: "unavailable",
                mode: "taric_required",
                checkedAt: "2026-10-26T00:00:00.000Z",
                reason: "request failed token=super-secret",
            },
        })
        expect(report.status).toBe("blocked")
        expect(report.diagnostics[0]).toMatchObject({ code: "authority_unavailable", severity: "error" })
        expect(report.diagnostics[0]?.message).toContain("token=[redacted]")
        expect(report.diagnostics[0]?.message).not.toContain("super-secret")
        expect(report.selectedProfile).toBe("authenticated_proxy")
        expect(JSON.stringify(report)).not.toContain("super-secret")
    })

    test("redacts configuration secret forms from health diagnostics", () => {
        const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nfixture-private-key-bytes\n-----END RSA PRIVATE KEY-----"
        const report = buildTaricDiagnostics({
            mode: "taric_required",
            health: {
                status: "unavailable",
                profile: "unavailable",
                mode: "taric_required",
                checkedAt: "2026-10-26T00:00:00.000Z",
                reason: `gateway token=fixture-gateway-token; database_url=postgres://fixture:fixture-db-password@db.invalid/app; registry_key=fixture-registry-key; outbox_key=fixture-outbox-key; cookie=fixture-cookie ${privateKey}`,
            },
        })
        const serialized = JSON.stringify(report)
        for (const secret of ["fixture-gateway-token", "fixture-db-password", "fixture-registry-key", "fixture-outbox-key", "fixture-cookie", "fixture-private-key-bytes"]) {
            expect(serialized).not.toContain(secret)
        }
    })

    test("reports the observed profile and all pinned artifact SRI digests", () => {
        const report = buildTaricDiagnostics({
            mode: "taric_best_effort",
            health: {
                status: "healthy",
                profile: "bun_in_process",
                mode: "taric_best_effort",
                checkedAt: "2026-10-26T00:00:00.000Z",
            },
        })
        const expectedDigests = Object.fromEntries([
            ...Object.entries(TARIC_PACKAGE_ARTIFACTS).map(([name, artifact]) => [name, artifact.integrity]),
            ...Object.entries(TARIC_UPSTREAM_COMPONENT_ARTIFACTS).map(([name, artifact]) => [name, artifact.integrity]),
        ])

        expect(report.selectedProfile).toBe("embedded_bun")
        expect(report.artifactDigests).toEqual(expectedDigests)
        expect(Object.values(report.artifactDigests).every((digest) => digest.startsWith("sha512-"))).toBe(true)
    })

    test("exposes backlog, replay conflict, version, and recovery watermark state", () => {
        const report = buildTaricDiagnostics({
            mode: "taric_best_effort",
            compatibilityMismatches: ["schemaVersion mismatch"],
            outbox: { pending: 4, conflicts: 1, maxEvents: 4, confirmedReadSeq: 12 },
            replay: { conflicts: 1, stopped: true, watermark: 12 },
            recovery: {
                projectId: "opaque-project",
                state: "healthy",
                confirmedReadSeq: 13,
                lastRefreshAt: "2026-10-26T00:00:00.000Z",
            },
            now: new Date("2026-10-26T00:01:00.000Z"),
        })
        expect(report.status).toBe("blocked")
        expect(report.metrics).toEqual({ pendingOutbox: 4, replayConflicts: 1, confirmedReadSeq: 13 })
        expect(report.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["version_mismatch", "outbox_backlog", "replay_conflict"]))
    })

    test("treats stale notification recovery as degraded without blocking best effort control", () => {
        const report = buildTaricDiagnostics({
            mode: "taric_best_effort",
            recovery: {
                projectId: "opaque-project",
                state: "healthy",
                confirmedReadSeq: 9,
                lastRefreshAt: "2026-10-25T23:00:00.000Z",
            },
            now: new Date("2026-10-26T00:00:00.000Z"),
        })
        expect(report.status).toBe("degraded")
        expect(report.diagnostics[0]).toMatchObject({ code: "recovery_stale", severity: "warning" })
        expect(report.metrics.confirmedReadSeq).toBe(9)
    })
})
