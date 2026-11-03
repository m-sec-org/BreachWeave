import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { AuthorityReportServiceOptions } from "./authority-report-service"
import { TaricAuthorityReportService } from "./authority-report-service"

const engagementId = "019a0000-0000-7000-8000-000000000001"
const reportId = "019a0000-0000-7000-8000-000000000002"
const manifestId = "019a0000-0000-7000-8000-000000000003"
const scopeRevisionId = "019a0000-0000-7000-8000-000000000004"
const resourceRevisionId = "019a0000-0000-7000-8000-000000000005"
const digest = `sha256:${"a".repeat(64)}`
const binding = { projectId: "report-project", tenantId: "report-tenant", engagementId, hostPrincipalId: "report-host", modelPrincipalId: "report-model" }
const reportInput = { expectedAuthoritySeq: 12, manifestId, manifestDigest: digest, scopeRevisionId, policyDigest: digest, resourceRevisionIds: [resourceRevisionId], artifactSessionId: "report-session", artifactRef: `${reportId}@v1`, idempotencyKey: "report-commit" }

function fixture(overrides: Partial<AuthorityReportServiceOptions> = {}) {
    const calls: Array<{ role: string; operation: string; input: Record<string, unknown> }> = []
    const options: AuthorityReportServiceOptions = {
        host: {
            getBinding: () => binding,
            async invokeHost(operation, input) { calls.push({ role: "host", operation, input }); throw new Error("No authority response installed") },
            async invokeOperator(operation, input) { calls.push({ role: "operator", operation, input }); throw new Error("No operator authority configured") },
        },
        coverage: { async snapshot() { throw new Error("No Coverage response installed") } },
        ...overrides,
    }
    return { service: new TaricAuthorityReportService(options), calls, options }
}

describe("canonical ReportSnapshot and CloseDecision boundary", () => {
    test("invalid digests and revision identities cannot reach an authority mutation", async () => {
        const { service, calls } = fixture()
        await expect(service.commitSnapshot({ ...reportInput, manifestDigest: "host-local-summary" })).rejects.toMatchObject({ code: "validation_error" })
        await expect(service.commitSnapshot({ ...reportInput, resourceRevisionIds: [resourceRevisionId, resourceRevisionId] })).rejects.toMatchObject({ code: "validation_error" })
        expect(calls).toEqual([])
    })

    test("missing canonical Coverage cannot fall back to a report file or cached gate", async () => {
        const { service, calls } = fixture()
        await expect(service.commitSnapshot(reportInput)).rejects.toThrow("No Coverage response installed")
        expect(calls).toEqual([])
    })

    test("close requires explicit compare-and-set premises and routes only through operator authority", async () => {
        const { service, calls } = fixture()
        const input = { reportSnapshotId: reportId, expectedEngagementVersion: 2, expectedAuthoritySeq: 13, reason: "Operator fixture approval", idempotencyKey: "fixture-close" }
        await expect(service.close({ ...input, expectedAuthoritySeq: -1 })).rejects.toMatchObject({ code: "validation_error" })
        expect(calls).toEqual([])
        await expect(service.close(input)).rejects.toThrow("No operator authority configured")
        expect(calls).toEqual([{ role: "operator", operation: "engagement.close", input: { expected_engagement_version: 2, expected_authority_seq: 13, report_snapshot_ref: reportId, reason: input.reason, idempotency_key: input.idempotencyKey } }])
    })

    test("reconstruction fails if canonical queries fail rather than retaining local closed state", async () => {
        const { service, calls } = fixture()
        await expect(service.reconstruct()).rejects.toThrow("No authority response installed")
        expect(calls).toEqual([{ role: "host", operation: "resource.query", input: { kind: "engagement", include_candidates: true, page_size: 50 } }])
    })
})

const fixtureSource = process.env.TARIC_CONTROL_PLANE_FIXTURE_SOURCE
test.skipIf(!fixtureSource)("real SQLite report, operator close, process reconstruction and reopen", async () => {
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "../../../../scripts/smoke-taric-control-plane.ts"), `--source=${fixtureSource}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const report = JSON.parse(stdout) as { metrics: { passed: number; total: number }; productionEvidence: boolean }
    expect(report.metrics.total).toBeGreaterThanOrEqual(10)
    expect(report.metrics.passed).toBe(report.metrics.total)
    expect(report.productionEvidence).toBe(false)
}, 30_000)
