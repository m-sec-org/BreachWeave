import { describe, expect, test } from "bun:test"
import { createServer as createHttpsServer } from "node:https"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ConfigManager } from "../config/index"
import { deriveCompositeProjectKey } from "../project/types"
import { ChallengeManager } from "./manager"
import { CHALLENGE_ENV_DIR } from "./env"
import { createAuthorizedChallengeProjectionProvider, projectAuthorizedChallenge } from "./authorized-projection"
import { AuthorizedProjectInventoryStore } from "../config/authorized-projects"
import { TARIC_COMPATIBILITY_BASELINE } from "../taric/compatibility"
import type { AuthorizedProjectBinding } from "../config/authorized-projects"
import type { AuthorizedProjection } from "../taric/governance"

const project = {
    mode: "authorized_pentest" as const,
    tenant_id: "tenant-projection",
    engagement_id: "engagement-projection",
    scope_revision: 1,
    coverage_manifest_id: "manifest-projection",
    memory_mode: "taric_required" as const,
    taric_engagement_id: "engagement-projection",
}

function projection(overrides: Partial<AuthorizedProjection> = {}): AuthorizedProjection {
    return {
        format: "breachweave-authorized-projection/1",
        source: "canonical_taric_records",
        readSeq: 42,
        refreshedAt: "2026-11-02T00:00:00.000Z",
        lifecycleMode: "taric_projection",
        diagnostics: { status: "complete", reconciliation: "matched", evidenceClass: "authority_projection" },
        scope: [{ id: "scope-1", created_at: "2026-11-01T00:00:00.000Z" }],
        scopeRevisions: [],
        resources: [{ id: "019a0000-0000-7000-8000-000000000001", identity: { origin: "http://127.0.0.1:8080", path: "/login" } }],
        resourceRevisions: [],
        work: [{ id: "019a0000-0000-7000-8000-000000000002", status: "completed" }],
        context: [],
        coverage: [{ id: "019a0000-0000-7000-8000-000000000003", status: "positive" }],
        coverageGate: { can_close: true, gaps: [] },
        evidence: [{ id: "019a0000-0000-7000-8000-000000000004" }],
        actionAudit: [{ event_id: "019a0000-0000-7000-8000-000000000005", work_run_id: "019a0000-0000-7000-8000-000000000006" }],
        report: { engagement: { status: "completed" }, reports: [{ id: "019a0000-0000-7000-8000-000000000007", report_artifact_ref: "artifact@v1", evidence_refs: ["019a0000-0000-7000-8000-000000000004"] }], decisions: [], closed: true, readSeq: 42, source: "canonical_taric_records" },
        ...overrides,
    }
}

const FIXTURE_IDS = {
    engagement: "019a0000-0000-7000-8000-000000000010",
    scope: "019a0000-0000-7000-8000-000000000011",
    scopeRevision: "019a0000-0000-7000-8000-000000000012",
    manifest: "019a0000-0000-7000-8000-000000000013",
    resource: "019a0000-0000-7000-8000-000000000014",
    resourceRevision: "019a0000-0000-7000-8000-000000000015",
    work: "019a0000-0000-7000-8000-000000000016",
    evidence: "019a0000-0000-7000-8000-000000000017",
    coverage: "019a0000-0000-7000-8000-000000000018",
    report: "019a0000-0000-7000-8000-000000000019",
    closeDecision: "019a0000-0000-7000-8000-000000000020",
} as const

