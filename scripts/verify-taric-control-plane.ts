import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { inspectTaricControlPlaneContract } from "../packages/core/src/taric/control-plane-contract"
import { getTaricArtifactDigests, validateTaricCleanConsumerReport } from "../packages/core/src/taric/verification"
import { readTaricSourceIdentity } from "../packages/core/src/taric/source-evidence"

const projectRoot = resolve(import.meta.dir, "..")
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))
const output = resolve(projectRoot, outputArg?.slice("--output=".length) ?? "docs/artifacts/taric-103-control-plane-local.json")
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="))
const fixtureSource = sourceArg ? resolve(sourceArg.slice("--source=".length)) : undefined
const temp = await mkdtemp(resolve(tmpdir(), "breachweave-control-plane-"))
const target = process.platform === "darwin"
    ? process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
    : process.platform === "win32" ? "bun-windows-x64-baseline"
        : process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"

interface CheckResult {
    status: "passed" | "failed"
    exitCode: number
    command: string
    passedTests?: number
    failedTests?: number
    skippedTests?: number
}

const commands: Record<string, string[]> = {
    typecheck: ["bun", "run", "typecheck"],
    uiTypecheck: ["bun", "./node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/ui-web"],
    foundations: ["bun", "test", "packages/core/src/taric/compatibility.test.ts", "packages/core/src/taric/verification.test.ts", "packages/core/src/taric/control-plane-contract.test.ts", "packages/core/src/taric/governance-readiness.test.ts", "packages/core/src/taric/host-identity.test.ts", "packages/core/src/taric/recovery-locator.test.ts", "packages/core/src/taric/source-evidence.test.ts", "packages/core/src/project/migration.test.ts"],
    boundaries: ["bun", "test", "packages/core/src/taric", "packages/core/src/challenge/manager-memory-mode.test.ts", "packages/ui-web/src/taric-governance-api.test.ts"],
    // Test source files directly. `packages/core` also traverses stale
    // generated dist tests after a build and can report duplicate failures
    // unrelated to the current TypeScript sources.
    core: ["bun", "test", "packages/core/src"],
    build: ["bun", "run", "scripts/build.ts", target, resolve(temp, process.platform === "win32" ? "tch-agent.exe" : "tch-agent")],
}

const fixtureReports = {
    workFixture: "docs/artifacts/taric-103-work-fixture.json",
    artifactFixture: "docs/artifacts/taric-103-artifact-fixture.json",
    evidenceFixture: "docs/artifacts/taric-103-artifact-governance.json",
    actionFixture: "docs/artifacts/taric-103-actions.json",
    contractAudit: "docs/artifacts/taric-103-contract-audit.json",
    canonicalFixture: "docs/artifacts/taric-104-canonical-control-plane.json",
} as const
if (fixtureSource) {
    commands.workFixture = ["bun", "run", "scripts/smoke-taric-work.ts", `--source=${fixtureSource}`, `--output=${fixtureReports.workFixture}`]
    commands.artifactFixture = ["bun", "run", "scripts/smoke-taric-artifacts.ts", `--source=${fixtureSource}`, `--output=${fixtureReports.artifactFixture}`]
    commands.evidenceFixture = ["bun", "run", "scripts/smoke-taric-artifact-governance.ts", `--source=${fixtureSource}`, `--output=${fixtureReports.evidenceFixture}`]
    commands.actionFixture = ["bun", "run", "scripts/smoke-taric-actions.ts", `--source=${fixtureSource}`, `--output=${fixtureReports.actionFixture}`]
    commands.canonicalFixture = ["bun", "run", "scripts/smoke-taric-control-plane.ts", `--source=${fixtureSource}`, `--output=${fixtureReports.canonicalFixture}`]
    commands.contractAudit = ["bun", "run", "scripts/audit-taric-103-contract.ts", `--taric-source=${fixtureSource}`, `--output=${fixtureReports.contractAudit}`]
}

