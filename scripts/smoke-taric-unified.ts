import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const source = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length)
if (!source) throw new Error("Pass --source=/absolute/path/to/pinned/Taric")

const output = resolve(projectRoot, process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/artifacts/taric-104-unified-smoke.json")
const artifactRoot = resolve(projectRoot, "docs/artifacts")
await mkdir(artifactRoot, { recursive: true })

interface CommandResult {
    id: string
    command: string
    exitCode: number
    durationMs: number
    report?: string
}

const results: CommandResult[] = []

async function run(id: string, args: string[], env: Record<string, string> = {}, report?: string, cwd = projectRoot): Promise<CommandResult> {
    const started = performance.now()
    const child = Bun.spawn(args, {
        cwd,
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
    })
    const [, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const result: CommandResult = { id, command: args.join(" "), exitCode, durationMs: Math.round(performance.now() - started), ...(report ? { report } : {}) }
    results.push(result)
    console.log(`[taric-unified] ${id}: ${exitCode === 0 ? "passed" : "failed"} (${result.durationMs}ms)`)
    return result
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
        const value = await Bun.file(path).json()
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    } catch {
        return undefined
    }
}

function metric(value: Record<string, unknown> | undefined): { passed: number; total: number; complete: boolean } {
    const metrics = value?.metrics
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return { passed: 0, total: 0, complete: false }
    const row = metrics as Record<string, unknown>
    const passed = typeof row.passed === "number" ? row.passed : 0
    const total = typeof row.total === "number" ? row.total : 0
    return { passed, total, complete: total > 0 && passed === total }
}

function scenarioMetric(items: unknown): { passed: number; total: number; complete: boolean } {
    if (!Array.isArray(items)) return { passed: 0, total: 0, complete: false }
    const passed = items.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).passed === true).length
    const total = items.length
    return { passed, total, complete: total > 0 && passed === total }
}

const reports = {
    diagnostics: resolve(artifactRoot, "taric-104-unified-orbstack-diagnostics.json"),
    canonical: resolve(artifactRoot, "taric-104-unified-canonical-control-plane.json"),
    work: resolve(artifactRoot, "taric-104-unified-work.json"),
    actions: resolve(artifactRoot, "taric-104-unified-actions.json"),
    artifacts: resolve(artifactRoot, "taric-104-unified-artifacts.json"),
    artifactGovernance: resolve(artifactRoot, "taric-104-unified-artifact-governance.json"),
    postgres: resolve(artifactRoot, "taric-104-unified-postgres-runtime.json"),
    multiHost: resolve(artifactRoot, "taric-104-unified-multi-host-postgres.json"),
    authorizedProduct: resolve(artifactRoot, "taric-104-unified-authorized-product.json"),
    authorizedEgress: resolve(artifactRoot, "taric-104-unified-authorized-egress.json"),
}

await run("typecheck", ["bun", "run", "typecheck"])
await run("ui_typecheck", ["bun", "./node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/ui-web"])
await run("core_source_tests", ["bun", "test", "packages/core/src"])
await run("web_session_recovery_tests", ["bun", "test", "packages/ui-web/src/taric-governance-api.test.ts"])
await run("orbstack_diagnostics", ["bun", "run", "scripts/diagnose-taric-orbstack.ts", `--source=${source}`, `--output=${reports.diagnostics}`], {}, reports.diagnostics)
await run("canonical_control_plane", ["bun", "run", "scripts/smoke-taric-control-plane.ts", `--source=${source}`, `--output=${reports.canonical}`], {}, reports.canonical)
await run("work_restart_lease_recovery", ["bun", "run", "scripts/smoke-taric-work.ts", `--source=${source}`, `--output=${reports.work}`], {}, reports.work)
await run("action_restart_unknown_fencing", ["bun", "run", "scripts/smoke-taric-actions.ts", `--source=${source}`, `--output=${reports.actions}`], {}, reports.actions)
await run("artifact_process_crash_recovery", ["bun", "run", "scripts/smoke-taric-artifacts.ts", `--source=${source}`, `--output=${reports.artifacts}`], {}, reports.artifacts)
await run("artifact_governance_restart", ["bun", "run", "scripts/smoke-taric-artifact-governance.ts", `--source=${source}`, `--output=${reports.artifactGovernance}`], {}, reports.artifactGovernance)

