// Engagement solver guidance: dynamic, phase-aware persona/guidance injected into
// the solver system prompt (Slice 4).
//
// The builder is PURE and SDK-free (no @mariozechner/* import) so it is unit-testable
// without the SDK installed. The thin reader wraps the on-disk engagement-policy.json
// (Slice 2) + run-state.json (pentest-workspace) and never throws on missing files.

import { readEngagementPolicy } from "./bootstrap"
import type { OwaspClass, TestPolicy } from "./policy"
import { readRunState, type RunState } from "../config/tools/pentest-workspace"

type Phase = RunState["current_phase"]

export interface EngagementSolverGuidanceInput {
    policy: TestPolicy
    allowedTargets: string[]
    phase: Phase
    seeds: string[]
}

const PHASE_ORDER: Phase[] = ["SCOPE", "RECON", "HYPOTHESIZE", "TEST", "DOCUMENT", "REPORT"]

/** One-line description of what each engagement phase should accomplish. */
const PHASE_GUIDE: Record<Phase, string> = {
    SCOPE: "确认授权范围与测试策略：只在 allowed_targets 内行动，明确本次要覆盖的漏洞类与红线。",
    RECON: "自主发现 attack surface：从 seeds 出发爬取/枚举接口、参数、技术指纹，全部结果受 allowed_targets 白名单约束。",
    HYPOTHESIZE: "把发现的 attack surface 映射到策略勾选的漏洞类，生成可验证的 hypothesis backlog（statement/kind/entry_point/priority）。",
    TEST: "对 backlog 里的假设做 PoC 级非破坏取证：验证漏洞是否可利用，保留请求/响应证据；及时推进假设状态。",
    DOCUMENT: "对已验证的漏洞用 document_finding 记录，附 severity/confidence/remediation 与请求-响应证据、复现步骤。",
    REPORT: "收敛整理：确认覆盖度达标、backlog 无未决假设，调用 generate_engagement_report 产出 report.md + report.sarif.json。",
}

/** Human-readable label per OWASP vuln class for the focus section. */
const VULN_CLASS_LABEL: Record<OwaspClass, string> = {
    sqli: "SQL 注入 (SQLi)",
    xss: "跨站脚本 (XSS)",
    ssrf: "服务端请求伪造 (SSRF)",
    auth: "认证缺陷 (Authentication)",
    "access-control": "访问控制缺陷 (Access Control)",
    injection: "命令/代码注入 (Injection)",
    ssti: "服务端模板注入 (SSTI)",
    xxe: "XML 外部实体 (XXE)",
    deserialization: "反序列化 (Deserialization)",
    idor: "不安全的直接对象引用 (IDOR)",
    "file-upload": "文件上传 (File Upload)",
    "path-traversal": "路径穿越 (Path Traversal)",
}

function describeVulnClass(vulnClass: OwaspClass): string {
    return VULN_CLASS_LABEL[vulnClass] ?? vulnClass
}

function renderPhaseWorkflow(current: Phase): string[] {
    const lines = ["## Phase Workflow (当前状态机)"]
    for (const phase of PHASE_ORDER) {
        const marker = phase === current ? "▶" : "-"
        const emphasis = phase === current ? "  ← 当前阶段，优先推进" : ""
        lines.push(`${marker} ${phase}: ${PHASE_GUIDE[phase]}${emphasis}`)
    }
    lines.push(
        "- 完成当前阶段目标后，用 `engagement_transition_phase({to, reason})` 正向推进到下一阶段（只能向前或原地；回退由 ingest 的 reentry 语义处理，不要用本工具绕过）。",
        "- 到 REPORT 阶段用 `generate_engagement_report` 出报告（report.md + report.sarif.json）。",
    )
    return lines
}

function renderFocus(policy: TestPolicy): string[] {
    const lines = ["## Focus (测试策略)"]
    if (policy.vulnClasses.length > 0) {
        lines.push("- 要覆盖的漏洞类：")
        for (const vulnClass of policy.vulnClasses) {
            lines.push(`  - ${describeVulnClass(vulnClass)}`)
        }
    } else {
        lines.push("- 未勾选特定漏洞类：按通用授权黑盒方法覆盖常见 Web 漏洞面。")
    }
    lines.push(`- 测试深度：${policy.depth}`)

    const excludedPaths = policy.exclusions?.paths ?? []
    const excludedParams = policy.exclusions?.params ?? []
    if (excludedPaths.length > 0) {
        lines.push(`- 排除路径（不要测试）：${excludedPaths.join(", ")}`)
    }
    if (excludedParams.length > 0) {
        lines.push(`- 排除参数（不要测试）：${excludedParams.join(", ")}`)
    }
    return lines
}

