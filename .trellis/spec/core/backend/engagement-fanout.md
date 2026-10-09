# Spec: Engagement Sub-Agent Fan-out（Slice 5b 契约）

> 目标：接通 orchestrator→sub-agent 委派，打通 spawn(`subagent`)→`submit_sub_agent_output`→`ingest_sub_agent_output`→phase/backlog 推进的多-agent 深度。承接 Slice 5a（单-agent 闭环已通）。
> 现状：`createSubagentTool` 注册名 `subagent`，仅当 prompt 有 `subagents:` frontmatter 时生成；无 builtin 子 agent prompt；scope-guard 用 `spawn_sub_agent`（与真实名 `subagent` 不符）。

## 1. Builtin 子 agent prompts（config/prompts/builtin/）
建三个（frontmatter `isSubagent: true`，只列真实存在的 skills 目录——实现前 `ls skills/builtin/`）：
- `ENGAGEMENT_RECON.md`（role 语义 recon）：tools `[bash, read, write, grep, find, ls, submit_sub_agent_output, security_kimi_search]`；persona=在授权范围内做 attack-surface 发现（爬取/枚举/指纹），产出 assets + candidate hypotheses；**收尾必须调 `submit_sub_agent_output`**（role="recon", stage="recon", candidate_findings 状态保持 "candidate"）。
- `ENGAGEMENT_TARGETED_PENTEST.md`（role targeted-pentest）：验证单条 hypothesis，PoC-safe 取证；收尾 `submit_sub_agent_output`（role="targeted-pentest", stage="test", 必带 `goal`, 至少一个 verified 才 goal.achieved=true）。
- `ENGAGEMENT_PAYLOAD_RESEARCH.md`（role payload-research）：检索/构造 payload 与绕过思路；收尾 `submit_sub_agent_output`（role="payload-research", candidate 状态保持）。
- 三者都：中性（无 flag/CTF）、授权范围约束、PoC-safe 红线、与 `pentest-output.ts` 的 `SubmitSubAgentOutputParams` 契约一致（hypotheses/candidate_findings/evidence_refs/coverage_gaps；targeted-pentest 的 goal 规则见 `normalizeSubmittedSubAgentOutputPayload`）。
- 接进 `builtin-assets.generated.ts`：手工加 prompt_3/4/5 import + map（**不整文件重生成**）。

## 2. ENGAGEMENT_SOLVER.md：接通 spawn
- frontmatter 加 `subagents: [ENGAGEMENT_RECON, ENGAGEMENT_TARGETED_PENTEST, ENGAGEMENT_PAYLOAD_RESEARCH]`（用真实 prompt name，不含 .md）。→ resolvePromptSession 会据此 `createSubagentTool` 并授予 `subagent` 工具。
- 正文/guidance 用真实工具名 `subagent` 委派（single/parallel/chain 模式），说明 spawn→submit→`ingest_sub_agent_output` 的闭环。

## 3. solver-guidance.ts：委派段
- 在 guidance 加"委派与编排"：RECON 阶段派 `ENGAGEMENT_RECON`；TEST 阶段对高优先 hypothesis 派 `ENGAGEMENT_TARGETED_PENTEST`；需要 payload 时派 `ENGAGEMENT_PAYLOAD_RESEARCH`；每次子 agent 返回后调 `ingest_sub_agent_output` 推进 backlog/phase。用真实工具名 `subagent`。
- 同步更新 solver-guidance.test 断言（含委派/ingest 提示）。

## 4. scope-guard 命名对齐（真实缺陷修复）
- `scope-guard.ts` 现用 `event.toolName === "spawn_sub_agent"` 做 main 直接动作预算重置——真实 spawn 工具名是 `subagent`，导致 orchestrator 委派后预算不重置、会被误锁。
- 抽 SDK-free 纯 `isSpawnToolName(name): boolean`（识别 `"subagent"`，兼容历史 `"spawn_sub_agent"`）到 `scope-guard-policy.ts`，在 scope-guard 用它替换硬比较。单测覆盖。

## 5. 验收
- 三个子 agent prompt frontmatter YAML 合法；引用工具已注册、skills 目录真实存在；`isSubagent:true`。
- `ENGAGEMENT_SOLVER.md` 的 `subagents:` 列表指向三个真实 prompt name；接进 builtin-assets（prompt_3/4/5）无新 tsc 错误。
- `isSpawnToolName` 单测（subagent/spawn_sub_agent→true，bash→false）；scope-guard 测试仍绿。
- engagement 全套 + scope-guard 测试绿；无回归。
- `tsc -p packages/core` 仅保留 pre-existing 3 处生成文件错误。
- 不做：RECON 真实执行引擎深化、Campaign 多目标、UI。

## 6. 约定
- 加法式：新 prompt + frontmatter + guidance 文案；唯一改共享行为处 = scope-guard 用 `isSpawnToolName`（且兼容旧名，纯扩大匹配，不缩小）。
- prompt 只引用真实工具名与 skill 目录；子 agent 契约严格匹配 `pentest-output.ts` 校验，避免 ingest 报错。
