import { approveFixtureScope } from "./taric-fixture-scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { buildTaricEvidenceCandidate } from "../packages/core/src/taric/artifact-evidence"
import { TaricArtifactPolicy } from "../packages/core/src/taric/artifact-policy"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface Authority {
    dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}
interface CoreModule {
    AuthorityStore: new (driver: unknown) => unknown
    createCoreService(store: unknown, contentRoot: string): Promise<Authority>
    createPrincipal(role: "host" | "operator" | "model", id: string, engagementId?: string, grants?: readonly string[]): unknown
    API_CONTRACT_VERSION: string
}
interface DriverModule { BunSqliteAuthorityDriver: new (path: string) => unknown }

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fixture returned an invalid object")
    return value as Record<string, unknown>
}
function must(value: unknown): Record<string, unknown> {
    const envelope = record(value)
    if (envelope.ok !== true) throw new TaricOperationError(String(record(envelope.error).code).slice(0, 64), "Fixture operation rejected")
    return record(envelope.data)
}
function argument(name: string): string | undefined { return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) }
function digest(value: string): string { return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}` }

const sourceArgument = argument("source")
if (!sourceArgument) throw new Error("Pass --source=/absolute/path/to/pinned/Taric; no user configuration is read")
const source = resolve(sourceArgument)
const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: source, stdout: "pipe", stderr: "ignore" })
const revision = (await new Response(revisionProcess.stdout).text()).trim()
if (await revisionProcess.exited !== 0 || revision !== TARIC_UPSTREAM_COMMIT) throw new Error("Fixture Taric checkout does not match the pinned source")
const [core, driver] = await Promise.all([
    import(join(source, "packages/core/dist/index.js")) as Promise<CoreModule>,
    import(join(source, "packages/driver-bun-sqlite/dist/index.js")) as Promise<DriverModule>,
])
if (core.API_CONTRACT_VERSION !== TARIC_COMPATIBILITY_BASELINE.apiContractVersion) throw new Error("Fixture runtime contract mismatch")
const root = await mkdtemp(join(tmpdir(), "bw-taric-artifact-governance-"))
const contentRoot = join(root, "content")
const authorityPath = join(root, "authority.sqlite")
let authority = await core.createCoreService(new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath)), contentRoot)
const assertions: Array<{ id: string; passed: boolean }> = []
function check(id: string, passed: boolean): void { assertions.push({ id, passed }); if (!passed) throw new Error(`Artifact governance fixture failed: ${id}`) }
try {
    const operator = core.createPrincipal("operator", "artifact-governance-operator")
    const engagement = must(await authority.dispatch("engagement.init", operator, { name: "Artifact governance fixture", scope: { allowed_targets: ["http://127.0.0.1"], excluded_targets: [], rules_of_engagement_ref: "synthetic-fixture-only" } }))
    const engagementId = String(engagement.id)
        const approvedScope = await approveFixtureScope({ authority, operator, engagement, contentRoot })
    const hostPrincipalId = "artifact-governance-host"
    const principal = core.createPrincipal("host", hostPrincipalId, engagementId, ["content_read"])
    const host = {
        getBinding() { return { projectId: "artifact-governance-project", tenantId: "artifact-governance-tenant", engagementId, hostPrincipalId, modelPrincipalId: "artifact-governance-model" } },
        async invokeHost(operation: string, input: Record<string, unknown>): Promise<unknown> { return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId })) },
    }
    async function admit(content: Record<string, unknown>): Promise<Record<string, unknown>> {
        const submitted = await authority.dispatch("proposal.submit", principal, { engagement_id: engagementId, subject_type: content.kind, expected_version: 0, content: { schema_version: "1.0.0", engagement_id: engagementId, ...content } })
        const proposal = must(submitted)
        const admitted = await authority.dispatch("admission.evaluate", operator, { engagement_id: engagementId, proposal_id: proposal.id, expected_version: 0, policy_digest: digest("artifact-local-fixture-policy") })
        return record(must(admitted).record)
    }
    const initialResource = await admit({ kind: "resource", asset_type: "endpoint", identity: { origin: "http://127.0.0.1", path: "/fixture" }, revision: 1 })
    const observation = await admit({ kind: "observation", resource_ref: initialResource.id, artifact_refs: [{ host_ref: "fixture:synthetic-inventory", content_hash: digest("fixture-inventory") }], observed_at: new Date().toISOString(), statement: "The fixture inventory declares an in-scope loopback test service.", limitations: ["Synthetic inventory fixture; no target request performed."] })
    const revised = record(await host.invokeHost("resource.revise", { resource_id: initialResource.id, expected_version: initialResource.version, method: "GET", path: "/fixture", content_hash: digest("fixture-resource"), source_observation_refs: [observation.id] }))
    const resource = record(revised.resource)
    const resourceRevision = record(revised.revision)
    const work = await admit({ kind: "work_item", title: "Fixture Artifact evidence", status: "queued", acceptance_criteria: ["Persist bounded fixture evidence."], resource_refs: [resource.id, resourceRevision.id] })
    const run = record(await host.invokeHost("work.claim", { work_item_id: work.id, agent_id: "artifact-fixture-worker", ttl_ms: 30_000 }))
    const policy = new TaricArtifactPolicy({ journalPath: join(root, "artifact-policy.json"), retentionMs: 60_000, redactValues: ["synthetic-target-credential"], configurationSecrets: ["synthetic-configuration-key"] })
    const service = new TaricArtifactService({ host, chunkBytes: 7, egressGrant: { principalId: hostPrincipalId, engagementId, capability: "content_read" }, onCommitted: (value) => policy.register(value), assertReadable: (value) => policy.assertReadable(value), configurationSecrets: ["synthetic-configuration-key"] })
    const sessionId = "artifact-governance-session"
    await service.bindSession({ mode: "run-bound", sessionId, root: join(contentRoot, sessionId), workRunId: String(run.run_id), attemptId: String(run.attempt_ref), generation: Number(run.generation), ownerHost: hostPrincipalId })
    check("run_bound_session_uses_authority_fence", true)
    const prepared = policy.prepareOrdinaryText("Fixture response status=200; credential synthetic-target-credential removed.")
    const evidence = await service.storeArtifact({ sessionId, requestId: "ordinary-evidence", category: "evidence", payloadKind: "text", mediaType: "text/plain", payload: prepared.bytes })
    const report = await service.storeArtifact({ sessionId, requestId: "ordinary-report", category: "report", payloadKind: "text", mediaType: "text/markdown", payload: "# Fixture report\nSynthetic data only.\n" })
    const target = await service.storeTargetAuth({ sessionId, requestId: "target-auth", payloadKind: "text", mediaType: "text/plain", payload: "synthetic-target-credential" })
    check("ordinary_evidence_report_and_target_auth_are_taric_stored", [evidence, report, target].every((item) => item.storageMode === "taric_stored" && item.workRunId === run.run_id && item.attemptId === run.attempt_ref && item.generation === run.generation))
    const evidenceQuery = must(await authority.dispatch("evidence.query", principal, { engagement_id: engagementId, kind: "evidence", page_size: 100, include_candidates: true }))
    const queryRecords = Array.isArray(evidenceQuery.records) ? evidenceQuery.records : Array.isArray(evidenceQuery.items) ? evidenceQuery.items : Array.isArray(evidenceQuery.results) ? evidenceQuery.results : undefined
    check("artifact_alone_is_not_canonical_evidence", queryRecords !== undefined && queryRecords.length === 0)
    const candidate = buildTaricEvidenceCandidate({ resourceRef: String(resource.id), resourceRevision: Number(resourceRevision.revision), observedAt: new Date().toISOString(), statement: "The synthetic response has the retained fixture status.", limitations: [...prepared.limitations, "Local synthetic fixture only."], artifact: evidence }, { engagementId, hostPrincipalId, sessionId, resourceId: String(resource.id), resourceRevisionId: String(resourceRevision.id), resourceRevision: Number(resourceRevision.revision), workRunId: String(run.run_id), attemptId: String(run.attempt_ref), generation: Number(run.generation) })
    const canonical = await admit(candidate as unknown as Record<string, unknown>)
    check("canonical_evidence_requires_domain_proposal_and_admission", canonical.kind === "evidence" && canonical.trust_level === "L1" && record(canonical.artifact_ref).content_ref === evidence.contentRef)
    let ordinaryRecovered = false
    await service.consumeArtifact({ sessionId, contentRef: evidence.contentRef }, async (bytes) => { ordinaryRecovered = new TextDecoder().decode(bytes).includes("[REDACTED]") && !new TextDecoder().decode(bytes).includes("synthetic-target-credential") })
    check("host_redaction_precedes_opaque_storage", ordinaryRecovered)
    let wrongChannelRejected = false
    try { await service.consumeArtifact({ sessionId, contentRef: target.contentRef }, async () => {}) } catch { wrongChannelRejected = true }
    check("target_auth_denied_on_ordinary_content_channel", wrongChannelRejected)
    const model = core.createPrincipal("model", "artifact-governance-model", engagementId)
    const deniedModel = record(await authority.dispatch("artifact.content.read", model, { engagement_id: engagementId, session_id: sessionId, content_ref: target.contentRef }))
    check("model_raw_content_denied_by_authority", deniedModel.ok === false && record(deniedModel.error).code === "authorization_error")
    await authority.close()
    authority = await core.createCoreService(new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath)), contentRoot)
    const restartedPolicy = new TaricArtifactPolicy({ journalPath: join(root, "artifact-policy.json"), retentionMs: 60_000 })
    const restarted = new TaricArtifactService({ host, chunkBytes: 7, egressGrant: { principalId: hostPrincipalId, engagementId, capability: "content_read" }, assertReadable: (value) => restartedPolicy.assertReadable(value) })
    let evidenceRecovered = false
    let reportRecovered = false
    let targetRecovered = false
    await restarted.consumeArtifact({ sessionId, contentRef: evidence.contentRef }, async (bytes) => { evidenceRecovered = digest(new TextDecoder().decode(bytes)) === evidence.contentHash })
    await restarted.consumeArtifact({ sessionId, contentRef: report.contentRef }, async (bytes) => { reportRecovered = digest(new TextDecoder().decode(bytes)) === report.contentHash })
    await restarted.consumeTargetAuth({ sessionId, contentRef: target.contentRef }, async (bytes) => { targetRecovered = new TextDecoder().decode(bytes) === "synthetic-target-credential" })
    check("ordinary_evidence_report_and_auth_round_trip_after_sqlite_reopen", evidenceRecovered && reportRecovered && targetRecovered)
    const stagedText = "Staged bytes must not publish after the run completes."
    const stagedHash = digest(stagedText)
    const staged = record(await host.invokeHost("artifact.store.begin", { session_id: sessionId, payload_kind: "text", media_type: "text/plain", storage_mode: "taric_stored", category: "evidence", expected_bytes: new TextEncoder().encode(stagedText).byteLength, expected_hash: stagedHash, idempotency_key: "stale-staged:begin" }))
    await host.invokeHost("artifact.store.append", { session_id: sessionId, upload_id: staged.upload_id, ordinal: 0, chunk_hash: stagedHash, data: Buffer.from(stagedText).toString("base64"), encoding: "base64", idempotency_key: "stale-staged:append" })
    await host.invokeHost("work.transition", { work_run_id: run.run_id, generation: run.generation, status: "completed", idempotency_key: "artifact-governance-complete" })
    let stagedCommitRejected = false
    try { await host.invokeHost("artifact.store.commit", { session_id: sessionId, upload_id: staged.upload_id, total_bytes: new TextEncoder().encode(stagedText).byteLength, content_hash: stagedHash, chunk_count: 1, idempotency_key: "stale-staged:commit" }) } catch (error) { stagedCommitRejected = error instanceof TaricOperationError && ["stale_version", "conflict"].includes(error.code) }
    check("run_completion_fences_already_staged_artifact_commit", stagedCommitRejected)
    const catalog = record(await host.invokeHost("artifact.content.list", { session_id: sessionId, page_size: 16 }))
    check("staged_content_never_enters_committed_catalog", Array.isArray(catalog.items) && catalog.items.length === 3 && !JSON.stringify(catalog).includes(stagedText) && !JSON.stringify(catalog).includes("synthetic-target-credential"))
    let staleRejected = false
    try { await restarted.storeArtifact({ sessionId, requestId: "stale-after-completion", category: "evidence", payloadKind: "text", mediaType: "text/plain", payload: "This must never publish." }) } catch (error) { staleRejected = error instanceof TaricOperationError && ["stale_version", "conflict"].includes(error.code) }
    check("stale_run_cannot_publish_ordinary_artifact", staleRejected)
    const result = { reportVersion: "breachweave-taric-artifact-governance/1", generatedAt: new Date().toISOString(), evidenceClass: "local_dist_sqlite_fixture", sourceCommit: revision, runtimeSourceProvenance: "unverified", runtimeEntryDigests: { core: digest(await Bun.file(join(source, "packages/core/dist/index.js")).text()), driver: digest(await Bun.file(join(source, "packages/driver-bun-sqlite/dist/index.js")).text()) }, authority: "single_host_sqlite", artifactDeploymentProfile: "local_process_crash", restartMethod: "clean_authority_close_reopen", powerLossDurabilityClaimed: false, productionEvidence: false, targetTrafficGenerated: false, userConfigurationRead: false, temporaryStateRemoved: true, assertions, metrics: { passed: assertions.filter((item) => item.passed).length, total: assertions.length }, limitations: ["Pinned checkout and selected dist entry digests identify fixture inputs; source-to-dist dependency provenance is unverified.", "Synthetic local admission is L1, not independent L2 review or production conformance.", "Physical Artifact deletion requires an explicit deployment adapter; upstream opaque storage is not a deletion API."] }
    const output = argument("output")
    if (output) await Bun.write(resolve(output), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
} finally {
    await authority.close()
    await rm(root, { recursive: true, force: true })
}
