import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { relative, resolve, sep } from "node:path"
import { TARIC_ARTIFACT_MANIFEST } from "../packages/core/src/taric/compatibility"
import { getTaricArtifactDigests, TARIC_VERIFICATION_CHECKS, type TaricDeploymentProfile, type TaricVerificationReport } from "../packages/core/src/taric/verification"

const projectRoot = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const profileArg = args.find((value) => value.startsWith("--profile="))?.slice("--profile=".length)
const selectedProfile = (profileArg ?? process.env.TARIC_VERIFICATION_PROFILE ?? "authenticated_proxy") as TaricDeploymentProfile
if (selectedProfile !== "authenticated_proxy" && selectedProfile !== "embedded_bun") {
    throw new Error(`unsupported Taric profile: ${selectedProfile}`)
}

const configDir = process.env.TCH_CONFIG_DIR?.trim() || resolve(homedir(), ".tch-agent", "config")
const reportPath = process.env.TARIC_VERIFICATION_REPORT_PATH?.trim() || resolve(configDir, "taric-verification.json")
const buildTarget = process.platform === "darwin"
    ? process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
    : process.platform === "win32"
        ? "bun-windows-x64-baseline"
        : process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"
const tempDir = await mkdtemp(resolve(tmpdir(), "breachweave-taric-verification-"))
const commands: Record<(typeof TARIC_VERIFICATION_CHECKS)[number], string[]> = {
    typecheck: ["bun", "run", "typecheck"],
    focused: ["bun", "test", "packages/core/src/challenge", "packages/core/src/runtime", "packages/core/src/taric", "packages/core/src/project"],
    core: ["bun", "test", "packages/core"],
    build: ["bun", "run", "scripts/build.ts", buildTarget, resolve(tempDir, process.platform === "win32" ? "tch-agent.exe" : "tch-agent")],
}
const results: TaricVerificationReport["checks"] = {} as TaricVerificationReport["checks"]

try {
    for (const name of TARIC_VERIFICATION_CHECKS) {
        const command = commands[name]
        const processResult = Bun.spawn(command, { cwd: projectRoot, stdout: "inherit", stderr: "inherit", env: process.env })
        const exitCode = await processResult.exited
        results[name] = { exitCode, command: command.join(" ") }
    }
} finally {
    await rm(tempDir, { recursive: true, force: true })
}

let sourceRevision = "unknown"
const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" })
if (await revisionProcess.exited === 0) sourceRevision = (await new Response(revisionProcess.stdout).text()).trim() || "unknown"
const reportRelativePath = relative(projectRoot, resolve(reportPath)).split(sep).join("/")
const reportPathInRepo = !reportRelativePath.startsWith("..") && !reportRelativePath.startsWith("/")
const [statusProcess, diffProcess, untrackedProcess] = [
    Bun.spawn(["git", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" }),
    Bun.spawn(["git", "diff", "HEAD", "--binary", ...(reportPathInRepo ? ["--", ".", `:(exclude)${reportRelativePath}`] : [])], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" }),
    Bun.spawn(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" }),
]
const [statusBytes, diffBytes, untrackedBytes] = await Promise.all([
    new Response(statusProcess.stdout).arrayBuffer(),
    new Response(diffProcess.stdout).arrayBuffer(),
    new Response(untrackedProcess.stdout).arrayBuffer(),
])
await Promise.all([statusProcess.exited, diffProcess.exited, untrackedProcess.exited])
const statusLines = new TextDecoder().decode(statusBytes).split("\n").filter((line) => line && (!reportPathInRepo || !line.endsWith(` ${reportRelativePath}`)))
const worktreeHasher = new Bun.CryptoHasher("sha256")
worktreeHasher.update(new TextEncoder().encode(statusLines.join("\n")))
worktreeHasher.update(diffBytes)
const untrackedPaths = new TextDecoder().decode(untrackedBytes).split("\0").filter((path) => path && (!reportPathInRepo || path !== reportRelativePath)).sort()
for (const path of untrackedPaths) {
    worktreeHasher.update(new TextEncoder().encode(`${path}\0`))
    const file = Bun.file(resolve(projectRoot, path))
    if (await file.exists()) worktreeHasher.update(new Uint8Array(await file.arrayBuffer()))
}
const report: TaricVerificationReport = {
    format: "breachweave-taric-verification/1",
    generatedAt: new Date().toISOString(),
    selectedProfile,
    status: TARIC_VERIFICATION_CHECKS.every((name) => results[name]?.exitCode === 0) ? "passed" : "blocked",
    sourceRevision,
    worktree: {
        dirtyPathCount: statusLines.length,
        digest: `sha256:${worktreeHasher.digest("hex")}`,
    },
    checks: results,
    artifactDigests: getTaricArtifactDigests(),
}
await mkdir(resolve(reportPath, ".."), { recursive: true })
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`[taric] verification ${report.status} for ${selectedProfile}; report: ${reportPath}`)
console.log(`[taric] source revision: ${sourceRevision}`)
for (const [name, artifact] of Object.entries({ ...TARIC_ARTIFACT_MANIFEST.packages, ...TARIC_ARTIFACT_MANIFEST.upstreamComponents })) {
    console.log(`[taric] artifact ${name}@${artifact.version} ${artifact.integrity}`)
}
if (report.status !== "passed") process.exitCode = 1
