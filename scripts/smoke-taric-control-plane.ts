import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { TaricAuthorityProjectBootstrap } from "../packages/core/src/taric/authority-bootstrap"
import { TARIC_DEFAULT_POLICY_DIGEST } from "../packages/core/src/taric/compatibility"
import { TaricAuthorityWorkService } from "../packages/core/src/taric/authority-work-service"
import { TaricAuthorityReportService } from "../packages/core/src/taric/authority-report-service"
import { TaricAuthorityActionService } from "../packages/core/src/taric/authority-action-service"
import { CaptureDtoError } from "../packages/core/src/taric/capture-dto"
import { evaluateEgress } from "../packages/core/src/taric/governance"
import type { RecoveryPremise } from "../packages/core/src/taric/recovery-locator"
import { TaricOperationError } from "../packages/core/src/taric/types"
import { createTaricControlPlaneFixture, digest, record } from "./taric-control-plane-fixture"

function argument(name: string): string | undefined {
    return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const source = argument("source")
if (!source) throw new Error("Pass --source=/absolute/path/to/pinned/Taric")
const fixture = await createTaricControlPlaneFixture(source)
const assertions: Array<{ id: string; passed: boolean }> = []
function check(id: string, passed: boolean): void {
    assertions.push({ id, passed })
    if (!passed) throw new Error(`Control-plane fixture assertion failed: ${id}`)
}

/**
 * Exercise the product projection boundary in a fresh test process. The test
 * creates the local ChallengeManager cache, deletes every disposable file,
 * and reconstructs the challenge, submissions, and stats from Taric.
 */
async function runChallengeProjectionRebuildSmoke(): Promise<boolean> {
    const child = Bun.spawn(["bun", "test", "packages/core/src/challenge/authorized-projection.test.ts"], {
        cwd: resolve(import.meta.dir, ".."),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ])
    if (exitCode !== 0) {
        console.error(`[taric-control-plane] challenge projection smoke failed (exit ${exitCode}): ${stderr.slice(0, 2000)}`)
        return false
    }
    const output = `${stdout}\n${stderr}`
    const passed = Number(output.match(/(?:^|\n)\s*(\d+) pass\b/)?.[1] ?? 0)
    const rebuildCasePassed = output.includes("(pass) authorized challenge projection > rebuilds the product projection after local cache deletion and rejects missing canonical target identity")
    return passed > 0 && rebuildCasePassed
}

let report: Record<string, unknown> | undefined
const targetCredential = "Bearer synthetic-control-plane-credential-canary"
let targetRequests = 0
let credentialInjected = false
const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    targetRequests += 1
    credentialInjected = request.headers.get("authorization") === targetCredential
    return new Response("Controlled local acceptance fixture response")
} })
try {
    const { host, project, coverage } = fixture
    const challengeProjectionRebuildPassed = await runChallengeProjectionRebuildSmoke()
    check("challenge_file_projection_rebuild_after_disposable_cache_deletion", challengeProjectionRebuildPassed)
    check("canonical_scope_revision_binds_verified_roe", project.scope.scopeRevisionId === fixture.scope.scopeRevisionId && project.scope.roeContentHash === fixture.roe.contentHash)
    check("bootstrap_admits_resource_revision_work_cells_and_manifest", project.manifest.length === 1 && project.manifest[0]!.coverage.length === 2 && project.manifest[0]!.workItems.length === 2 && project.coverageManifest.kind === "coverage_manifest")
    const replay = await new TaricAuthorityProjectBootstrap({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST }).bootstrap(fixture.bootstrapInput)
    check("bootstrap_replay_preserves_canonical_ids", replay.coverageManifest.id === project.coverageManifest.id && replay.manifest[0]!.coverage.every((cell, index) => cell.id === project.manifest[0]!.coverage[index]!.id) && replay.manifest[0]!.workItems.every((item, index) => item.id === project.manifest[0]!.workItems[index]!.id))
    const snapshot = await coverage.snapshot({ manifestId: String(project.coverageManifest.id), manifestDigest: project.manifestDigest, pageSize: 1 })
    check("coverage_complete_fixed_domain_pages_preserve_watermark", snapshot.cells.length === 2 && snapshot.diagnostics.pages === 2 && snapshot.diagnostics.completeDomain && snapshot.metadata.expected_cell_count === 2)
    check("untested_manifest_gate_cannot_close", snapshot.gate.can_close === false && project.closable === false)
    const entry = project.manifest[0]!
    const premise: RecoveryPremise = { binding: fixture.binding, challengeId: entry.challengeId, assetId: entry.assetId, scopeId: project.scope.scopeId, scopeVersion: project.scope.scopeVersion, scopeRevisionId: project.scope.scopeRevisionId, scopePolicyDigest: project.scope.policyDigest, resourceId: String(entry.resource.id), resourceRevisionId: String(entry.revision.id), targetVersion: Number(entry.revision.revision), workItemId: String(entry.workItems[0]!.id), workItemVersion: Number(entry.workItems[0]!.version) }
    const work = new TaricAuthorityWorkService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
    const run = await work.claim({ premise, agentId: "fixture-worker", taskSessionId: fixture.sessionId, ttlMs: 120_000 })
    const context = record(await host.query("context.query", { budget: 50_000, include_candidates: false }))
    const checkpoint = await work.checkpoint({ premise, authorityRun: run, piSessionId: "fixture-pi-session", contextSnapshotId: Bun.randomUUIDv7(), sourceReadSeq: Number(context.read_seq), sourceContext: { snapshotId: String(context.context_snapshot_id), readSeq: Number(context.read_seq), contentDigest: digest(JSON.stringify(context)) }, completedSteps: ["Validated local manifest"], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [] })
    check("checkpoint_persists_immutable_scope_and_recovery_locator", checkpoint.checkpoint.scope_revision_ref === premise.scopeRevisionId && checkpoint.locator.scopeRevisionId === premise.scopeRevisionId)
    const credential = await fixture.artifacts.storeTargetAuth({ sessionId: fixture.sessionId, requestId: "fixture-target-auth", payloadKind: "text", mediaType: "text/plain", payload: targetCredential })
    const actionContext = { engagementId: fixture.binding.engagementId, workRunId: String(run.run_id), attemptId: String(run.attempt_ref), generation: Number(run.generation), ownerHost: fixture.binding.hostPrincipalId, scopeId: premise.scopeId, scopeVersion: premise.scopeVersion, scopeRevisionId: premise.scopeRevisionId!, taskSessionId: fixture.sessionId }
    const actions = new TaricAuthorityActionService({ host, policyDigest: premise.scopePolicyDigest!, allowLocalFixtureExecution: true, artifactService: fixture.artifacts, scopeService: fixture.scopes, network: {
        evaluateEgress: (request) => evaluateEgress({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [target.port!], allowedProtocols: ["http"] }, { startsAt: fixture.policy.valid_from, endsAt: fixture.policy.valid_until }, request),
    } })
    const executed = await actions.execute({ request: { url: target.url.toString(), targetAuth: { sessionId: fixture.sessionId, contentRef: credential.contentRef } }, rationale: "Inspect the explicitly approved local fixture" }, actionContext)
    check("target_auth_round_trip_injects_only_into_actual_loopback_connection", executed.canonicalStatus === "executed" && targetRequests === 1 && credentialInjected && !JSON.stringify(executed).includes(targetCredential))
    const audit = await actions.queryAudit({ actionId: executed.actionId, pageSize: 1 })
    check("action_audit_is_complete_pinned_and_has_observed_socket_provenance", audit.diagnostics.status === "complete" && audit.diagnostics.snapshotPinned && audit.records.length === 3 && audit.records.some((event) => event.status === "executed" && JSON.stringify(event).includes("127.0.0.1")) && !JSON.stringify(audit).includes(targetCredential))
    let staleActionRejected = false
    try { await actions.execute({ request: { url: target.url.toString() }, rationale: "Reject an intentionally stale fixture generation" }, { ...actionContext, generation: actionContext.generation + 1 }) } catch (error) { staleActionRejected = error instanceof TaricOperationError && error.code === "stale_version" }
    check("stale_generation_action_is_rejected_before_a_second_connection", staleActionRejected && targetRequests === 1)
    const captureInput = { eventId: "fixture-supported-capture", sourceKind: "host_event" as const, captureKind: "platform" as const, workRunId: actionContext.workRunId, generation: actionContext.generation, observation: { resource_ref: String(entry.resource.id), observed_at: new Date().toISOString(), statement: "The controlled loopback fixture returned one HTTP response.", artifact_refs: [], limitations: ["Synthetic local fixture only; no independent verification."], status: "proposed" as const } }
    const captured = record(await host.captureObservation(captureInput))
    const duplicateCapture = record(await host.captureObservation(captureInput))
    const captureOrigin = record(captured.content).provenance && record(record(captured.content).provenance).dispatch_id
    const duplicateOrigin = record(duplicateCapture.content).provenance && record(record(duplicateCapture.content).provenance).dispatch_id
    check("non_idempotent_capture_duplicates_remain_identifiable_l0_candidates", typeof captured.id === "string" && typeof duplicateCapture.id === "string" && captured.id !== duplicateCapture.id && captured.status === "pending" && duplicateCapture.status === "pending" && captureOrigin === duplicateOrigin && !captured.canonical_id && !duplicateCapture.canonical_id)
    const validationDiagnostics = []
    for (const observation of [{ ...captureInput.observation, resource_ref: "invalid-fixture-resource" }, { ...captureInput.observation, statement: targetCredential }, { ...captureInput.observation, status: "verified" }]) {
        try { await host.captureObservation({ ...captureInput, observation }); throw new Error("Invalid fixture capture unexpectedly passed") } catch (error) {
            if (!(error instanceof CaptureDtoError)) throw error
            validationDiagnostics.push(error.diagnostic)
        }
    }
    check("capture_validation_diagnostics_are_bounded_and_payload_free", validationDiagnostics.length === 3 && validationDiagnostics.every((diagnostic) => diagnostic.field.length <= 128 && diagnostic.message.length <= 180) && !JSON.stringify(validationDiagnostics).includes(targetCredential) && !JSON.stringify(validationDiagnostics).includes("invalid-fixture-resource"))
    const recoveredHost = await fixture.openHost()
    try {
        const recoveredWork = new TaricAuthorityWorkService({ host: recoveredHost, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
        const recovered = await recoveredWork.recoverActive(premise)
        check("fresh_host_discovers_run_and_restores_checkpoint_without_local_map", recovered.status === "resumed" && recovered.locator.piSessionId === "fixture-pi-session")
    } finally { await recoveredHost.close() }
    await work.transition(premise, run, "completed", "fixture-work-completed")
    for (const cell of entry.coverage) {
        await coverage.record({ dimension: { resource_ref: String(entry.resource.id), resource_revision_ref: String(entry.revision.id), test_category: String(cell.test_category) }, scopeRevisionId: premise.scopeRevisionId, policyDigest: premise.scopePolicyDigest, expectedVersion: Number(cell.version), cellId: String(cell.id), status: "not_applicable", notApplicableReason: "Protocol-only loopback fixture: this target descriptor has no login or authorization feature.", limitations: ["Exercises governance only; no assessment of external targets."], idempotencyKey: `fixture-cell-terminal:${cell.id}` })
    }
    const artifact = await fixture.artifacts.storeArtifact({ sessionId: fixture.sessionId, requestId: "fixture-final-report", category: "report", payloadKind: "text", mediaType: "text/plain", payload: "Canonical local control-plane verification. Fixture cells are explicitly not applicable; this is not a penetration test result." })
    const passing = await coverage.snapshot({ manifestId: String(project.coverageManifest.id), manifestDigest: project.manifestDigest })
    check("explicit_not_applicable_reasons_produce_passing_complete_gate", passing.diagnostics.completeDomain && passing.gate.can_close === true)
    const reports = new TaricAuthorityReportService({ host, coverage })
    const reportInput = { expectedAuthoritySeq: passing.readSeq, manifestId: String(project.coverageManifest.id), manifestDigest: project.manifestDigest, scopeRevisionId: premise.scopeRevisionId, policyDigest: premise.scopePolicyDigest, resourceRevisionIds: [String(entry.revision.id)], artifactSessionId: fixture.sessionId, artifactRef: artifact.contentRef, idempotencyKey: "fixture-report-commit" }
    const committedReport = await reports.commitSnapshot(reportInput)
    const duplicateReport = await reports.commitSnapshot(reportInput)
    check("report_snapshot_commit_replay_preserves_canonical_identity", committedReport.id === duplicateReport.id)
    const candidate = await reports.reconstruct()
    let staleRejected = false
    try { await reports.close({ reportSnapshotId: String(committedReport.id), expectedEngagementVersion: Number(candidate.engagement.version), expectedAuthoritySeq: candidate.readSeq - 1, reason: "Intentional stale fixture request", idempotencyKey: "fixture-close-stale" }) } catch (error) { staleRejected = error instanceof TaricOperationError && error.code === "stale_version" }
    check("close_rejects_stale_authority_watermark", staleRejected)
    const closed = await reports.close({ reportSnapshotId: String(committedReport.id), expectedEngagementVersion: Number(candidate.engagement.version), expectedAuthoritySeq: candidate.readSeq, reason: "Explicit local fixture close", idempotencyKey: "fixture-close" })
    const closedProjection = await reports.reconstruct()
    check("canonical_close_atomically_completes_engagement", closedProjection.closed && closedProjection.latestDecision?.id === closed.id)
    const targetAuthDigest = `sha256:${new Bun.CryptoHasher("sha256").update(targetCredential).digest("hex")}`
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "taric-control-plane-recover.ts"), `--source=${fixture.source}`, `--authority=${fixture.authorityPath}`, `--content=${fixture.contentRoot}`, `--engagement=${fixture.binding.engagementId}`, `--action-id=${executed.actionId}`, `--action-read-seq=${audit.readSeq}`, `--target-auth-ref=${credential.contentRef}`, `--target-auth-digest=${targetAuthDigest}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exitCode !== 0) throw new Error(`Authority-only subprocess recovery failed: ${stderr.slice(0, 4096)}`)
    const restored = record(JSON.parse(stdout))
    check("new_process_reconstructs_scope_work_checkpoint_cells_report_and_close", restored.closed === true && restored.decisionId === closed.id && restored.reportId === committedReport.id && restored.scopeRevisionId === premise.scopeRevisionId && restored.reportArtifactVerified === true && restored.coverageDigest === passing.snapshotDigest && Array.isArray(restored.checkpointLocators) && restored.checkpointLocators.length === 1)
    check("new_process_recovers_target_auth_and_identical_action_audit", restored.targetAuthVerified === true && restored.actionAuditDigest === digest(JSON.stringify(audit.records)) && restored.actionAuditCount === 3)
    const reopenCandidate = await reports.reconstruct()
    const reopened = await reports.reopen({ closeDecisionId: String(closed.id), expectedEngagementVersion: Number(reopenCandidate.engagement.version), expectedAuthoritySeq: reopenCandidate.readSeq, reason: "Explicit fixture audit reopen", idempotencyKey: "fixture-reopen" })
    check("reopen_appends_a_decision_and_preserves_close_history", reopened.supersedes === closed.id && (await reports.reconstruct()).closed === false)
    report = { reportVersion: "breachweave-canonical-control-plane-fixture/2", generatedAt: new Date().toISOString(), sourceCommit: fixture.sourceCommit, evidenceClass: "local_source_dist_sqlite_embedded_host_operator_loopback", assertions, metrics: { passed: assertions.filter((entry) => entry.passed).length, total: assertions.length }, acceptanceProfile: "local_development", authorityProfile: "single_host_sqlite", restartMethod: "fresh_recovery_subprocess_from_authority", coverage: { canonicalScopeRoe: "passed", targetAuthArtifactRoundTrip: "passed", checkpointRecovery: "passed", actionAuditRecovery: "passed", connectionTimeDecision: "passed", staleGenerationRejection: "passed", gateWatermark: "passed", supportedCapture: "passed", duplicateHandling: "non_idempotent_capture_produces_distinct_candidates; duplicate idempotent proposal replay preserves canonical identity", boundedValidationDiagnostics: "passed", challengeFileProjectionRebuild: challengeProjectionRebuildPassed ? "passed" : "failed", independentL2Review: "unverified", realGateway: "unverified" }, validationDiagnostics, productionEvidence: false, userConfigurationRead: false, targetTrafficGenerated: true, targetTrafficProfile: "isolated_loopback_Bun_serve_only", temporaryStateRemoved: true, limitations: ["Fixture review/admission is synthetic L1; no independent L2 or production reviewer identity is claimed.", "ChallengeManager projection rebuild is exercised by the local integration test in a separate process; the canonical authority fixture itself creates no product cache files.", "The subprocess rebuilds authority state while the original host exists; this is process reconstruction, not a power-loss durability claim."] }
} finally { target.stop(true); await fixture.cleanup() }
const output = argument("output")
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`) }
console.log(JSON.stringify(report, null, 2))
