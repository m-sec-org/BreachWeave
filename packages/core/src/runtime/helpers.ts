import { createHash } from "node:crypto"
import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import type { Message } from "@mariozechner/pi-ai"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { TCH_AGENT_HOME_DIR } from "../config/index"
import { RUNTIME_ASSET_FILES } from "../config/builtin-assets.generated"
import { solverDir } from "./types"

const DOCKERFILE_HASH_LABEL = "ai.tch-agent.dockerfile-sha256"
const RUNTIME_IMAGE_ARCH = "amd64"
const RUNTIME_DIR = resolve(TCH_AGENT_HOME_DIR, "runtime")
const RUNTIME_SELF_DIR = resolve(RUNTIME_DIR, "self")
const GENERATED_RUNTIME_PACKAGE_JSON = {
    name: "tch-agent-runtime",
    version: "0.0.1",
    private: true,
    type: "module",
}

export { DOCKERFILE_HASH_LABEL, RUNTIME_IMAGE_ARCH }

export function hashDockerfileContent(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

export function getAgentEndError(event: AgentSessionEvent): string | undefined {
    if (event.type !== "agent_end") return

    for (let i = event.messages.length - 1; i >= 0; i -= 1) {
        const message = event.messages[i]
        if (message.role !== "assistant") continue
        if (message.stopReason !== "error") return
        return message.errorMessage ?? "Agent ended with an unknown error"
    }

    return
}

export function getAssistantError(messages: Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message.role !== "assistant") continue
        if (message.stopReason !== "error") continue
        return message.errorMessage
    }
    return
}

async function listJsonlFiles(dir: string): Promise<string[]> {
    try {
        const files = await readdir(dir)
        return files.filter((file) => file.endsWith(".jsonl")).sort().map((file) => resolve(dir, file))
    } catch {
        return []
    }
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

export async function readMessagesFromSessionDir(dir: string): Promise<{ messages: Message[]; sessionId?: string; createdAt?: number }> {
    const files = await listJsonlFiles(dir)
    const messages: Message[] = []
    let sessionId: string | undefined
    let createdAt: number | undefined

    for (const file of files) {
        const text = await Bun.file(file).text().catch(() => "")
        for (const rawLine of text.split("\n")) {
            const line = rawLine.trim()
            if (!line) continue
            let parsed: unknown
            try {
                parsed = JSON.parse(line)
            } catch {
                continue
            }
            if (!parsed || typeof parsed !== "object") continue
            const entry = parsed as { type?: string; id?: string; timestamp?: string; message?: Message }
            if (entry.type === "session") {
                if (!sessionId && entry.id) sessionId = entry.id
                if (!createdAt && entry.timestamp) {
                    const ts = Date.parse(entry.timestamp)
                    if (!Number.isNaN(ts)) createdAt = ts
                }
            }
            if (entry.type === "message" && entry.message) {
                messages.push(entry.message)
            }
        }
    }

    return { messages, sessionId, createdAt }
}

export async function readStartup(path: string): Promise<unknown | undefined> {
    try {
        const text = await Bun.file(path).text()
        if (!text.trim()) return undefined
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

export async function getStableSolverCreatedAt(solverId: string, startup: unknown, sessionCreatedAt?: number): Promise<number> {
    if (sessionCreatedAt) return sessionCreatedAt

    if (startup && typeof startup === "object" && "createdAt" in startup) {
        const createdAt = (startup as { createdAt?: unknown }).createdAt
        if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt
    }

    try {
        const info = await stat(solverDir(solverId))
        return info.mtimeMs
    } catch {
        return 0
    }
}

export async function ensureSolverBinary(): Promise<string> {
    const binDir = RUNTIME_SELF_DIR
    const binPath = resolve(binDir, "tch-agent-linux-x64")
    const projectRoot = resolve(import.meta.dir, "../../../..")
    const buildScript = resolve(projectRoot, "scripts/build.ts")

    await mkdir(binDir, { recursive: true })
    const proc = Bun.spawn(["bun", buildScript, "bun-linux-x64-baseline", binPath], { cwd: projectRoot, stdout: "inherit", stderr: "inherit" })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`Failed to compile solver binary (exit ${exitCode})`)
    }
    await Bun.write(resolve(binDir, "package.json"), JSON.stringify(GENERATED_RUNTIME_PACKAGE_JSON, null, 2))
    return binPath
}

async function ensureEmbeddedLinuxSolverBinary(): Promise<string> {
    const binDir = RUNTIME_SELF_DIR
    const binPath = resolve(binDir, "tch-agent-linux-x64")
    await mkdir(binDir, { recursive: true })
    const embedded = await import("tch-agent:embedded-linux-solver", { with: { type: "file" } })
    await Bun.write(binPath, Bun.file(embedded.default))
    await Bun.write(resolve(binDir, "package.json"), JSON.stringify(GENERATED_RUNTIME_PACKAGE_JSON, null, 2))
    return binPath
}

async function ensureRuntimePackageManifest(): Promise<string> {
    const binDir = RUNTIME_SELF_DIR
    const path = resolve(binDir, "package.json")
    await mkdir(binDir, { recursive: true })
    await Bun.write(path, JSON.stringify(GENERATED_RUNTIME_PACKAGE_JSON, null, 2))
    return path
}

export async function resolveSolverInjection(): Promise<{ binds: string[]; cmd: string[] }> {
    const execPath = process.execPath
    const bunRuntime = isBunRuntime()

    let binary: string
    const packageJson = await ensureRuntimePackageManifest()

    if (bunRuntime) {
        binary = await ensureSolverBinary()
    } else if (process.platform === "linux" && process.arch === "x64") {
        binary = execPath
    } else {
        binary = await ensureEmbeddedLinuxSolverBinary()
    }

    return {
        binds: [`${binary}:/opt/tch-agent/tch-agent:ro`, `${packageJson}:/opt/tch-agent/package.json:ro`],
        cmd: ["/opt/tch-agent/tch-agent", "solver", "rpc"],
    }
}

function isBunRuntime(): boolean {
    const execName = basename(process.execPath).toLowerCase()
    return execName === "bun" || execName === "bun.exe"
}

export async function resolveDockerfilePath(onProgress?: (message: string) => void): Promise<string> {
    const targetDockerfile = resolve(RUNTIME_DIR, "Dockerfile")
    for (const [relativePath, sourcePath] of Object.entries(RUNTIME_ASSET_FILES)) {
        const targetPath = resolve(RUNTIME_DIR, relativePath)
        await mkdir(dirname(targetPath), { recursive: true })
        await Bun.write(targetPath, Bun.file(sourcePath))
    }
    onProgress?.(`Synced runtime assets to ${RUNTIME_DIR}`)

    return targetDockerfile
}
