import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { ENGAGEMENT_POLICY_FILE, bootstrapEngagement, type EngagementPolicyRecord } from "./bootstrap"
import { ENGAGEMENT_ENV_DIR, ENGAGEMENT_ENV_ID } from "./env"
import { readEngagementCompletion } from "./oracle"
import { readRunPolicy, readRunState } from "../config/tools/pentest-workspace"
import type { TestPolicy } from "./policy"

const created: string[] = []

async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "engagement-bootstrap-"))
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
        depth: "deep",
        redLine: "poc-safe",
        rateLimit: { maxToolCalls: 500 },
        ...overrides,
    }
}

describe("bootstrapEngagement", () => {
    test("writes run-policy.json with compiled allowed_targets", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com", "10.0.0.0/24"],
            seeds: ["https://api.corp.com/"],
            policy: makePolicy(),
        })

        const runPolicy = await readRunPolicy(dir)
        expect(runPolicy.allowed_targets).toEqual(["api.corp.com", "10.0.0.0/24"])
        expect(runPolicy.recon.profile).toBe("deep")
    })

    test("writes engagement-policy.json preserving vulnClasses + seeds", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: ["https://api.corp.com/", " "],
            policy: makePolicy({ vulnClasses: ["sqli", "xss", "ssti"] }),
        })

        const record: EngagementPolicyRecord = await Bun.file(join(dir, ENGAGEMENT_POLICY_FILE)).json()
        expect(record.engagementId).toBe("eng-42")
        expect(record.policy.vulnClasses).toEqual(["sqli", "xss", "ssti"])
        expect(record.authorizedTargets).toEqual(["api.corp.com"])
        expect(record.seeds).toEqual(["https://api.corp.com/"])
    })

    test("initializes run-state.json at phase=SCOPE", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy(),
        })

        const state = await readRunState(dir)
        expect(state.current_phase).toBe("SCOPE")
        expect(state.completed_phases).toEqual([])
        expect(state.goal_achieved).toBe(false)
    })

    test("returns env with ENGAGEMENT_ID/DIR", async () => {
        const dir = await makeTmpDir()
        const { env } = await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy(),
        })

        expect(env[ENGAGEMENT_ENV_ID]).toBe("eng-42")
        expect(env[ENGAGEMENT_ENV_DIR]).toBe(dir)
    })

    test("Slice-1 linkage: readEngagementCompletion is in_progress after bootstrap", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy(),
        })

        const completion = await readEngagementCompletion(dir)
        expect(completion.complete).toBe(false)
        expect(completion.reason).toBe("in_progress")
    })

    test("idempotent: re-bootstrap keeps existing findings, refreshes run-policy", async () => {
        const dir = await makeTmpDir()
        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com"],
            seeds: [],
            policy: makePolicy({ depth: "quick" }),
        })

        const findingsPath = join(dir, "findings.md")
        await Bun.write(findingsPath, "# Findings\n\n- existing finding\n")

        await bootstrapEngagement({
            engagementId: "eng-42",
            workspaceDir: dir,
            authorizedTargets: ["api.corp.com", "app.corp.com"],
            seeds: [],
            policy: makePolicy({ depth: "deep" }),
        })

        // findings preserved
        expect(await Bun.file(findingsPath).text()).toContain("existing finding")
        // run-policy refreshed to latest compiled policy
        const runPolicy = await readRunPolicy(dir)
        expect(runPolicy.recon.profile).toBe("deep")
        expect(runPolicy.allowed_targets).toEqual(["api.corp.com", "app.corp.com"])
    })
})
