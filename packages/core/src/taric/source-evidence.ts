import { resolve } from "node:path"

export interface TaricSourceIdentity {
    revision: string
    digest: string
    fileCount: number
}

/** Bind evidence to file contents, including uncommitted and untracked code. */
export async function readTaricSourceIdentity(projectRoot: string): Promise<TaricSourceIdentity> {
    const roots = ["packages", "apps", "scripts", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"]
    const pathsProcess = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...roots], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" })
    const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" })
    const [pathsText, revisionText, pathsExit, revisionExit] = await Promise.all([
        new Response(pathsProcess.stdout).text(), new Response(revisionProcess.stdout).text(), pathsProcess.exited, revisionProcess.exited,
    ])
    if (pathsExit !== 0 || revisionExit !== 0) throw new Error("source identity requires a readable Git checkout")
    const hasher = new Bun.CryptoHasher("sha256")
    const paths = [...new Set(pathsText.split("\0").filter(Boolean))].sort()
    let fileCount = 0
    for (const path of paths) {
        const file = Bun.file(resolve(projectRoot, path))
        if (!await file.exists()) {
            hasher.update(`${path}\0deleted\0`)
            continue
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        hasher.update(`${path}\0${bytes.byteLength}\0`)
        hasher.update(bytes)
        fileCount += 1
    }
    return { revision: revisionText.trim(), digest: `sha256:${hasher.digest("hex")}`, fileCount }
}
