import tailwind from "bun-plugin-tailwind"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { generateBuiltinAssets } from "./generate-builtin-assets"

type BuildTarget =
    | "bun-linux-x64"
    | "bun-linux-x64-baseline"
    | "bun-linux-arm64"
    | "bun-darwin-x64"
    | "bun-darwin-arm64"
    | "bun-windows-x64"
    | "bun-windows-x64-baseline"

const projectRoot = resolve(import.meta.dir, "..")
const entrypoint = resolve(projectRoot, "apps/cli/src/main.ts")
const workspaceAliases = {
    "@tch/core": resolve(projectRoot, "packages/core/src/index.ts"),
    "@tch/ui-web": resolve(projectRoot, "packages/ui-web/src/index.ts"),
    "@tch/ui-tui": resolve(projectRoot, "packages/ui-tui/src/index.ts"),
    "pi-mcp-adapter": resolve(projectRoot, "packages/libs/pi-mcp-adapter/index.ts"),
} as const
const workspaceResolver: Bun.BunPlugin = {
    name: "workspace-resolver",
    setup(build) {
        build.onResolve({ filter: /^(@tch\/(core|ui-web|ui-tui)|pi-mcp-adapter)$/ }, (args) => ({
            path: workspaceAliases[args.path as keyof typeof workspaceAliases],
        }))
    },
}
const runtimeAssetsDir = resolve(projectRoot, "packages/core/src/runtime/assets")
const embeddedLinuxSolverFallbackPath = resolve(runtimeAssetsDir, "Dockerfile")
let embeddedLinuxSolverImportPath = embeddedLinuxSolverFallbackPath
const embeddedLinuxSolverResolver: Bun.BunPlugin = {
    name: "embedded-linux-solver-resolver",
    setup(build) {
        build.onResolve({ filter: /^tch-agent:embedded-linux-solver$/ }, () => ({ path: embeddedLinuxSolverImportPath }))
    },
}
const target = process.argv[2] as BuildTarget | undefined
const outfile = process.argv[3]

if (!target || !outfile) {
    console.error("usage: bun run scripts/build.ts <target> <outfile>")
    process.exit(1)
}

const buildTarget: BuildTarget = target

function shouldEmbedLinuxSolverBinary(buildTarget: BuildTarget): boolean {
    return buildTarget !== "bun-linux-x64" && buildTarget !== "bun-linux-x64-baseline"
}

interface EmbeddedLinuxSolverBuild {
    path: string
    tempDir: string
}

async function buildEmbeddedLinuxSolverBinary(): Promise<EmbeddedLinuxSolverBuild | undefined> {
    if (!shouldEmbedLinuxSolverBinary(buildTarget)) return

    const tempDir = await mkdtemp(resolve(tmpdir(), "tch-agent-embedded-solver-"))
    const path = resolve(tempDir, "tch-agent-linux-x64")
    const proc = Bun.spawn(["bun", resolve(projectRoot, "scripts/build.ts"), "bun-linux-x64-baseline", path], {
        cwd: projectRoot,
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        await rm(tempDir, { recursive: true, force: true })
        throw new Error(`failed to build embedded linux solver binary (exit ${exitCode})`)
    }
    return { path, tempDir }
}

const embeddedLinuxSolver = await buildEmbeddedLinuxSolverBinary()
embeddedLinuxSolverImportPath = embeddedLinuxSolver?.path ?? embeddedLinuxSolverFallbackPath
await generateBuiltinAssets()
await mkdir(dirname(outfile), { recursive: true })

const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: dirname(outfile),
    naming: {
        entry: dirname(outfile) === "." ? "[dir]/[name]" : "[name]",
    },
    compile: {
        outfile,
        target: buildTarget,
    },
    plugins: [workspaceResolver, embeddedLinuxSolverResolver, tailwind],
})

if (embeddedLinuxSolver) await rm(embeddedLinuxSolver.tempDir, { recursive: true, force: true })

if (!result.success) {
    for (const log of result.logs) console.error(log.message)
    process.exit(1)
}
