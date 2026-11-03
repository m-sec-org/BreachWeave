import { resolve } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { inspectTaricControlPlaneContract } from "../packages/core/src/taric/control-plane-contract"
import { TARIC_OPERATION_REGISTRY, TARIC_OPERATION_REGISTRY_DIGEST, TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"

type Row = Record<string, unknown>
const projectRoot = resolve(import.meta.dir, "..")
const taricSource = resolve(process.argv.find((arg) => arg.startsWith("--taric-source="))?.slice("--taric-source=".length) ?? resolve(projectRoot, "../Taric"))
const output = resolve(projectRoot, process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/artifacts/taric-103-contract-audit.json")
const checks: Array<{ id: string; status: "passed" | "failed"; sources: string[]; diagnostic?: string }> = []
function digest(bytes: string | Uint8Array): string { return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` }
function check(id: string, condition: boolean, sources: string[]): void { checks.push({ id, status: condition ? "passed" : "failed", sources }) }
async function command(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(args, { cwd: taricSource, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}
const revision = await command(["git", "rev-parse", "HEAD"])
const commit = revision.stdout
check("source_matches_pinned_commit", revision.exitCode === 0 && commit === TARIC_UPSTREAM_COMMIT, ["git:HEAD"])
const sourceFiles = ["packages/core/src/store.ts", "packages/core/src/service.ts", "packages/core/src/validation.ts", "packages/core/src/coverage.ts", "packages/schemas/src/registry.ts", "packages/schemas/schemas/v1/core.schema.json", "packages/core/dist/index.js", "packages/core/dist/store.js", "packages/core/dist/service.js", "packages/core/dist/coverage.js", "packages/driver-bun-sqlite/dist/index.js", "packages/driver-bun-sqlite/dist/bun-sqlite.js", "packages/schemas/dist/src/registry.js", "packages/schemas/dist/schemas/v1/core.schema.json"]
const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, digest(new Uint8Array(await Bun.file(resolve(taricSource, file)).arrayBuffer()))])))
check("registry_source_digest_matches_pin", sourceDigests["packages/schemas/src/registry.ts"] === TARIC_OPERATION_REGISTRY_SOURCE_DIGEST, ["packages/schemas/src/registry.ts"])
const hostSourceFiles = ["packages/core/src/taric/control-plane-contract.ts", "packages/core/src/taric/host-module.ts", "packages/core/src/taric/operation-registry.ts", "scripts/audit-taric-103-contract.ts"]
const hostSourceDigests = Object.fromEntries(await Promise.all(hostSourceFiles.map(async (file) => [file, digest(new Uint8Array(await Bun.file(resolve(projectRoot, file)).arrayBuffer()))])))
const schema = await Bun.file(resolve(taricSource, "packages/schemas/schemas/v1/core.schema.json")).json() as { $defs: Record<string, unknown> }
const runtime = await import(resolve(taricSource, "packages/schemas/dist/src/index.js")) as { operationContracts: unknown[]; API_CONTRACT_VERSION: string }
const core = await import(resolve(taricSource, "packages/core/dist/index.js")) as Row
check("runtime_registry_matches_locked_operations", digest(JSON.stringify(runtime.operationContracts)) === TARIC_OPERATION_REGISTRY_DIGEST && runtime.operationContracts.length === TARIC_OPERATION_REGISTRY.length, ["packages/schemas/dist/src/registry.js"])
check("runtime_contract_tuple_matches_pin", runtime.API_CONTRACT_VERSION === TARIC_COMPATIBILITY_BASELINE.apiContractVersion && core.AUTHORITY_STORAGE_CONTRACT_VERSION === TARIC_COMPATIBILITY_BASELINE.storageContract, ["packages/core/dist/index.js", "packages/schemas/dist/src/index.js"])
for (const [fact, definition, operations] of [
    ["scope_roe_revision", "scopeRevision", ["scope.revise", "scope.invalidate", "scope.query"]],
    ["complete_coverage_domain", "coverageSnapshotRequest", ["coverage.manifest.commit", "coverage.snapshot", "coverage.gate"]],
    ["action_audit_query", "actionAuditQueryRequest", ["action.audit.query"]],
    ["report_snapshot", "reportSnapshot", ["report.snapshot.commit"]],
    ["close_decision", "closeDecision", ["engagement.close", "engagement.reopen"]],
] as const) check(`${fact}_public_contract_exists`, definition in schema.$defs && operations.every((operation) => TARIC_OPERATION_REGISTRY.some((entry) => entry.operation === operation)), ["packages/schemas/schemas/v1/core.schema.json", "packages/schemas/src/registry.ts"])
const suites = ["scope-revision", "coverage-snapshot", "coverage-record-dispatch", "action-audit", "report-close"]
const suiteEvidence: Array<{ suite: string; exitCode: number; outputDigest: string; fixtureDigest: string; adaptedFixtureDigest: string; passedTests: number; failedTests: number; diagnostic?: string }> = []
if (checks.every((item) => item.status === "passed")) {
    const fixtures = await mkdtemp(resolve(tmpdir(), "bw-taric-contract-probes-"))
    try {
        for (const suite of suites) {
            const file = `packages/core/test/${suite}.test.mjs`
            // Upstream defaults to node:sqlite. Select the declared Bun driver while
            // keeping all behavioral assertions intact and leave the checkout untouched.
            const original = await Bun.file(resolve(taricSource, file)).text()
            const adapted = `import { BunSqliteAuthorityDriver } from ${JSON.stringify(resolve(taricSource, "packages/driver-bun-sqlite/dist/index.js"))};\n` + original
                .replaceAll('"../dist/index.js"', JSON.stringify(resolve(taricSource, "packages/core/dist/index.js")))
                .replaceAll('"./scope-fixture.mjs"', JSON.stringify(resolve(taricSource, "packages/core/test/scope-fixture.mjs")))
                .replaceAll("new AuthorityStore()", "new AuthorityStore(new BunSqliteAuthorityDriver())")
                .replaceAll("new AuthorityStore(filename)", "new AuthorityStore(new BunSqliteAuthorityDriver(filename))")
            const fixture = resolve(fixtures, `${suite}.test.mjs`)
            await Bun.write(fixture, adapted)
            const result = await command([process.execPath, "test", fixture])
            suiteEvidence.push({ suite, exitCode: result.exitCode, fixtureDigest: digest(original), adaptedFixtureDigest: digest(adapted), passedTests: Number(result.stderr.match(/(?:^|\n)\s*(\d+) pass\b/)?.[1] ?? 0), failedTests: Number(result.stderr.match(/(?:^|\n)\s*(\d+) fail\b/)?.[1] ?? 0), outputDigest: digest(`${result.stdout}\n${result.stderr}`), ...(result.exitCode ? { diagnostic: result.stderr.slice(-2000) } : {}) })
            check(`${suite}_behavioral_contract_probes`, result.exitCode === 0, [file])
        }
    } finally { await rm(fixtures, { recursive: true, force: true }) }
}
const diagnostic = inspectTaricControlPlaneContract()
check("host_canonical_mapping_complete", diagnostic.status === "available" && diagnostic.missingFacts.length === 0, ["BreachWeave:packages/core/src/taric/control-plane-contract.ts"])
const report = {
    format: "breachweave-taric-contract-audit/2", completedAt: new Date().toISOString(),
    status: checks.every((item) => item.status === "passed") && suiteEvidence.length === suites.length ? "passed" : "failed",
    source: { commit, digests: sourceDigests }, host: { digests: hostSourceDigests },
    evidenceClass: "upstream_source_and_local_sqlite_probe", checks, suites: suiteEvidence,
    metrics: { passed: checks.filter((item) => item.status === "passed").length, total: checks.length },
    conclusions: { canonicalMappingsStillUnresolved: diagnostic.missingFacts, completeCoverageDomainSnapshot: "canonical_manifest_fixed_snapshot", actionAudit: "append_only_fixed_watermark", closeDecision: "canonical_atomic_cas", hostAcceptance: "requires_separate_current_source_verification" },
    limitations: ["These source/build checks and upstream behavioral suites establish contract availability; host local acceptance is reported separately.", "Upstream suite copies run under Bun with only AuthorityStore default constructors replaced by the public Bun SQLite driver; their assertions are unchanged and original fixture/source digests identify the input.", "No production, remote gateway, power-loss or cross-physical-host conformance is claimed.", "SQLite behavioral probes exercise the selected local dist build; isolated clean-consumer evidence verifies rebuilt artifact provenance separately."],
}
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ status: report.status, output, metrics: report.metrics }))
if (report.status !== "passed") process.exitCode = 1
