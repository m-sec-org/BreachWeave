import { TARIC_ARTIFACT_MANIFEST } from "./compatibility"

export type TaricDeploymentProfile = "embedded_bun" | "authenticated_proxy"

export const TARIC_VERIFICATION_CHECKS = ["typecheck", "focused", "core", "build"] as const

export interface TaricVerificationArtifact {
    version: string
    integrity: string
}

export interface TaricVerificationReport {
    format: "breachweave-taric-verification/1"
    generatedAt: string
    selectedProfile: TaricDeploymentProfile
    status: "passed" | "blocked"
    sourceRevision: string
    worktree: {
        dirtyPathCount: number
        digest: string
    }
    checks: Record<(typeof TARIC_VERIFICATION_CHECKS)[number], { exitCode: number; command: string }>
    artifactDigests: Record<string, TaricVerificationArtifact>
}

export function getTaricArtifactDigests(): Record<string, TaricVerificationArtifact> {
    return Object.fromEntries(
        Object.entries({ ...TARIC_ARTIFACT_MANIFEST.packages, ...TARIC_ARTIFACT_MANIFEST.upstreamComponents })
            .map(([name, artifact]) => [name, { version: artifact.version, integrity: artifact.integrity }]),
    )
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Verify observed clean-consumer facts against the host pins, never the report's own expected values. */
export function validateTaricCleanConsumerReport(value: unknown): string[] {
    const report = record(value)
    const source = record(report.source)
    const observed = record(report.observed)
    const tuple = record(observed.tuple)
    const errors: string[] = []
    if (report.format !== "breachweave-taric-clean-consumer/1" || report.status !== "passed" || !Array.isArray(report.blockers) || report.blockers.length !== 0) {
        errors.push("clean-consumer report has not passed")
    }
    const checks = Array.isArray(report.checks) ? report.checks.map(record) : []
    if (checks.length === 0 || checks.some((check) => check.exitCode !== 0) || !checks.some((check) => check.name === "packed_cli_version")) {
        errors.push("clean-consumer recorded checks failed or are missing")
    }
    if (source.commit !== TARIC_ARTIFACT_MANIFEST.sourceCommit || source.cleanBefore !== true || source.cleanAfter !== true || source.registrySourceDigest !== TARIC_ARTIFACT_MANIFEST.operationRegistrySourceDigest) {
        errors.push("clean-consumer source does not match the clean locked revision")
    }
    const expectedTuple = { ...TARIC_ARTIFACT_MANIFEST.contract, policyDigest: TARIC_ARTIFACT_MANIFEST.policyDigest }
    if (Object.entries(expectedTuple).some(([key, expected]) => key !== "sourceCommit" && tuple[key] !== expected) || observed.operationCount !== TARIC_ARTIFACT_MANIFEST.operationCount || observed.registryDigest !== TARIC_ARTIFACT_MANIFEST.operationRegistryDigest || observed.cliApiVersion !== TARIC_ARTIFACT_MANIFEST.contract.apiContractVersion) {
        errors.push("clean-consumer contract or operation registry differs from the host pins")
    }
    if (observed.packageImports !== true || observed.bunSqliteQuery !== true || observed.canonicalCloseReopenRead !== true || observed.emptyReplacementRejected !== true || observed.workspaceLinked !== false) {
        errors.push("clean-consumer import and persistence checks are incomplete")
    }
    const artifacts = Array.isArray(report.artifacts) ? report.artifacts.map(record).filter((artifact) => artifact.packingMethod === "npm_pack_under_node") : []
    const expectedArtifacts = { ...TARIC_ARTIFACT_MANIFEST.packages, ...TARIC_ARTIFACT_MANIFEST.upstreamComponents }
    if (artifacts.length !== Object.keys(expectedArtifacts).length || Object.entries(expectedArtifacts).some(([name, expected]) => {
        const matches = artifacts.filter((artifact) => artifact.packageName === name)
        const artifact = matches[0]
        return matches.length !== 1 || !artifact || artifact.version !== expected.version || artifact.filename !== expected.filename || artifact.actualIntegrity !== expected.integrity || artifact.expectedIntegrity !== expected.integrity || artifact.integrityMatches !== true || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 1
    })) errors.push("clean-consumer artifacts do not match all five locked npm-packed SRIs")
    return errors
}

export function validateTaricVerificationReport(
    value: unknown,
    selectedProfile: TaricDeploymentProfile,
): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return ["verification report is missing or invalid"]
    const report = value as Partial<TaricVerificationReport>
    const errors: string[] = []
    if (report.format !== "breachweave-taric-verification/1") errors.push("verification report format is unsupported")
    const checksPassed = Boolean(report.checks) && TARIC_VERIFICATION_CHECKS.every((name) => report.checks?.[name]?.exitCode === 0)
    if (report.status !== "passed" || !checksPassed) errors.push("Taric verification checks have not passed")
    if (report.selectedProfile !== selectedProfile) errors.push(`verification report profile does not match selected profile ${selectedProfile}`)
    if (!checksPassed) {
        errors.push("one or more required Taric verification checks failed or are missing")
    }
    const expectedArtifacts = getTaricArtifactDigests()
    const actualArtifacts = report.artifactDigests
    if (!actualArtifacts || Object.keys(expectedArtifacts).some((name) => {
        const expected = expectedArtifacts[name]
        const actual = actualArtifacts[name]
        return !actual || actual.version !== expected.version || actual.integrity !== expected.integrity
    })) {
        errors.push("verification report artifact digests do not match the locked Taric manifest")
    }
    return errors
}

export async function assertTaricVerificationReport(path: string, profile: TaricDeploymentProfile): Promise<void> {
    let value: unknown
    try {
        value = await Bun.file(path).json()
    } catch {
        throw new Error(`Taric profile ${profile} is not verified; run bun run verify:taric for this profile`)
    }
    const errors = validateTaricVerificationReport(value, profile)
    if (errors.length > 0) {
        throw new Error(`Taric profile ${profile} is not verified: ${errors.join("; ")}`)
    }
}
