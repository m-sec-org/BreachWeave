/**
 * Local Taric gateway supervisor.
 *
 * A local deployment starts one `taric gateway` child process on loopback by
 * default. All credentials live under the gateway state directory with 0600
 * permissions; tokens reach the daemon only through process environment
 * variables, never through settings.json.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { TaricHostSettings } from "../config/types"
import { createNetworkTaricServiceAdapter } from "./network-adapter"
import { assertTaricVerificationReport } from "./verification"

export const TARIC_LOCAL_GATEWAY_SERVER_NAME = "taric-local-gateway"
export const TARIC_LOCAL_GATEWAY_DEFAULT_PORT = 8849
export const TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV = "TARIC_GATEWAY_HOST_TOKEN"
export const TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV = "TARIC_GATEWAY_MODEL_TOKEN"
export const TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV = "TARIC_GATEWAY_OPERATOR_TOKEN"

const STATE_VERSION = 1
const STARTUP_TIMEOUT_MS = 20_000
const PORT_PROBE_TIMEOUT_MS = 500

export interface LocalTaricGatewayRuntime {
    stateDir: string
    dbPath: string
    gatewayConfigPath: string
    runtimeConfigPath: string
    caFile: string
    host: string
    port: number
    serverName: string
    hostPrincipalId: string
    modelPrincipalId: string
    operatorPrincipalId: string
    /** Shared Engagement every local project binds to (gateway tokens are pinned to it). */
    engagementId: string
    /** True when a listener already accepted connections before we spawned. */
    adopted: boolean
}

interface GatewayStateFile {
    version: number
    host: string
    port: number
    hostPrincipalId: string
    modelPrincipalId: string
    operatorPrincipalId: string
    engagementId?: string
}

interface GatewayConfigFile {
    tls_tcp: { host: string; port: number }
    tls: { key_file: string; cert_file: string }
    tokens: Array<{ token: string; role: "host" | "model" | "operator"; principal_id: string; engagement_id?: string }>
    /** 32-byte hex key for the taric_best_effort encrypted outbox; injected as TARIC_OUTBOX_KEY. */
    outboxKey?: string
}

interface GatewayRuntimeConfigFile {
    authority: { profile: "single_host_sqlite"; sqlite: { path: string } }
    db_path: string
    content_root: string
    principal_id: string
    principal_role: "operator"
    engagement_id: string
}

export class LocalTaricGatewayUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "LocalTaricGatewayUnavailableError"
    }
}

export interface EnsureLocalTaricGatewayOptions {
    configDir: string
    taricSettings?: TaricHostSettings
    log?: (message: string) => void
    /** Test seams. */
    probePort?: (host: string, port: number) => Promise<boolean>
    spawnProcess?: (command: string[], options: { cwd?: string; env?: Record<string, string> }) => { exited: Promise<number> }
    runCommand?: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
    probeGatewayStatus?: (input: { runtimeConfigPath: string; expectedDigest: string; host: string; port: number }) => Promise<unknown>
}

export function localGatewayStateDir(configDir: string): string {
    return resolve(dirname(configDir), "taric-gateway")
}

function statePath(stateDir: string): string {
    return join(stateDir, "state.json")
}

function gatewayConfigPath(stateDir: string): string {
    return join(stateDir, "gateway.json")
}

function runtimeConfigPath(stateDir: string): string {
    return join(stateDir, "runtime.json")
}

function generateToken(): string {
    return randomBytes(48).toString("hex")
}

function principalId(prefix: string): string {
    return `${prefix}-${randomBytes(4).toString("hex")}`
}

async function isFileReadable(path: string): Promise<boolean> {
    const file = Bun.file(path)
    return await file.exists()
}

