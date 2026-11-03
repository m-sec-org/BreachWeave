import { $ } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { TARIC_COMPATIBILITY_BASELINE, TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { TARIC_OPERATION_REGISTRY_DIGEST, TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface FixtureAuthority {
    dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}

interface FixtureCoreModule {
    AuthorityStore: new (driver: unknown) => unknown
    API_CONTRACT_VERSION: string
    AUTHORITY_STORAGE_CONTRACT_VERSION: string
    createCoreService(store: unknown, contentRoot: string): Promise<FixtureAuthority>
    createPrincipal(role: "host" | "operator", id: string, engagementId?: string, grants?: readonly string[]): unknown
}

interface FixtureDriverModule {
    BunSqliteAuthorityDriver: new (path: string) => unknown
}

interface FixtureRegistryModule {
    operationContracts: unknown
}

function requiredRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fixture authority returned an invalid envelope")
    return value as Record<string, unknown>
}

function must(value: unknown): Record<string, unknown> {
    const response = requiredRecord(value)
    if (response.ok !== true) {
        const error = requiredRecord(response.error)
        // Bound diagnostics to codes: no authority response body enters this report.
        throw new TaricOperationError(String(error.code), "Fixture authority operation was rejected")
    }
    return requiredRecord(response.data)
}

function digest(value: string): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`
}

function argument(name: string): string | undefined {
    return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

async function runtimeDirectoryEvidence(source: string, directory: string, entry: string): Promise<{ directory: string; entry: string; entryDigest: string; directoryDigest: string; fileCount: number; byteLength: number }> {
    const root = join(source, directory)
    const paths: string[] = []
    for await (const path of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true })) paths.push(path)
    paths.sort()
    const files = await Promise.all(paths.map(async (path) => {
        const bytes = new Uint8Array(await Bun.file(join(root, path)).arrayBuffer())
        return { path, byteLength: bytes.byteLength, digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}` }
    }))
    const entryFile = files.find((file) => file.path === entry)
    if (!entryFile) throw new Error("Fixture runtime entry is absent from the directory digest")
    return { directory, entry, entryDigest: entryFile.digest, directoryDigest: digest(JSON.stringify(files)), fileCount: files.length, byteLength: files.reduce((total, file) => total + file.byteLength, 0) }
}

