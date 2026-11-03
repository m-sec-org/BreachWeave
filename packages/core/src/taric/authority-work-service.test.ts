import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { TaricHostModule } from "./host-module"
import { TaricAuthorityClaimError, TaricAuthorityWorkService } from "./authority-work-service"
import { createAuthorityRecoveryCheckpoint } from "./recovery-locator"
import type { RecoveryPremise } from "./recovery-locator"
import { TaricOperationError } from "./types"

function service() {
    const calls: string[] = []
    const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
        getBinding() { return { projectId: "project", tenantId: "tenant", engagementId: "019a0000-0000-7000-8000-000000000001", hostPrincipalId: "host", modelPrincipalId: "model" } },
        async invokeHost(operation) { calls.push(operation); throw new Error("unexpected authority mutation") },
        async submitProposal() { calls.push("proposal.submit"); throw new Error("unexpected authority mutation") },
    }
    return { calls, work: new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` }) }
}

describe("authority Work lifecycle preflight", () => {
    const premise = () => {
        const id = (number: number) => `019a0000-0000-7000-8000-${number.toString().padStart(12, "0")}`
        const binding = { projectId: "project", tenantId: "tenant", engagementId: id(1), hostPrincipalId: "host", modelPrincipalId: "model" }
        return {
            binding,
            challengeId: "challenge",
            assetId: "asset",
            scopeId: id(2),
            scopeVersion: 1, scopeRevisionId: id(90), scopePolicyDigest: `sha256:${"a".repeat(64)}`,
            resourceId: id(3),
            resourceRevisionId: id(4),
            workItemId: id(5),
            workItemVersion: 1,
            targetVersion: 1,
        } satisfies RecoveryPremise
    }

    const run = () => ({
        run_id: "019a0000-0000-7000-8000-000000000006",
        work_item_id: "019a0000-0000-7000-8000-000000000005",
        attempt_ref: "019a0000-0000-7000-8000-000000000007",
        engagement_id: "019a0000-0000-7000-8000-000000000001",
        generation: 2,
        status: "running",
        owner: { host_id: "host", agent_id: "worker" },
        lease_expires_at: "2099-01-01T00:00:00.000Z",
        task_session_ref: "task-session",
        scope_ref: "019a0000-0000-7000-8000-000000000002",
        scope_version: 1, scope_revision_ref: "019a0000-0000-7000-8000-000000000090", policy_digest: `sha256:${"a".repeat(64)}`,
        work_item_version: 1,
        target_version: 1,
    })

    function canonicalPremises(input: RecoveryPremise) {
        return [
            { id: input.scopeRevisionId, engagement_id: input.binding.engagementId, kind: "scope_revision", scope_ref: input.scopeId, policy_digest: input.scopePolicyDigest, approval_status: "approved", trust_level: "L2", policy: { valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" } },
            { id: input.scopeId, engagement_id: input.binding.engagementId, kind: "scope", version: 1, trust_level: "L2", current_revision_ref: input.scopeRevisionId, policy_digest: input.scopePolicyDigest, revision_state: "approved" },
            { id: input.resourceId, engagement_id: input.binding.engagementId, kind: "resource", revision: 1, version: 1, trust_level: "L1" },
            { id: input.resourceRevisionId, engagement_id: input.binding.engagementId, kind: "resource_revision", revision: 1, version: 1, trust_level: "L1", resource_ref: input.resourceId },
            { id: input.workItemId, engagement_id: input.binding.engagementId, kind: "work_item", version: input.workItemVersion, scope_ref: input.scopeId, target_version: input.targetVersion, resource_refs: [input.resourceId], trust_level: "L1" },
        ]
    }

    function recoveryFixture() {
        const input = premise()
        const base = run()
        const calls: Array<{ operation: string; args: Record<string, unknown> }> = []
        const packet: Record<string, unknown> = {
            run: base,
            checkpoint: createAuthorityRecoveryCheckpoint({ premise: input, authorityRun: base, piSessionId: "pi-session", contextSnapshotId: "019a0000-0000-7000-8000-000000000009", sourceReadSeq: 10, sourceContext: { snapshotId: "ctx_0123456789abcdef", readSeq: 10, contentDigest: `sha256:${"b".repeat(64)}` }, builderVersion: "breachweave-authority-work-1", completedSteps: [], nextSteps: [], observationRefs: [], evidenceRefs: [], unresolvedWork: [] }),
            pending_actions: [], task_session_ref: base.task_session_ref, checkpoint_read_seq: 10, current_read_seq: 12,
            premise_checks: { engagement: true, work_item: true, scope: true, scope_revision: true, checkpoint: true, attempt: true, source_sequence: true, lease: true, context_manifest: true, host_authorization_refs: true, action_results: true },
            blocked: false, replan_required: false, resume_advice: "resume_allowed",
        }
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
            getBinding() { return input.binding },
            async invokeHost(operation, args) {
                calls.push({ operation, args })
                if (operation === "resource.query") return { records: canonicalPremises(input).filter((entry) => entry.kind === args.kind), read_seq: 10 }
                if (operation === "work.resume") return packet
                if (operation === "work.reclaim") return { ...base, generation: base.generation + 1, attempt_ref: "019a0000-0000-7000-8000-000000000099", owner: { host_id: "host", agent_id: args.agent_id }, lease_expires_at: "2099-01-01T00:00:00.000Z" }
                throw new Error(`unexpected ${operation}`)
            },
            async submitProposal() { throw new Error("unexpected proposal") },
        }
        return { input, base, packet, calls, host, work: new TaricAuthorityWorkService({ host, policyDigest: input.scopePolicyDigest }) }
    }

    test("recovery pins WorkItem and all immutable premises before authority resume", async () => {
        const { work, input, base, calls } = recoveryFixture()
        await expect(work.recover(input, base.run_id)).resolves.toMatchObject({ status: "resumed", run: { generation: 2 } })
        expect(calls.filter((call) => call.operation === "resource.query").map((call) => call.args.kind)).toEqual(["scope", "scope_revision", "resource", "resource_revision", "work_item"])
        expect(calls.filter((call) => call.operation === "resource.query").slice(1).every((call) => call.args.as_of === 10)).toBe(true)
        expect(calls.at(-1)?.operation).toBe("work.resume")
    })

    test("expired authority lease can reclaim only a verified checkpoint into a strictly newer generation", async () => {
        const { work, input, base, packet, calls } = recoveryFixture()
        base.lease_expires_at = "2020-01-01T00:00:00.000Z"
        packet.premise_checks = { ...(packet.premise_checks as Record<string, unknown>), lease: false }
        Object.assign(packet, { blocked: true, replan_required: true, resume_advice: "replan_required" })
        await expect(work.recover(input, base.run_id, { agentId: "replacement", ttlMs: 60_000 })).resolves.toMatchObject({ status: "replan_required", reason: "lease_reclaimed", run: { generation: 3, owner: { agent_id: "replacement" } } })
        expect(calls.filter((call) => call.operation === "work.reclaim")).toHaveLength(1)
        packet.checkpoint = null
        await expect(work.recover(input, base.run_id, { agentId: "replacement" })).resolves.toMatchObject({ status: "replan_required", reason: "authority_premise_incomplete" })
        expect(calls.filter((call) => call.operation === "work.reclaim")).toHaveLength(1)
    })

    test("cursor failure and a resume watermark older than pinned premises block recovery", async () => {
        const { input, base, packet, host } = recoveryFixture()
        packet.current_read_seq = 9
        await expect(new TaricAuthorityWorkService({ host, policyDigest: input.scopePolicyDigest }).recover(input, base.run_id)).resolves.toMatchObject({ status: "replan_required" })
        const work = new TaricAuthorityWorkService({ host: { ...host, async invokeHost() { throw new TaricOperationError("invalid_cursor", "expired authority cursor") } }, policyDigest: input.scopePolicyDigest })
        await expect(work.recover(input, base.run_id)).resolves.toMatchObject({ status: "replan_required", reason: "authority_premise_incomplete" })
        await expect(work.recoverActive(input)).resolves.toMatchObject({ status: "replan_required", reason: "authority_premise_incomplete" })
    })

    test("renew rejects an acknowledgement for a superseded generation", async () => {
        const base = run()
        const input = premise()
        const host = {
            getBinding() { return input.binding },
            async invokeHost(operation: string, args: Record<string, unknown>) {
                if (operation === "resource.query") return { records: canonicalPremises(input).filter((entry) => entry.kind === args.kind), read_seq: 10 }
                if (operation === "work.renew") return { ...base, generation: 3 }
                throw new Error(`unexpected ${operation}`)
            },
            async submitProposal() { throw new Error("unexpected proposal") },
        } satisfies Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
        const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(work.renew(input, base)).rejects.toMatchObject({ code: "replan_required" })
    })

    test("a canonical ResourceRevision UUID cannot substitute another target version or a superseded resource revision", async () => {
        for (const [currentRevision, suppliedRevision] of [[1, 2], [2, 1]]) {
            const input = premise()
            const canonical = [
                { id: input.scopeRevisionId, engagement_id: input.binding.engagementId, kind: "scope_revision", scope_ref: input.scopeId, policy_digest: input.scopePolicyDigest, approval_status: "approved", trust_level: "L2", policy: { valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" } },
                { id: input.scopeId, engagement_id: input.binding.engagementId, kind: "scope", version: 1, trust_level: "L2", current_revision_ref: input.scopeRevisionId, policy_digest: input.scopePolicyDigest, revision_state: "approved" },
                { id: input.resourceId, engagement_id: input.binding.engagementId, kind: "resource", revision: currentRevision, version: 1, trust_level: "L1" },
                { id: input.resourceRevisionId, engagement_id: input.binding.engagementId, kind: "resource_revision", revision: suppliedRevision, version: 1, trust_level: "L1", resource_ref: input.resourceId },
            ]
            const mutations: string[] = []
            const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
                getBinding() { return input.binding },
                async invokeHost(operation, args) {
                    if (operation === "resource.query") return { records: canonical.filter((entry) => entry.kind === args.kind), read_seq: 10 }
                    mutations.push(operation)
                    throw new Error("invalid resource premise reached mutation")
                },
                async submitProposal() { throw new Error("unexpected proposal") },
            }
            const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
            await expect(work.claim({ premise: input, agentId: "worker", taskSessionId: "task-session" })).rejects.toMatchObject({ claimOutcome: "not_dispatched" })
            await expect(work.recover(input, run().run_id)).rejects.toMatchObject({ code: "replan_required" })
            await expect(work.renew(input, run())).rejects.toMatchObject({ code: "replan_required" })
            for (const status of ["running", "checkpointed", "blocked", "completed"] as const) await expect(work.transition(input, run(), status, `stale-resource-${status}`)).rejects.toMatchObject({ code: "replan_required" })
            expect(mutations).toEqual([])
        }
    })

    test("transition rejects a mismatched owner or status acknowledgement", async () => {
        const base = run()
        const input = premise()
        const host = {
            getBinding() { return input.binding },
            async invokeHost(operation: string, args: Record<string, unknown>) {
                if (operation === "resource.query") return { records: canonicalPremises(input).filter((entry) => entry.kind === args.kind), read_seq: 10 }
                if (operation === "work.transition") return { ...base, status: "completed", owner: { host_id: "other-host", agent_id: "worker" } }
                throw new Error(`unexpected ${operation}`)
            },
            async submitProposal() { throw new Error("unexpected proposal") },
        } satisfies Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
        const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(work.transition(input, base, "running", "transition-request")).rejects.toMatchObject({ code: "replan_required" })
    })

    test("failed or cancelled cleanup remains possible after Scope and Resource invalidation", async () => {
        const input = premise()
        for (const status of ["failed", "cancelled"] as const) {
            const calls: string[] = []
            const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
                getBinding() { return input.binding },
                async invokeHost(operation) { calls.push(operation); return { ...run(), status } },
                async submitProposal() { throw new Error("unexpected proposal") },
            }
            const work = new TaricAuthorityWorkService({ host, policyDigest: input.scopePolicyDigest })
            await expect(work.transition(input, run(), status, `cleanup-${status}`)).resolves.toMatchObject({ status })
            expect(calls).toEqual(["work.transition"])
        }
    })

    test("recovery rejects a valid checkpoint returned for a different run id", async () => {
        const input = premise()
        const expectedRun = run()
        const substitutedRun = { ...expectedRun, run_id: "019a0000-0000-7000-8000-000000000008" }
        const checkpoint = createAuthorityRecoveryCheckpoint({
            premise: input,
            authorityRun: substitutedRun,
            piSessionId: "pi-session",
            contextSnapshotId: "019a0000-0000-7000-8000-000000000009",
            sourceReadSeq: 10,
            sourceContext: { snapshotId: "ctx_0123456789abcdef", readSeq: 10, contentDigest: `sha256:${"b".repeat(64)}` },
            builderVersion: "breachweave-authority-work-1",
            completedSteps: [],
            nextSteps: [],
            observationRefs: [],
            evidenceRefs: [],
            unresolvedWork: [],
        })
        const canonical = [
            { id: input.scopeRevisionId, engagement_id: input.binding.engagementId, kind: "scope_revision", scope_ref: input.scopeId, policy_digest: input.scopePolicyDigest, approval_status: "approved", trust_level: "L2", policy: { valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" } },
            { id: input.scopeId, engagement_id: input.binding.engagementId, kind: "scope", version: 1, trust_level: "L2", current_revision_ref: input.scopeRevisionId, policy_digest: input.scopePolicyDigest, revision_state: "approved" },
            { id: input.resourceId, engagement_id: input.binding.engagementId, kind: "resource", revision: 1, version: 1, trust_level: "L1" },
            { id: input.resourceRevisionId, engagement_id: input.binding.engagementId, kind: "resource_revision", revision: 1, version: 1, trust_level: "L1", resource_ref: input.resourceId },
            { id: input.workItemId, engagement_id: input.binding.engagementId, kind: "work_item", version: input.workItemVersion, scope_ref: input.scopeId, target_version: input.targetVersion, resource_refs: [input.resourceId], trust_level: "L1" },
        ]
        const host = {
            getBinding() { return input.binding },
            async invokeHost(operation: string, args: Record<string, unknown>) {
                if (operation === "resource.query") return { records: canonical.filter((entry) => entry.kind === args.kind), read_seq: 10 }
                if (operation === "work.resume") return {
                    run: substitutedRun,
                    checkpoint,
                    pending_actions: [],
                    task_session_ref: "task-session",
                    checkpoint_read_seq: 10,
                    current_read_seq: 12,
                    premise_checks: { engagement: true, work_item: true, scope: true, scope_revision: true, checkpoint: true, attempt: true, source_sequence: true, lease: true, context_manifest: true, host_authorization_refs: true, action_results: true },
                    blocked: false,
                    replan_required: false,
                    resume_advice: "resume_allowed",
                }
                throw new Error(`unexpected ${operation}`)
            },
            async submitProposal() { throw new Error("unexpected proposal") },
        } satisfies Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">
        const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        await expect(work.recover(input, expectedRun.run_id)).resolves.toMatchObject({ status: "replan_required", reason: "authority_premise_incomplete" })
    })

    test("successful claim dispatch with a malformed reply is indeterminate rather than a confirmed validation rejection", async () => {
        const id = (number: number) => `019a0000-0000-7000-8000-${number.toString().padStart(12, "0")}`
        const binding = { projectId: "project", tenantId: "tenant", engagementId: id(1), hostPrincipalId: "host", modelPrincipalId: "model" }
        const premise: RecoveryPremise = { binding, challengeId: "challenge", assetId: "asset", scopeId: id(2), scopeVersion: 1, scopeRevisionId: id(90), scopePolicyDigest: `sha256:${"a".repeat(64)}`, resourceId: id(3), resourceRevisionId: id(4), workItemId: id(5), workItemVersion: 1, targetVersion: 1 }
        const canonical = [
            { id: premise.scopeRevisionId, engagement_id: binding.engagementId, kind: "scope_revision", scope_ref: premise.scopeId, policy_digest: premise.scopePolicyDigest, approval_status: "approved", trust_level: "L2", policy: { valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z" } },
            { id: id(2), engagement_id: id(1), kind: "scope", version: 1, trust_level: "L2", current_revision_ref: premise.scopeRevisionId, policy_digest: premise.scopePolicyDigest, revision_state: "approved" },
            { id: id(3), engagement_id: id(1), kind: "resource", revision: 1, version: 1, trust_level: "L1" },
            { id: id(4), engagement_id: id(1), kind: "resource_revision", revision: 1, version: 1, trust_level: "L1", resource_ref: id(3) },
            { id: id(5), engagement_id: id(1), kind: "work_item", version: 1, trust_level: "L1", scope_ref: id(2), target_version: 1, resource_refs: [id(3)] },
        ]
        let claimCommitted = false
        const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal"> = {
            getBinding() { return { ...binding } },
            async invokeHost(operation, input) {
                if (operation === "work.claim") { claimCommitted = true; return null }
                if (operation === "resource.query") return { records: canonical.filter((entry) => entry.kind === input.kind), read_seq: 10 }
                throw new Error("unexpected authority operation")
            },
            async submitProposal() { throw new Error("unexpected proposal") },
        }
        const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
        let rejected: unknown
        try { await work.claim({ premise, agentId: "worker", taskSessionId: "task-session" }) } catch (error) { rejected = error }
        expect(claimCommitted).toBe(true)
        expect(rejected).toBeInstanceOf(TaricAuthorityClaimError)
        expect(rejected).toMatchObject({ claimOutcome: "indeterminate", code: "claim_indeterminate" })
    })

    test("invalid policy fails before any authority mutation", () => {
        expect(() => new TaricAuthorityWorkService({ host: {} as Pick<TaricHostModule, "getBinding" | "invokeHost" | "submitProposal">, policyDigest: "untrusted" })).toThrow("SHA-256")
    })

    test("empty target manifest and acceptance criteria cannot provision Work", async () => {
        const { work, calls } = service()
        const input = { challengeId: "challenge", assetId: "asset", workKey: "cell", scopeId: "019a0000-0000-7000-8000-000000000002", targetVersion: 1, resourceIds: [], title: "Inspect manifest", acceptanceCriteria: ["Evidence"] }
        await expect(work.proposeWorkItem(input)).rejects.toThrow("Resource references")
        await expect(work.proposeWorkItem({ ...input, resourceIds: ["019a0000-0000-7000-8000-000000000003"], acceptanceCriteria: [] })).rejects.toThrow("acceptance criteria")
        expect(calls).toEqual([])
    })

    test("sensitive acceptance text is rejected before a proposal", async () => {
        const { work, calls } = service()
        await expect(work.proposeWorkItem({ challengeId: "challenge", assetId: "asset", workKey: "cell", scopeId: "019a0000-0000-7000-8000-000000000002", targetVersion: 1, resourceIds: ["019a0000-0000-7000-8000-000000000003"], title: "Inspect manifest", acceptanceCriteria: ["password=fixture-secret"] })).rejects.toThrow("sensitive")
        expect(calls).toEqual([])
    })
})

const fixtureSource = process.env.TARIC_WORK_FIXTURE_SOURCE
test.skipIf(!fixtureSource)("real pinned SQLite authority admits, fences, checkpoints and recovers Work", async () => {
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "../../../../scripts/smoke-taric-work.ts"), `--source=${fixtureSource}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const report = JSON.parse(stdout) as { metrics: { passed: number; total: number }; authority: string; userConfigurationRead: boolean; targetTrafficGenerated: boolean }
    expect(report.authority).toBe("single_host_sqlite")
    expect(report.metrics.passed).toBe(report.metrics.total)
    expect(report.metrics.total).toBeGreaterThanOrEqual(12)
    expect(report.userConfigurationRead).toBe(false)
    expect(report.targetTrafficGenerated).toBe(false)
}, 30_000)