async function readJson<T>(path: string): Promise<T | undefined> {
    if (!(await isFileReadable(path))) return
    try {
        return (await Bun.file(path).json()) as T
    } catch {
        return
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Resolve the taric CLI entry used to spawn the gateway and provision engagements. */
export function resolveTaricCliPath(explicit?: string, exists: (path: string) => boolean = existsSync): string | undefined {
    const candidates = [
        explicit?.trim() || undefined,
        process.env.TARIC_CLI?.trim() || undefined,
        resolve(import.meta.dir, "../../../..", "..", "Taric", "packages", "cli", "dist", "bin.js"),
        Bun.which("taric") ? "taric" : undefined,
    ]
    for (const candidate of candidates) {
        if (!candidate) continue
        if (candidate === "taric") return candidate
        if (exists(candidate)) return candidate
    }
    return undefined
}

function resolveNodePath(): string {
    return Bun.which("node") ?? "/usr/local/bin/node"
}

function taricInvocation(cliPath: string): { command: string[] } {
    if (cliPath === "taric") return { command: ["taric"] }
    return { command: [resolveNodePath(), cliPath] }
}

async function probeTcpPort(host: string, port: number): Promise<boolean> {
    try {
        const socket = Bun.connect({
            hostname: host,
            port,
            socket: { data() {}, error() {}, close() {}, end() {} },
        })
        const connected = await Promise.race([
            socket.then(
                (conn) => {
                    conn.end()
                    return true
                },
                () => false,
            ),
            new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), PORT_PROBE_TIMEOUT_MS)),
        ])
        return connected
    } catch {
        return false
    }
}

