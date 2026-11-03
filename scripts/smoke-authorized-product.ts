import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { ConfigManager } from "../packages/core/src/config/index"
import { createAuthorizedChallengeProjectionProvider } from "../packages/core/src/challenge/authorized-projection"
import type { AuthorizedChallengeProjection } from "../packages/core/src/challenge/authorized-projection"
import { ChallengeManager } from "../packages/core/src/challenge/manager"
import { CHALLENGE_ENV_DIR } from "../packages/core/src/challenge/env"
import { TaricAuthorityReportService } from "../packages/core/src/taric/authority-report-service"
import { createTaricControlPlaneFixture, record } from "./taric-control-plane-fixture"

const source = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length)
if (!source) throw new Error("Pass --source=/absolute/path/to/pinned/Taric")
const output = resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/artifacts/taric-104-authorized-product.json")
const fixture = await createTaricControlPlaneFixture(source)
const previousChallengeDir = process.env[CHALLENGE_ENV_DIR]
process.env[CHALLENGE_ENV_DIR] = resolve(fixture.root, "challenges")
const checks: Array<{ id: string; passed: boolean }> = []
function check(id: string, passed: boolean) {
    checks.push({ id, passed })
    if (!passed) throw new Error(`Authorized product smoke failed: ${id}`)
}
const binding = {
    challengeId: fixture.asset.challengeId,
    title: "Authorized product fixture",
    scopeId: fixture.scope.scopeId,
    project: { mode: "authorized_pentest" as const, tenant_id: fixture.binding.tenantId, engagement_id: fixture.binding.engagementId, taric_engagement_id: fixture.binding.engagementId, scope_revision: fixture.scope.revision, coverage_manifest_id: String(fixture.project.coverageManifest.id), memory_mode: "taric_required" as const },
}
const config = {
    dir: fixture.root,
    listAuthorizedProjectBindings: async () => [binding],
    getHostSettings: async () => ({ runtime: {}, planner: {}, taric: { profile: "embedded_bun", authorityPath: fixture.authorityPath, contentRoot: fixture.contentRoot } }),
    listModelPrefs: async () => [],
    listAgentPrompts: async () => [],
} as unknown as ConfigManager
const createHost: Parameters<typeof createAuthorizedChallengeProjectionProvider>[1] = async (_config, _project, _key, runtime) => fixture.openHost(runtime?.hostSessionId)
let provider = createAuthorizedChallengeProjectionProvider(config, createHost)
function authorityState(projection: AuthorizedChallengeProjection) {
    return { work: projection.authority.work, gaps: projection.authority.coverageGate.gaps, evidence: projection.authority.evidence.map((item) => item.id), reports: projection.submissions, closed: projection.authority.report?.closed }
}
try {
    const prepared = await provider.prepareSolver!(binding.challengeId, "product-fixture-solver")
    check("solver_prepares_complete_pinned_taric_context", prepared.projection.authority.context.length > 0 && prepared.projection.authority.context.some((item) => item.id === prepared.run.workItemId))
    const input = { challengeId: binding.challengeId, workRunId: prepared.run.runId, generation: prepared.run.generation, agentId: prepared.run.owner.agent_id, resourceId: prepared.run.targetResourceId }
    await provider.renewWorkRun!(input)
    check("solver_heartbeat_renews_canonical_workrun", record(record(await fixture.host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation })).run).status === "running")
    const baseline = (await provider.read(binding.challengeId))!
    const cacheDir = resolve(fixture.root, "disposable-product-state")
    await mkdir(cacheDir, { recursive: true })
    for (const name of ["challenge.json", "manifest.json", "session.json", "checkpoint.json", "action-map.json", "report-index.json"]) await Bun.write(resolve(cacheDir, name), "stale local snapshot")
    await provider.close?.()
    await rm(cacheDir, { recursive: true })
    provider = createAuthorizedChallengeProjectionProvider(config, createHost)
    check("fresh_provider_rebuilds_work_gaps_evidence_and_close_without_caches", JSON.stringify(authorityState((await provider.read(binding.challengeId))!)) === JSON.stringify(authorityState(baseline)))
    const recovery = await provider.recoverStartup!(binding.challengeId)
    if (!recovery.some((item) => item.status === "resumed")) console.error(JSON.stringify({ recovery }))
    check("fresh_provider_recovers_active_checkpoint_from_taric", recovery.some((item) => item.runId === input.workRunId && item.status === "resumed" && item.generation === input.generation))
    const manager = new ChallengeManager(config, undefined, undefined, undefined, provider)
    manager.attachRuntime({ listAll: async () => [] } as never)
    const planner = await (manager as unknown as { buildPlannerSnapshot(source: string, challengeId: string): Promise<{ challenges: Array<{ authority?: { context: unknown[]; work: unknown[]; gaps: unknown[] } }> }> }).buildPlannerSnapshot("product-fixture", binding.challengeId)
    check("planner_context_rebuilds_from_authority", (planner.challenges[0]?.authority?.context.length ?? 0) > 0 && planner.challenges[0]?.authority?.work.length === baseline.authority.work.length)
    await provider.finishWorkRun!(input)
    const completedProjection = (await provider.read(binding.challengeId))!
    const completedRun = record(record(await fixture.host.invokeHost("work.resume", { work_run_id: input.workRunId, generation: input.generation })).run)
    check("explicit_solver_completion_is_canonical", completedRun.status === "completed" && completedProjection.authority.work.some((item) => item.id === prepared.run.workItemId && item.status === "queued"))
    let staleCompletionRejected = false
    try { await provider.finishWorkRun!({ ...input, generation: input.generation + 1 }) } catch { staleCompletionRejected = true }
    check("stale_solver_completion_is_rejected", staleCompletionRejected)
    const entry = fixture.project.manifest[0]!
    for (const cell of entry.coverage) await fixture.coverage.record({ dimension: { resource_ref: String(entry.resource.id), resource_revision_ref: String(entry.revision.id), test_category: String(cell.test_category) }, scopeRevisionId: fixture.scope.scopeRevisionId, policyDigest: fixture.scope.policyDigest, expectedVersion: Number(cell.version), cellId: String(cell.id), status: "not_applicable", notApplicableReason: "Protocol-only fixture descriptor has no authentication feature.", limitations: ["Governance fixture only."], idempotencyKey: `product-terminal:${cell.id}` })
    const artifact = await fixture.artifacts.storeArtifact({ sessionId: fixture.sessionId, requestId: "product-report", category: "report", payloadKind: "text", mediaType: "text/plain", payload: "Local authorized product projection acceptance fixture." })
    const snapshot = await fixture.coverage.snapshot({ manifestId: String(fixture.project.coverageManifest.id), manifestDigest: fixture.project.manifestDigest })
    const reports = new TaricAuthorityReportService({ host: fixture.host, coverage: fixture.coverage })
    const committed = await reports.commitSnapshot({ expectedAuthoritySeq: snapshot.readSeq, manifestId: String(fixture.project.coverageManifest.id), manifestDigest: fixture.project.manifestDigest, scopeRevisionId: fixture.scope.scopeRevisionId, policyDigest: fixture.scope.policyDigest, resourceRevisionIds: [String(entry.revision.id)], artifactSessionId: fixture.sessionId, artifactRef: artifact.contentRef, idempotencyKey: "product-report-commit" })
    const candidate = await reports.reconstruct()
    await reports.close({ reportSnapshotId: String(committed.id), expectedEngagementVersion: Number(candidate.engagement.version), expectedAuthoritySeq: candidate.readSeq, reason: "Local product fixture close", idempotencyKey: "product-close" })
    const closed = (await provider.read(binding.challengeId))!
    await provider.close?.()
    provider = createAuthorizedChallengeProjectionProvider(config, createHost)
    check("report_index_and_close_rebuild_after_provider_restart", closed.authority.report?.closed === true && JSON.stringify(authorityState((await provider.read(binding.challengeId))!)) === JSON.stringify(authorityState(closed)))
    let closedLaunchRejected = false
    try { await provider.prepareSolver!(binding.challengeId, "closed-fixture-solver") } catch { closedLaunchRejected = true }
    check("closed_engagement_blocks_solver_preparation", closedLaunchRejected)
} finally {
    await provider.close?.()
    await fixture.cleanup()
    if (previousChallengeDir === undefined) delete process.env[CHALLENGE_ENV_DIR]
    else process.env[CHALLENGE_ENV_DIR] = previousChallengeDir
}
await Bun.write(output, `${JSON.stringify({ format: "breachweave-authorized-product-smoke/1", generatedAt: new Date().toISOString(), sourceCommit: fixture.sourceCommit, status: "passed", checks, metrics: { passed: checks.filter((item) => item.passed).length, total: checks.length }, productionEvidence: false, userConfigurationRead: false, targetTrafficGenerated: false, limitations: ["Embedded local SQLite and deterministic host fixture; no external model, independent reviewer, production or physical-host evidence."] }, null, 2)}\n`)
console.log(`[authorized-product] passed ${checks.length}/${checks.length}; report=${output}`)
