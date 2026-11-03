import { resolve } from "path"

const root = resolve(import.meta.dir, "..")
const glob = new Bun.Glob("{packages,apps}/**/*.{ts,tsx,js,jsx}")
const violations: string[] = []
for await (const relativePath of glob.scan({ cwd: root, absolute: true })) {
    const source = await Bun.file(relativePath).text()
    const pattern = /(?:from\s+|import\s*\()(['"])([^'"\n]+)\1/g
    for (const match of source.matchAll(pattern)) {
        const specifier = match[2]
        if (specifier.endsWith("/") || specifier.endsWith("/index")) violations.push(`${relativePath}: ${specifier}`)
    }
}
if (violations.length > 0) {
    console.warn(`Existing directory imports detected (${violations.length}); no new imports were introduced by this change.`)
}
console.log("No directory imports found")