async function processCrashEvidence(source: string): Promise<{ assertions: Array<{ id: string; passed: boolean }>; restartMethod: string }> {
    const root = await mkdtemp(join(tmpdir(), "bw-taric-artifact-process-crash-"))
    const metadataPath = join(root, "artifact-locator.json")
    const workerPath = join(import.meta.dir, "taric-artifact-crash-worker.ts")
    const assertions: Array<{ id: string; passed: boolean }> = []
    let writer: ReturnType<typeof Bun.spawn> | undefined
    try {
        writer = Bun.spawn(["bun", workerPath, `--source=${source}`, `--root=${root}`, "--phase=write"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
        const stderrPromise = new Response(writer.stderr).text()
        const reader = writer.stdout.getReader()
        let stdout = ""
        const readReadyLine = async () => {
            while (!stdout.includes("\n")) {
                const { done, value } = await reader.read()
                if (done || !value) {
                    await writer?.exited
                    const stderr = (await stderrPromise).slice(0, 2048)
                    throw new Error(`Artifact writer exited before commit (exit ${writer?.exitCode ?? "signal"}): ${stderr}`)
                }
                stdout += new TextDecoder().decode(value)
                if (stdout.length > 16 * 1024) throw new Error("Artifact writer diagnostic exceeded its bound")
            }
            return stdout.slice(0, stdout.indexOf("\n"))
        }
        let timeout: ReturnType<typeof setTimeout> | undefined
        const readyLine = await Promise.race([
            readReadyLine(),
            new Promise<string>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Artifact writer timed out before commit")), 30_000) }),
        ]).finally(() => { if (timeout) clearTimeout(timeout) })
        const ready = requiredRecord(JSON.parse(readyLine))
        if (ready.ready !== true || typeof ready.engagementId !== "string" || typeof ready.contentRef !== "string" || typeof ready.contentHash !== "string" || typeof ready.byteLength !== "number") throw new Error("Artifact writer returned invalid fixture metadata")
        await Bun.write(metadataPath, `${JSON.stringify({ engagementId: ready.engagementId, contentRef: ready.contentRef, contentHash: ready.contentHash, byteLength: ready.byteLength })}\n`)
        assertions.push({ id: "crash_locator_contains_metadata_only", passed: !(await Bun.file(metadataPath).text()).includes("synthetic-process-crash-credential") })
        writer.kill("SIGKILL")
        await writer.exited
        assertions.push({ id: "authority_process_killed_with_sigkill", passed: writer.signalCode === "SIGKILL" })

        const recovery = Bun.spawn(["bun", workerPath, `--source=${source}`, `--root=${root}`, `--phase=read`, `--metadata=${metadataPath}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
        const [recoveryOutput, exitCode] = await Promise.all([new Response(recovery.stdout).text(), recovery.exited])
        const recovered = exitCode === 0 && recoveryOutput.length <= 16 * 1024 && recoveryOutput.includes('"recovered":true')
        assertions.push({ id: "content_recovered_after_sigkill_restart", passed: recovered })
        if (!recovered || assertions.some((assertion) => !assertion.passed)) throw new Error("Artifact content did not recover after authority process kill and restart")
        return { assertions, restartMethod: "authority child process SIGKILL followed by a fresh Bun process" }
    } finally {
        if (writer && writer.exitCode === null && writer.signalCode === null) {
            writer.kill("SIGKILL")
            await writer.exited
        }
        await rm(root, { recursive: true, force: true })
    }
}

async function main(): Promise<void> {
    const sourceArgument = argument("source")
    if (!sourceArgument) throw new Error("Pass --source=/absolute/path/to/pinned/Taric; no user gateway or configuration is used")
    const source = resolve(sourceArgument)
    const sourceCommit = (await $`git -C ${source} rev-parse HEAD`.quiet().text()).trim()
    if (sourceCommit !== TARIC_UPSTREAM_COMMIT) throw new Error("Fixture Taric source commit does not match the pinned contract")
    const registrySource = await Bun.file(join(source, "packages/schemas/src/registry.ts")).text()
    if (digest(registrySource) !== TARIC_OPERATION_REGISTRY_SOURCE_DIGEST) throw new Error("Fixture Taric registry source digest does not match")
    const packageMetadata = requiredRecord(await Bun.file(join(source, "packages/core/package.json")).json())
    if (packageMetadata.version !== TARIC_COMPATIBILITY_BASELINE.coreVersion) throw new Error("Fixture Taric package version does not match")
    // HEAD and the registry check identify the checkout contract, not the provenance
    // of ignored dist output. Hash the actual selected runtime directories separately.
    const [coreRuntime, driverRuntime, schemaRuntime] = await Promise.all([
        runtimeDirectoryEvidence(source, "packages/core/dist", "index.js"),
        runtimeDirectoryEvidence(source, "packages/driver-bun-sqlite/dist", "index.js"),
        runtimeDirectoryEvidence(source, "packages/schemas/dist", "src/index.js"),
    ])
    // Sibling imports exist only in this explicitly selected fixture runner.
    const [core, driver, registry] = await Promise.all([
        import(join(source, "packages/core/dist/index.js")) as Promise<FixtureCoreModule>,
        import(join(source, "packages/driver-bun-sqlite/dist/index.js")) as Promise<FixtureDriverModule>,
        import(join(source, "packages/schemas/dist/src/index.js")) as Promise<FixtureRegistryModule>,
    ])
    if (digest(JSON.stringify(registry.operationContracts)) !== TARIC_OPERATION_REGISTRY_DIGEST) throw new Error("Fixture Taric built operation registry does not match")
    if (core.API_CONTRACT_VERSION !== TARIC_COMPATIBILITY_BASELINE.apiContractVersion || core.AUTHORITY_STORAGE_CONTRACT_VERSION !== TARIC_COMPATIBILITY_BASELINE.storageContract) throw new Error("Fixture Taric runtime contract does not match")

    const root = await mkdtemp(join(tmpdir(), "bw-taric-artifact-fixture-"))
    const crashEvidence = await processCrashEvidence(source)
    const authorityPath = join(root, "authority.sqlite")
    const contentRoot = join(root, "content")
    let authority = await core.createCoreService(new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath)), contentRoot)
    const assertions: Array<{ id: string; passed: boolean }> = []
    function check(id: string, passed: boolean): void { assertions.push({ id, passed }) }
    let identicalRebind: "confirmed" | "conflict" = "confirmed"
    let finalReport: Record<string, unknown> | undefined
    try {
        const operator = core.createPrincipal("operator", "artifact-fixture-operator")
        const engagement = must(await authority.dispatch("engagement.init", operator, {
            name: "BreachWeave Artifact fixture",
            scope: { allowed_targets: ["http://127.0.0.1"], excluded_targets: [], rules_of_engagement_ref: "fixture-only" },
        }))
        const engagementId = String(engagement.id)
        const principal = core.createPrincipal("host", "artifact-fixture-host", engagementId, ["content_read"])
        const host = {
            getBinding() { return { projectId: "artifact-fixture-project", tenantId: "artifact-fixture-tenant", engagementId, hostPrincipalId: "artifact-fixture-host", modelPrincipalId: "artifact-fixture-model" } },
            async invokeHost(operation: string, input: Record<string, unknown>): Promise<unknown> {
                return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId }))
            },
        }
        function service(): TaricArtifactService {
            return new TaricArtifactService({ host, chunkBytes: 4, egressGrant: { principalId: "artifact-fixture-host", engagementId, capability: "content_read" } })
        }
        const first = service()
        const session = { sessionId: "fixture-session", root: join(contentRoot, "fixture-session"), mode: "host-session" as const }
        await first.bindSession(session)
        check("explicit_host_session_bound", true)
        const upload = { sessionId: session.sessionId, requestId: "fixture-target-auth", payloadKind: "text" as const, mediaType: "text/plain", payload: "synthetic-fixture-credential" }
        const before = await first.storeTargetAuth(upload)
        check("committed_managed_target_auth", before.storageMode === "taric_stored" && before.category === "target-auth" && before.contentStatus === "available" && before.integrityStatus === "verified")
        let recoveredBefore = false
        let consumed: Uint8Array | undefined
        await first.consumeTargetAuth({ sessionId: session.sessionId, contentRef: before.contentRef }, async (bytes) => { recoveredBefore = new TextDecoder().decode(bytes) === upload.payload; consumed = bytes })
        check("verified_content_before_restart", recoveredBefore)
        check("consumer_buffer_cleared", consumed?.every((byte) => byte === 0) === true)
        await authority.close()
        authority = await core.createCoreService(new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(authorityPath)), contentRoot)
        const restarted = service()
        try { await restarted.bindSession(session) } catch (error) {
            if (!(error instanceof TaricOperationError) || error.code !== "conflict") throw error
            identicalRebind = "conflict"
        }
        const after = await restarted.storeTargetAuth(upload)
        check("durable_upload_identity_after_restart", before.contentRef === after.contentRef && before.contentHash === after.contentHash)
        let recoveredAfter = false
        await restarted.consumeTargetAuth({ sessionId: session.sessionId, contentRef: after.contentRef }, async (bytes) => { recoveredAfter = new TextDecoder().decode(bytes) === upload.payload })
        check("verified_content_after_authority_reopen", recoveredAfter)
        check("ordinary_metadata_only", !JSON.stringify(after).includes(upload.payload) && !Object.keys(after).some((key) => ["data", "root", "payload", "manifest_path", "relative_dir"].includes(key)))
        const ungranted = core.createPrincipal("host", "artifact-fixture-host", engagementId)
        const denied = requiredRecord(await authority.dispatch("artifact.content.read", ungranted, { engagement_id: engagementId, session_id: session.sessionId, content_ref: after.contentRef }))
        check("ungranted_raw_read_denied", denied.ok === false && requiredRecord(denied.error).code === "authorization_error")
        let changedBindingDenied = false
        try { await restarted.bindSession({ ...session, root: join(contentRoot, "different-root") }) } catch (error) { changedBindingDenied = error instanceof TaricOperationError && error.code === "conflict" }
        check("changed_session_binding_denied", changedBindingDenied)
        const report = {
            reportVersion: "breachweave-taric-artifact-fixture/1", generatedAt: new Date().toISOString(),
            evidenceClass: "local_dist_fixture", sourceCommit, sourceCommitMeaning: "expected_checkout_ref_only", taricVersion: packageMetadata.version,
            taricVersionProvenance: "checkout_package_metadata", runtimeSourceProvenance: "unverified",
            runtimeArtifacts: { core: coreRuntime, schemas: schemaRuntime, driver: driverRuntime },
            runtimeDirectoryDigestAlgorithm: "sha256(JSON.stringify(sorted array of {path,byteLength,digest} for every runtime directory file))",
            apiContractVersion: core.API_CONTRACT_VERSION, storageContract: core.AUTHORITY_STORAGE_CONTRACT_VERSION,
            operationRegistryDigest: TARIC_OPERATION_REGISTRY_DIGEST, operationRegistrySourceDigest: TARIC_OPERATION_REGISTRY_SOURCE_DIGEST,
            authority: "single_host_sqlite", storagePathProfile: "isolated_temporary_database_and_content_root",
            artifactDeploymentProfile: "local_process_crash", restartMethod: "clean_authority_close_reopen_and_sigkill_child_process",
            processKillTested: crashEvidence.assertions.every((assertion) => assertion.passed), powerLossDurabilityClaimed: false, temporaryStateRemoved: true,
            targetTrafficGenerated: false, userConfigurationRead: false, productionEvidence: false,
            assertions: [...assertions, ...crashEvidence.assertions], metrics: { passed: [...assertions, ...crashEvidence.assertions].filter((item) => item.passed).length, total: assertions.length + crashEvidence.assertions.length },
            identicalHostSessionRebind: identicalRebind,
            limitations: [
                "This uses explicitly selected local dist directories, not rebuilt clean-consumer artifacts, registry tarballs, or real-gateway evidence.",
                "Source HEAD and registry digests identify the expected checkout contract only. This runtime smoke does not certify source-to-dist provenance; runtimeSourceProvenance is unverified.",
                "Runtime directory digests identify the selected Core, schema, and driver files, not their dependency closure or reproducible build provenance.",
                `Authority restart includes ${crashEvidence.restartMethod}; power-loss and multi-host durability are unverified.`,
                ...(identicalRebind === "conflict" ? ["The selected local runtime returns conflict for identical host-session rebind after SQL hydration, consistent with nullable run-field comparison in the expected checkout. Existing committed content remains readable; rebind idempotency is not accepted."] : []),
            ],
        }
        if (assertions.some((item) => !item.passed)) throw new Error("Artifact fixture assertion failed")
        finalReport = report
    } finally {
        await authority.close()
        await rm(root, { recursive: true, force: true })
    }
    const output = argument("output")
    if (output) {
        const outputPath = resolve(output)
        await mkdir(dirname(outputPath), { recursive: true })
        await Bun.write(outputPath, `${JSON.stringify(finalReport, null, 2)}\n`)
    }
    console.log(JSON.stringify(finalReport, null, 2))
}

await main()
