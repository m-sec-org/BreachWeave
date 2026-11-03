import { test, expect } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTaricSourceIdentity } from "./source-evidence"

test("source evidence changes with untracked source edits and ignores generated reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "taric-source-evidence-"))
    async function git(args: string[]): Promise<void> {
        const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })
        if (await process.exited !== 0) throw new Error("fixture Git setup failed")
    }
    try {
        await git(["init"])
        await Bun.write(join(root, "package.json"), '{"name":"source-fixture"}')
        await git(["add", "package.json"])
        await git(["-c", "user.name=Test Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
        await mkdir(join(root, "packages"))
        const first = await readTaricSourceIdentity(root)
        await Bun.write(join(root, "packages", "fixture.ts"), "export const version = 1")
        const second = await readTaricSourceIdentity(root)
        expect(second.digest).not.toBe(first.digest)
        expect(second.fileCount).toBe(first.fileCount + 1)
        await Bun.write(join(root, "packages", "fixture.ts"), "export const version = 2")
        const third = await readTaricSourceIdentity(root)
        expect(third.digest).not.toBe(second.digest)
        await Bun.write(join(root, "docs", "report.json"), '{"status":"passed"}')
        expect(await readTaricSourceIdentity(root)).toEqual(third)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
