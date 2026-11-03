import { describe, expect, test } from "bun:test"
import { TARIC_VERIFICATION_CHECKS, getTaricArtifactDigests, validateTaricCleanConsumerReport, validateTaricVerificationReport } from "./verification"
import { TARIC_ARTIFACT_MANIFEST } from "./compatibility"

function passedReport() {
    return {
        format: "breachweave-taric-verification/1",
        generatedAt: "2026-10-27T00:00:00.000Z",
        selectedProfile: "authenticated_proxy",
        status: "passed",
        sourceRevision: "test-revision",
        worktree: { dirtyPathCount: 1, digest: `sha256:${"a".repeat(64)}` },
        checks: Object.fromEntries(TARIC_VERIFICATION_CHECKS.map((name) => [name, { exitCode: 0, command: `bun ${name}` }])),
        artifactDigests: getTaricArtifactDigests(),
    }
}

describe("Taric verification gate", () => {
    test("accepts a passing report for the selected profile and exact locked artifact digests", () => {
        expect(validateTaricVerificationReport(passedReport(), "authenticated_proxy")).toEqual([])
    })

    test("blocks failed checks, profile mismatch, and artifact digest mismatch", () => {
        const report = passedReport()
        report.checks.core.exitCode = 1
        report.artifactDigests["@taric/core"].integrity = "sha512-mismatch"
        const errors = validateTaricVerificationReport(report, "embedded_bun")
        expect(errors).toEqual(expect.arrayContaining([
            "Taric verification checks have not passed",
            "verification report profile does not match selected profile embedded_bun",
            "one or more required Taric verification checks failed or are missing",
            "verification report artifact digests do not match the locked Taric manifest",
        ]))
    })

    test("blocks missing or incomplete reports", () => {
        expect(validateTaricVerificationReport(undefined, "authenticated_proxy")).toEqual(["verification report is missing or invalid"])
        const report = passedReport()
        delete report.checks.typecheck
        expect(validateTaricVerificationReport(report, "authenticated_proxy")).toContain("one or more required Taric verification checks failed or are missing")
    })
})

function cleanConsumerReport() {
    return {
        format: "breachweave-taric-clean-consumer/1", status: "passed", blockers: [],
        checks: [{ name: "packed_cli_version", exitCode: 0 }],
        source: { commit: TARIC_ARTIFACT_MANIFEST.sourceCommit, cleanBefore: true, cleanAfter: true, registrySourceDigest: TARIC_ARTIFACT_MANIFEST.operationRegistrySourceDigest },
        observed: {
            tuple: { ...TARIC_ARTIFACT_MANIFEST.contract, policyDigest: String(TARIC_ARTIFACT_MANIFEST.policyDigest) },
            operationCount: Number(TARIC_ARTIFACT_MANIFEST.operationCount), registryDigest: TARIC_ARTIFACT_MANIFEST.operationRegistryDigest,
            cliApiVersion: String(TARIC_ARTIFACT_MANIFEST.contract.apiContractVersion),
            packageImports: true, bunSqliteQuery: true, canonicalCloseReopenRead: true, emptyReplacementRejected: true, workspaceLinked: false,
        },
        artifacts: Object.entries({ ...TARIC_ARTIFACT_MANIFEST.packages, ...TARIC_ARTIFACT_MANIFEST.upstreamComponents }).map(([packageName, artifact]) => ({
            packingMethod: "npm_pack_under_node", packageName, version: artifact.version, filename: artifact.filename,
            actualIntegrity: artifact.integrity as string, expectedIntegrity: artifact.integrity as string, integrityMatches: true, bytes: 1,
        })),
    }
}

describe("clean-consumer source evidence", () => {
    test("requires exact npm-packed bytes while retaining other packing results as separate evidence", () => {
        const report = cleanConsumerReport()
        report.artifacts.push({ ...report.artifacts[0]!, packingMethod: "bun_pm_pack", actualIntegrity: "sha512-different", integrityMatches: false })
        expect(validateTaricCleanConsumerReport(report)).toEqual([])
    })

    test("does not trust a reported success or a report's substituted expected SRI", () => {
        const report = cleanConsumerReport()
        report.artifacts[0]!.actualIntegrity = "sha512-substituted"
        report.artifacts[0]!.expectedIntegrity = "sha512-substituted"
        expect(validateTaricCleanConsumerReport(report)).toContain("clean-consumer artifacts do not match all five locked npm-packed SRIs")
    })

    test("rejects contradictory CLI observations and failed or absent recorded checks", () => {
        const report = cleanConsumerReport()
        report.observed.cliApiVersion = "incompatible"
        report.checks[0]!.exitCode = 1
        expect(validateTaricCleanConsumerReport(report)).toEqual(expect.arrayContaining([
            "clean-consumer recorded checks failed or are missing",
            "clean-consumer contract or operation registry differs from the host pins",
        ]))
        report.checks = []
        expect(validateTaricCleanConsumerReport(report)).toContain("clean-consumer recorded checks failed or are missing")
        report.checks = [{ name: "unrelated_check", exitCode: 0 }]
        expect(validateTaricCleanConsumerReport(report)).toContain("clean-consumer recorded checks failed or are missing")
    })

    test("rejects missing, duplicate, or alternate-format substitutes for locked artifacts", () => {
        for (const change of ["missing", "duplicate", "packing"] as const) {
            const report = cleanConsumerReport()
            if (change === "missing") report.artifacts.pop()
            if (change === "duplicate") report.artifacts[4] = { ...report.artifacts[0]! }
            if (change === "packing") report.artifacts[0]!.packingMethod = "bun_pm_pack"
            expect(validateTaricCleanConsumerReport(report)).toContain("clean-consumer artifacts do not match all five locked npm-packed SRIs")
        }
    })

    test("rejects wrong source, registry, tuple and persistence claims with bounded diagnostics", () => {
        const report = cleanConsumerReport()
        report.source.cleanAfter = false
        report.observed.operationCount = 1
        report.observed.tuple.policyDigest = "sha256:substituted"
        report.observed.emptyReplacementRejected = false
        report.observed.workspaceLinked = true
        expect(validateTaricCleanConsumerReport(report)).toEqual(expect.arrayContaining([
            "clean-consumer source does not match the clean locked revision",
            "clean-consumer contract or operation registry differs from the host pins",
            "clean-consumer import and persistence checks are incomplete",
        ]))
        expect(validateTaricCleanConsumerReport(undefined).every((error) => error.length < 100)).toBe(true)
    })
})
