import { approveFixtureScope } from "./taric-fixture-scope"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { TaricAuthorityActionService } from "../packages/core/src/taric/authority-action-service"
import type { TaricAuthorityActionContext, TaricAuthorityActionHost } from "../packages/core/src/taric/authority-action-service"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { TaricAuthorityScopeService } from "../packages/core/src/taric/authority-scope-service"
import { evaluateEgress } from "../packages/core/src/taric/governance"
import { TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface FixtureStore {
    createRecord(input: Record<string, unknown>, trust?: "L1" | "L2"): Promise<Record<string, unknown>>
    list(engagementId: string): Promise<Array<Record<string, unknown>>>
    getActionIntent(actionId: string): Promise<Record<string, unknown> | undefined>
    events(): Promise<Array<Record<string, unknown>>>
}
interface FixtureAuthority { dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }
interface FixtureCore {
    AuthorityStore: new (driver: unknown) => FixtureStore
    createCoreService(store: FixtureStore, contentRoot: string): Promise<FixtureAuthority>
    createPrincipal(role: "host" | "model" | "operator", id: string, engagementId?: string, grants?: readonly string[], attestation?: undefined, sessionId?: string): unknown
}

function argument(name: string): string | undefined { return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Action fixture response"); return value as Record<string, unknown> }
function must(value: unknown): Record<string, unknown> { const envelope = record(value); if (envelope.ok !== true) throw new TaricOperationError(String(record(envelope.error).code), "Action fixture operation rejected"); return record(envelope.data) }
function digest(value: unknown): string { return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}` }

const sourceArgument = argument("source")
if (!sourceArgument) throw new Error("Pass --source=/absolute/path/to/pinned/Taric")
const source = resolve(sourceArgument)
const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: source, stdout: "pipe", stderr: "ignore" })
const revision = (await new Response(revisionProcess.stdout).text()).trim()
if (await revisionProcess.exited !== 0 || revision !== TARIC_UPSTREAM_COMMIT) throw new Error("Action fixture requires pinned Taric source")
if (`sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(join(source, "packages/schemas/src/registry.ts")).text()).digest("hex")}` !== TARIC_OPERATION_REGISTRY_SOURCE_DIGEST) throw new Error("Action fixture registry digest mismatch")
const [core, driver] = await Promise.all([
    import(join(source, "packages/core/dist/index.js")) as Promise<FixtureCore>,
    import(join(source, "packages/driver-bun-sqlite/dist/index.js")) as Promise<{ BunSqliteAuthorityDriver: new (path: string) => unknown }>,
])
const root = await mkdtemp(join(tmpdir(), "bw-taric-action-fixture-"))
const authorityPath = join(root, "authority.sqlite")
const contentRoot = join(root, "content")
let store = new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath))
let authority = await core.createCoreService(store, contentRoot)
const assertions: Array<{ id: string; passed: boolean }> = []
function check(id: string, passed: boolean) { assertions.push({ id, passed }); if (!passed) throw new Error(`Action fixture assertion failed: ${id}`) }
async function rejectsCode(operation: () => Promise<unknown>, code: string) { try { await operation(); return false } catch (error) { return error instanceof TaricOperationError && error.code === code } }
let requests = 0
let receiverRequests = 0
let sawTargetAuth = false
const targetCredential = "Bearer synthetic-action-credential-canary"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests += 1; if (new URL(request.url).pathname === "/slow") await Bun.sleep(100); if (request.headers.get("authorization") === targetCredential) { sawTargetAuth = true; return new Response(targetCredential) } return new Response("synthetic loopback fixture response") } })
const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { receiverRequests += 1; return new Response("out of scope") } })
let finalReport: Record<string, unknown> | undefined
try {
    const operator = core.createPrincipal("operator", "action-fixture-operator")
    const engagement = must(await authority.dispatch("engagement.init", operator, { name: "BreachWeave canonical Action fixture", scope: { allowed_targets: [server.url.toString()], excluded_targets: [], rules_of_engagement_ref: "fixture-only" } }))
    const engagementId = String(engagement.id)
    const approvedScope = await approveFixtureScope({ authority, operator, engagement, contentRoot, ports: [server.port!] })
    const hostId = "action-fixture-host"
    const agentId = "action-fixture-model"
    const sessionId = "action-fixture-session"
    const principal = core.createPrincipal("host", hostId, engagementId, ["content_read"], undefined, sessionId)
    const model = core.createPrincipal("model", agentId, engagementId)
    const binding = { projectId: "action-fixture-project", tenantId: "action-fixture-tenant", engagementId, hostPrincipalId: hostId, modelPrincipalId: agentId }
    const host: TaricAuthorityActionHost = {
        getBinding() { return { ...binding } },
        async invokeHost(operation, input) { return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId })) },
        async invokeAction(operation, input) { return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId })) },
    }
    const artifactHost = { getBinding: () => ({ ...binding }), async invokeHost(operation: string, input: Record<string, unknown>) { return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId })) } }
    await artifactHost.invokeHost("artifact.session.bind", { session_id: sessionId, root: join(contentRoot, sessionId), mode: "host-session" })
    const resource = await store.createRecord({ schema_version: "1.0.0", engagement_id: engagementId, kind: "resource", asset_type: "endpoint", identity: { origin: server.url.origin }, revision: 1 }, "L1")
    const scope = (await store.list(engagementId)).find((item) => item.id === engagement.scope_ref)
    if (!scope) throw new Error("Action fixture canonical Scope is absent")
    const item = await store.createRecord({ schema_version: "1.0.0", engagement_id: engagementId, kind: "work_item", title: "Canonical Action fixture", status: "queued", acceptance_criteria: ["Record host decisions and actual local request outcomes."], resource_refs: [resource.id], scope_ref: scope.id, target_version: 1 }, "L1")
    const run = must(await authority.dispatch("work.claim", principal, { engagement_id: engagementId, work_item_id: item.id, agent_id: agentId, task_session_ref: sessionId, ttl_ms: 60_000 }))
    const checkpoint = { work_item_ref: item.id, work_run_ref: run.run_id, attempt_ref: run.attempt_ref, generation: run.generation, target_version: run.target_version, work_item_version: run.work_item_version, scope_ref: scope.id, scope_version: scope.version, scope_revision_ref: approvedScope.revision.id, policy_digest: approvedScope.revision.policy_digest, owner: run.owner, lease_expires_at: run.lease_expires_at, source_read_seq: run.read_seq, completed_steps: [], next_steps: [], observation_refs: [], evidence_refs: [], negative_results: [], unresolved_work: [], host_decision_refs: [], external_action_state: "none", budget: {}, draft_refs: [], handoff_refs: [], action_refs: [], tool_result_refs: [], context_manifest: { context_snapshot_id: Bun.randomUUIDv7(), read_seq: run.read_seq, builder_version: "breachweave-action-loopback-fixture" } }
    must(await authority.dispatch("checkpoint.commit", principal, { engagement_id: engagementId, work_run_id: run.run_id, generation: run.generation, host_id: hostId, checkpoint }))
    const context: TaricAuthorityActionContext = { engagementId, workRunId: String(run.run_id), attemptId: String(run.attempt_ref), generation: Number(run.generation), ownerHost: hostId, scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(approvedScope.revision.id), taskSessionId: sessionId }
    const artifactService = new TaricArtifactService({ host: artifactHost, egressGrant: { engagementId, principalId: hostId, capability: "content_read" } })
    const credential = await artifactService.storeTargetAuth({ sessionId, requestId: "action-fixture-credential", payloadKind: "text", mediaType: "text/plain", payload: targetCredential })
    const now = Date.now()
    const network = { configurationSecrets: ["configuration-action-canary"], evaluateEgress: (request: Parameters<typeof evaluateEgress>[2]) => evaluateEgress({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [server.port!], allowedProtocols: ["http"] }, { startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 60_000).toISOString() }, request) }
    const scopeService = new TaricAuthorityScopeService({ host: { ...artifactHost, async invokeOperator(operation, input) { return must(await authority.dispatch(operation, operator, { ...input, engagement_id: engagementId })) } } })
    const options = { host, policyDigest: String(approvedScope.revision.policy_digest), network, artifactService, scopeService, allowLocalFixtureExecution: true }
    let actions = new TaricAuthorityActionService(options)
    const modelRecommendation = must(await authority.dispatch("action.recommend", model, { engagement_id: engagementId, work_run_id: run.run_id, generation: run.generation, target: server.url.toString(), method: "GET", rationale: "Model suggests fixture inspection", scope: String(scope.id) }))
    check("model_recommendation_only_creates_recommended_action", (await store.getActionIntent(String(modelRecommendation.recommendation_id)))?.status === "recommended" && requests === 0)
    const modelDecision = record(await authority.dispatch("action.host-decision", model, { engagement_id: engagementId, work_run_id: run.run_id, generation: run.generation, action_id: modelRecommendation.recommendation_id, mode: "authorized_autonomous", status: "authorized", host_decision_ref: "model-forged-decision" }))
    check("model_cannot_authorize_or_send_its_recommendation", modelDecision.ok === false && record(modelDecision.error).code === "authorization_error" && requests === 0)
    check("default_profile_blocks_before_recommendation_or_traffic", await rejectsCode(() => new TaricAuthorityActionService({ ...options, allowLocalFixtureExecution: false }).execute({ request: { url: server.url.toString() }, rationale: "Blocked fixture" }, context), "action_contract_blocked") && requests === 0)
    const beforeSensitiveMetadata = (await store.events()).length
    const sensitiveTargetRejected = await rejectsCode(() => actions.execute({ request: { url: `${server.url}?access_token=inline-action-query-canary` }, rationale: "Reject inline authentication" }, context), "validation_error")
    const sensitiveSummaryRejected = await rejectsCode(() => actions.execute({ request: { url: server.url.toString() }, rationale: "configuration-action-canary" }, context), "validation_error")
    const encodedInventoryRejected = await rejectsCode(() => actions.execute({ request: { url: `${server.url}?ordinary=%63onfiguration-action-canary` }, rationale: "Reject encoded configuration inventory" }, context), "validation_error")
    check("canonical_action_metadata_rejects_inline_and_inventory_canaries", sensitiveTargetRejected && sensitiveSummaryRejected && encodedInventoryRejected && (await store.events()).length === beforeSensitiveMetadata && requests === 0)
    const first = await actions.execute({ request: { url: server.url.toString() }, rationale: "Host inspects an approved loopback fixture" }, context)
    const firstAction = await store.getActionIntent(first.actionId)
    check("canonical_recommend_decide_network_result_chain_executes", first.canonicalStatus === "executed" && firstAction?.status === "executed" && requests === 1 && String(firstAction.host_decision_ref).startsWith("bw-action-decision:sha256:") && String(firstAction.result_ref).startsWith("bw-action-result:sha256:"))
    const firstEvents = (await store.events()).filter((event) => event.subject_id === first.actionId).map((event) => event.event_type)
    check("authority_events_record_recommended_authorized_executed", JSON.stringify(firstEvents) === JSON.stringify(["action_intent.recommended", "action_intent.authorized", "action_intent.executed"]))
    check("structured_socket_provenance_is_canonical", firstAction?.scope_revision_ref === approvedScope.revision.id && firstAction?.policy_digest === approvedScope.revision.policy_digest && record(firstAction?.network_provenance).connected_address === "127.0.0.1" && record(firstAction?.network_provenance).port === server.port && record(firstAction?.network_provenance).ip_family === "ipv4")
    const targetBound = new TaricAuthorityActionService({ ...options, allowLocalFixtureExecution: false, allowAuthorizedTargetExecution: true, targetBaseUrl: `${server.url}allowed/` })
    const targetTrafficBeforeBoundaryChecks = requests
    check("active_workitem_resource_path_is_an_enforced_target_boundary", await rejectsCode(() => targetBound.execute({ request: { url: `${server.url}outside` }, rationale: "Outside admitted resource" }, context), "authorization_error") && requests === targetTrafficBeforeBoundaryChecks)
    const mediated = await targetBound.execute({ request: { url: `${server.url}allowed/resource` }, rationale: "Inspect the admitted resource", includeResponseBody: true }, context)
    check("authorized_workitem_http_uses_the_taric_action_chain", mediated.canonicalStatus === "executed" && Boolean(mediated.responseBodyBase64) && requests === targetTrafficBeforeBoundaryChecks + 1)
    const mediatedAction = await store.getActionIntent(mediated.actionId)
    check("authorized_workitem_request_is_bound_to_scope_and_run", mediatedAction?.run_id === context.workRunId && mediatedAction?.attempt_ref === context.attemptId && mediatedAction?.generation === context.generation && mediatedAction?.scope_revision_ref === context.scopeRevisionId)
    const audit = await actions.queryAudit({ actionId: first.actionId, pageSize: 1 })
    check("public_action_audit_is_complete_pinned_and_ordered", audit.diagnostics.status === "complete" && audit.diagnostics.completeDomain === true && audit.diagnostics.pages === 3 && JSON.stringify(audit.records.map((event) => event.status)) === JSON.stringify(["recommended", "authorized", "executed"]))
    const denied = await actions.execute({ request: { url: receiver.url.toString() }, rationale: "Check port policy denial fixture" }, context)
    check("canonical_denied_action_leaves_receiver_untouched", denied.canonicalStatus === "denied" && (await store.getActionIntent(denied.actionId))?.status === "denied" && receiverRequests === 0)
    const beforeStale = requests
    check("stale_generation_cannot_recommend_or_send", await rejectsCode(() => actions.execute({ request: { url: server.url.toString() }, rationale: "Stale fixture request" }, { ...context, generation: context.generation + 1 }), "stale_version") && requests === beforeStale)
    const authenticated = await actions.execute({ request: { url: server.url.toString(), targetAuth: { sessionId, contentRef: credential.contentRef } }, rationale: "Use private fixture target authentication" }, context)
    check("target_auth_is_in_memory_only_with_metadata_result", authenticated.canonicalStatus === "executed" && sawTargetAuth && !JSON.stringify(authenticated).includes(targetCredential))
    check("authority_action_audit_contains_no_credential_payload", !JSON.stringify([await store.getActionIntent(authenticated.actionId), await store.events()]).includes(targetCredential))
    const timed = new TaricAuthorityActionService({ ...options, network: { ...network, timeoutMs: 25 } })
    const ambiguous = await timed.execute({ request: { url: `${server.url}slow`, method: "POST", body: "one fixture attempt" }, rationale: "Fixture transport timeout" }, context)
    check("ambiguous_network_outcome_is_canonical_unknown", ambiguous.canonicalStatus === "unknown" && (await store.getActionIntent(ambiguous.actionId))?.status === "unknown")
    await Bun.sleep(130)
    const requestsBeforeRestart = requests
    await authority.close()
    store = new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath))
    authority = await core.createCoreService(store, contentRoot)
    actions = new TaricAuthorityActionService(options)
    const rebuiltAudit = await actions.queryAudit({ actionId: first.actionId, readSeq: audit.readSeq, pageSize: 1 })
    check("public_action_history_rebuilds_after_sqlite_restart_at_original_watermark", JSON.stringify(rebuiltAudit.records) === JSON.stringify(audit.records))
    check("unknown_survives_sqlite_restart_and_blocks_reexecution", await rejectsCode(() => actions.execute({ request: { url: `${server.url}slow`, method: "POST", body: "one fixture attempt" }, rationale: "Must not replay an unknown action" }, context), "action_reconciliation_required") && requests === requestsBeforeRestart)
    check("stale_unknown_reconciliation_is_denied", await rejectsCode(() => actions.reconcileUnknown({ actionId: ambiguous.actionId, status: "executed", hostReceiptDigest: digest("reviewed fixture receipt") }, { ...context, generation: context.generation + 1 }), "stale_version"))
    await actions.reconcileUnknown({ actionId: ambiguous.actionId, status: "executed", hostReceiptDigest: digest("reviewed fixture receipt") }, context)
    check("explicit_reconciliation_changes_authority_without_traffic", (await store.getActionIntent(ambiguous.actionId))?.status === "executed" && requests === requestsBeforeRestart)
    const priorAction = JSON.stringify(await store.getActionIntent(first.actionId))
    must(await authority.dispatch("work.renew", principal, { engagement_id: engagementId, work_run_id: run.run_id, generation: run.generation, ttl_ms: 5 }))
    await Bun.sleep(15)
    const reclaimed = must(await authority.dispatch("work.reclaim", principal, { engagement_id: engagementId, work_run_id: run.run_id, agent_id: agentId, ttl_ms: 60_000 }))
    check("expired_run_reclaims_a_new_generation", Number(reclaimed.generation) === context.generation + 1)
    const lateRequest = { engagement_id: engagementId, work_run_id: run.run_id, action_id: first.actionId, generation: run.generation, mode: "authorized_autonomous", status: "failed", result_ref: "fixture-reviewed-late-result", scope_revision_ref: context.scopeRevisionId, policy_digest: options.policyDigest, network_provenance: firstAction?.network_provenance }
    const late = must(await authority.dispatch("action.host-result", principal, lateRequest))
    const lateReplay = must(await authority.dispatch("action.host-result", principal, lateRequest))
    const quarantine = await actions.queryAudit({ actionId: first.actionId, status: "late_result_quarantine", pageSize: 1 })
    check("stale_result_is_audited_idempotently_without_mutating_current_action", late.status === "late_result_quarantine" && lateReplay.late_result_id === late.late_result_id && quarantine.records.length === 1 && record(quarantine.records[0]?.payload).quarantine_reason === "stale_generation" && JSON.stringify(await store.getActionIntent(first.actionId)) === priorAction && requests === requestsBeforeRestart)
    check("full_control_plane_and_production_claim_remain_blocked", actions.diagnostic().fullControlPlane === "blocked" && actions.diagnostic().scopeMapping === "immutable_scope_revision" && actions.diagnostic().actionAuditQuery === "canonical_pinned_history" && actions.diagnostic().productionEvidence === false)
    finalReport = { reportVersion: "breachweave-taric-action-loopback-fixture/2", generatedAt: new Date().toISOString(), evidenceClass: "local_dist_sqlite_loopback_fixture", sourceCommit: revision, runtimeSourceProvenance: "unverified", authority: "single_host_sqlite", restartMethod: "clean_authority_close_reopen", assertions, metrics: { passed: assertions.filter((entry) => entry.passed).length, total: assertions.length }, userConfigurationRead: false, targetTrafficGenerated: true, targetTrafficProfile: "isolated_loopback_Bun_serve_only", productionEvidence: false, temporaryStateRemoved: true, profile: actions.diagnostic(), limitations: ["Canonical Resource/WorkItem fixture foundations use the actual AuthorityStore; project manifest bootstrap is outside this smoke.", "Public Action audit reconstructs complete history at a fixed watermark; socket provenance is observed by this host rather than independently attested.", "Only explicit loopback fixture execution is enabled; real project activation and arbitrary shell/socket firewall enforcement remain blocked."] }
} finally {
    await server.stop(true)
    await receiver.stop(true)
    await authority.close()
    await rm(root, { recursive: true, force: true })
}
const output = argument("output")
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await Bun.write(path, `${JSON.stringify(finalReport, null, 2)}\n`) }
console.log(JSON.stringify(finalReport, null, 2))
