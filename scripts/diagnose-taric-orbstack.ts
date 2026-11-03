import { Socket } from "node:net"
import { resolve } from "node:path"

interface Probe { id: string; [key: string]: unknown }
const output = resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/artifacts/taric-104-orbstack-diagnostics.json")
const source = resolve(process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length) ?? "../Taric")
const checks: Probe[] = []
async function command(id: string, args: string[], timeoutMs = 5000): Promise<Probe> {
    const start = performance.now()
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    const result = { id, args, exitCode, timedOut, durationMs: Math.round(performance.now() - start), stdout: stdout.slice(-3000), stderr: stderr.slice(-1000) }
    checks.push(result)
    return result
}

async function postgresProtocol(): Promise<Probe> {
    return new Promise((accept) => {
        const socket = new Socket()
        const start = performance.now()
        let connected = false
        socket.setTimeout(5000)
        socket.on("connect", () => {
            connected = true
            // PostgreSQL SSLRequest is harmless and must receive one byte (S/N).
            const request = Buffer.alloc(8)
            request.writeInt32BE(8, 0)
            request.writeInt32BE(80877103, 4)
            socket.write(request)
        })
        function finish(fields: Record<string, unknown>) {
            socket.destroy()
            accept({ id: "postgres_protocol_ssl_request", host: "127.0.0.1", port: 55432, requestHex: "0000000804d2162f", expectedResponse: "53_or_4e", connected, durationMs: Math.round(performance.now() - start), ...fields })
        }
        socket.on("data", (bytes) => finish({ bytes: bytes.length, response: bytes.toString("hex"), passed: bytes[0] === 83 || bytes[0] === 78 }))
        socket.on("timeout", () => finish({ bytes: 0, timedOut: true, passed: false }))
        socket.on("error", (error) => finish({ bytes: 0, error: error.message, passed: false }))
        socket.connect(55432, "127.0.0.1")
    })
}

const context = await command("docker_context", ["docker", "context", "inspect", "orbstack"])
let endpoint = ""
try { endpoint = JSON.parse(String(context.stdout))[0].Endpoints.docker.Host as string } catch { /* retained diagnostic is sufficient */ }
await command("orbstack_status", ["orbctl", "status"])
await command("orbstack_version", ["orbctl", "version"])
const socketPath = endpoint.startsWith("unix://") ? endpoint.slice("unix://".length) : ""
const pingArgs = socketPath ? ["curl", "--noproxy", "*", "--silent", "--show-error", "--max-time", "5", "--unix-socket", socketPath, "http://localhost/_ping"] : undefined
let latestPing = pingArgs ? await command("docker_unix_ping_no_proxy", pingArgs, 6000) : undefined
checks.push(await postgresProtocol())
const ensureStarted = process.argv.includes("--ensure-started")
if (ensureStarted) {
    await command("safe_start_existing_orbstack", ["orbctl", "start"])
    if (pingArgs) latestPing = await command("docker_ping_after_safe_start", pingArgs, 6000)
}
const sourceRevision = await command("taric_source_revision", ["git", "-C", source, "rev-parse", "HEAD"])
const sourceRuntimeDigests = Object.fromEntries(await Promise.all(["packages/core/dist/index.js", "packages/core/dist/postgres.js", "packages/core/src/postgres.ts"].map(async (file) => [file, `sha256:${new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(resolve(source, file)).arrayBuffer())).digest("hex")}`])))
const report = {
    generatedAt: new Date().toISOString(), status: latestPing?.exitCode === 0 && checks.find((check) => check.id === "postgres_protocol_ssl_request")?.passed === true ? "responsive" : "blocked",
    evidenceClass: "local_deployment_diagnostics", productionEvidence: false, sourceCommit: String(sourceRevision.stdout).trim(), sourceRuntimeDigests,
    environment: { proxyVariablesPresent: Object.keys(process.env).filter((key) => /^(https?|all|no)_proxy$/i.test(key)), dockerContext: "orbstack", dockerEndpoint: endpoint },
    checks, conclusion: "Docker readiness requires an HTTP response from the local Unix socket; PostgreSQL readiness requires a protocol response, not only an accepted TCP connection.",
    actions: { engineRestarted: false, containersRestarted: false, databasesDeleted: false, userConfigurationChanged: false, safeStartExistingOrbStackAttempted: ensureStarted },
    limitations: ["OrbStack status and start can report running while Docker/PostgreSQL requests time out.", "No broad OrbStack engine restart was attempted; this would interrupt other local containers, including MongoDB.", "This readiness probe is not current-source PostgreSQL conformance evidence."],
}
await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ status: report.status, output }))
if (report.status !== "responsive") process.exitCode = 1