const POLICY_DIGEST = `sha256:${"a".repeat(64)}`
const MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`
const COVERAGE_DIGEST = `sha256:${"c".repeat(64)}`
const EVIDENCE_DIGEST = `sha256:${"d".repeat(64)}`
const REPORT_DIGEST = `sha256:${"e".repeat(64)}`
const REPORT_ARTIFACT_DIGEST = `sha256:${"f".repeat(64)}`

function createCanonicalGatewayState(missingResourceIdentity = false) {
    const scope = {
        id: FIXTURE_IDS.scope, kind: "scope", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1", version: 1,
        current_revision_ref: FIXTURE_IDS.scopeRevision, revision_state: "approved", policy_digest: POLICY_DIGEST,
    }
    const policy = {
        allowed_targets: ["127.0.0.1"], excluded_targets: [], protocols: ["http"], ports: [{ from: 1, to: 65535 }], methods: ["GET"],
        dns: { require_pinned_addresses: true, reject_private_addresses: false, max_addresses: 4 },
        redirects: { max_hops: 1, same_scope_only: true },
        valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2030-01-01T00:00:00.000Z",
    }
    const scopeRevision = {
        id: FIXTURE_IDS.scopeRevision, kind: "scope_revision", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1", scope_ref: FIXTURE_IDS.scope,
        revision: 1, approval_status: "approved", policy_digest: POLICY_DIGEST, policy,
        roe_artifact_ref: "019a0000-0000-7000-8000-000000000021@v1", roe_artifact_version: 1, roe_content_hash: EVIDENCE_DIGEST,
    }
    const expectedCell = {
        resource_ref: FIXTURE_IDS.resource, resource_revision_ref: FIXTURE_IDS.resourceRevision, test_category: "authentication", conditions: [],
    }
    const manifest = {
        id: FIXTURE_IDS.manifest, kind: "coverage_manifest", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        scope_revision_ref: FIXTURE_IDS.scopeRevision, policy_digest: POLICY_DIGEST, manifest_digest: MANIFEST_DIGEST, expected_cells: [expectedCell],
    }
    const resource = {
        id: FIXTURE_IDS.resource, kind: "resource", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        ...(missingResourceIdentity ? {} : { identity: { origin: "http://127.0.0.1:8080", path: "/login" } }),
    }
    const resourceRevision = {
        id: FIXTURE_IDS.resourceRevision, kind: "resource_revision", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        resource_ref: FIXTURE_IDS.resource, revision: 1,
    }
    const work = {
        id: FIXTURE_IDS.work, kind: "work_item", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1", scope_ref: FIXTURE_IDS.scope,
        resource_refs: [FIXTURE_IDS.resource], status: "completed",
    }
    const evidence = {
        id: FIXTURE_IDS.evidence, kind: "evidence", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        resource_ref: FIXTURE_IDS.resource, resource_revision_ref: FIXTURE_IDS.resourceRevision,
    }
    const coverage = {
        id: FIXTURE_IDS.coverage, kind: "coverage", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1", ...expectedCell,
        manifest_ref: FIXTURE_IDS.manifest, manifest_digest: MANIFEST_DIGEST, scope_revision_ref: FIXTURE_IDS.scopeRevision,
        policy_digest: POLICY_DIGEST, status: "positive", evidence_refs: [FIXTURE_IDS.evidence],
    }
    const engagement = { id: FIXTURE_IDS.engagement, kind: "engagement", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1", version: 2, status: "completed", scope_ref: FIXTURE_IDS.scope }
    const report = {
        id: FIXTURE_IDS.report, kind: "report_snapshot", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        manifest_ref: FIXTURE_IDS.manifest, manifest_digest: MANIFEST_DIGEST, scope_revision_ref: FIXTURE_IDS.scopeRevision, policy_digest: POLICY_DIGEST,
        evidence_snapshot_hash: EVIDENCE_DIGEST, coverage_snapshot_digest: COVERAGE_DIGEST, coverage_read_seq: 42, authority_read_seq: 42,
        report_artifact_session_id: "fixture-report-session", report_artifact_ref: "019a0000-0000-7000-8000-000000000022@v1",
        report_artifact_digest: REPORT_ARTIFACT_DIGEST, snapshot_digest: REPORT_DIGEST, resource_revision_refs: [FIXTURE_IDS.resourceRevision],
        committed_at: "2026-11-02T00:00:00.000Z",
    }
    const decision = {
        id: FIXTURE_IDS.closeDecision, kind: "close_decision", engagement_id: FIXTURE_IDS.engagement, trust_level: "L1",
        decision: "closed", report_snapshot_ref: FIXTURE_IDS.report, scope_revision_ref: FIXTURE_IDS.scopeRevision, policy_digest: POLICY_DIGEST,
        evidence_snapshot_hash: EVIDENCE_DIGEST, coverage_snapshot_digest: COVERAGE_DIGEST, snapshot_read_seq: 42,
        resource_revision_refs: [FIXTURE_IDS.resourceRevision], commit_seq: 43,
    }

    return {
        scope,
        scopeRevision,
        manifest,
        resource,
        resourceRevision,
        work,
        evidence,
        coverage,
        engagement,
        report,
        decision,
    }
}

function page(records: Record<string, unknown>[], readSeq = 42): Record<string, unknown> {
    return { records, read_seq: readSeq, has_more: false }
}

function createGatewayResponse(input: { id: string; method: string; params: Record<string, unknown> }, state: ReturnType<typeof createCanonicalGatewayState>): Record<string, unknown> {
    if (input.method === "taric.gateway.status") return { jsonrpc: "2.0", id: input.id, result: { ok: true, data: { readiness: true, liveness: true } } }
    const operation = String(input.params.operation)
    const request = input.params.request as Record<string, unknown>
    let data: Record<string, unknown>
    if (operation === "engagement.status") {
        data = { api_contract_version: TARIC_COMPATIBILITY_BASELINE.apiContractVersion, schema_version: TARIC_COMPATIBILITY_BASELINE.schemaVersion }
    } else if (operation === "resource.query") {
        const records = request.kind === "scope" ? [state.scope]
            : request.kind === "scope_revision" ? [state.scopeRevision]
              : request.kind === "coverage_manifest" ? [state.manifest]
                : request.kind === "resource" ? [state.resource]
                  : request.kind === "resource_revision" ? [state.resourceRevision]
                    : request.kind === "work_item" ? [state.work]
                      : request.kind === "evidence" ? [state.evidence]
                        : request.kind === "engagement" ? [state.engagement]
                          : request.kind === "report_snapshot" ? [state.report]
                            : request.kind === "close_decision" ? [state.decision]
                              : []
        data = page(records)
    } else if (operation === "scope.query") {
        data = page([state.scope, state.scopeRevision], Number(request.as_of ?? 42))
    } else if (operation === "context.query") {
        data = {
            items: request.work_item_id === state.work.id ? [{
                id: "019a0000-0000-7000-8000-000000000024",
                kind: "work_context",
                engagement_id: FIXTURE_IDS.engagement,
                work_item_ref: state.work.id,
                summary: "canonical handoff from Taric Context",
            }] : [],
            context_snapshot_id: "context-fixture-snapshot",
            read_seq: Number(request.read_seq ?? 42),
            truncated_count: 0,
            omitted_count: 0,
            omitted_count_complete: true,
            omitted_as_unexamined: false,
            has_more: false,
        }
    } else if (operation === "work.query") {
        data = { items: [{ ...state.work, active_run: null }], read_seq: Number(request.read_seq ?? 42), has_more: false }
    } else if (operation === "coverage.snapshot") {
        data = {
            engagement_id: FIXTURE_IDS.engagement, manifest_ref: FIXTURE_IDS.manifest, manifest_digest: MANIFEST_DIGEST,
            cells: [state.coverage], read_seq: Number(request.as_of ?? 42), has_more: false, snapshot_id: "019a0000-0000-7000-8000-000000000023",
            snapshot_digest: COVERAGE_DIGEST, expected_cell_count: 1, domain_cell_count: 1, complete_domain: true, truncated: false,
            manifest_binding_verified: true, missing_items_complete: true, expected_cell_count_complete: true,
        }
    } else if (operation === "coverage.gate") {
        data = { can_close: true, read_seq: Number(request.as_of ?? 42), snapshot_digest: COVERAGE_DIGEST, gaps: [] }
    } else if (operation === "action.audit.query") {
        data = { events: [], read_seq: Number(request.read_seq ?? 42), has_more: false }
    } else {
        throw new Error(`Unexpected Taric fixture operation: ${operation}`)
    }
    return { jsonrpc: "2.0", id: input.id, result: { ok: true, data } }
}

async function startProjectionGateway(readState: () => ReturnType<typeof createCanonicalGatewayState>) {
    const fixtureDir = new URL("../taric/fixtures/", import.meta.url)
    const key = await Bun.file(new URL("gateway-test-key.pem", fixtureDir)).text()
    const cert = await Bun.file(new URL("gateway-test-cert.pem", fixtureDir)).text()
    const server = createHttpsServer({ key, cert }, (request, reply) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        request.on("end", () => {
            const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: Record<string, unknown> }
            const response = JSON.stringify(createGatewayResponse(input, readState()))
            reply.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(response) })
            reply.end(response)
        })
    })
    const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
    })
    return { server, port, certPath: new URL("../taric/fixtures/gateway-test-cert.pem", import.meta.url).pathname }
}

describe("authorized challenge projection", () => {
    test("rebuilds close, evidence, work and action summaries without local snapshots", () => {
        const binding: AuthorizedProjectBinding = { challengeId: "challenge-projection", title: "Projection challenge", project, scopeId: "019a0000-0000-7000-8000-000000000008" }
        const result = projectAuthorizedChallenge(binding, projection())
        expect(result.challenge.project_id).toBe(deriveCompositeProjectKey(project))
        expect(result.challenge.authority_projection).toMatchObject({ read_seq: 42, closed: true, can_close: true, work_total: 1, action_event_total: 1 })
        expect(result.submissions).toHaveLength(1)
        expect(result.submissions[0]?.report).toContain("artifact@v1")
        expect(result.stats.stats.authority).toMatchObject({ read_seq: 42, work_completed: 1, evidence_total: 1, action_event_total: 1, closed: true })
        expect(result.attempts).toEqual([])
    })

    test("does not infer close from a positive cell when canonical report is absent", () => {
        const binding: AuthorizedProjectBinding = { challengeId: "challenge-open", title: "Open challenge", project, scopeId: "019a0000-0000-7000-8000-000000000008" }
        const result = projectAuthorizedChallenge(binding, projection({ report: undefined, coverageGate: { can_close: true, gaps: [] } }))
        expect(result.challenge.authority_projection?.closed).toBe(false)
        expect(result.submissions).toEqual([])
        expect(result.stats.stats.submission_count).toBe(0)
    })

    test("rebuilds the product projection after local cache deletion and rejects missing canonical target identity", async () => {
        const root = await mkdtemp(join(tmpdir(), "breachweave-authorized-projection-"))
        const previousChallengeDir = process.env[CHALLENGE_ENV_DIR]
        const challengeRoot = join(root, "challenge-state")
        process.env[CHALLENGE_ENV_DIR] = challengeRoot
        const fixtureProject = {
            ...project,
            engagement_id: FIXTURE_IDS.engagement,
            taric_engagement_id: FIXTURE_IDS.engagement,
            coverage_manifest_id: FIXTURE_IDS.manifest,
        }
        const binding: AuthorizedProjectBinding = {
            challengeId: "projection-provider-rebuild",
            title: "Projection provider rebuild",
            project: fixtureProject,
            scopeId: FIXTURE_IDS.scope,
        }
        const inventory = new AuthorizedProjectInventoryStore(join(root, "authorized-projects.json"))
        const hostTokenName = "TARIC_PROJECTION_FIXTURE_HOST_TOKEN"
        const modelTokenName = "TARIC_PROJECTION_FIXTURE_MODEL_TOKEN"
        const previousHostToken = process.env[hostTokenName]
        const previousModelToken = process.env[modelTokenName]
        process.env[hostTokenName] = "projection-fixture-host-token-012345678901234567"
        process.env[modelTokenName] = "projection-fixture-model-token-012345678901234567"
        let state = createCanonicalGatewayState()
        const gateway = await startProjectionGateway(() => state)
        const config = {
            dir: root,
            async getHostSettings() {
                return {
                    taric: {
                        enabled: true,
                        profile: "authenticated_proxy" as const,
                        engagementBoundary: "shared_development" as const,
                        hostPrincipalId: "projection-fixture-host",
                        modelPrincipalId: "projection-fixture-model",
                        gatewayUrl: `https://localhost:${gateway.port}/rpc`,
                        gatewayCaFile: gateway.certPath,
                        gatewayHostTokenEnv: hostTokenName,
                        gatewayModelTokenEnv: modelTokenName,
                        gatewayTimeoutMs: 5_000,
                    },
                }
            },
            listAuthorizedProjectBindings: () => inventory.list(),
        }
        await inventory.save(binding)
        const cachePaths = ["challenge.json", "manifest.json", "session.json", "checkpoint.json", "action-map.json", "report-index.json"].map((name) => join(challengeRoot, encodeURIComponent(binding.challengeId), name))
        for (const path of cachePaths) {
            await mkdir(dirname(path), { recursive: true })
            await Bun.write(path, "stale-local-copy")
        }
        let provider = createAuthorizedChallengeProjectionProvider(config as never)
        let manager: ChallengeManager | undefined
        try {
            const withLocalCopies = await provider.read(binding.challengeId)
            expect(withLocalCopies).toBeDefined()
            const baseline = withLocalCopies!
            await provider.close?.()
            await Promise.all(cachePaths.map((path) => rm(path, { force: true })))
            expect(await Promise.all(cachePaths.map((path) => Bun.file(path).exists()))).toEqual(cachePaths.map(() => false))

            provider = createAuthorizedChallengeProjectionProvider(config as never)
            manager = new ChallengeManager(config as unknown as ConfigManager, undefined, undefined, undefined, provider)
            const listed = await manager.listStoredChallenges()
            const challenge = listed.find((item) => item.id === binding.challengeId)
            const rebuilt = await manager.getAuthorizedProjection(binding.challengeId)
            const submissions = await manager.listSubmissionLogs(binding.challengeId)
            const stats = await manager.refreshStats(binding.challengeId)
            expect(rebuilt?.challenge).toMatchObject({
                id: binding.challengeId,
                source: "taric:canonical_projection",
                assets_url: ["http://127.0.0.1:8080/login"],
                authority_projection: { read_seq: 42, closed: true, can_close: true, work_total: 1 },
            })
            expect(challenge).toMatchObject({
                id: baseline.challenge.id,
                source: baseline.challenge.source,
                assets_url: baseline.challenge.assets_url,
                authority_projection: baseline.challenge.authority_projection,
            })
            expect(rebuilt?.challenge.assets_url).toEqual(baseline.challenge.assets_url)
            expect(rebuilt?.challenge.authority_projection).toEqual(baseline.challenge.authority_projection)
            expect(rebuilt?.authority.work).toEqual(baseline.authority.work)
            expect(rebuilt?.authority.coverageGate).toEqual(baseline.authority.coverageGate)
            expect(rebuilt?.authority.evidence.map((item) => item.id)).toEqual(baseline.authority.evidence.map((item) => item.id))
            expect(rebuilt?.authority.report?.closed).toBe(baseline.authority.report?.closed)
            expect(rebuilt?.authority.report?.reports.map((item) => item.id)).toEqual(baseline.authority.report?.reports.map((item) => item.id))
            expect(submissions).toHaveLength(1)
            expect(submissions).toEqual(baseline.submissions)
            expect(submissions[0]?.report).toContain(FIXTURE_IDS.report)
            expect(stats.stats.authority).toMatchObject({ read_seq: 42, work_completed: 1, evidence_total: 1, closed: true })
            expect(stats.stats.authority).toEqual(baseline.stats.stats.authority)
            expect(rebuilt?.attempts).toEqual([])
            expect(rebuilt?.authority).toMatchObject({
                source: baseline.authority.source,
                readSeq: baseline.authority.readSeq,
                work: baseline.authority.work,
                coverage: baseline.authority.coverage,
                coverageGate: baseline.authority.coverageGate,
                evidence: baseline.authority.evidence,
                actionAudit: baseline.authority.actionAudit,
                report: baseline.authority.report,
            })
            expect(await Promise.all(cachePaths.map((path) => Bun.file(path).exists()))).toEqual(cachePaths.map(() => false))

            state = createCanonicalGatewayState(true)
            await expect(manager.listStoredChallenges()).rejects.toMatchObject({ code: "incomplete_authority_snapshot" })
        } finally {
            if (manager) await manager.close()
            else await provider.close?.()
            await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()))
            if (previousHostToken === undefined) delete process.env[hostTokenName]
            else process.env[hostTokenName] = previousHostToken
            if (previousModelToken === undefined) delete process.env[modelTokenName]
            else process.env[modelTokenName] = previousModelToken
            if (previousChallengeDir === undefined) delete process.env[CHALLENGE_ENV_DIR]
            else process.env[CHALLENGE_ENV_DIR] = previousChallengeDir
            await rm(root, { recursive: true, force: true })
        }
    })
})