async function runOpenssl(args: string[], cwd: string): Promise<void> {
    const openssl = Bun.which("openssl")
    if (!openssl) throw new LocalTaricGatewayUnavailableError("openssl is required to bootstrap local Taric gateway TLS material")
    const proc = Bun.spawn([openssl, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (exitCode !== 0) throw new LocalTaricGatewayUnavailableError(`openssl ${args[0]} failed: ${stderr.trim()}`)
}

async function ensureTlsMaterial(stateDir: string): Promise<void> {
    const caKey = join(stateDir, "ca.key")
    const caCrt = join(stateDir, "ca.crt")
    const serverKey = join(stateDir, "server.key")
    const serverCsr = join(stateDir, "server.csr")
    const serverCrt = join(stateDir, "server.crt")
    if (await isFileReadable(serverCrt)) return

    await runOpenssl(
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-subj", "/CN=BreachWeave Local Taric CA"],
        stateDir,
    )
    await runOpenssl(
        ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${TARIC_LOCAL_GATEWAY_SERVER_NAME}`],
        stateDir,
    )
    await Bun.write(join(stateDir, "ext.cnf"), `subjectAltName=DNS:${TARIC_LOCAL_GATEWAY_SERVER_NAME},IP:127.0.0.1\n`)
    await runOpenssl(
        ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "825", "-extfile", "ext.cnf"],
        stateDir,
    )
    for (const secret of [caKey, serverKey, serverCsr]) {
        await Bun.spawn(["chmod", "600", secret]).exited
    }
    await Bun.spawn(["rm", "-f", serverCsr, join(stateDir, "ext.cnf"), join(stateDir, "ca.srl")]).exited
}

async function ensureGatewayIdentity(stateDir: string, taricSettings?: TaricHostSettings): Promise<GatewayStateFile> {
    const existing = await readJson<GatewayStateFile>(statePath(stateDir))
    if (existing?.version === STATE_VERSION && existing.hostPrincipalId && existing.modelPrincipalId) return existing
    const state: GatewayStateFile = {
        version: STATE_VERSION,
        host: "127.0.0.1",
        port: existing?.port ?? TARIC_LOCAL_GATEWAY_DEFAULT_PORT,
        // Keep principal identities aligned with any previously saved host settings.
        hostPrincipalId: taricSettings?.hostPrincipalId?.trim() || existing?.hostPrincipalId || principalId("bw-local-host"),
        modelPrincipalId: taricSettings?.modelPrincipalId?.trim() || existing?.modelPrincipalId || principalId("bw-local-model"),
        operatorPrincipalId: existing?.operatorPrincipalId || "bw-local-operator",
        ...(existing?.engagementId ? { engagementId: existing.engagementId } : {}),
    }
    await writeJson(statePath(stateDir), state)
    return state
}

async function ensureGatewayConfig(stateDir: string, state: GatewayStateFile): Promise<GatewayConfigFile> {
    const existing = await readJson<GatewayConfigFile>(gatewayConfigPath(stateDir))
    // Tokens are pinned to the shared Engagement (fail-closed resolver), so a
    // stale config from a run before the Engagement existed is regenerated.
    const hostEntry = existing?.tokens?.find((entry) => entry.role === "host")
    const tokensPinned = existing?.tls_tcp && hostEntry?.engagement_id === state.engagementId
    let config: GatewayConfigFile = tokensPinned
        ? existing!
        : {
              tls_tcp: { host: state.host, port: state.port },
              tls: { key_file: "server.key", cert_file: "server.crt" },
              tokens: [
                  { token: generateToken(), role: "host", principal_id: state.hostPrincipalId, engagement_id: state.engagementId },
                  { token: generateToken(), role: "model", principal_id: state.modelPrincipalId, engagement_id: state.engagementId },
                  { token: generateToken(), role: "operator", principal_id: state.operatorPrincipalId },
              ],
          }
    if (!config.outboxKey) config = { ...config, outboxKey: randomBytes(32).toString("hex") }
    if (config !== existing) {
        await writeJson(gatewayConfigPath(stateDir), config)
        await Bun.spawn(["chmod", "600", gatewayConfigPath(stateDir)]).exited
    }
    return config
}

async function ensureGatewayRuntimeConfig(stateDir: string, state: GatewayStateFile): Promise<string> {
    const path = runtimeConfigPath(stateDir)
    const authorityPath = join(stateDir, "authority.sqlite")
    const config: GatewayRuntimeConfigFile = {
        authority: { profile: "single_host_sqlite", sqlite: { path: authorityPath } },
        db_path: authorityPath,
        content_root: join(stateDir, "content"),
        principal_id: state.operatorPrincipalId,
        principal_role: "operator",
        engagement_id: state.engagementId ?? "",
    }
    await writeJson(path, config)
    await Bun.spawn(["chmod", "600", path]).exited
    return path
}

async function verifyGatewayRuntimeConfig(
    options: EnsureLocalTaricGatewayOptions,
    state: GatewayStateFile,
    config: GatewayConfigFile,
    runtimePath: string,
): Promise<void> {
    const runtimeText = await Bun.file(runtimePath).text()
    const expectedDigest = `sha256:${createHash("sha256").update(runtimeText).digest("hex")}`
    const injected = await options.probeGatewayStatus?.({ runtimeConfigPath: runtimePath, expectedDigest, host: state.host, port: state.port })
    let result = injected
    if (result === undefined) {
        const hostToken = config.tokens.find((entry) => entry.role === "host")?.token
        const modelToken = config.tokens.find((entry) => entry.role === "model")?.token
        if (!hostToken || !modelToken) throw new LocalTaricGatewayUnavailableError("local Taric gateway credentials are incomplete")
        const adapter = createNetworkTaricServiceAdapter({
            binding: {
                projectId: "local-gateway",
                tenantId: "local-gateway",
                engagementId: state.engagementId ?? "",
                hostPrincipalId: state.hostPrincipalId,
                modelPrincipalId: state.modelPrincipalId,
            },
            transport: {
                kind: "tls_tcp",
                host: state.host,
                port: state.port,
                hostToken,
                modelToken,
                ca: await Bun.file(join(dirname(runtimePath), "ca.crt")).text(),
                servername: TARIC_LOCAL_GATEWAY_SERVER_NAME,
            },
        })
        try {
            result = await adapter.gatewayStatus?.()
        } finally {
            await adapter.close()
        }
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new LocalTaricGatewayUnavailableError("local Taric gateway status is unavailable")
    const data = (result as { ok?: unknown; data?: unknown }).data
    const runtime = data && typeof data === "object" && !Array.isArray(data) ? (data as { runtime_configuration?: unknown; readiness?: unknown }).runtime_configuration : undefined
    if (
        (result as { ok?: unknown }).ok !== true ||
        !data || typeof data !== "object" || Array.isArray(data) || (data as { readiness?: unknown }).readiness !== true ||
        !runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
        (runtime as { source?: unknown }).source !== "explicit" || (runtime as { digest?: unknown }).digest !== expectedDigest
    ) {
        throw new LocalTaricGatewayUnavailableError("local Taric gateway is not ready with the selected explicit runtime configuration")
    }
}

/** The gateway resolver fail-closes on token/engagement mismatch, so one local deployment shares one Engagement. */
async function ensureSharedEngagement(stateDir: string, state: GatewayStateFile, cliPath: string, runCommand?: EnsureLocalTaricGatewayOptions["runCommand"], log?: (message: string) => void): Promise<GatewayStateFile> {
    if (state.engagementId) return state
    const result = await createLocalTaricEngagement({
        stateDir,
        cliPath,
        name: "breachweave-local",
        notes: "BreachWeave local deployment shared Engagement",
        runCommand,
    })
    const next = { ...state, engagementId: result.engagementId }
    await writeJson(statePath(stateDir), next)
    log?.(`[taric] provisioned shared Engagement ${result.engagementId}`)
    return next
}

/** Find the first loopback port that is not currently accepting connections. */
export async function pickFreeLoopbackPort(startPort: number, probe: (host: string, port: number) => Promise<boolean> = probeTcpPort, attempts = 10): Promise<number> {
    for (let offset = 0; offset < attempts; offset++) {
        const port = startPort + offset
        if (!(await probe("127.0.0.1", port))) return port
    }
    throw new LocalTaricGatewayUnavailableError(`no free loopback port in range ${startPort}-${startPort + attempts - 1}`)
}

/**
 * Make sure a local Taric gateway is running and the daemon process carries
 * its credentials. Idempotent: adopts an existing listener, respawns after a
 * crash, and regenerates missing material without touching valid state.
 */
export async function ensureLocalTaricGateway(options: EnsureLocalTaricGatewayOptions): Promise<LocalTaricGatewayRuntime> {
    const log = options.log ?? (() => {})
    const probe = options.probePort ?? probeTcpPort
    const stateDir = localGatewayStateDir(options.configDir)
    await Bun.spawn(["mkdir", "-p", stateDir]).exited

    const cliPath = resolveTaricCliPath(options.taricSettings?.localCliPath)
    if (!cliPath) {
        throw new LocalTaricGatewayUnavailableError(
            "taric CLI not found; set tch.taric.localCliPath or TARIC_CLI, install taric on PATH, or place the Taric checkout next to BreachWeave",
        )
    }

    let state = await ensureGatewayIdentity(stateDir, options.taricSettings)
    const hasGatewayConfig = await isFileReadable(gatewayConfigPath(stateDir))

    // An already-listening gateway is adopted instead of being replaced.
    if (await probe(state.host, state.port)) {
        if (!hasGatewayConfig) throw new LocalTaricGatewayUnavailableError(`port ${state.port} is occupied by an unknown service`)
        log(`[taric] adopting existing local gateway on ${state.host}:${state.port}`)
        state = await ensureSharedEngagement(stateDir, state, cliPath, options.runCommand, log)
        const config = await ensureGatewayConfig(stateDir, state)
        const runtimePath = await ensureGatewayRuntimeConfig(stateDir, state)
        await verifyGatewayRuntimeConfig(options, state, config, runtimePath)
        injectGatewayCredentials(config)
        return runtimeFrom(stateDir, state, true)
    }

    // Port may have drifted (state written when 8849 was taken, then freed).
    if (!hasGatewayConfig) {
        state = { ...state, port: await pickFreeLoopbackPort(state.port, probe) }
        await writeJson(statePath(stateDir), state)
    }

    // The shared Engagement must exist before the gateway config so tokens can pin to it.
    state = await ensureSharedEngagement(stateDir, state, cliPath, options.runCommand, log)
    await ensureTlsMaterial(stateDir)
    const config = await ensureGatewayConfig(stateDir, state)
    const runtimePath = await ensureGatewayRuntimeConfig(stateDir, state)

    const logFile = join(stateDir, "gateway.log")
    const { command } = taricInvocation(cliPath)
    const cliArgs = [...command.slice(1), "gateway", "--config", gatewayConfigPath(stateDir), "--runtime-config", runtimePath]

    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const spawn = options.spawnProcess ?? ((commandLine: string[], spawnOptions: { cwd?: string; env?: Record<string, string> }) => Bun.spawn(commandLine, { cwd: spawnOptions.cwd, env: spawnOptions.env, stdout: Bun.file(logFile), stderr: Bun.file(logFile) }) as unknown as { exited: Promise<number> })
    const child = spawn([command[0], ...cliArgs], { env })
    const exited = child.exited
    void exited.then((code) => {
        if (code !== 0) log(`[taric] local gateway exited with code ${code}; see ${logFile}`)
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
        if (await probe(state.host, state.port)) break
        if (await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))])) {
            throw new LocalTaricGatewayUnavailableError(`local taric gateway failed to start; see ${logFile}`)
        }
        await new Promise((r) => setTimeout(r, 300))
    }
    if (!(await probe(state.host, state.port))) {
        throw new LocalTaricGatewayUnavailableError(`local taric gateway did not accept connections within ${STARTUP_TIMEOUT_MS}ms; see ${logFile}`)
    }

    await verifyGatewayRuntimeConfig(options, state, config, runtimePath)

    log(`[taric] local gateway listening on ${state.host}:${state.port}`)
    injectGatewayCredentials(config)
    return runtimeFrom(stateDir, state, false)
}

function runtimeFrom(stateDir: string, state: GatewayStateFile, adopted: boolean): LocalTaricGatewayRuntime {
    return {
        stateDir,
        dbPath: join(stateDir, "authority.sqlite"),
        gatewayConfigPath: gatewayConfigPath(stateDir),
        runtimeConfigPath: runtimeConfigPath(stateDir),
        caFile: join(stateDir, "ca.crt"),
        host: state.host,
        port: state.port,
        serverName: TARIC_LOCAL_GATEWAY_SERVER_NAME,
        hostPrincipalId: state.hostPrincipalId,
        modelPrincipalId: state.modelPrincipalId,
        operatorPrincipalId: state.operatorPrincipalId,
        engagementId: state.engagementId ?? "",
        adopted,
    }
}

/** Tokens enter the daemon environment only; settings.json stays credential-free. */
function injectGatewayCredentials(config: GatewayConfigFile | undefined): void {
    if (!config) return
    const hostToken = config.tokens.find((entry) => entry.role === "host")?.token
    const modelToken = config.tokens.find((entry) => entry.role === "model")?.token
    const operatorToken = config.tokens.find((entry) => entry.role === "operator")?.token
    if (hostToken) process.env[TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV] = hostToken
    if (modelToken) process.env[TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV] = modelToken
    if (operatorToken) process.env[TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV] = operatorToken
    if (config.outboxKey && !process.env.TARIC_OUTBOX_KEY) process.env.TARIC_OUTBOX_KEY = config.outboxKey
}

export interface LocalEngagementResult {
    engagementId: string
}

/** Provision one Engagement through the taric CLI against a local authority database. */
export async function createLocalTaricEngagement(options: {
    stateDir: string
    cliPath?: string
    taricSettings?: TaricHostSettings
    name: string
    /** Targets the engagement is scoped to; falls back to a generic local target when omitted or empty. */
    allowedTargets?: string[]
    notes?: string
    runCommand?: EnsureLocalTaricGatewayOptions["runCommand"]
}): Promise<LocalEngagementResult> {
    const cliPath = options.cliPath ?? resolveTaricCliPath(options.taricSettings?.localCliPath)
    if (!cliPath) throw new LocalTaricGatewayUnavailableError("taric CLI not found; cannot provision a local Engagement")
    const allowedTargets = (options.allowedTargets ?? []).map((target) => target.trim()).filter(Boolean)
    if (allowedTargets.length === 0) allowedTargets.push("local-practice")
    const stateDir = options.stateDir
    const request = JSON.stringify({
        name: options.name,
        scope: {
            allowed_targets: allowedTargets,
            excluded_targets: [],
            rules_of_engagement_ref: "breachweave-local-roe-v1",
            notes: options.notes?.trim() || `BreachWeave local engagement ${options.name}`,
        },
    })
    const { command } = taricInvocation(cliPath)
    const argv = [...command.slice(1), "engagement.init", request]
    const env: Record<string, string> = {
        ...process.env,
        TARIC_DB: join(stateDir, "authority.sqlite"),
        TARIC_PRINCIPAL_ROLE: "operator",
        TARIC_PRINCIPAL_ID: "bw-local-operator",
    }
    const run = options.runCommand ?? (async (commandLine: string[]) => {
        const proc = Bun.spawn(commandLine, { env, stdout: "pipe", stderr: "pipe" })
        const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        return { exitCode, stdout, stderr }
    })
    const result = await run([command[0], ...argv])
    if (result.exitCode !== 0) throw new LocalTaricGatewayUnavailableError(`taric engagement.init failed: ${result.stderr.trim() || result.stdout.trim()}`)
    const engagementId = parseEngagementId(result.stdout)
    if (!engagementId) throw new LocalTaricGatewayUnavailableError(`taric engagement.init returned no engagement id: ${result.stdout.trim().slice(0, 200)}`)
    return { engagementId }
}

export function parseEngagementId(stdout: string): string | undefined {
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("{")) continue
        try {
            const value = JSON.parse(trimmed) as { ok?: boolean; data?: { id?: unknown; engagement_id?: unknown } }
            const id = value?.data?.id ?? value?.data?.engagement_id
            if (typeof id === "string" && UUID_LIKE.test(id)) return id
        } catch {
            continue
        }
    }
    return undefined
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let activeLocalGateway: LocalTaricGatewayRuntime | undefined

/** Runtime of the gateway supervised by this daemon, if it came up. */
export function getLocalTaricGatewayRuntime(): LocalTaricGatewayRuntime | undefined {
    return activeLocalGateway
}

/**
 * Default local deployment bootstrap: ensure the gateway is up, publish its
 * non-secret settings, and remember the runtime for default project bindings.
 * Failures are reported to the caller and never thrown — memory routing falls
 * back to legacy_local until the gateway becomes available.
 */
export async function ensureDefaultLocalTaricGateway(config: {
    dir: string
    getHostSettings: () => Promise<{ taric?: TaricHostSettings }>
    applyLocalTaricDefaults: (gateway: {
        host: string
        port: number
        caFile: string
        serverName: string
        hostPrincipalId: string
        modelPrincipalId: string
        operatorPrincipalId: string
    }) => Promise<unknown>
}, log: (message: string) => void = console.log): Promise<LocalTaricGatewayRuntime | undefined> {
    try {
        const settings = await config.getHostSettings()
        if (settings.taric?.enabled === false) {
            log("[taric] disabled in host settings; local gateway not started")
            return undefined
        }
        const profile = settings.taric?.profile ?? "authenticated_proxy"
        try {
            await assertTaricVerificationReport(settings.taric?.verificationReportPath ?? join(config.dir, "taric-verification.json"), profile)
        } catch (error) {
            // The local supervisor is a development convenience. The provider
            // still enforces this report for explicit taric_required projects.
            log(`[taric] verification report unavailable; continuing local startup: ${error instanceof Error ? error.message : String(error)}`)
        }
        const runtime = await ensureLocalTaricGateway({ configDir: config.dir, taricSettings: settings.taric, log })
        await config.applyLocalTaricDefaults(runtime)
        activeLocalGateway = runtime
        return runtime
    } catch (error) {
        log(`[taric] local gateway unavailable, memory defaults stay legacy_local: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
    }
}
