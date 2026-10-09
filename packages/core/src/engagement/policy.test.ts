import { describe, expect, test } from "bun:test"
import { READ_ONLY_FORBIDDEN_COMMANDS, compileTestPolicy, type TestPolicy } from "./policy"
import { DEFAULT_RUN_POLICY, type RunPolicy } from "../config/tools/pentest-workspace"

function makePolicy(overrides?: Partial<TestPolicy>): TestPolicy {
    return {
        vulnClasses: ["sqli", "xss"],
        depth: "standard",
        redLine: "poc-safe",
        ...overrides,
    }
}

describe("compileTestPolicy", () => {
    test("authorizedTargets → allowed_targets (trimmed, empty dropped)", () => {
        const policy = makePolicy()
        const compiled = compileTestPolicy(policy, [" api.corp.com ", "10.0.0.0/24", "  "])
        expect(compiled.allowed_targets).toEqual(["api.corp.com", "10.0.0.0/24"])
    })

    test("depth deep → recon deep + highest per-role budgets", () => {
        const quick = compileTestPolicy(makePolicy({ depth: "quick" }), ["api.corp.com"])
        const standard = compileTestPolicy(makePolicy({ depth: "standard" }), ["api.corp.com"])
        const deep = compileTestPolicy(makePolicy({ depth: "deep" }), ["api.corp.com"])

        expect(deep.recon.profile).toBe("deep")
        expect(standard.recon.profile).toBe("standard")
        expect(quick.recon.profile).toBe("quick")

        // deep budgets strictly exceed standard, which strictly exceed quick (per role).
        for (const role of ["recon", "targeted-pentest", "payload-research", "custom"] as const) {
            expect(deep.max_tool_calls[role]!).toBeGreaterThan(standard.max_tool_calls[role]!)
            expect(standard.max_tool_calls[role]!).toBeGreaterThan(quick.max_tool_calls[role]!)
        }
    })

    test("read-only → no_scan=true and forbidden includes exploit tooling", () => {
        const compiled = compileTestPolicy(makePolicy({ redLine: "read-only", depth: "deep" }), ["api.corp.com"])
        expect(compiled.no_scan).toBe(true)
        for (const tool of READ_ONLY_FORBIDDEN_COMMANDS) {
            expect(compiled.forbidden_commands).toContain(tool)
        }
        expect(compiled.forbidden_commands).toContain("sqlmap")
        expect(compiled.forbidden_commands).toContain("nuclei")
        // default scanner block list is still present.
        for (const tool of DEFAULT_RUN_POLICY.forbidden_commands) {
            expect(compiled.forbidden_commands).toContain(tool)
        }
    })

    test("poc-safe keeps default forbidden_commands (no exploit tools added)", () => {
        const compiled = compileTestPolicy(makePolicy({ redLine: "poc-safe", depth: "standard" }), ["api.corp.com"])
        expect(compiled.forbidden_commands).toEqual(DEFAULT_RUN_POLICY.forbidden_commands)
        for (const tool of READ_ONLY_FORBIDDEN_COMMANDS) {
            if (!DEFAULT_RUN_POLICY.forbidden_commands.includes(tool)) {
                expect(compiled.forbidden_commands).not.toContain(tool)
            }
        }
    })

    test("poc-safe deep unlocks scanning (no_scan=false); quick/standard keep no_scan=true", () => {
        expect(compileTestPolicy(makePolicy({ redLine: "poc-safe", depth: "deep" }), []).no_scan).toBe(false)
        expect(compileTestPolicy(makePolicy({ redLine: "poc-safe", depth: "standard" }), []).no_scan).toBe(true)
        expect(compileTestPolicy(makePolicy({ redLine: "poc-safe", depth: "quick" }), []).no_scan).toBe(true)
    })

    test("reentry mirrors DEFAULT_RUN_POLICY.reentry", () => {
        const compiled = compileTestPolicy(makePolicy(), ["api.corp.com"])
        expect(compiled.reentry).toEqual(DEFAULT_RUN_POLICY.reentry)
    })

    test("result is structurally a RunPolicy (round-trips through readRunPolicy shape)", () => {
        const compiled = compileTestPolicy(makePolicy(), ["api.corp.com"])
        // Same top-level keys as DEFAULT_RUN_POLICY — so readRunPolicy reads it back unchanged.
        expect(Object.keys(compiled).sort()).toEqual(Object.keys(DEFAULT_RUN_POLICY).sort())
        const asRunPolicy: RunPolicy = compiled
        expect(typeof asRunPolicy.no_scan).toBe("boolean")
        expect(Array.isArray(asRunPolicy.forbidden_commands)).toBe(true)
        expect(Array.isArray(asRunPolicy.allowed_targets)).toBe(true)
    })
})
