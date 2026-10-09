# Spec: Engagement Solver Persona + 工具接线（Slice 4 契约）

> 目标：让 engagement 模式**端到端可跑**——solver 有企业渗透 persona、按 run-state 阶段 + TestPolicy 推进、能用 document_finding / 子 agent。承接 Slice 1-3。
> 大部分加法式；对共享注册表/生成清单做**小幅、可控**改动。

## 1. engagement/solver-guidance.ts —— 纯 builder + 薄 reader（可测）
- `buildEngagementSolverGuidance(input: { policy: TestPolicy; allowedTargets: string[]; phase: RunState["current_phase"]; seeds: string[] }): string`（PURE，无 SDK import）。产出注入 solver 的动态指导：
  1. Persona：企业授权黑盒渗透 solver（非 CTF、无 flag 语义）。
  2. Phase workflow：SCOPE→RECON→HYPOTHESIZE→TEST→DOCUMENT→REPORT，**高亮当前 phase 该做什么**。
  3. Focus：`policy.vulnClasses` 要覆盖的漏洞类；`policy.exclusions` 要跳过的 path/param。
  4. 授权与红线：只在 `allowedTargets` 内；`policy.redLine`（PoC-safe/read-only）——禁破坏/持久化/横向/DoS。
  5. 取证：发现即用 `document_finding`（带 severity/confidence/remediation + 请求/响应证据），推进 hypothesis backlog。
  6. seeds 作为 RECON 起点。
- `readEngagementSolverGuidance(dir: string): Promise<string>`——读 `engagement-policy.json`（Slice 2 `ENGAGEMENT_POLICY_FILE`）+ `readRunState(dir)` → 调 builder。缺文件时给一个安全默认（不抛）。
- 若 Slice 2 未暴露 `readEngagementPolicy(dir)`，在 `bootstrap.ts` 或 `policy.ts` 补一个（读 engagement-policy.json → `{policy, authorizedTargets, seeds}`，容错默认）。

## 2. 工具注册（config/tools/index.ts）
- 取消注释注册 `documentFindingTool`、`submitSubAgentOutputTool`、`ingestSubAgentOutputTool`（加法式；prompt 不列则不获得，CTF 不受影响）。
- 保持 `challengeTools` / `securityKimiSearchTool` 原样。

## 3. Builtin 引擎 prompt（config/prompts/builtin/ENGAGEMENT_SOLVER.md）
- frontmatter：`observerEnabled: true`，`tools: [bash, read, edit, write, grep, find, ls, document_finding, submit_sub_agent_output, ingest_sub_agent_output, security_kimi_search]`，`skills: [recon, targeted-pentest, payload-research, ffuf-skill, nuclei-skill, payloads-everything, jwt-oauth-token-attacks, known-product-exploit]`（只列 `skills/builtin/` 下真实存在的目录名——实现前 `ls` 校验）。
- markdown：企业授权黑盒渗透 persona + 阶段工作法 + PoC-safe 红线 + 授权范围约束 + document_finding/子 agent 用法。**中性，无 flag/CTF 语义。**
- **接线进生成清单**：在 `builtin-assets.generated.ts` **手工、最小**新增一行 import（`prompt_2 from "./prompts/builtin/ENGAGEMENT_SOLVER.md" with { type: "file" }`）+ 一条 map 项（`"ENGAGEMENT_SOLVER.md": prompt_2`）。**不要整文件重新生成**（避免大 churn / 不触动 pre-existing 状态）。

## 4. 动态指导注入（engagement-observer/index.ts）
- 在 factory 里加 `pi.on("before_agent_start", ...)`：engagement 模式下读 `readEngagementSolverGuidance(engagementDir())`，返回 `{ systemPrompt: event.systemPrompt + "\n\n" + guidance }`。缺 dir 时不改。
- 保留既有 `appendSystemPrompt`（静态 engagement 契约）不变；两者互补（静态契约 + 动态阶段指导）。

## 5. 测试契约（Slice 4 验收）
- `buildEngagementSolverGuidance`：含所选 vulnClasses、当前 phase 高亮、allowedTargets、PoC-safe 红线、document_finding 提示；read-only 时明确"只读/不利用"；**不含** "flag"/"CTF"。
- `readEngagementSolverGuidance`（写 tmp：bootstrap 一个 engagement 后读）：返回非空、含 policy 的 vulnClasses 与当前 phase。
- 工具注册：`customTools` 含 document_finding / submit_sub_agent_output / ingest_sub_agent_output 三个 name（可对 `customTools.map(t=>t.name)` 断言；注意该文件 import SDK，测试需按现有 challenge-observer 测试的 mock 方式，或改为断言纯清单——优先在不引 SDK 的前提下测 guidance，工具注册用 grep/构建期校验）。
- `bun test` engagement 全套仍绿；新 guidance 测试绿。
- `tsc -p packages/core`：新文件 0 错误；builtin-assets.generated.ts 仅保留 pre-existing 3 处 `.MD` 错误（手工加的 prompt_2 行不得引入新错误）。
- Prompt 校验：`ENGAGEMENT_SOLVER.md` 的 frontmatter YAML 合法；引用的 skills 目录都真实存在（实现前 `ls packages/core/src/config/skills/builtin/`）。
- 不做：真实 recon 执行引擎、UI、Campaign 调度。

## 6. 约定
- 纯逻辑在 `solver-guidance.ts`（SDK-free、可测）；I/O 薄封装读 workspace。
- 不改 Slice 1-3 已交付文件行为；工具注册与 before_agent_start 为加法式。
- Prompt 只引用真实存在的工具名与 skill 目录。
