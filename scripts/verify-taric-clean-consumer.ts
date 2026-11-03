import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, TARIC_PACKAGE_ARTIFACTS, TARIC_UPSTREAM_COMMIT, TARIC_UPSTREAM_COMPONENT_ARTIFACTS } from "../packages/core/src/taric/compatibility"
import { TARIC_OPERATION_REGISTRY_DIGEST, TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"

interface VerificationStep {
    name: string
    exitCode: number
    durationMs: number
}

interface PackedArtifact {
    packingMethod: "bun_pm_pack" | "npm_pack_under_node"
    packageName: string
    version: string
    filename: string
    actualIntegrity: string
    expectedIntegrity: string
    integrityMatches: boolean
    bytes: number
}

export interface TaricCleanConsumerReport {
    format: "breachweave-taric-clean-consumer/1"
    startedAt: string
    completedAt: string
    status: "passed" | "blocked"
    runtime: { bun: string; platform: string; architecture: string; npmPackCliVersion?: string; npmPackNodeVersion?: string; typescriptVersion?: string }
    source: { commit: string; tree: string; cleanBefore: boolean; cleanAfter: boolean; registrySourceDigest: string }
    expected: { commit: string; registrySourceDigest: string; registryDigest: string; operationCount: number; tuple: Record<string, string> }
    observed: Record<string, unknown>
    artifacts: PackedArtifact[]
    checks: VerificationStep[]
    blockers: string[]
    packagingDifferences: string[]
    limitations: string[]
}

function sha256(value: string | Uint8Array): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`
}

function within(parent: string, child: string): boolean {
    const path = relative(parent, child)
    return !path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

const EXPECTED_TUPLE = {
    apiContractVersion: TARIC_COMPATIBILITY_BASELINE.apiContractVersion,
    adapterContractVersion: TARIC_COMPATIBILITY_BASELINE.adapterContractVersion,
    schemaVersion: TARIC_COMPATIBILITY_BASELINE.schemaVersion,
    coreVersion: TARIC_COMPATIBILITY_BASELINE.coreVersion,
    storageContract: TARIC_COMPATIBILITY_BASELINE.storageContract,
    sqlContract: "authority-sql/4",
    policyVersion: TARIC_COMPATIBILITY_BASELINE.policyVersion,
    policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
}

const PACKAGES = [
    { workspace: "schemas", packageName: "@taric/schemas" },
    { workspace: "core", packageName: "@taric/core" },
    { workspace: "driver-bun-sqlite", packageName: "@taric/driver-bun-sqlite" },
    { workspace: "cli", packageName: "@taric/cli" },
    { workspace: "mcp", packageName: "@taric/mcp" },
] as const

/**
 * Reads the explicit upstream checkout, exports committed source, and performs all
 * builds, packs, installs and database writes inside an isolated temporary tree.
 * npm's pack CLI runs under Node to reproduce the npm-packed lock bytes. Different
 * Bun packing bytes are recorded separately and are never adopted as a new pin.
 */
export async function verifyTaricCleanConsumer(options: { source: string; output?: string }): Promise<TaricCleanConsumerReport> {
    const source = await realpath(resolve(options.source))
    const output = options.output === undefined ? undefined : resolve(options.output)
    if (output && within(source, output)) throw new Error("verification output must be outside the upstream source checkout")
    const report: TaricCleanConsumerReport = {
        format: "breachweave-taric-clean-consumer/1", startedAt: new Date().toISOString(), completedAt: "", status: "blocked",
        runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch },
        source: { commit: "", tree: "", cleanBefore: false, cleanAfter: false, registrySourceDigest: "" },
        expected: { commit: TARIC_UPSTREAM_COMMIT, registrySourceDigest: TARIC_OPERATION_REGISTRY_SOURCE_DIGEST, registryDigest: TARIC_OPERATION_REGISTRY_DIGEST, operationCount: 66, tuple: EXPECTED_TUPLE },
        observed: {}, artifacts: [], checks: [], blockers: [], packagingDifferences: [],
        limitations: [
            "Local clean-consumer evidence only; this does not certify BreachWeave host integration, authorization, target execution, or production acceptance.",
            "Packages are rebuilt from a clean committed source export. Bun pack is recorded separately; npm pack runs under Node to reproduce the locked SRIs, and only exact locked npm-packed SRI matches can satisfy artifact verification.",
            "The isolated consumer overrides Taric transitive package references to the same-version locally packed artifacts; it does not use source links or imply registry publication.",
            "SQLite close/reopen checks process lifecycle only and do not establish sudden power-loss durability, PostgreSQL, multi-host recovery, or registry publication.",
            "Dependency installation may access the package registry; the smoke uses local fixture data and makes no target requests.",
        ],
    }
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), "bw-taric-clean-consumer-")))

    async function command(name: string, args: string[], cwd: string): Promise<string> {
        const started = performance.now()
        const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        report.checks.push({ name, exitCode, durationMs: Math.round(performance.now() - started) })
        // Never place registry output or environment-derived credentials in reports.
        if (exitCode !== 0) {
            const diagnostic = stderr.replace(/https?:\/\/\S+/g, "<registry-url>").replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, "$1<redacted>").slice(-1600)
            console.error(`[taric-clean-consumer] ${name}: ${diagnostic}`)
            throw new Error(`${name} failed with exit code ${exitCode}`)
        }
        return stdout.trim()
    }

    try {
        report.source.commit = await command("source_revision", ["git", "rev-parse", "HEAD"], source)
        report.source.cleanBefore = (await command("source_clean_before", ["git", "status", "--porcelain=v1", "--untracked-files=all"], source)) === ""
        report.source.tree = await command("source_tree", ["git", "rev-parse", "HEAD^{tree}"], source)
        report.source.registrySourceDigest = sha256(new Uint8Array(await Bun.file(resolve(source, "packages/schemas/src/registry.ts")).arrayBuffer()))
        if (report.source.commit !== TARIC_UPSTREAM_COMMIT) throw new Error("upstream source commit differs from the locked baseline")
        if (!report.source.cleanBefore) throw new Error("upstream source checkout must be clean")
        if (report.source.registrySourceDigest !== TARIC_OPERATION_REGISTRY_SOURCE_DIGEST) throw new Error("upstream operation registry source digest differs from the locked baseline")

        const build = resolve(directory, "source")
        const packed = resolve(directory, "packed")
        const bunPacked = resolve(packed, "bun")
        const npmPacked = resolve(packed, "npm")
        const consumer = resolve(directory, "consumer")
        await Promise.all([mkdir(build), mkdir(packed), mkdir(consumer)])
        await Promise.all([mkdir(bunPacked), mkdir(npmPacked)])
        const nodePath = Bun.which("node")
        if (!nodePath) throw new Error("Node is unavailable for reproducing the locked npm-packed bytes")
        const npmPath = Bun.which("npm")
        if (!npmPath) throw new Error("npm pack CLI is unavailable for reproducing the locked npm-packed bytes")
        const npmNode = await realpath(nodePath)
        const npmCli = await realpath(npmPath)
        report.runtime.npmPackNodeVersion = await command("npm_pack_node_version", [npmNode, "--version"], directory)
        report.runtime.npmPackCliVersion = await command("npm_pack_cli_version_under_node", [npmNode, npmCli, "--version"], directory)
        const archive = resolve(directory, "source.tar")
        const archiveProcess = Bun.spawn(["git", "archive", "--format=tar", TARIC_UPSTREAM_COMMIT], { cwd: source, stdout: "pipe", stderr: "ignore" })
        const [archiveBytes, archiveExit] = await Promise.all([new Response(archiveProcess.stdout).arrayBuffer(), archiveProcess.exited])
        if (archiveExit !== 0) throw new Error("committed source export failed")
        await Bun.write(archive, new Uint8Array(archiveBytes))
        await command("extract_committed_source", ["tar", "-xf", archive, "-C", build], directory)
        await command("install_build_dependencies", [process.execPath, "install", "--ignore-scripts"], build)
        report.runtime.typescriptVersion = await command("compiler_version_under_bun", [process.execPath, resolve(build, "node_modules/typescript/bin/tsc"), "--version"], build)

        for (const item of PACKAGES) {
            const packageRoot = resolve(build, "packages", item.workspace)
            await rm(resolve(packageRoot, "dist"), { recursive: true, force: true })
            await command(`build_${item.workspace}`, [process.execPath, resolve(build, "node_modules/typescript/bin/tsc"), "-p", resolve(packageRoot, "tsconfig.json")], build)
            // Match the upstream build script exactly. tsc already emits an imported
            // JSON schema into dist/schemas; cp -R retains it and nests the raw source
            // schemas directory, unlike fs.cp which overwrites the emitted schema.
            if (item.workspace === "schemas") await command("copy_schema_assets", ["cp", "-R", "schemas", "dist/schemas"], packageRoot)
            const manifest = await Bun.file(resolve(packageRoot, "package.json")).json() as { name: string; version: string }
            const lock = { ...TARIC_PACKAGE_ARTIFACTS, ...TARIC_UPSTREAM_COMPONENT_ARTIFACTS }[item.packageName]
            if (manifest.name !== item.packageName || manifest.version !== lock.version) throw new Error("rebuilt package identity differs from the locked baseline")
            await command(`bun_pack_${item.workspace}`, [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", resolve(bunPacked, lock.filename), "--quiet"], packageRoot)
            await command(`npm_pack_under_node_${item.workspace}`, [npmNode, npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", npmPacked, packageRoot], build)
            for (const [packingMethod, destination] of [["bun_pm_pack", bunPacked], ["npm_pack_under_node", npmPacked]] as const) {
                const bytes = new Uint8Array(await Bun.file(resolve(destination, lock.filename)).arrayBuffer())
                const actualIntegrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
                report.artifacts.push({ packingMethod, packageName: manifest.name, version: manifest.version, filename: lock.filename, actualIntegrity, expectedIntegrity: lock.integrity, integrityMatches: actualIntegrity === lock.integrity, bytes: bytes.byteLength })
                if (actualIntegrity !== lock.integrity) {
                    const diagnostic = `${manifest.name}: ${packingMethod} SRI differs from the locked SRI`
                    if (packingMethod === "npm_pack_under_node") report.blockers.push(diagnostic)
                    else report.packagingDifferences.push(diagnostic)
                }
            }
        }

        const dependencies = Object.fromEntries(report.artifacts.filter((item) => item.packingMethod === "npm_pack_under_node").map((item) => [item.packageName, `file:${resolve(npmPacked, item.filename)}`]))
        await Bun.write(resolve(consumer, "package.json"), `${JSON.stringify({ name: "breachweave-taric-isolated-consumer", private: true, type: "module", dependencies, overrides: dependencies }, null, 2)}\n`)
        await command("install_packed_consumer", [process.execPath, "install", "--ignore-scripts", "--linker", "hoisted"], consumer)
        for (const item of PACKAGES) {
            const installed = resolve(consumer, "node_modules", ...item.packageName.split("/"))
            if ((await lstat(installed)).isSymbolicLink() || !within(consumer, await realpath(installed))) throw new Error("clean consumer package resolves through a workspace or external link")
        }

        const smoke = String.raw`
import { AuthorityStore, createCoreService, createPrincipal, AUTHORITY_STORAGE_CONTRACT_VERSION, AUTHORITY_SQL_SCHEMA_VERSION, ADMISSION_POLICY_VERSION, policyDigest } from "@taric/core";
import { API_CONTRACT_VERSION, ADAPTER_CONTRACT_VERSION, SCHEMA_VERSION, operationContracts } from "@taric/schemas";
import { BunSqliteAuthorityDriver } from "@taric/driver-bun-sqlite";
import { MCP_PACKAGE } from "@taric/mcp";
import * as cli from "@taric/cli";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const filename = new URL("./authority.sqlite", import.meta.url).pathname;
const content = new URL("./content", import.meta.url).pathname;
const firstDriver = new BunSqliteAuthorityDriver(filename);
const firstStore = new AuthorityStore(firstDriver);
const first = await createCoreService(firstStore, content);
const initialized = await first.init({ name:"isolated local fixture", scope:{ allowed_targets:["https://consumer.fixture.invalid"], excluded_targets:[], rules_of_engagement_ref:"fixture:clean-consumer" } });
assert(initialized.ok === true, "fixture initialization failed");
const engagementId = initialized.data.id;
const originalEngagement = await firstStore.get(engagementId);
assert(originalEngagement && originalEngagement.kind === "engagement", "initialized Engagement record is missing");
const originalScope = await firstStore.get(originalEngagement.scope_ref);
assert(originalScope && originalScope.kind === "scope", "initialized Scope record is missing");
async function verifyPersistedRecords(store) {
  const engagement = await store.get(engagementId);
  const scope = await store.get(originalScope.id);
  assert(engagement && engagement.id === originalEngagement.id && engagement.version === originalEngagement.version && engagement.scope_ref === originalScope.id && JSON.stringify(engagement) === JSON.stringify(originalEngagement), "persisted Engagement differs after reopen");
  assert(scope && scope.id === originalScope.id && scope.version === originalScope.version && JSON.stringify(scope) === JSON.stringify(originalScope), "persisted Scope differs after reopen");
}
await first.close();
await firstStore.close();
const reopenedDriver = new BunSqliteAuthorityDriver(filename);
const reopenedStore = new AuthorityStore(reopenedDriver);
const reopened = await createCoreService(reopenedStore, content);
const status = await reopened.dispatch("engagement.status", createPrincipal("operator", "clean-consumer", engagementId), { engagement_id:engagementId });
assert(status.ok === true && status.data.schema_supported === true, "canonical read after close/reopen failed");
await verifyPersistedRecords(reopenedStore);
assert((await reopenedDriver.get("SELECT 1 AS value")).value === 1, "Bun SQLite query failed");
await reopened.close();
await reopenedStore.close();
const emptyStore = new AuthorityStore(new BunSqliteAuthorityDriver(new URL("./empty-replacement.sqlite", import.meta.url).pathname));
let emptyReplacementRejected = false;
try { await verifyPersistedRecords(emptyStore); } catch { emptyReplacementRejected = true; }
await emptyStore.close();
assert(emptyReplacementRejected, "an empty replacement database must fail canonical persistence verification");
assert(MCP_PACKAGE === "@taric/mcp" && typeof cli === "object", "package imports failed");
const packageJson = await Bun.file(new URL("./node_modules/@taric/core/package.json", import.meta.url)).json();
console.log(JSON.stringify({ packageImports:true, bunSqliteQuery:true, canonicalCloseReopenRead:true, emptyReplacementRejected, persistedRecords:[{kind:"engagement",id:originalEngagement.id,version:originalEngagement.version},{kind:"scope",id:originalScope.id,version:originalScope.version}], workspaceLinked:false, operationCount:operationContracts.length, registryDigest:"sha256:" + new Bun.CryptoHasher("sha256").update(JSON.stringify(operationContracts)).digest("hex"), tuple:{ apiContractVersion:API_CONTRACT_VERSION, adapterContractVersion:ADAPTER_CONTRACT_VERSION, schemaVersion:SCHEMA_VERSION, coreVersion:packageJson.version, storageContract:AUTHORITY_STORAGE_CONTRACT_VERSION, sqlContract:AUTHORITY_SQL_SCHEMA_VERSION, policyVersion:ADMISSION_POLICY_VERSION, policyDigest:policyDigest() } }));
`
        await Bun.write(resolve(consumer, "smoke.mjs"), smoke)
        report.observed = JSON.parse(await command("consumer_imports_and_sqlite_close_reopen", [process.execPath, resolve(consumer, "smoke.mjs")], consumer)) as Record<string, unknown>
        const cliVersion = await command("packed_cli_version", [process.execPath, resolve(consumer, "node_modules/@taric/cli/dist/bin.js"), "--version"], consumer)
        report.observed.cliApiVersion = cliVersion
        const observedTuple = report.observed.tuple as Record<string, unknown>
        if (Object.entries(EXPECTED_TUPLE).some(([key, value]) => observedTuple?.[key] !== value)) report.blockers.push("rebuilt clean-consumer contract tuple differs from the locked baseline")
        if (report.observed.operationCount !== 66 || report.observed.registryDigest !== TARIC_OPERATION_REGISTRY_DIGEST) report.blockers.push("rebuilt clean-consumer operation registry differs from the locked baseline")
        if (cliVersion !== EXPECTED_TUPLE.apiContractVersion) report.blockers.push("packed CLI API version differs from the locked baseline")
    } catch (error) {
        report.blockers.push(error instanceof Error ? error.message : "clean-consumer verification failed")
    } finally {
        try {
            const commit = await command("source_revision_after", ["git", "rev-parse", "HEAD"], source)
            report.source.cleanAfter = (await command("source_clean_after", ["git", "status", "--porcelain=v1", "--untracked-files=all"], source)) === "" && commit === report.source.commit
            if (!report.source.cleanAfter) report.blockers.push("upstream source changed during verification")
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
        report.completedAt = new Date().toISOString()
        report.status = report.blockers.length === 0 && report.artifacts.length === PACKAGES.length * 2 && report.artifacts.filter((item) => item.packingMethod === "npm_pack_under_node" && item.integrityMatches).length === PACKAGES.length && report.observed.canonicalCloseReopenRead === true ? "passed" : "blocked"
        if (output) {
            await mkdir(dirname(output), { recursive: true })
            await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
        }
    }
    return report
}

if (import.meta.main) {
    const args = process.argv.slice(2)
    const source = args.find((value) => value.startsWith("--source="))?.slice("--source=".length)
    const output = args.find((value) => value.startsWith("--output="))?.slice("--output=".length)
    if (!source || args.some((value) => !value.startsWith("--source=") && !value.startsWith("--output="))) throw new Error("Usage: bun run scripts/verify-taric-clean-consumer.ts --source=/path/to/Taric [--output=/path/to/report.json]")
    const report = await verifyTaricCleanConsumer({ source, output })
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== "passed") process.exitCode = 1
}
