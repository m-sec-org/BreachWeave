import { Command } from "commander"
import { basename, resolve } from "node:path"
import type { OwaspClass, TestDepth, RedLine, TestPolicy } from "@tch/core"

const OWASP_CLASSES: readonly OwaspClass[] = [
    "sqli",
    "xss",
    "ssrf",
    "auth",
    "access-control",
    "injection",
    "ssti",
    "xxe",
    "deserialization",
    "idor",
    "file-upload",
    "path-traversal",
]
const TEST_DEPTHS: readonly TestDepth[] = ["quick", "standard", "deep"]
const RED_LINES: readonly RedLine[] = ["poc-safe", "read-only"]

function splitList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

function parseOwaspClasses(value: string | undefined): OwaspClass[] {
    const classes = splitList(value)
    for (const cls of classes) {
        if (!OWASP_CLASSES.includes(cls as OwaspClass)) {
            throw new Error(`invalid --classes value: ${cls} (allowed: ${OWASP_CLASSES.join(", ")})`)
        }
    }
    return classes as OwaspClass[]
}

function parseTestDepth(value: string | undefined): TestDepth {
    const depth = (value ?? "standard").trim()
    if (!TEST_DEPTHS.includes(depth as TestDepth)) {
        throw new Error(`invalid --depth value: ${depth} (allowed: ${TEST_DEPTHS.join(", ")})`)
    }
    return depth as TestDepth
}

function parseRedLine(value: string | undefined): RedLine {
    const redLine = (value ?? "poc-safe").trim()
    if (!RED_LINES.includes(redLine as RedLine)) {
        throw new Error(`invalid --red-line value: ${redLine} (allowed: ${RED_LINES.join(", ")})`)
    }
    return redLine as RedLine
}

const GENERATED_PACKAGE_JSON = {
    name: "tch-agent-runtime",
    version: "0.0.1",
    private: true,
    type: "module",
}

const DEFAULT_WEB_LISTEN = "127.0.0.1:3000"

function collectEnvOption(value: string, previous: string[]) {
    return [...previous, value]
}

function readEnvArgsFromArgv(argv: string[]): string[] {
    const values: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i]
        if (current !== "--env" && current !== "-e") continue
        const next = argv[i + 1]
        if (typeof next === "string" && next.trim()) {
            values.push(next)
            i += 1
        }
    }
    return values
}

function applyEnvPairs(pairs: string[]) {
    for (const pair of pairs) {
        const raw = pair.trim()
        if (!raw) continue
        const eqIndex = raw.indexOf("=")
        if (eqIndex <= 0) {
            throw new Error(`invalid --env pair: ${raw}`)
        }
        const key = raw.slice(0, eqIndex).trim()
        const value = raw.slice(eqIndex + 1)
        if (!key) {
            throw new Error(`invalid --env key: ${raw}`)
        }
        process.env[key] = value
    }
}

