import { dirname, relative, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const skipInstallScript = process.env.TCH_AGENT_SKIP_INSTALL_SCRIPT === "1"
const installArgs = process.argv.slice(2)

if (skipInstallScript) process.exit(0)

async function runInstallIn(cwd: string) {
    const label = relative(projectRoot, cwd) || "."
    console.log(`Installing dependencies in ${label}`)
    const proc = Bun.spawn(["bun", "install", ...installArgs], {
        cwd,
        env: { ...process.env, TCH_AGENT_SKIP_INSTALL_SCRIPT: "1" },
        stdout: "inherit",
        stderr: "inherit",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`bun install failed in ${label} (exit ${exitCode})`)
    }
}

async function listNestedInstallDirs() {
    const dirs = new Set<string>()
    const glob = new Bun.Glob("packages/libs/**/package.json")
    for await (const file of glob.scan({ cwd: projectRoot, absolute: true })) {
        if (file.includes("/node_modules/") || file.includes("/dist/")) continue
        const rel = relative(projectRoot, file)
        if (rel.split("/").length <= 4) continue
        dirs.add(dirname(file))
    }
    return [...dirs].sort()
}

await runInstallIn(projectRoot)

for (const dir of await listNestedInstallDirs()) {
    await runInstallIn(dir)
}
