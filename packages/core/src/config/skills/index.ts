import { resolve, dirname } from "path"
import { mkdir } from "fs/promises"
import { existsSync, readdirSync, statSync } from "fs"
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent"
import type { Skill } from "@mariozechner/pi-coding-agent"
import { BUILTIN_SKILL_FILES } from "../builtin-assets.generated"

/** 将内置 skills 释放到用户 config 目录（仅首次 / 有更新时） */
export async function initBuiltinSkills(dir: string) {
    const destBase = resolve(dir, "skills")
    await mkdir(destBase, { recursive: true })
    const builtinSkillFiles = BUILTIN_SKILL_FILES as unknown as Record<string, string>

    for (const [relativePath, sourcePath] of Object.entries(builtinSkillFiles)) {
        const destPath = resolve(destBase, relativePath)
        await mkdir(dirname(destPath), { recursive: true })
        await Bun.write(destPath, Bun.file(sourcePath))
    }
}

// ── 目录发现 ──

export function listSkills(dir: string): Skill[] {
    const userDir = resolve(dir, "skills")
    return existsSync(userDir) ? loadSkillsFromDir({ dir: userDir, source: "user" }).skills : []
}

export function getSkill(dir: string, name: string): Skill | undefined {
    return listSkills(dir).find((s) => s.name === name)
}

// ── CRUD ──

export async function removeSkill(dir: string, name: string) {
    const dest = resolve(dir, "skills", name)
    const { rm } = await import("fs/promises")
    await rm(dest, { recursive: true, force: true })
}

// ── Install helpers ──

/** 递归复制目录，排除指定条目 */
async function copyDir(src: string, dest: string, exclude: string[]) {
    const { readdirSync, statSync } = await import("fs")
    for (const entry of readdirSync(src)) {
        if (exclude.includes(entry)) continue
        const srcPath = resolve(src, entry)
        const destPath = resolve(dest, entry)
        if (statSync(srcPath).isDirectory()) {
            await mkdir(destPath, { recursive: true })
            await copyDir(srcPath, destPath, exclude)
        } else {
            await Bun.write(destPath, Bun.file(srcPath))
        }
    }
}

/** 在目录树中找到包含 SKILL.md 的根目录（检查根 + 一层子目录） */
function findSkillRoot(baseDir: string): string | null {
    const { readdirSync, statSync, existsSync } = require("fs")
    if (existsSync(resolve(baseDir, "SKILL.md"))) return baseDir
    for (const entry of readdirSync(baseDir)) {
        const sub = resolve(baseDir, entry)
        if (statSync(sub).isDirectory() && existsSync(resolve(sub, "SKILL.md"))) {
            return sub
        }
    }
    return null
}

/** 从 zip 安装 skill */
export async function addSkillFromZip(dir: string, zipData: ArrayBuffer): Promise<{ name: string }> {
    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-"))
    try {
        const zipPath = resolve(tmpDir, "skill.zip")
        await Bun.write(zipPath, zipData)

        const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", tmpDir], { stdout: "ignore", stderr: "pipe" })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`unzip failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(tmpDir)
        if (!skillRoot) throw new Error("zip 中未找到 SKILL.md")

        const skillName = skillRoot === tmpDir ? "unnamed-skill" : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, ["skill.zip", "__MACOSX"])

        return { name: skillName }
    } finally {
        const { rm: rmTmp } = await import("fs/promises")
        await rmTmp(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}

/** 从 Git 仓库安装 skill */
export async function addSkillFromGit(dir: string, url: string): Promise<{ name: string }> {
    const repoName = url
        .replace(/\.git$/, "")
        .split("/")
        .pop()
    if (!repoName) throw new Error("无法从 URL 提取仓库名")

    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-git-"))

    try {
        const cloneDir = resolve(tmpDir, repoName)
        const proc = Bun.spawn(["git", "clone", "--depth", "1", url, cloneDir], {
            stdout: "ignore",
            stderr: "pipe",
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`git clone failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(cloneDir)
        if (!skillRoot) throw new Error("仓库中未找到 SKILL.md")

        const skillName = skillRoot === cloneDir ? repoName : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, [".git"])

        return { name: skillName }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}
