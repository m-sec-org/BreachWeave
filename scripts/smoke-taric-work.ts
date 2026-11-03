import { approveFixtureScope } from "./taric-fixture-scope"
import { $ } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { TaricAuthorityWorkService } from "../packages/core/src/taric/authority-work-service"
import { TaricAuthorityResourceService } from "../packages/core/src/taric/authority-resource-service"
import { TaricAuthorityBoard } from "../packages/core/src/taric/authority-board"
import { TaricAuthorityScheduler, TaricHostWorkerReservations } from "../packages/core/src/taric/authority-scheduler"
import { TARIC_DEFAULT_POLICY_DIGEST, TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"
import type { RecoveryPremise } from "../packages/core/src/taric/recovery-locator"
import type { TaricHostModule } from "../packages/core/src/taric/host-module"
import { createAuthorityRecoveryCheckpoint } from "../packages/core/src/taric/recovery-locator"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface FixtureAuthority {
    dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}

interface FixtureStore {
    createRecord(record: Record<string, unknown>, trust?: "L1" | "L2"): Promise<Record<string, unknown>>
    list(engagementId: string): Promise<Array<Record<string, unknown>>>
}

interface FixtureCore {
    AuthorityStore: new (driver: unknown) => FixtureStore
    createCoreService(store: FixtureStore, contentRoot: string): Promise<FixtureAuthority>
    createPrincipal(role: "host" | "model" | "operator", id: string, engagementId?: string, grants?: readonly string[], attestation?: undefined, sessionId?: string): unknown
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fixture response")
    return value as Record<string, unknown>
}

function must(value: unknown): Record<string, unknown> {
    const envelope = record(value)
    if (envelope.ok !== true) throw new TaricOperationError(String(record(envelope.error).code), String(record(envelope.error).message).slice(0, 256), record(envelope.error).details)
    return record(envelope.data)
}

function argument(name: string): string | undefined {
    return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function digest(value: string): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`
}

async function main(): Promise<void> {
    const sourceArgument = argument("source")
    if (!sourceArgument) throw new Error("Pass --source=/absolute/path/to/pinned/Taric")
    const source = resolve(sourceArgument)
    const sourceCommit = (await $`git -C ${source} rev-parse HEAD`.quiet().text()).trim()
    if (sourceCommit !== TARIC_UPSTREAM_COMMIT) throw new Error("fixture requires pinned Taric source")
    if (digest(await Bun.file(join(source, "packages/schemas/src/registry.ts")).text()) !== TARIC_OPERATION_REGISTRY_SOURCE_DIGEST) throw new Error("registry source digest mismatch")
    const [core, driver] = await Promise.all([
        import(join(source, "packages/core/dist/index.js")) as Promise<FixtureCore>,
        import(join(source, "packages/driver-bun-sqlite/dist/index.js")) as Promise<{ BunSqliteAuthorityDriver: new (path: string) => unknown }>,
    ])
    const root = await mkdtemp(join(tmpdir(), "bw-taric-work-fixture-"))
    const databasePath = join(root, "authority.sqlite")
    const contentRoot = join(root, "content")
    let store = new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(databasePath))
    let authority = await core.createCoreService(store, contentRoot)
    const assertions: Array<{ id: string; passed: boolean }> = []
    function check(id: string, passed: boolean): void {
        assertions.push({ id, passed })
        if (!passed) throw new Error(`Work fixture assertion failed: ${id}`)
    }
    async function rejectsCode(operation: () => Promise<unknown>, code: string): Promise<boolean> {
        try { await operation(); return false } catch (error) { return error instanceof TaricOperationError && error.code === code }
    }
    let report: Record<string, unknown> | undefined
    try {
        const operator = core.createPrincipal("operator", "work-fixture-operator")
        const engagement = must(await authority.dispatch("engagement.init", operator, { name: "BreachWeave Work fixture", scope: { allowed_targets: ["http://127.0.0.1"], excluded_targets: [], rules_of_engagement_ref: "fixture-only" } }))
        const engagementId = String(engagement.id)
        const approvedScope = await approveFixtureScope({ authority, operator, engagement, contentRoot })
        const sessionId = "work-fixture-session"
        const hostId = "work-fixture-host"
        const modelId = "work-fixture-model"
        const principal = core.createPrincipal("host", hostId, engagementId, ["admit"], undefined, sessionId)
        const model = core.createPrincipal("model", modelId, engagementId)
        const binding = { projectId: "work-fixture-project", tenantId: "work-fixture-tenant", engagementId, hostPrincipalId: hostId, modelPrincipalId: modelId }
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal" | "query"> = {
            getBinding() { return { ...binding } },
            async invokeHost(operation, input) { return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId })) },
            async submitProposal(input) { return must(await authority.dispatch("proposal.submit", model, { engagement_id: engagementId, subject_type: input.subjectType, expected_version: input.expectedVersion, content: { ...input.content, schema_version: "1.0.0", engagement_id: engagementId }, client_request_id: input.eventId, idempotency_key: input.eventId })) },
            async query(operation, input = {}) { return must(await authority.dispatch(operation, model, { ...input, engagement_id: engagementId })) },
        }
        await host.invokeHost("artifact.session.bind", { session_id: sessionId, root: join(contentRoot, sessionId), mode: "host-session" })
        const resources = new TaricAuthorityResourceService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
        const asset = { challengeId: "fixture-challenge", assetId: "fixture-asset", origin: "http://127.0.0.1", path: "/" }
        const resource = await resources.provision(asset)
        const duplicateResource = await resources.provision(asset)
        check("resource_proposal_admission_retries_keep_the_same_canonical_id", resource.id === duplicateResource.id)
        const resolvedResource = await new TaricAuthorityResourceService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST }).resolve(asset)
        check("resource_mapping_resolves_without_local_identity_ledger", resolvedResource.resource.id === resource.id)
        const observation = await store.createRecord({ schema_version: "1.0.0", engagement_id: engagementId, kind: "observation", resource_ref: resource.id, observed_at: new Date().toISOString(), statement: "Isolated loopback target manifest", artifact_refs: [], limitations: ["fixture only"] }, "L1")
        const revision = await host.invokeHost("resource.revise", { resource_id: resource.id, expected_version: resource.version, content_hash: digest("work-fixture-target"), source_observation_refs: [observation.id], method: "GET", path: "/" })
        const canonicalResource = record(record(revision).resource)
        const canonicalRevision = record(record(revision).revision)
        const scope = (await store.list(engagementId)).find((item) => item.id === engagement.scope_ref)
        if (!scope) throw new Error("canonical fixture Scope is missing")
        const definition = { challengeId: "fixture-challenge", assetId: "fixture-asset", workKey: "manifest-cell-1", scopeId: String(scope.id), targetVersion: 1, resourceIds: [String(canonicalResource.id)], title: "Inspect isolated target manifest", acceptanceCriteria: ["Capture verified evidence for the manifest cell"] }
        let service = new TaricAuthorityWorkService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
        const proposal = await service.proposeWorkItem(definition)
        check("pending_proposal_not_claimable", await rejectsCode(() => host.invokeHost("work.claim", { work_item_id: proposal.id, host_id: hostId, agent_id: modelId, task_session_ref: sessionId }), "validation_error"))
        const item = await service.admitWorkItem(String(proposal.id))
        const repeatedItem = await service.provisionWorkItem(definition)
        check("stable_proposal_and_admission_identity", repeatedItem.id === item.id)
        const projectManifest = { resourceIds: [String(canonicalResource.id)], workItemIds: [String(item.id)] }
        const board = new TaricAuthorityBoard({ host, work: service, projectManifest })
        const initialBoard = await board.initialize()
        check("board_builds_same_watermark_context_work_resource_snapshot", initialBoard.status === "healthy" && initialBoard.freshnessAllowsScheduling && initialBoard.records.work.some((entry) => entry.id === item.id) && Object.values(initialBoard.queries ?? {}).every((entry) => entry.readSeq === initialBoard.readSeq))
        check("board_projection_metadata_only_and_contract_gate_preserved", !JSON.stringify(initialBoard).includes(definition.acceptanceCriteria[0]!) && !JSON.stringify(initialBoard).includes(definition.title) && initialBoard.launchAuthorized === false && initialBoard.completeness.entireEngagementReconstructed === false && initialBoard.completeness.coverageGate === "not_read_or_inferred")
        const unsignaledItem = await service.provisionWorkItem({ ...definition, workKey: "manifest-cell-unsignaled", title: "Work committed while notification was lost" })
        projectManifest.workItemIds.push(String(unsignaledItem.id))
        board.updateProjectManifest(projectManifest)
        const scheduledBoard = await board.refreshForScheduling()
        check("lost_notification_rebuilt_before_scheduling", scheduledBoard.records.work.some((entry) => entry.id === unsignaledItem.id) && scheduledBoard.readSeq! > initialBoard.readSeq!)
        const duplicateBoards = await Promise.all([board.notify(), board.notify(), board.notify()])
        check("duplicate_notifications_requery_without_duplicate_work", duplicateBoards.every((entry) => entry.status === "healthy" && entry.records.work.length === 2 && new Set(entry.records.work.map((item) => item.id)).size === 2))
        board.markConnectionStale("slow_consumer")
        check("stale_connection_blocks_scheduling_after_complete_reads", await rejectsCode(() => board.refreshForScheduling(), "authority_board_stale"))
        check("explicit_reconnect_rebuilds_complete_snapshot", (await board.reconnect()).freshnessAllowsScheduling)
        const limitedBoard = new TaricAuthorityBoard({ host, work: service, projectManifest, limits: { maxRecords: 1 } })
        let limitedBlocked = false
        try { await limitedBoard.initialize() } catch { limitedBlocked = limitedBoard.snapshot().status === "blocked" && limitedBoard.snapshot().records.work.length === 0 }
        check("truncated_board_snapshot_never_published", limitedBlocked)
        const invalidCursorBoard = new TaricAuthorityBoard({ host: { ...host, async query(operation, input = {}) { return must(await authority.dispatch(operation, model, { ...input, engagement_id: engagementId, cursor: "invalid-native-authority-cursor" })) } }, work: service, projectManifest })
        check("native_invalid_cursor_blocks_board", await rejectsCode(() => invalidCursorBoard.initialize(), "invalid_cursor") && invalidCursorBoard.snapshot().status === "blocked")
        limitedBoard.close()
        invalidCursorBoard.close()
        const foreignBinding = { ...binding, projectId: "work-fixture-project-b" }
        const foreignHost = { ...host, getBinding() { return { ...foreignBinding } } }
        const foreignResource = await new TaricAuthorityResourceService({ host: foreignHost, policyDigest: TARIC_DEFAULT_POLICY_DIGEST }).provision({ challengeId: "foreign-challenge", assetId: "foreign-asset", origin: "http://127.0.0.1", path: "/" })
        const foreignObservation = await store.createRecord({ schema_version: "1.0.0", engagement_id: engagementId, kind: "observation", resource_ref: foreignResource.id, observed_at: new Date().toISOString(), statement: "Project B canonical observation", artifact_refs: [], limitations: ["fixture only"] }, "L2")
        const foreignRevision = record(record(await foreignHost.invokeHost("resource.revise", { resource_id: foreignResource.id, expected_version: foreignResource.version, content_hash: digest("foreign-fixture-target"), source_observation_refs: [foreignObservation.id], method: "GET", path: "/" })).revision)
        const foreignService = new TaricAuthorityWorkService({ host: foreignHost, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
        const foreignItem = await foreignService.provisionWorkItem({ ...definition, challengeId: "foreign-challenge", assetId: "foreign-asset", resourceIds: [String(foreignResource.id)] })
        const isolatedA = await board.manualRefresh()
        const isolatedB = await new TaricAuthorityBoard({ host: foreignHost, work: foreignService, projectManifest: { resourceIds: [String(foreignResource.id)], workItemIds: [String(foreignItem.id)] } }).initialize()
        check("same_engagement_project_manifest_filters_foreign_ids_on_all_surfaces", ![foreignResource.id, foreignRevision.id, foreignObservation.id, foreignItem.id].some((id) => JSON.stringify(isolatedA).includes(String(id))) && ![canonicalResource.id, canonicalRevision.id, item.id, unsignaledItem.id].some((id) => JSON.stringify(isolatedB).includes(String(id))) && isolatedB.records.context.some((entry) => entry.id === foreignObservation.id))
        const crossProjectBoard = new TaricAuthorityBoard({ host, work: service, projectManifest: { resourceIds: [String(canonicalResource.id)], workItemIds: [String(foreignItem.id)] } })
        check("trusted_manifest_cannot_bind_foreign_work_to_project_resource", await rejectsCode(() => crossProjectBoard.initialize(), "authorization_error") && crossProjectBoard.snapshot().records.work.length === 0)
        const schedulerResource = await resources.provision({ ...asset, assetId: "fixture-scheduler-resource" })
        const schedulerObservation = await store.createRecord({ schema_version: "1.0.0", engagement_id: engagementId, kind: "observation", resource_ref: schedulerResource.id, observed_at: new Date().toISOString(), statement: "Scheduler reservation fixture", artifact_refs: [], limitations: ["fixture only"] }, "L1")
        const schedulerRevision = record(record(await host.invokeHost("resource.revise", { resource_id: schedulerResource.id, expected_version: schedulerResource.version, content_hash: digest("scheduler-reservation-fixture"), source_observation_refs: [schedulerObservation.id], method: "GET", path: "/" })).revision)
        const scheduledItems = [await service.provisionWorkItem({ ...definition, workKey: "scheduler-work-a" }), await service.provisionWorkItem({ ...definition, assetId: "fixture-scheduler-resource", workKey: "scheduler-work-b", resourceIds: [String(schedulerResource.id)] })]
        projectManifest.resourceIds.push(String(schedulerResource.id))
        projectManifest.workItemIds.push(...scheduledItems.map((entry) => String(entry.id)))
        board.updateProjectManifest(projectManifest)
        const schedulingPremises: RecoveryPremise[] = scheduledItems.map((entry, index) => ({ binding, challengeId: definition.challengeId, assetId: index ? "fixture-scheduler-resource" : definition.assetId, resourceId: String(index ? schedulerResource.id : canonicalResource.id), resourceRevisionId: String(index ? schedulerRevision.id : canonicalRevision.id), scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(approvedScope.revision.id), scopePolicyDigest: String(approvedScope.revision.policy_digest), workItemId: String(entry.id), workItemVersion: Number(entry.version), targetVersion: 1 }))
        const reservations = new TaricHostWorkerReservations({ hostId, maxWorkerSlots: 2 })
        const schedulerOptions = { host, board, work: service, reservations, exclusiveTargetsFor: () => ["fixture-shared-exclusive-target"] }
        const defaultScheduler = new TaricAuthorityScheduler(schedulerOptions)
        let defaultDenied = false
        try { await defaultScheduler.schedule({ premise: schedulingPremises[0]!, agentId: modelId, taskSessionId: sessionId }) } catch (error) { defaultDenied = error instanceof TaricOperationError && error.code === "governance_not_ready" }
        check("scheduler_default_requires_trusted_host_authorization_before_reservation", defaultDenied && defaultScheduler.snapshot().occupiedWorkerSlots === 0)
        let fixtureAuthorizations = 0
        const scheduler = new TaricAuthorityScheduler({ ...schedulerOptions, async assertAuthorization() { fixtureAuthorizations += 1 } })
        const scheduling = await Promise.allSettled(schedulingPremises.map((premise) => scheduler.schedule({ premise, agentId: modelId, taskSessionId: sessionId, ttlMs: 60_000 })))
        const scheduledWinners = scheduling.filter((entry): entry is PromiseFulfilledResult<{ reservationId: string; run: Record<string, unknown> }> => entry.status === "fulfilled")
        const targetRejected = scheduling.some((entry) => entry.status === "rejected" && entry.reason instanceof TaricOperationError && entry.reason.code === "target_reserved")
        check("scheduler_same_exclusive_target_has_one_host_and_authority_owner", scheduledWinners.length === 1 && targetRejected && scheduler.snapshot().occupiedWorkerSlots === 1 && fixtureAuthorizations === 2)
        const firstScheduled = scheduledWinners[0]!.value
        await scheduler.transition(firstScheduled.reservationId, "cancelled", "fixture-scheduler-worker-stopped")
        scheduler.releaseAfterWorkerStopped(firstScheduled.reservationId)
        const remainingPremise = schedulingPremises.find((entry) => entry.workItemId !== firstScheduled.run.work_item_id)!
        const remainingScheduled = await scheduler.schedule({ premise: remainingPremise, agentId: modelId, taskSessionId: sessionId, ttlMs: 20 })
        await Bun.sleep(60)
        check("scheduler_expired_authority_lease_does_not_free_host_slot", await rejectsCode(() => scheduler.renew(remainingScheduled.reservationId), "stale_version") && scheduler.snapshot().occupiedWorkerSlots === 1 && scheduler.snapshot().projectReservations[0]?.state === "lease_lost")
        scheduler.releaseAfterWorkerStopped(remainingScheduled.reservationId)
        const schedulerReclaimed = await service.reclaim(remainingPremise, String(remainingScheduled.run.run_id), modelId, 60_000)
        check("scheduler_host_stop_releases_slots_while_authority_reclaim_creates_generation", scheduler.snapshot().occupiedWorkerSlots === 0 && schedulerReclaimed.status === "replan_required" && schedulerReclaimed.run?.generation === Number(remainingScheduled.run.generation) + 1)
        const malformedItem = await service.provisionWorkItem({ ...definition, workKey: "scheduler-malformed-claim-reply" })
        projectManifest.workItemIds.push(String(malformedItem.id))
        board.updateProjectManifest(projectManifest)
        const malformedWork = new TaricAuthorityWorkService({ policyDigest: TARIC_DEFAULT_POLICY_DIGEST, host: { ...host, async invokeHost(operation, input) { const response = await host.invokeHost(operation, input); return operation === "work.claim" ? null : response } } })
        const malformedScheduler = new TaricAuthorityScheduler({ ...schedulerOptions, work: malformedWork, async assertAuthorization() {} })
        const malformedPremise: RecoveryPremise = { ...schedulingPremises[0]!, workItemId: String(malformedItem.id), workItemVersion: Number(malformedItem.version) }
        const malformedRejected = await rejectsCode(() => malformedScheduler.schedule({ premise: malformedPremise, agentId: modelId, taskSessionId: sessionId }), "claim_indeterminate")
        const nativeCommitted = (await service.queryWork([malformedPremise.resourceId], true)).records.find((entry) => entry.id === malformedItem.id)?.active_run
        check("successful_native_claim_with_null_reply_keeps_indeterminate_host_reservation", malformedRejected && nativeCommitted !== undefined && malformedScheduler.snapshot().occupiedWorkerSlots === 1 && malformedScheduler.snapshot().projectReservations[0]?.state === "claim_indeterminate")
        const premise: RecoveryPremise = { binding, challengeId: definition.challengeId, assetId: definition.assetId, resourceId: String(canonicalResource.id), resourceRevisionId: String(canonicalRevision.id), scopeId: String(scope.id), scopeVersion: Number(scope.version), scopeRevisionId: String(approvedScope.revision.id), scopePolicyDigest: String(approvedScope.revision.policy_digest), workItemId: String(item.id), workItemVersion: Number(item.version), targetVersion: 1 }
        const query = await service.queryWork([premise.resourceId])
        check("canonical_workitem_query_pinned", query.diagnostics.snapshotPinned && query.diagnostics.status === "complete" && query.records.some((entry) => entry.id === item.id))
        let forgedRevisionDenied = false
        try { await service.claim({ premise: { ...premise, resourceRevisionId: Bun.randomUUIDv7() }, agentId: modelId, taskSessionId: sessionId }) } catch { forgedRevisionDenied = true }
        check("forged_resource_revision_cannot_claim", forgedRevisionDenied)
        const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => service.claim({ premise, agentId: modelId, taskSessionId: sessionId, ttlMs: 60_000 })))
        const winners = attempts.filter((result): result is PromiseFulfilledResult<Record<string, unknown>> => result.status === "fulfilled")
        check("four_concurrent_claims_one_authority_owner", winners.length === 1 && attempts.filter((result) => result.status === "rejected").length === 3)
        let run = winners[0]!.value
        run = await service.transition(premise, run, "running", "fixture-transition-running")
        run = await service.renew(premise, run, 60_000)
        const context = must(await authority.dispatch("context.query", model, { engagement_id: engagementId, work_item_id: item.id, budget: 50_000 }))
        check("actual_context_snapshot_is_opaque", typeof context.context_snapshot_id === "string" && String(context.context_snapshot_id).startsWith("ctx_"))
        // The locked Core emits ctx_<hex> while checkpoint schema requires UUID.
        // This is an explicitly host-built checkpoint snapshot, not that Core ID.
        const checkpointInput = { premise, authorityRun: run, piSessionId: "fixture-pi-session", contextSnapshotId: Bun.randomUUIDv7(), sourceReadSeq: Number(context.read_seq), sourceContext: { snapshotId: String(context.context_snapshot_id), readSeq: Number(context.read_seq), contentDigest: digest(JSON.stringify(context)) }, completedSteps: ["Validated isolated manifest"], nextSteps: ["Inspect the next approved manifest cell"], observationRefs: [], evidenceRefs: [], unresolvedWork: [] }
        const recovered = await service.checkpoint(checkpointInput)
        check("authority_checkpoint_stores_complete_recovery_locator", recovered.locator.workRunId === run.run_id && recovered.locator.attemptId === run.attempt_ref && recovered.locator.piSessionId === "fixture-pi-session")
        run = await service.renew(premise, run, 120_000)
        check("checkpoint_then_renew_keeps_same_generation", Number(run.generation) === recovered.run.generation && Date.parse(String(run.lease_expires_at)) > Date.parse(String(recovered.checkpoint.lease_expires_at)))
        run = await service.renew(premise, run, 30_000)
        const shortenedResume = await service.recoverActive(premise)
        check("shortened_active_lease_resumes_historical_longer_checkpoint", shortenedResume.status === "resumed" && Date.parse(String(shortenedResume.checkpoint.lease_expires_at)) > Date.parse(shortenedResume.run.leaseExpiresAt))
        run = await service.renew(premise, run, 120_000)
        await authority.close()
        store = new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(databasePath))
        authority = await core.createCoreService(store, contentRoot)
        service = new TaricAuthorityWorkService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
        const restartedBoard = await new TaricAuthorityBoard({ host, work: service, projectManifest }).initialize()
        check("board_rebuilt_after_sql_restart_without_projection_files", restartedBoard.status === "healthy" && restartedBoard.records.work.some((entry) => entry.id === unsignaledItem.id) && restartedBoard.records.work.some((entry) => entry.id === item.id))
        const restarted = await service.recoverActive(premise)
        check("restart_without_local_run_map_or_checkpoint_recovers", restarted.status === "resumed" && restarted.locator.workRunId === recovered.locator.workRunId && restarted.locator.piSessionId === recovered.locator.piSessionId)
        check("renewed_run_recovers_older_checkpoint_after_restart", restarted.status === "resumed" && Date.parse(restarted.run.leaseExpiresAt) > Date.parse(String(restarted.checkpoint.lease_expires_at)))
        const shortened = await service.renew(premise, run, 20)
        await Bun.sleep(60)
        check("expired_lease_rejects_renewal", await rejectsCode(() => service.renew(premise, shortened), "stale_version"))
        const reclaimed = await service.recover(premise, String(run.run_id), { agentId: modelId, ttlMs: 60_000 })
        check("lease_reclaim_new_generation_and_attempt", reclaimed.status === "replan_required" && reclaimed.reason === "lease_reclaimed" && reclaimed.run?.generation === Number(run.generation) + 1 && reclaimed.run?.attemptId !== run.attempt_ref)
        const staleCheckpoint = createAuthorityRecoveryCheckpoint({ ...checkpointInput, builderVersion: "fixture-builder" })
        check("old_generation_checkpoint_rejected_by_authority", await rejectsCode(() => host.invokeHost("checkpoint.commit", { work_run_id: run.run_id, generation: run.generation, checkpoint: staleCheckpoint }), "stale_version"))
        check("old_generation_transition_rejected_by_authority", await rejectsCode(() => host.invokeHost("work.transition", { work_run_id: run.run_id, generation: run.generation, status: "running", idempotency_key: "fixture-stale-transition" }), "stale_version"))
        const beforeLateCapture = (await store.list(engagementId)).filter((entry) => ["observation", "evidence", "coverage"].includes(String(entry.kind))).map((entry) => `${entry.id}@${entry.version}`).sort()
        const lateCapture = record(await host.invokeHost("capture.observation", { work_run_id: run.run_id, generation: run.generation, observation: { schema_version: "1.0.0", engagement_id: engagementId, kind: "observation", resource_ref: canonicalResource.id, observed_at: new Date().toISOString(), statement: "A late worker cannot publish this fixture result.", artifact_refs: [], limitations: ["Stale generation rejection fixture."] }, client_request_id: "fixture-stale-capture", idempotency_key: "fixture-stale-capture" }))
        check("old_generation_capture_quarantined_by_authority", lateCapture.status === "rejected")
        const afterLateCapture = (await store.list(engagementId)).filter((entry) => ["observation", "evidence", "coverage"].includes(String(entry.kind))).map((entry) => `${entry.id}@${entry.version}`).sort()
        check("late_capture_cannot_change_canonical_observation_evidence_or_coverage", JSON.stringify(beforeLateCapture) === JSON.stringify(afterLateCapture))
        const replan = await service.recover(premise, String(run.run_id))
        check("old_checkpoint_never_resumes_reclaimed_generation", replan.status === "replan_required")
        report = {
            reportVersion: "breachweave-taric-work-fixture/1", generatedAt: new Date().toISOString(), evidenceClass: "local_dist_fixture", sourceCommit,
            sourceCommitMeaning: "expected_checkout_ref_only", runtimeSourceProvenance: "unverified", authority: "single_host_sqlite", restartMethod: "clean_authority_close_reopen_with_fresh_service_instance",
            operationRegistrySourceDigest: TARIC_OPERATION_REGISTRY_SOURCE_DIGEST, assertions, metrics: { passed: assertions.filter((entry) => entry.passed).length, total: assertions.length },
            board: { surfaces: ["model_context_L2_only", "host_workitem_L1_L2", "host_resource_L1_L2", "host_resource_revision_L1_L2"], recordVersionsPinnedToSameWatermark: true, notificationsAreHintsOnly: true, localProjectionFilesRead: false, genericRecordVisibility: "current_recall_filtered", completeEngagementReconstructionClaimed: false, coverageGateInferredFromBoard: false, launchAuthorizationGrantedByBoard: false },
            scheduler: { authorization: "trusted_isolated_fixture_callback_only", productionDefaultGate: "trusted_host_authorization_required", sharedHostWorkerPoolIndependentOfLeases: true, targetTrafficGenerated: false },
            userConfigurationRead: false, targetTrafficGenerated: false, productionEvidence: false, temporaryStateRemoved: true,
            limitations: ["The selected upstream dist artifacts are local fixtures; source-to-dist and dependency closure provenance are not certified.", "Resource and observation fixture foundations are canonical AuthorityStore records; this smoke does not certify project manifest bootstrap.", "WorkItem records are snapshot-pinned; active_run discovery is a live join, followed by authoritative work.resume validation.", "The fixture requires an initialized Engagement and an operator-approved immutable ScopeRevision bound to a committed ROE Artifact.", "Core context.query emits ctx_<hex>, but checkpoint ContextManifest requires UUID; the checkpoint uses an explicitly host-built UUID snapshot and the actual queried read_seq, not a fabricated canonical Core Context ID.", "Expired runs cannot be rediscovered through Work's active_run join alone; reclaim requires the already persisted WorkRun identifier.", "Only clean authority restart is covered here; SIGKILL and power-loss durability are not claimed."],
        }
    } finally { await authority.close(); await rm(root, { recursive: true, force: true }) }
    const output = argument("output")
    if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true }); await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`) }
    console.log(JSON.stringify(report, null, 2))
}

await main()