const postgresUrl = process.env.TARIC_TEST_DATABASE_URL ?? "postgresql://taric:taric-local-only@127.0.0.1:55432/taric"
const postgresContainer = process.env.TARIC_TEST_POSTGRES_CONTAINER ?? "taric-authority-postgres-1"
await run("postgres_runtime_backup_restore", ["node", "scripts/verify-postgres-runtime.mjs", "--output", reports.postgres], {
    TARIC_TEST_DATABASE_URL: postgresUrl,
    TARIC_TEST_POSTGRES_CONTAINER: postgresContainer,
}, reports.postgres, resolve(source))
await run("multi_process_postgres_lease_recovery", ["node", "scripts/verify-multi-host-postgres-live.mjs", "--output", reports.multiHost], {
    TARIC_TEST_DATABASE_URL: postgresUrl,
    TARIC_TEST_POSTGRES_CONTAINER: postgresContainer,
    TARIC_RUNTIME_CONFORMANCE: process.env.TARIC_RUNTIME_CONFORMANCE ?? reports.postgres,
}, reports.multiHost, resolve(source))
await run("authorized_product_projection_recovery", ["bun", "run", "scripts/smoke-authorized-product.ts", `--source=${source}`, `--output=${reports.authorizedProduct}`], {}, reports.authorizedProduct)
await run("authorized_solver_host_mediated_egress", ["bun", "run", "scripts/smoke-authorized-solver-egress.ts", `--output=${reports.authorizedEgress}`], {}, reports.authorizedEgress)

const reportData = Object.fromEntries(await Promise.all(Object.entries(reports).map(async ([name, path]) => [name, await readJson(path)]))) as Record<string, Record<string, unknown> | undefined>
const reportMetrics = Object.fromEntries(Object.entries(reportData).map(([name, value]) => {
    if (name === "diagnostics") return [name, { passed: value?.status === "responsive" ? 1 : 0, total: 1, complete: value?.status === "responsive" }]
    if (name === "postgres") return [name, scenarioMetric((value?.runtime_conformance as Record<string, unknown> | undefined)?.scenarios)]
    if (name === "multiHost") return [name, scenarioMetric(value?.checks)]
    return [name, metric(value)]
}))
const multiHostChecks = Array.isArray(reportData.multiHost?.checks) ? reportData.multiHost!.checks : []
const multiHostPassed = multiHostChecks.length === 4 && multiHostChecks.every((check) => check && typeof check === "object" && (check as Record<string, unknown>).passed === true)
const postgresPassed = reportData.postgres?.runtime_conformance && typeof reportData.postgres.runtime_conformance === "object" && (reportData.postgres.runtime_conformance as Record<string, unknown>).passed === true && reportData.postgres.readiness && typeof reportData.postgres.readiness === "object" && (reportData.postgres.readiness as Record<string, unknown>).runtime_state === "enabled"
const diagnosticsPassed = reportData.diagnostics?.status === "responsive"
const authorizedEgressPassed = reportData.authorizedEgress?.status === "passed" && Array.isArray(reportData.authorizedEgress.checks) && (reportData.authorizedEgress.checks as Array<Record<string, unknown>>).length === 4 && (reportData.authorizedEgress.checks as Array<Record<string, unknown>>).every((check) => check.blocked === true) && reportData.authorizedEgress.fixtureRequests === 0 && (reportData.authorizedEgress.modelTransport as Record<string, unknown> | undefined)?.passed === true
const commandPassed = results.every((result) => result.exitCode === 0)
const serviceReportsPassed = ["canonical", "work", "actions", "artifacts", "artifactGovernance", "authorizedProduct"].every((name) => reportMetrics[name]?.complete === true)
const lifecycleTestsPassed = results.filter((result) => result.id === "core_source_tests" || result.id === "web_session_recovery_tests").every((result) => result.exitCode === 0)
const report = {
    format: "breachweave-taric-unified-smoke/1",
    generatedAt: new Date().toISOString(),
    source: { path: resolve(source), commit: String((await Bun.$`git -C ${source} rev-parse HEAD`.text()).trim()) },
    environment: { dockerContext: "orbstack", postgresContainer, postgresUrl: postgresUrl.replace(/:\/\/[^@]+@/, "://<redacted>@") },
    status: commandPassed && diagnosticsPassed && serviceReportsPassed && postgresPassed === true && multiHostPassed && lifecycleTestsPassed && authorizedEgressPassed ? "passed" : "failed",
    acceptanceProfile: "local_development",
    evidenceClass: "unified_local_orbstack_smoke",
    productionEvidence: false,
    checks: results,
    metrics: { passed: results.filter((result) => result.exitCode === 0).length, total: results.length },
    reportMetrics,
    postgres: { runtimeConformance: postgresPassed === true ? "passed" : "failed", multiProcessLeaseRecovery: multiHostPassed ? "passed" : "failed" },
    lifecycle: { managerStartupRecovery: lifecycleTestsPassed ? "passed" : "failed", projectionRehydration: lifecycleTestsPassed ? "passed" : "failed", localSessionFallback: "blocked" },
    limitations: [
        "OrbStack multi-process verification uses two independent containers on one workstation and one PostgreSQL authority; physical host failure and network partitions are not covered.",
        "Taric runtime and fixture reports use the pinned local checkout and do not establish registry, production, power-loss, or real-gateway evidence.",
        "Authorized Solver egress is verified only for the local Docker network-none profile and supported HTTP model transports; unsupported provider transports remain blocked.",
    ],
}
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(`[taric-unified] ${report.status}; report=${output}`)
if (report.status !== "passed") process.exitCode = 1
