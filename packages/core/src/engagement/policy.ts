// TestPolicy: the structured, checkbox-style engagement test policy (decision #4).
//
// Pure compilation of a human-authored TestPolicy + authorization scope into the
// pentest-workspace RunPolicy consumed by scope-guard / the phase state machine.
// SDK-free (no @mariozechner/* import) so it is unit-testable without the SDK.

import { DEFAULT_RUN_POLICY, type PolicyRole, type ReconPolicy, type RunPolicy } from "../config/tools/pentest-workspace"

/** OWASP-oriented vulnerability classes the engagement may test (decision #4). */
export type OwaspClass =
    | "sqli"
    | "xss"
    | "ssrf"
    | "auth"
    | "access-control"
    | "injection"
    | "ssti"
    | "xxe"
    | "deserialization"
    | "idor"
    | "file-upload"
    | "path-traversal"

/** Test depth per class — drives recon profile + per-role tool-call budgets. */
export type TestDepth = "quick" | "standard" | "deep"

/** Destructiveness red line (decision #3, default poc-safe). */
export type RedLine = "read-only" | "poc-safe"

export interface TestPolicy {
    vulnClasses: OwaspClass[]
    depth: TestDepth
    exclusions?: { paths?: string[]; params?: string[] }
    /** decision #3 — default "poc-safe". */
    redLine: RedLine
    /** Budget backstop (feeds the completion oracle). */
    rateLimit?: { maxToolCalls?: number; maxDurationMs?: number }
}

/** Safe fallback policy for tolerant readers (missing/corrupt engagement-policy.json). */
export const DEFAULT_TEST_POLICY: TestPolicy = {
    vulnClasses: [],
    depth: "standard",
    redLine: "poc-safe",
}

/**
 * Exploit-mode / active-exploitation tooling forbidden under the read-only red line.
 * These go BEYOND the default scanner block list (which is about noisy recon);
 * read-only means "no exploitation frameworks or exploit-mode scanners at all".
 */
export const READ_ONLY_FORBIDDEN_COMMANDS = ["sqlmap", "nuclei", "metasploit", "msfconsole", "msfvenom", "commix", "xsser", "hydra", "medusa"]

/** Per-depth tool-call budgets by role (deep highest, quick lowest). */
const DEPTH_TOOL_CALL_BUDGETS: Record<TestDepth, Partial<Record<PolicyRole, number>>> = {
    quick: {
        recon: 15,
        "targeted-pentest": 20,
        "payload-research": 15,
        custom: 20,
    },
    standard: {
        recon: 25,
        "targeted-pentest": 40,
        "payload-research": 30,
        custom: 40,
    },
    deep: {
        recon: 50,
        "targeted-pentest": 80,
        "payload-research": 60,
        custom: 80,
    },
}

/** Depth → recon profile (quick/standard/deep pass through directly). */
function reconProfileForDepth(depth: TestDepth): ReconPolicy["profile"] {
    return depth
}

/**
 * Compile a structured TestPolicy + authorization scope into a RunPolicy.
 *
 * Mapping (spec §2):
 * - authorizedTargets → allowed_targets (scope-guard matches host/subdomain/CIDR precisely).
 * - depth → recon.profile + per-role max_tool_calls (deep highest, quick lowest).
 * - redLine "read-only" → no_scan=true and forbidden_commands adds exploit-mode tooling;
 *   "poc-safe" keeps DEFAULT_RUN_POLICY.forbidden_commands (destructive commands are the
 *   scope-guard commandIsDestructive backstop's job).
 * - reentry → DEFAULT_RUN_POLICY.reentry.
 *
 * The result is structurally identical to what readRunPolicy returns, so it round-trips.
 */
export function compileTestPolicy(policy: TestPolicy, authorizedTargets: string[]): RunPolicy {
    const allowedTargets = authorizedTargets.map((target) => target.trim()).filter((target) => target.length > 0)

    const readOnly = policy.redLine === "read-only"
    const forbiddenCommands = readOnly
        ? [...new Set([...DEFAULT_RUN_POLICY.forbidden_commands, ...READ_ONLY_FORBIDDEN_COMMANDS])]
        : [...DEFAULT_RUN_POLICY.forbidden_commands]

    // read-only never scans; poc-safe unlocks scanners only at the deep profile.
    const noScan = readOnly ? true : policy.depth !== "deep"

    return {
        no_scan: noScan,
        max_tool_calls: { ...DEPTH_TOOL_CALL_BUDGETS[policy.depth] },
        forbidden_commands: forbiddenCommands,
        allowed_targets: allowedTargets,
        recon: { profile: reconProfileForDepth(policy.depth) },
        reentry: { ...DEFAULT_RUN_POLICY.reentry },
    }
}
