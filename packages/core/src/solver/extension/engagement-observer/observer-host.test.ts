import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// Mock the review runner so importing observer-host does not pull the (absent) SDK.
// observer-host imports observer-loop type-only, so no SDK is loaded at runtime.
mock.module("../challenge-observer/observer-agent", () => ({
    runSolverObserverReview: mock(async () => ({ applied: true })),
}))

const { createEngagementObserverHost, createEngagementReviewHost, ENGAGEMENT_OBSERVER_SYSTEM_PROMPT } = await import("./observer-host")

describe("engagement observer host (de-CTF)", () => {
    beforeEach(() => {
        process.env.ENGAGEMENT_ID = "eng-42"
        process.env.ENGAGEMENT_DIR = "/tmp/eng-workspace"
    })
    afterEach(() => {
        delete process.env.ENGAGEMENT_ID
        delete process.env.ENGAGEMENT_DIR
    })

    test("getId reads ENGAGEMENT_ID (not CHALLENGE env)", () => {
        expect(createEngagementObserverHost().getId()).toBe("eng-42")
    })

    test("force-review triggers only on a successful document_finding", () => {
        const host = createEngagementObserverHost()
        expect(host.forceReviewReason("document_finding", false)).toBe("force")
        expect(host.forceReviewReason("document_finding", true)).toBeUndefined()
        expect(host.forceReviewReason("bash", false)).toBeUndefined()
        expect(host.forceReviewReason("challenge_get_hint", false)).toBeUndefined()
    })

    test("system prompt is pentest-neutral (no CTF flag/hint semantics)", () => {
        expect(ENGAGEMENT_OBSERVER_SYSTEM_PROMPT).toContain("observer sidecar")
        expect(ENGAGEMENT_OBSERVER_SYSTEM_PROMPT).toContain("engagement")
        expect(ENGAGEMENT_OBSERVER_SYSTEM_PROMPT).not.toContain("flag")
        expect(ENGAGEMENT_OBSERVER_SYSTEM_PROMPT).not.toContain("CTF 解题")
        expect(ENGAGEMENT_OBSERVER_SYSTEM_PROMPT).not.toContain("提交 flag")
    })

    test("review host with no context provider does not report completion", async () => {
        const rh = createEngagementReviewHost()
        const resolved = await rh.resolve("eng-42")
        expect(resolved.isComplete).toBe(false)
        expect(resolved.contextBlock).toContain("## Engagement State")
        expect(resolved.contextBlock).toContain("eng-42")
    })
})
