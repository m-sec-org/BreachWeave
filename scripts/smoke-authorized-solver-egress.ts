import { createServer } from "node:http"
import { lookup } from "node:dns/promises"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { RuntimeManager } from "../packages/core/src/runtime/runtime"
import type { ConfigManager } from "../packages/core/src/config/index"
import type { HostBridgeAction } from "../packages/core/src/challenge/host-bridge-types"

const projectRoot = resolve(import.meta.dir, "..")
const output = resolve(projectRoot, process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/artifacts/taric-104-authorized-solver-egress.json")
const image = process.env.TCH_AUTHORIZED_SOLVER_IMAGE ?? "tch-agent:latest"
await mkdir(resolve(projectRoot, "docs/artifacts"), { recursive: true })

const requests: string[] = []
let modelRequests = 0
const modelSecret = "synthetic-egress-model-host-key"
const server = createServer((request, response) => {
    if (request.url === "/v1/chat/completions" && request.method === "POST" && request.headers.authorization === `Bearer ${modelSecret}`) {
        modelRequests += 1
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "fixture model streaming" }, finish_reason: null }] })}\n\n`)
        setTimeout(() => response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`), 25)
        return
    }
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("fixture reached")
})
const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "0.0.0.0", () => resolvePort((server.address() as { port: number }).port))
})

async function runModelTransport(): Promise<{ passed: boolean; exitCode: number; bridgeActions: string[]; error?: string }> {
    const root = await mkdtemp(resolve(tmpdir(), "bw-model-egress-"))
    const binary = resolve(root, "worker")
    const build = Bun.spawn(["bun", "build", "--compile", "--target=bun-linux-x64-baseline", resolve(import.meta.dir, "authorized-model-bridge-worker.ts"), "--outfile", binary], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" })
    const [, buildError, buildExit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])
    if (buildExit !== 0) {
        await rm(root, { recursive: true, force: true })
        return { passed: false, exitCode: buildExit, bridgeActions: [], error: buildError.slice(0, 2000) }
    }
    const runtime = new RuntimeManager({ getHostSettings: async () => ({ runtime: {} }) } as unknown as ConfigManager, [])
    const host = runtime as unknown as {
        authorizedModelBindings: Map<string, { origin: string; pathPrefix: string; providerId: string; modelPrefId: string; modelId: string; apiKey: string; configDir: string }>
        executeHostBridgeAction(solverId: string, action: HostBridgeAction, params: unknown): Promise<unknown>
    }
    const origin = `http://127.0.0.1:${port}`
    host.authorizedModelBindings.set("egress-model", { origin, pathPrefix: "/v1/", providerId: "fixture", modelPrefId: "fixture", modelId: "fixture", apiKey: modelSecret, configDir: root })
    const child = Bun.spawn(["docker", "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none", "--entrypoint", "/smoke/worker", "-v", `${binary}:/smoke/worker:ro`, image, origin], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const deadline = setTimeout(() => child.kill(), 60_000)
    const stderr = new Response(child.stderr).text()
    const bridgeActions: string[] = []
    let passed = false
    let buffered = ""
    try {
        for await (const chunk of child.stdout) {
            buffered += new TextDecoder().decode(chunk)
            let newline: number
            while ((newline = buffered.indexOf("\n")) >= 0) {
                const line = buffered.slice(0, newline)
                buffered = buffered.slice(newline + 1)
                const event = JSON.parse(line) as { type: string; request_id: string; action: HostBridgeAction; params: unknown; passed?: boolean }
                if (event.type === "model_smoke_result") passed = event.passed === true
                if (event.type !== "host_bridge_request") continue
                bridgeActions.push(event.action)
                try {
                    const data = await host.executeHostBridgeAction("egress-model", event.action, event.params)
                    child.stdin.write(`${JSON.stringify({ request_id: event.request_id, success: true, data })}\n`)
                } catch (error) {
                    child.stdin.write(`${JSON.stringify({ request_id: event.request_id, success: false, error: String(error) })}\n`)
                }
            }
        }
        const exitCode = await child.exited
        return { passed: passed && exitCode === 0 && modelRequests === 1, exitCode, bridgeActions, ...(exitCode !== 0 ? { error: (await stderr).slice(0, 2000) } : {}) }
    } finally {
        clearTimeout(deadline)
        child.kill()
        host.authorizedModelBindings.clear()
        await rm(root, { recursive: true, force: true })
    }
}

try {
    const hostAddress = (await lookup("host.docker.internal", { family: 4 })).address
    const script = [
        "import json, socket, subprocess, sys",
        "host, port = sys.argv[1], int(sys.argv[2])",
        "checks = []",
        "def blocked(label, target, target_port):",
        "    try:",
        "        sock = socket.create_connection((target, target_port), timeout=2)",
        "        sock.close()",
        "        checks.append({'id': label, 'blocked': False})",
        "    except OSError:",
        "        checks.append({'id': label, 'blocked': True})",
        "blocked('raw_tcp_host', host, port)",
        "blocked('raw_tcp_public', '1.1.1.1', 443)",
        "for label, target in [('curl_host', f'http://{host}:{port}/'), ('curl_public', 'https://1.1.1.1/')]:",
        "    result = subprocess.run(['curl', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '3', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "    checks.append({'id': label, 'blocked': result.returncode != 0})",
        "print(json.dumps(checks))",
        "sys.exit(0 if len(checks) == 4 and all(item['blocked'] for item in checks) else 1)",
    ].join("\n")
    const child = Bun.spawn([
        "docker", "run", "--rm", "--network", "none", "--add-host", `host.docker.internal:${hostAddress}`,
        "--entrypoint", "python3", image, "-c", script, hostAddress, String(port),
    ], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const checks = exitCode === 0 ? JSON.parse(stdout) as Array<{ id: string; blocked: boolean }> : []
    const modelTransport = await runModelTransport()
    const report = {
        format: "breachweave-authorized-solver-egress-smoke/1",
        generatedAt: new Date().toISOString(),
        dockerContext: (await Bun.$`docker context show`.text()).trim(),
        image,
        networkMode: "none",
        status: exitCode === 0 && checks.length === 4 && checks.every((item) => item.blocked) && requests.length === 0 && modelTransport.passed ? "passed" : "failed",
        checks,
        modelTransport: { ...modelTransport, requests: modelRequests, hostCredentialInjected: modelRequests === 1 },
        metrics: { passed: checks.filter((item) => item.blocked).length + Number(modelTransport.passed), total: 5 },
        fixtureRequests: requests.length,
        targetTrafficGenerated: requests.length > 0,
        productionEvidence: false,
        output: { stdout: stdout.trim().slice(0, 4000), stderr: stderr.trim().slice(0, 2000), exitCode },
    }
    await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[authorized-egress] ${report.status}; report=${output}`)
    if (report.status !== "passed") process.exitCode = 1
} finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}
