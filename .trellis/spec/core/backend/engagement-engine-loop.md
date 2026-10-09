# Spec: Engagement 引擎闭环补全（Slice 5a 契约）

> 目标：让**单-agent** engagement 引擎真正跑通闭环——阶段能被推进到 REPORT、覆盖度 oracle 可达、能产出报告。补齐两个真实缺口：无阶段推进工具、报告函数不可被 agent 调用。
> 现状（调研结论）：`transitionToPhase` 只在 `ingest_sub_agent_output` 内被调用（goal→DOCUMENT、reentry→RECON）；SCOPE→RECON→HYPOTHESIZE→TEST→DOCUMENT→REPORT 的**正向推进无驱动**；`writeEngagementReport`(Slice 3) 是函数、非工具。

## 1. engagement_transition_phase 工具（新）
`packages/core/src/config/tools/engagement-phase.ts`：
- name `engagement_transition_phase`，params `{ to: PentestPhase, reason: string }`（PentestPhase = SCOPE|RECON|HYPOTHESIZE|TEST|DOCUMENT|REPORT）。
- execute：`ensurePentestWorkspace(ctx.cwd)` → 读 `readRunState` → **只允许正向推进或原地**（`targetIndex >= currentIndex`；若 `< current` 拒绝并提示用 reentry 语义，避免绕过 reentry 计数）→ `transitionToPhase(ctx.cwd, to, reason)` → 返回新 phase + completed_phases。
- 纯校验逻辑（`isForwardPhaseTransition(from,to)`）抽到 SDK-free 小模块或 `pentest-workspace`，便于单测。

## 2. generate_engagement_report 工具（新）
`packages/core/src/config/tools/engagement-report-tool.ts`：
- name `generate_engagement_report`，params `{}`（或可选 `title`）。
- execute：`writeEngagementReport(ctx.cwd, { engagementId: engagementId() ?? "engagement", generatedAt: new Date().toISOString() })`（复用 Slice 3）→ 返回 `{ markdownPath, sarifPath, count }`。
- 时间在工具层注入（`new Date()` 只在此 I/O 层）。

## 3. 注册 + prompt + guidance
- `config/tools/index.ts`：注册 `engagement_transition_phase` + `generate_engagement_report`（加法式）。
- `ENGAGEMENT_SOLVER.md`：`tools:` 增加这两个工具名。
- `solver-guidance.ts`：更新 phase workflow 段——明确"完成当前 phase 的目标后用 `engagement_transition_phase` 推进到下一阶段；到 REPORT 阶段用 `generate_engagement_report` 出报告"。保持既有测试通过（可能需同步更新 guidance 断言）。

## 4. 引擎闭环集成测试（SDK-free，关键交付）
`packages/core/src/engagement/engine-loop.test.ts`——用已导出的 SDK-free 函数模拟单-agent 闭环，证明可达完成：
1. `bootstrapEngagement`（tmp dir，policy）→ run-state phase=SCOPE。
2. 逐步 `transitionToPhase`：SCOPE→RECON→HYPOTHESIZE→TEST→DOCUMENT→REPORT。
3. 断言 `readEngagementCompletion(dir)` 在推进到 REPORT（completed 含 TEST+DOCUMENT）且 backlog 无 candidate 时 → `complete:true, reason:"coverage_met"`。
4. `writeEngagementReport(dir, meta)` → 生成 report.md + report.sarif.json，`count` 合理（可先 document 一条 finding 再出报告）。
5. `isForwardPhaseTransition`：正向/原地 true，回退 false。

## 5. 验收
- 新增 `engagement/engine-loop.test.ts` + phase 校验测试绿；engagement 全套仍绿；无回归。
- `tsc -p packages/core` 新文件 0 错误（仅保留 pre-existing 3 处生成文件错误）。
- 覆盖度 oracle 在正向推进到 REPORT 后可达 `coverage_met`（这是本刀要证明的"引擎能真正完成"）。
- 不做：sub-agent fan-out（Slice 5b）、RECON 真实执行引擎、UI。

## 6. 约定
- 工具 execute 里做 I/O；纯校验/推导抽到 SDK-free 模块可测。
- 不改 Slice 1-4 已交付行为；均为加法式（新工具 + guidance 文案更新）。
- 回退阶段仍走 reentry 语义（ingest 内），不由 `engagement_transition_phase` 绕过。
