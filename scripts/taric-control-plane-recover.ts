import { join } from "node:path"
import { createEmbeddedTaricServiceAdapter } from "../packages/core/src/taric/embedded-adapter"
import type { EmbeddedTaricRuntimeDependencies } from "../packages/core/src/taric/embedded-adapter"
import { createTaricHostModule } from "../packages/core/src/taric/host-module"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST } from "../packages/core/src/taric/compatibility"
import { TaricAuthorityCoverageService } from "../packages/core/src/taric/authority-coverage-service"
import { TaricAuthorityReportService } from "../packages/core/src/taric/authority-report-service"
import { TaricAuthorityScopeService } from "../packages/core/src/taric/authority-scope-service"
import { TaricAuthorityWorkService } from "../packages/core/src/taric/authority-work-service"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { TaricAuthorityActionService } from "../packages/core/src/taric/authority-action-service"
import { digest, record } from "./taric-control-plane-fixture"

function argument(name: string): string {
    const value = process.argv.slice(2).find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (!value) throw new Error(`--${name} is required`)
    return value
}

const source = argument("source")
function optionalArgument(name: string): string | undefined { return process.argv.slice(2).find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) }
const [core, schemas, driver] = await Promise.all([import(join(source, "packages/core/dist/index.js")), import(join(source, "packages/schemas/dist/src/index.js")), import(join(source, "packages/driver-bun-sqlite/dist/index.js"))])
const binding = { projectId: "control-plane-fixture-project", tenantId: "control-plane-fixture-tenant", engagementId: argument("engagement"), hostPrincipalId: "control-plane-fixture-host", modelPrincipalId: "control-plane-fixture-model" }
const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath: argument("authority"), contentRoot: argument("content"), binding, hostCapabilities: ["admit", "content_read"], hostSessionId: "control-plane-fixture-session", operatorPrincipalId: "control-plane-fixture-operator", dependencies: { core, schemas, driver } as unknown as EmbeddedTaricRuntimeDependencies })
const host = createTaricHostModule({ adapter, binding, mode: "taric_required", expectedCompatibility: { ...TARIC_COMPATIBILITY_BASELINE, policyDigest: TARIC_DEFAULT_POLICY_DIGEST, bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY } } })
try {
    if ((await host.initialize()).status !== "healthy") throw new Error("Recovery host unavailable")
    const coverage = new TaricAuthorityCoverageService({ host })
    const reports = await new TaricAuthorityReportService({ host, coverage }).reconstruct()
    const scope = await new TaricAuthorityScopeService({ host }).resolve({ scopeId: String(reports.engagement.scope_ref) })
    const work = await new TaricAuthorityWorkService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST }).queryWork()
    if (work.diagnostics.status !== "complete" || work.diagnostics.hasMore) throw new Error("Work reconstruction incomplete")
    const latest = reports.reports.find((entry) => entry.id === reports.latestDecision?.report_snapshot_ref)
    if (!latest) throw new Error("Closed report is unavailable")
    const snapshot = await coverage.snapshot({ manifestId: String(latest.manifest_ref), manifestDigest: String(latest.manifest_digest), readSeq: Number(latest.coverage_read_seq) })
    const artifacts = new TaricArtifactService({ host, egressGrant: { capability: "content_read", principalId: binding.hostPrincipalId, engagementId: binding.engagementId } })
    let artifactHash: string | undefined
    await artifacts.consumeArtifact({ sessionId: String(latest.report_artifact_session_id), contentRef: String(latest.report_artifact_ref) }, async (bytes) => { artifactHash = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` })
    // Checkpoints live in Taric's execution tables. Session output supplies only
    // discovery locators; work.resume supplies the authoritative checkpoint.
    const executionPage = record(await host.invokeHost("artifact.session.output", { session_id: "control-plane-fixture-session", page_size: 50, include_content: false }))
    if (executionPage.execution_next_cursor || executionPage.next_cursor) throw new Error("Execution discovery incomplete")
    const runIds = [...new Set((executionPage.execution as Record<string, unknown>[]).filter((entry) => entry.kind === "checkpoint").map((entry) => String(entry.work_run_id)))]
    const locators: unknown[] = []
    for (const runId of runIds) {
        const packet = record(await host.invokeHost("work.resume", { work_run_id: runId }))
        const checkpoint = record(packet.checkpoint)
        const run = record(packet.run)
        if (run.run_id !== runId || run.engagement_id !== binding.engagementId || run.scope_revision_ref !== scope.scopeRevisionId || run.policy_digest !== scope.policyDigest || checkpoint.work_run_ref !== runId || checkpoint.scope_revision_ref !== scope.scopeRevisionId || checkpoint.policy_digest !== scope.policyDigest || run.status !== "completed") throw new Error("Terminal checkpoint provenance differs from authority")
        locators.push(record(record(checkpoint.context_manifest).adapter_manifest).breachweave_recovery)
    }
    const targetAuthRef = optionalArgument("target-auth-ref")
    let targetAuthVerified = false
    if (targetAuthRef) await artifacts.consumeTargetAuth({ sessionId: "control-plane-fixture-session", contentRef: targetAuthRef }, async (bytes) => {
        const expected = optionalArgument("target-auth-digest")
        targetAuthVerified = expected !== undefined && `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` === expected
    })
    const actionId = optionalArgument("action-id")
    let actionAudit: { digest?: string; count?: number; readSeq?: number } = {}
    if (actionId) {
        const actionService = new TaricAuthorityActionService({
            host,
            policyDigest: scope.policyDigest,
            scopeService: new TaricAuthorityScopeService({ host }),
            network: { evaluateEgress: () => ({ allowed: false, reason: "recovery-only smoke client", normalizedUrls: [] }) },
        })
        const readSeq = Number(optionalArgument("action-read-seq"))
        const audit = await actionService.queryAudit({ actionId, ...(Number.isSafeInteger(readSeq) && readSeq >= 0 ? { readSeq } : {}), pageSize: 1 })
        if (audit.diagnostics.status !== "complete" || audit.diagnostics.hasMore) throw new Error("Action audit recovery is incomplete")
        actionAudit = { digest: digest(JSON.stringify(audit.records)), count: audit.records.length, readSeq: audit.readSeq }
    }
    console.log(JSON.stringify({ source: "canonical_taric_records", closed: reports.closed, decisionId: reports.latestDecision?.id, reportId: latest.id, scopeRevisionId: scope.scopeRevisionId, workIds: work.records.map((entry) => entry.id).sort(), cellIds: snapshot.cells.map((entry) => entry.id).sort(), reportArtifactVerified: artifactHash === latest.report_artifact_digest, checkpointLocators: locators, targetAuthVerified, actionAuditDigest: actionAudit.digest, actionAuditCount: actionAudit.count, actionAuditReadSeq: actionAudit.readSeq, coverageDigest: snapshot.snapshotDigest, projectionDigest: digest(JSON.stringify([reports.latestDecision?.id, latest.id, snapshot.snapshotDigest])) }))
} finally { await host.close() }
