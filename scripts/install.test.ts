import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

const installScript = join(import.meta.dir, "install.ts")

test("install script forwards bun install arguments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tch-agent-install-test-"))
    const projectDir = join(tempDir, "project")
    const scriptDir = join(projectDir, "scripts")
    const fakeBinDir = join(tempDir, "bin")
    const installLog = join(tempDir, "installs.log")

    await mkdir(scriptDir, { recursive: true })
    await mkdir(fakeBinDir, { recursive: true })
    await Bun.write(join(scriptDir, "install.ts"), Bun.file(installScript))
    await Bun.write(join(projectDir, "package.json"), "{}")
    await Bun.write(
        join(fakeBinDir, "bun"),
        `#!/bin/sh
if [ "$1" = "install" ]; then
  printf "%s\\t%s\\n" "$(pwd)" "$*" >> "${installLog}"
  exit 0
fi
exec "${process.execPath}" "$@"
`,
    )
    await Bun.spawn(["chmod", "+x", join(fakeBinDir, "bun")]).exited

    const proc = Bun.spawn([process.execPath, "run", join(scriptDir, "install.ts"), "--verbose", "--linker", "hoisted"], {
        cwd: projectDir,
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)

    const installs = (await Bun.file(installLog).text()).trim().split("\n")
    expect(installs).toEqual([`${await realpath(projectDir)}\tinstall --verbose --linker hoisted`])
})
