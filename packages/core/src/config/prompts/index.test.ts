import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import * as prompts from "./index"

let configDir: string

beforeEach(async () => {
    configDir = await mkdtemp(resolve(tmpdir(), "tch-prompt-fallback-test-"))
})

afterEach(async () => {
    await rm(configDir, { recursive: true, force: true })
})

describe("builtin prompt fallback", () => {
    test("loads and lists a missing builtin solver without initialization", async () => {
        const promptFile = Bun.file(resolve(configDir, "prompts", "msec-security.md"))
        expect(await promptFile.exists()).toBe(false)

        const prompt = await prompts.loadPrompt(configDir, "msec-security")
        const listed = await prompts.listPrompts(configDir)
        const agents = await prompts.listAgentPrompts(configDir)

        expect(prompt).toMatchObject({ name: "msec-security", builtin: true })
        expect(prompt?.content).toContain("安全分析专家")
        expect(prompt?.meta.tools).toContain("bash")
        expect(listed.find((item) => item.name === "msec-security")).toEqual(prompt)
        expect(agents.find((item) => item.name === "msec-security")).toEqual(prompt)
        expect(await promptFile.exists()).toBe(false)
    })

    test("keeps an explicitly deleted builtin unavailable after initialization", async () => {
        await mkdir(resolve(configDir, "prompts"))
        await prompts.removePrompt(configDir, "msec-security")
        await prompts.initBuiltinPrompts(configDir)

        expect(await prompts.loadPrompt(configDir, "msec-security")).toBeUndefined()
        expect(await Bun.file(resolve(configDir, "prompts", "msec-security.md")).exists()).toBe(false)
        const listed = await prompts.listPrompts(configDir)
        expect(listed.find((item) => item.name === "msec-security")).toMatchObject({
            builtin: true,
            deleted: true,
            content: "",
        })
        expect(listed.filter((item) => item.deleted !== true).map((item) => item.name)).not.toContain("msec-security")
    })

    test("uses the builtin planner body while preserving configured metadata", async () => {
        const builtin = await prompts.loadPrompt(configDir, prompts.CHALLENGE_PLANNER_PROMPT_NAME)
        await mkdir(resolve(configDir, "prompts"))
        const raw = '---\nmodel: "bfcf7b40"\ntools:\n  - "challenge_submit_report"\n---\n\n  \n'
        const promptFile = Bun.file(resolve(configDir, "prompts", `${prompts.CHALLENGE_PLANNER_PROMPT_NAME}.md`))
        await Bun.write(promptFile, raw)

        const prompt = await prompts.loadPrompt(configDir, prompts.CHALLENGE_PLANNER_PROMPT_NAME)

        expect(prompt?.meta.model).toBe("bfcf7b40")
        expect(prompt?.meta.tools).toEqual(["challenge_submit_report"])
        expect(prompt?.content).toBe(builtin?.content)
        expect(prompt?.content).toContain("{{AVAILABLE_SOLVER_PROMPTS}}")
        expect(prompt?.content).toContain("{{CHALLENGE_STATE}}")
        expect(await promptFile.text()).toBe(raw)
    })
})