function renderScopeAndRedLine(allowedTargets: string[], policy: TestPolicy): string[] {
    const lines = ["## 授权范围与红线"]
    lines.push(`- 授权目标（仅允许在这些范围内动作，越界会被 scope-guard 拦截并记 audit.log）：${allowedTargets.length > 0 ? allowedTargets.join(", ") : "(未指定，谨慎行动)"}`)
    if (policy.redLine === "read-only") {
        lines.push("- 红线 = 只读：只做被动/只读探测，禁止任何利用动作（不使用 sqlmap/nuclei/metasploit 等利用工具，不写入/修改数据）。")
    } else {
        lines.push("- 红线 = PoC-safe：允许非破坏性取证（如 SQLi 取一条非敏感数据/版本号、LFI 读无害文件、RCE 回显 id/whoami）。")
    }
    lines.push("- 硬禁（任何模式下）：删改数据、持久化 webshell、横向移动、权限提升、DoS/压测。")
    return lines
}

function renderEvidence(): string[] {
    return [
        "## 取证与推进",
        "- 发现漏洞后立即用 `document_finding` 记录，带 severity、confidence、remediation，并附可复核的请求/响应证据与复现步骤。",
        "- 每条假设都通过实测推进状态（candidate → verified / rejected / inconclusive）；不要凭空判定。",
    ]
}

function renderDelegation(phase: Phase): string[] {
    const lines = [
        "## 委派与编排 (sub-agent fan-out)",
        "- 你是编排者：深度/可并行/需隔离上下文的子任务用 `subagent` 工具分派给专职子 agent，自己少做直接侦测/测试动作（否则触发 scope-guard 的 main 直接动作预算）。",
        "- 可用子 agent：`ENGAGEMENT_RECON`（attack-surface 发现）、`ENGAGEMENT_TARGETED_PENTEST`（验证单条 hypothesis，PoC-safe 取证）、`ENGAGEMENT_PAYLOAD_RESEARCH`（payload/绕过研究）。",
        "- 阶段化委派：RECON 阶段派 `ENGAGEMENT_RECON`；TEST 阶段对高优先 hypothesis 逐条派 `ENGAGEMENT_TARGETED_PENTEST`（一次一条、goal 明确）；需要 payload 弹药时派 `ENGAGEMENT_PAYLOAD_RESEARCH`。",
        "- `subagent` 支持 single / parallel / chain 三种模式。",
        "- 闭环：`subagent` 分派 → 子 agent 用 `submit_sub_agent_output` 汇报 → 你用 `ingest_sub_agent_output` 回收，推进 hypothesis backlog 与 phase；reentry（回退深入）由 ingest 的 reentry 语义处理，不要用 `engagement_transition_phase` 绕过。",
    ]
    if (phase === "RECON") {
        lines.push('- 当前处于 RECON：优先用 `subagent(agent="ENGAGEMENT_RECON")` 集中做授权范围内的发现。')
    } else if (phase === "TEST") {
        lines.push("- 当前处于 TEST：对 backlog 里高优先 hypothesis 逐条派 `ENGAGEMENT_TARGETED_PENTEST` 验证，返回后 `ingest_sub_agent_output` 推进。")
    }
    return lines
}

function renderSeeds(seeds: string[]): string[] {
    if (seeds.length === 0) return []
    return ["## RECON 起点 (seeds)", ...seeds.map((seed) => `- ${seed}`)]
}

/**
 * Build the dynamic engagement solver guidance block (PURE).
 *
 * Sections: persona → phase workflow (current phase emphasized) → focus (vuln classes
 * + exclusions) → authorization scope + red line → evidence/backlog → sub-agent
 * delegation (spawn→submit→ingest, phase-appropriate) → seeds.
 * Enterprise/neutral: no CTF / flag semantics.
 */
export function buildEngagementSolverGuidance(input: EngagementSolverGuidanceInput): string {
    const { policy, allowedTargets, phase, seeds } = input

    const sections: string[][] = [
        [
            "# Engagement Solver Guidance",
            "你是一名企业授权黑盒渗透测试 solver。你的目标是在授权范围内，对目标服务系统性地发现并以 PoC 级非破坏方式验证漏洞，产出可复核的证据与报告。",
            "你不是在解题，也没有需要提交的最终答案；你的成果是被 document_finding 记录的、带证据的漏洞发现。",
        ],
        renderPhaseWorkflow(phase),
        renderFocus(policy),
        renderScopeAndRedLine(allowedTargets, policy),
        renderEvidence(),
        renderDelegation(phase),
    ]

    const seedSection = renderSeeds(seeds)
    if (seedSection.length > 0) sections.push(seedSection)

    return sections.map((section) => section.join("\n")).join("\n\n")
}

/**
 * Read engagement-policy.json + run-state.json from a workspace and build the guidance.
 *
 * Tolerant: missing files fall back through readEngagementPolicy / readRunState defaults,
 * so this never throws. Returns a non-empty guidance string.
 */
export async function readEngagementSolverGuidance(dir: string): Promise<string> {
    const [{ policy, authorizedTargets, seeds }, runState] = await Promise.all([readEngagementPolicy(dir), readRunState(dir)])
    return buildEngagementSolverGuidance({
        policy,
        allowedTargets: authorizedTargets,
        phase: runState.current_phase,
        seeds,
    })
}
