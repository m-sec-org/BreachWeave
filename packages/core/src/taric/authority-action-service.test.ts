import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { TaricAuthorityActionContext, TaricAuthorityActionOptions } from "./authority-action-service"
import { TaricAuthorityActionService } from "./authority-action-service"

const context: TaricAuthorityActionContext = { engagementId: "019a0000-0000-7000-8000-000000000001", workRunId: "019a0000-0000-7000-8000-000000000002", attemptId: "019a0000-0000-7000-8000-000000000003", generation: 1, ownerHost: "action-host", scopeId: "019a0000-0000-7000-8000-000000000004", scopeVersion: 1, scopeRevisionId: "019a0000-0000-7000-8000-000000000005", taskSessionId: "action-session" }

function fixture(overrides: Partial<TaricAuthorityActionOptions> = {}) {
    const calls: string[] = []
    const options: TaricAuthorityActionOptions = {
        host: {
            getBinding() { return { engagementId: context.engagementId, projectId: "action-project", tenantId: "action-tenant", hostPrincipalId: "action-host", modelPrincipalId: "action-model" } },
            async invokeHost(operation) { calls.push(operation); throw new Error("No authority fixture installed") },
            async invokeAction(operation) { calls.push(operation); throw new Error("No authority fixture installed") },
        },
        policyDigest: `sha256:${"a".repeat(64)}`,
        network: { evaluateEgress: () => ({ allowed: true, reason: "fixture", normalizedUrls: [] }) },
        ...overrides,
    }
    return { service: new TaricAuthorityActionService(options), calls }
}

describe("canonical Action execution profile", () => {
    test("default profile blocks before authority mutations or traffic", async () => {
        const { service, calls } = fixture()
        expect(service.diagnostic()).toMatchObject({ status: "blocked", fullControlPlane: "blocked", actionAuditQuery: "canonical_pinned_history", scopeMapping: "immutable_scope_revision", runtimeFirewall: false })
        await expect(service.execute({ request: { url: "http://127.0.0.1/" }, rationale: "Fixture inspection" }, context)).rejects.toMatchObject({ code: "action_contract_blocked" })
        expect(calls).toEqual([])
    })

    test("forged Engagement/owner fails before asking authority or creating recommendations", async () => {
        const { service, calls } = fixture({ allowLocalFixtureExecution: true })
        await expect(service.execute({ request: { url: "http://127.0.0.1/" }, rationale: "Fixture inspection" }, { ...context, ownerHost: "forged" })).rejects.toMatchObject({ code: "authorization_error" })
        expect(calls).toEqual([])
    })

    test("a missing authoritative checkpoint cannot fall back to local action state", async () => {
        const { service, calls } = fixture({ allowLocalFixtureExecution: true })
        await expect(service.execute({ request: { url: "http://127.0.0.1/" }, rationale: "Fixture inspection" }, context)).rejects.toThrow("No authority fixture")
        expect(calls).toEqual(["work.resume"])
    })

    test("action callbacks bind resume to their expected generation and reject a replaced owner", async () => {
        const requests: Record<string, unknown>[] = []
        const binding = { engagementId: context.engagementId, projectId: "action-project", tenantId: "action-tenant", hostPrincipalId: "action-host", modelPrincipalId: "action-model" }
        let writes = 0
        const { service } = fixture({ allowLocalFixtureExecution: true, host: {
            getBinding() { return binding },
            async invokeHost(operation, input) {
                expect(operation).toBe("work.resume")
                requests.push(input)
                return {
                    run: { run_id: context.workRunId, engagement_id: context.engagementId, attempt_ref: context.attemptId, generation: context.generation, owner: { host_id: context.ownerHost, agent_id: "replacement" }, scope_ref: context.scopeId, scope_version: context.scopeVersion, scope_revision_ref: context.scopeRevisionId, policy_digest: `sha256:${"a".repeat(64)}`, task_session_ref: context.taskSessionId, status: "running", lease_expires_at: "2099-01-01T00:00:00.000Z" },
                    checkpoint: { scope_ref: context.scopeId, scope_version: context.scopeVersion, scope_revision_ref: context.scopeRevisionId, policy_digest: `sha256:${"a".repeat(64)}` },
                    task_session_ref: context.taskSessionId, pending_actions: [], premise_checks: { engagement: true, work_item: true, scope: true, checkpoint: true, attempt: true, source_sequence: true, lease: true, context_manifest: true, host_authorization_refs: true, action_results: true },
                }
            },
            async invokeAction() { writes += 1; throw new Error("unexpected write") },
        } })
        await expect(service.execute({ request: { url: "http://127.0.0.1/" }, rationale: "Fixture inspection" }, { ...context, ownerAgentId: "original" })).rejects.toMatchObject({ code: "stale_version" })
        expect(requests).toEqual([{ work_run_id: context.workRunId, generation: context.generation }])
        expect(writes).toBe(0)
    })
})

const fixtureSource = process.env.TARIC_ACTION_FIXTURE_SOURCE
test.skipIf(!fixtureSource)("real pinned SQLite Actions drive scoped loopback HTTP and unknown reconciliation", async () => {
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "../../../../scripts/smoke-taric-actions.ts"), `--source=${fixtureSource}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const report = JSON.parse(stdout) as { authority: string; metrics: { passed: number; total: number }; targetTrafficGenerated: boolean; productionEvidence: boolean }
    expect(report.authority).toBe("single_host_sqlite")
    expect(report.metrics.total).toBeGreaterThanOrEqual(10)
    expect(report.metrics.passed).toBe(report.metrics.total)
    expect(report.targetTrafficGenerated).toBe(true)
    expect(report.productionEvidence).toBe(false)
}, 30_000)