function parseListenAddress(value: string): { hostname: string; port: number } {
    const text = value.trim()
    if (!text) {
        throw new Error("listen address is required")
    }

    const index = text.lastIndexOf(":")
    if (index <= 0 || index === text.length - 1) {
        throw new Error(`invalid listen address: ${text}`)
    }

    const hostname = text.slice(0, index).trim()
    const portText = text.slice(index + 1).trim()
    const port = Number.parseInt(portText, 10)

    if (!hostname) {
        throw new Error(`invalid listen hostname: ${text}`)
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid listen port: ${text}`)
    }

    return { hostname, port }
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error)
}

function installGlobalErrorHandlers() {
    process.on("unhandledRejection", (reason) => {
        console.error("[host] unhandledRejection", formatError(reason))
    })

    process.on("uncaughtException", (error) => {
        console.error("[host] uncaughtException", formatError(error))
    })
}

async function ensureRuntimePackageJson(): Promise<void> {
    if (basename(process.execPath).startsWith("bun")) return
    const packageJsonPath = resolve(process.cwd(), "package.json")
    const file = Bun.file(packageJsonPath)
    if (await file.exists()) return
    await Bun.write(packageJsonPath, JSON.stringify(GENERATED_PACKAGE_JSON, null, 2))
}

async function ensureBuiltinAssetsGenerated(): Promise<void> {
    if (!basename(process.execPath).startsWith("bun")) return
    const modulePath = resolve(import.meta.dir, "../../../scripts/generate-builtin-assets.ts")
    const module = await import(modulePath)
    await module.generateBuiltinAssets()
}

async function ensureHostStaticConfig(configDir: string): Promise<void> {
    const { initBuiltinSkills } = await import("../../../packages/core/src/config/skills/index")
    const { initBuiltinPrompts } = await import("../../../packages/core/src/config/prompts/index")
    await initBuiltinSkills(configDir)
    await initBuiltinPrompts(configDir)
}

function shouldPrepareHostStaticConfig(argv: string[]): boolean {
    const command = argv[2]
    if (!command) return false
    if (command === "web") return true
    if (command === "solver" && argv[3] === "list") return true
    if (command === "subagent" && argv[3] === "list") return true
    return false
}

async function main() {
    installGlobalErrorHandlers()
    await ensureBuiltinAssetsGenerated()
    await ensureRuntimePackageJson()

    const { ConfigManager, runSolverCli, runSubagentCli, runSolverRpc, runEngagement } = await import("@tch/core")
    if (shouldPrepareHostStaticConfig(process.argv)) {
        const config = await ConfigManager.getInstance()
        await ensureHostStaticConfig(config.dir)
    }
    const program = new Command().name("tch-agent").description("tch-agent by ez team").version("0.0.1")

    program
        .command("web")
        .description("Start web UI")
        .option("-l, --listen <addr>", "listen address in host:port format", DEFAULT_WEB_LISTEN)
        .action(async (opts) => {
            const { startWeb } = await import("@tch/ui-web")
            const listen = parseListenAddress(String(opts.listen ?? DEFAULT_WEB_LISTEN))
            await startWeb(listen)
        })

    // program
    //     .command("tui", { isDefault: true })
    //     .description("Start terminal UI (default)")
    //     .action(async () => {
    //         const config = await ConfigManager.getInstance()
    //         console.log("TUI mode not yet implemented. Config dir:", config.dir)
    //     })

    const solver = program
        .command("solver")
        .description("Run as headless solver agent (yolo mode)")
        .option("-p, --prompt <name>", "Prompt name to use")
        .option("-e, --env <key=value>", "Inject environment variable", collectEnvOption, [] as string[])
        .argument("<task>", "Task to execute")
        .action(async (task, opts) => {
            if (!opts.prompt || !task) {
                console.error("solver requires --prompt <name> <task>")
                process.exit(1)
            }
            if (Array.isArray(opts.env) && opts.env.length > 0) {
                applyEnvPairs(opts.env)
            }
            const { startSolverTui } = await import("@tch/ui-tui")
            const onEvent = await startSolverTui(task, opts.prompt)
            await runSolverCli({ promptName: opts.prompt, task, onEvent })
        })

    solver
        .command("rpc")
        .description("Start RPC server (container-internal, reads JSONL from stdin)")
        .option("-e, --env <key=value>", "Inject environment variable", collectEnvOption, [] as string[])
        .action(async (opts) => {
            const env = Array.isArray(opts.env) && opts.env.length > 0 ? opts.env : readEnvArgsFromArgv(process.argv)
            await runSolverRpc({ env })
        })

    solver
        .command("list")
        .description("List available prompts")
        .action(async () => {
            const config = await ConfigManager.getInstance()
            const list = await config.listAgentPrompts()
            if (list.length === 0) {
                console.log("No prompts available.")
            } else {
                console.log("Available prompts:")
                for (const p of list) {
                    const desc = p.meta.description ? ` - ${p.meta.description}` : ""
                    console.log(`  ${p.name}${desc}`)
                }
            }
        })

    const subagent = program
        .command("subagent")
        .description("Internal subagent entrypoint")
        .option("-p, --prompt <name>", "Subagent prompt name")
        .argument("<task>", "Task to execute")
        .action(async (task, opts) => {
            if (!opts.prompt || !task) {
                console.error("subagent requires --prompt <name> <task>")
                process.exit(1)
            }
            try {
                await runSubagentCli({
                    promptName: opts.prompt,
                    task,
                })
                process.exit(0)
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error))
                process.exit(1)
            }
        })

    subagent
        .command("list")
        .description("List available subagent prompts")
        .action(async () => {
            const config = await ConfigManager.getInstance()
            const list = await config.listSubagentPrompts()
            if (list.length === 0) {
                console.log("No subagent prompts available.")
            } else {
                console.log("Available subagent prompts:")
                for (const prompt of list) {
                    const desc = prompt.meta.description ? ` - ${prompt.meta.description}` : ""
                    console.log(`  ${prompt.name}${desc}`)
                }
            }
        })

    const engagement = program
        .command("engagement")
        .description("Run an enterprise authorized black-box pentest engagement")

    engagement
        .command("run")
        .description("Bootstrap + run an engagement with the ENGAGEMENT_SOLVER engine")
        .requiredOption("-w, --workspace <dir>", "Engagement workspace directory (solver ctx.cwd)")
        .option("-t, --targets <a,b>", "Authorized targets (comma-separated hosts/IPs/CIDRs)")
        .option("-s, --seeds <u1,u2>", "Seed URLs for RECON (comma-separated)")
        .option("-c, --classes <sqli,xss>", "OWASP vuln classes to cover (comma-separated)")
        .option("-d, --depth <depth>", "Test depth: quick | standard | deep", "standard")
        .option("-r, --red-line <line>", "Destructiveness red line: poc-safe | read-only", "poc-safe")
        .argument("<task>", "Task to execute")
        .action(async (task, opts) => {
            if (!task) {
                console.error("engagement run requires <task>")
                process.exit(1)
            }
            const workspaceDir = resolve(String(opts.workspace))
            const authorizedTargets = splitList(opts.targets)
            const seeds = splitList(opts.seeds)
            const policy: TestPolicy = {
                vulnClasses: parseOwaspClasses(opts.classes),
                depth: parseTestDepth(opts.depth),
                redLine: parseRedLine(opts.redLine),
            }
            const engagementId = basename(workspaceDir) || crypto.randomUUID().slice(0, 8)
            const solverId = crypto.randomUUID().slice(0, 8)

            await runEngagement({
                engagementId,
                workspaceDir,
                task,
                solverId,
                bootstrap: { engagementId, workspaceDir, authorizedTargets, seeds, policy },
                onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
            })
        })

    program.parse()
}

await main().catch((error) => {
    console.error("[host] fatal startup error", formatError(error))
    process.exit(1)
})
