import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { bootstrapEngagement } from "./bootstrap"
import type { TestPolicy } from "./policy"
import { buildEngagementSolverGuidance, readEngagementSolverGuidance } from "./solver-guidance"

const created: string[] = []

async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "engagement-guidance-"))
    created.push(dir)
    return dir
}

afterEach(async () => {
    while (created.length > 0) {
        const dir = created.pop()!
        await rm(dir, { recursive: true, force: true })
    }
})

function makePolicy(overrides?: Partial<TestPolicy>): TestPolicy {
    return {
        vulnClasses: ["sqli", "ssrf", "idor"],
        depth: "standard",
        redLine: "poc-safe",
        ...overrides,
    }
}

describe("buildEngagementSolverGuidance", () => {
    test("includes selected vuln classes", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy({ vulnClasses: ["sqli", "xss", "ssti"] }),
            allowedTargets: ["api.corp.com"],
            phase: "RECON",
            seeds: [],
        })
        expect(guidance).toContain("SQLi")
        expect(guidance).toContain("XSS")
        expect(guidance).toContain("SSTI")
    })

    test("emphasizes the current phase", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "TEST",
            seeds: [],
        })
        expect(guidance).toContain("Phase Workflow")
        expect(guidance).toContain("▶ TEST")
        expect(guidance).toContain("当前阶段")
    })

    test("lists allowed targets", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com", "10.0.0.0/24"],
            phase: "SCOPE",
            seeds: [],
        })
        expect(guidance).toContain("api.corp.com")
        expect(guidance).toContain("10.0.0.0/24")
    })

    test("poc-safe red line allows non-destructive PoC forensics", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy({ redLine: "poc-safe" }),
            allowedTargets: ["api.corp.com"],
            phase: "TEST",
            seeds: [],
        })
        expect(guidance).toContain("PoC-safe")
        expect(guidance).toContain("非破坏")
    })

    test("read-only red line forbids exploitation", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy({ redLine: "read-only" }),
            allowedTargets: ["api.corp.com"],
            phase: "TEST",
            seeds: [],
        })
        expect(guidance).toContain("只读")
        expect(guidance).toContain("禁止")
    })

    test("hints document_finding usage", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "DOCUMENT",
            seeds: [],
        })
        expect(guidance).toContain("document_finding")
    })

    test("instructs advancing phases and generating the report", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "REPORT",
            seeds: [],
        })
        expect(guidance).toContain("engagement_transition_phase")
        expect(guidance).toContain("generate_engagement_report")
    })

    test("renders seeds when provided", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "RECON",
            seeds: ["https://api.corp.com/login"],
        })
        expect(guidance).toContain("https://api.corp.com/login")
    })

    test("contains no CTF or flag language", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "TEST",
            seeds: ["https://api.corp.com/"],
        })
        expect(guidance.toLowerCase()).not.toContain("flag")
        expect(guidance.toLowerCase()).not.toContain("ctf")
        expect(guidance).not.toContain("赛题")
    })

    test("includes sub-agent delegation guidance referencing the real subagent tool + spawn→submit→ingest loop", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "RECON",
            seeds: [],
        })
        expect(guidance).toContain("subagent")
        expect(guidance).toContain("ENGAGEMENT_RECON")
        expect(guidance).toContain("ENGAGEMENT_TARGETED_PENTEST")
        expect(guidance).toContain("ENGAGEMENT_PAYLOAD_RESEARCH")
        expect(guidance).toContain("submit_sub_agent_output")
        expect(guidance).toContain("ingest_sub_agent_output")
    })

    test("emphasizes RECON delegation in the RECON phase", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "RECON",
            seeds: [],
        })
        expect(guidance).toContain('subagent(agent="ENGAGEMENT_RECON")')
    })

    test("emphasizes targeted-pentest delegation in the TEST phase", () => {
        const guidance = buildEngagementSolverGuidance({
            policy: makePolicy(),
            allowedTargets: ["api.corp.com"],
            phase: "TEST",
            seeds: [],
        })
        expect(guidance).toContain("当前处于 TEST")
        expect(guidance).toContain("ENGAGEMENT_TARGETED_PENTEST")
    })
})

describe("readEngagementSolverGuidance", () => {
    test("after a real bootstrap returns non-empty guidance with policy classes + phase", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-guidance",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: ["https://api.corp.com/"],
            policy: makePolicy({ vulnClasses: ["sqli", "xss"] }),
        })

        const guidance = await readEngagementSolverGuidance(dir)
        expect(guidance.length).toBeGreaterThan(0)
        expect(guidance).toContain("SQLi")
        expect(guidance).toContain("XSS")
        // bootstrap initializes run-state at SCOPE
        expect(guidance).toContain("▶ SCOPE")
        expect(guidance).toContain("https://api.corp.com/")
    })

    test("missing engagement dir yields tolerant non-empty guidance (never throws)", async () => {
        const dir = await makeTmpDir()
        const guidance = await readEngagementSolverGuidance(join(dir, "does-not-exist"))
        expect(guidance.length).toBeGreaterThan(0)
        expect(guidance).toContain("Engagement Solver Guidance")
        expect(guidance).toContain("▶ SCOPE")
    })
})