const sourceBefore = await readTaricSourceIdentity(projectRoot)
const checks: Record<string, CheckResult> = {}
try {
    for (const [name, command] of Object.entries(commands)) {
        const child = Bun.spawn(command, { cwd: projectRoot, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        const result: CheckResult = { status: exitCode === 0 ? "passed" : "failed", exitCode, command: command.map((part) => part.startsWith(temp) ? "<temporary-build-output>" : part).join(" ") }
        if (command[1] === "test") {
            const text = `${stdout}\n${stderr}`
            result.passedTests = Number(text.match(/(?:^|\n)\s*(\d+) pass\b/)?.[1] ?? 0)
            result.failedTests = Number(text.match(/(?:^|\n)\s*(\d+) fail\b/)?.[1] ?? 0)
            result.skippedTests = Number(text.match(/(?:^|\n)\s*(\d+) skip\b/)?.[1] ?? 0)
        }
        checks[name] = result
        // Raw output remains private to this process; diagnostics never echo
        // upstream errors, model content, configuration or Artifact bytes.
        console.log(`[taric-control-plane] ${name}: ${result.status} (exit ${exitCode})`)
    }
} finally {
    await rm(temp, { recursive: true, force: true })
}
const source = await readTaricSourceIdentity(projectRoot)
const sourceUnchanged = source.digest === sourceBefore.digest && source.revision === sourceBefore.revision
const localFixtures: Record<string, { status: "passed" | "unverified"; report: string; digest?: string; passed?: number; total?: number; evidenceClass?: string }> = {}
for (const [name, path] of Object.entries(fixtureReports)) {
    if (!fixtureSource || checks[name]?.status !== "passed") {
        localFixtures[name] = { status: "unverified", report: path }
        continue
    }
    try {
        const bytes = new Uint8Array(await Bun.file(resolve(projectRoot, path)).arrayBuffer())
        const report = JSON.parse(new TextDecoder().decode(bytes))
        const metrics = report.metrics
        const passed = metrics?.passed
        const total = metrics?.total
        const valid = typeof passed === "number" && typeof total === "number" && total > 0 && passed === total && report.productionEvidence !== true && (report.sourceCommit ?? report.source?.commit) === TARIC_UPSTREAM_COMMIT
        localFixtures[name] = { status: valid ? "passed" : "unverified", report: path, digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`, passed, total, evidenceClass: report.evidenceClass }
    } catch {
        localFixtures[name] = { status: "unverified", report: path }
    }
}
const contract = inspectTaricControlPlaneContract()
const cleanConsumerPath = "docs/artifacts/taric-103-clean-consumer.json"
let cleanConsumer: { status: "passed" | "unverified"; report: string; digest?: string; errors: string[] }
try {
    const bytes = new Uint8Array(await Bun.file(resolve(projectRoot, cleanConsumerPath)).arrayBuffer())
    const errors = validateTaricCleanConsumerReport(JSON.parse(new TextDecoder().decode(bytes)))
    cleanConsumer = { status: errors.length === 0 ? "passed" : "unverified", report: cleanConsumerPath, digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`, errors }
} catch {
    cleanConsumer = { status: "unverified", report: cleanConsumerPath, errors: ["clean-consumer report is unavailable or invalid"] }
}
type CriterionStatus = "passed" | "blocked" | "unverified"
function checked(...names: string[]): CriterionStatus {
    return names.every((name) => checks[name]?.status === "passed") && sourceUnchanged ? "passed" : "blocked"
}
function fixtureChecked(name: string): CriterionStatus {
    return sourceUnchanged && localFixtures[name]?.status === "passed" ? "passed" : "unverified"
}
const criteria: Record<string, Array<{ id: string; status: CriterionStatus; evidenceClass: "breachweave_tests" | "host_conformance" | "clean_consumer" | "local_fixture" }>> = {
    Contract: [
        { id: "pinned_tuple_registry_and_pre_mutation_gate", status: checked("foundations", "boundaries"), evidenceClass: "breachweave_tests" },
        { id: "embedded_transport_principal_routing", status: checked("boundaries"), evidenceClass: "breachweave_tests" },
        { id: "locked_artifacts_clean_consumer", status: cleanConsumer.status, evidenceClass: "clean_consumer" },
        { id: "complete_canonical_fact_mapping", status: contract.status === "available" ? fixtureChecked("contractAudit") : "blocked", evidenceClass: "host_conformance" },
    ],
    Isolation: [{ id: "host_identity_and_negative_boundary_tests", status: checked("foundations", "boundaries"), evidenceClass: "breachweave_tests" }, { id: "shared_engagement_project_manifest_filter", status: fixtureChecked("workFixture"), evidenceClass: "local_fixture" }, { id: "production_project_engagement_isolation", status: "unverified", evidenceClass: "host_conformance" }],
    Paging: [{ id: "pinned_work_and_manifest_board_snapshot", status: fixtureChecked("workFixture"), evidenceClass: "local_fixture" }, { id: "complete_coverage_domain_snapshot", status: fixtureChecked("canonicalFixture"), evidenceClass: "local_fixture" }],
    Work: [{ id: "admission_query_claim_renew_transition", status: fixtureChecked("workFixture"), evidenceClass: "local_fixture" }],
    Recovery: [{ id: "checkpoint_and_resume_packet_validation", status: checked("foundations"), evidenceClass: "breachweave_tests" }, { id: "authority_restart_without_local_run_map", status: fixtureChecked("workFixture"), evidenceClass: "local_fixture" }, { id: "complete_authorized_startup_reconstruction", status: "blocked", evidenceClass: "host_conformance" }],
    Evidence: [{ id: "artifact_capability_and_outbox_boundaries", status: checked("boundaries"), evidenceClass: "breachweave_tests" }, { id: "artifact_sigkill_bytes_and_hash_recovery", status: fixtureChecked("artifactFixture"), evidenceClass: "local_fixture" }, { id: "admitted_evidence_artifact_restart_linkage", status: fixtureChecked("evidenceFixture"), evidenceClass: "local_fixture" }],
    Coverage: [{ id: "authority_bound_complete_gate_and_snapshot", status: fixtureChecked("canonicalFixture"), evidenceClass: "local_fixture" }],
    Action: [{ id: "canonical_loopback_decision_result_unknown_reconciliation", status: fixtureChecked("actionFixture"), evidenceClass: "local_fixture" }, { id: "complete_action_audit_and_scope_revision", status: fixtureChecked("actionFixture"), evidenceClass: "local_fixture" }],
    Projection: [{ id: "board_sqlite_restart_rebuild", status: fixtureChecked("workFixture"), evidenceClass: "local_fixture" }, { id: "canonical_scope_work_checkpoint_report_close_subprocess_rebuild", status: fixtureChecked("canonicalFixture"), evidenceClass: "local_fixture" }, { id: "challenge_file_projection_delete_rebuild", status: fixtureChecked("canonicalFixture"), evidenceClass: "local_fixture" }, { id: "authorized_planner_solver_web_stats_cutover", status: "blocked", evidenceClass: "host_conformance" }],
}
const metrics = Object.fromEntries(Object.entries(criteria).map(([name, items]) => [name, {
    numerator: items.filter((item) => item.status === "passed").length,
    denominator: items.length,
    blocked: items.filter((item) => item.status === "blocked").length,
    unverified: items.filter((item) => item.status === "unverified").length,
    criteria: items,
}]))
const localServicePaths = {
    canonicalScopeBootstrapCoverageReportCloseAndSubprocessRecovery: fixtureChecked("canonicalFixture"),
    admittedWorkLeaseCheckpointRestart: fixtureChecked("workFixture"),
    artifactProcessCrashRecovery: fixtureChecked("artifactFixture"),
    canonicalEvidenceAdmissionRestart: fixtureChecked("evidenceFixture"),
    controlledLoopbackActionAuditUnknownAndStaleResult: fixtureChecked("actionFixture"),
}
const servicePathsAccepted = sourceUnchanged && cleanConsumer.status === "passed" && Object.values(checks).every((check) => check.status === "passed") && Object.values(localServicePaths).every((status) => status === "passed")
const report = {
    format: "breachweave-taric-control-plane-local/1",
    generatedAt: new Date().toISOString(),
    phase: "canonical_control_plane_services_with_independent_process_recovery",
    acceptanceProfile: "local_development",
    authorityProfile: "single_host_sqlite",
    transport: "embedded_bun",
    implementationChecks: sourceUnchanged && Object.values(checks).every((check) => check.status === "passed") && (!fixtureSource || Object.values(localFixtures).every((fixture) => fixture.status === "passed")) ? "passed" : "failed",
    localAcceptance: "blocked",
    localServiceAcceptance: servicePathsAccepted ? "passed" : "unverified",
    localServicePaths,
    upstreamContractBlockers: contract.missingFacts,
    hostImplementationBlockers: ["Authorized Planner/Solver startup and lifecycle cutover", "Canonical Web/stat/report projections replacing the legacy map-backed session engine", "Complete mediated target I/O for the authorized solver tool surface"],
    productionAcceptance: "unverified",
    source,
    sourceUnchangedDuringChecks: sourceUnchanged,
    artifactDigests: getTaricArtifactDigests(),
    cleanConsumer,
    localFixtures,
    contract,
    checks,
    metrics,
    evidence: {
        breachweaveTests: "recorded_in_checks",
        cleanConsumer: cleanConsumer.status,
        upstreamTaricTests: fixtureChecked("contractAudit") === "passed" ? "selected_contract_suites_with_explicit_bun_driver_adaptation" : "unverified",
        hostConformance: "incomplete",
        localFixtureSmoke: fixtureSource ? "recorded_separately_in_localFixtures" : "not_run_explicit_source_required",
        realGatewaySmoke: "unavailable_for_this_source",
        productionDeployment: "unverified",
        comparativeQualityBenchmark: "not_performed",
    },
    limitations: [
        "Passing unit tests and a local build do not establish complete governance acceptance.",
        "Historical gateway or target smoke evidence is not attributed to this source digest.",
        "The pinned Taric 1.0.4 canonical contracts pass local probes; full host product cutover remains incomplete.",
        "The independent-process report fixture uses explicit not_applicable reasons for a protocol-only loopback target and makes no vulnerability-testing claim.",
        "Local source-dist fixtures and clean-consumer package verification are separately labeled; no registry publication claim is made.",
        "The controlled HTTP executor is not an arbitrary subprocess or socket firewall; fixture execution does not enable authorized project activation.",
        "Artifact process-restart results do not establish power-loss or multi-host durability.",
    ],
}
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(`[taric-control-plane] implementation checks ${report.implementationChecks}; canonical service paths ${report.localServiceAcceptance}; full local acceptance ${report.localAcceptance}; report: ${output}`)
if (report.implementationChecks !== "passed") process.exitCode = 1
