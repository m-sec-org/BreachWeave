# Spec: Engagement 启动器 + 架构文档（Slice 6 契约）

> 目标：补上"bootstrap → 设 env → 起 ENGAGEMENT_SOLVER"的单一入口，让 engagement 一键跑起来；并落一份可渲染的架构文档。承接 Slices 1-5b。
> 现状：`createSolverSession`(session.ts) 在 `isEngagementMode()` 下已自动装配整套引擎，但没有外层胶水调用 `bootstrapEngagement` + 设 env + 起 solver。`runSolverCli`(solver/cli.ts) 是既有单-solver 驱动范式（createSolverSession → session.prompt，continuation 自驱 ralph loop）。

## 1. engagement/run.ts —— 启动器
- `prepareEngagementRun(input: { engagementId: string; workspaceDir: string; task: string; solverId?: string }): { env: Record<string,string>; init: { solverId: string; promptName: string; task: string } }`（PURE，可测）：
  - env 必含：`ENGAGEMENT_ID`, `ENGAGEMENT_DIR`(=workspaceDir)，**`TCH_SOLVER_WORKSPACE`=workspaceDir**（关键：solver 的 ctx.cwd 必须=engagement workspace，findings/run-state/report 才落对地方），`TCH_SOLVER_SESSION_DIR`（=`<workspaceDir>/session` 或同级，供 observer `.observer` 与 board）。
  - init：`{ solverId: solverId ?? <8位随机>（随机由调用方注入，见约定）, promptName: "ENGAGEMENT_SOLVER", task }`。
- `runEngagement(input, deps?): Promise<{ session, sessionDir, workspaceDir }>`（编排）：
  1. 若给了 policy/targets/seeds → `bootstrapEngagement(...)`（复用 Slice 2）；否则要求 workspace 已 bootstrap。
  2. `{env, init} = prepareEngagementRun(...)` → `Object.assign(process.env, env)`。
  3. `createSolverSession(init)`（默认 dep = 真实 session.ts 的 createSolverSession；**deps 可注入**便于单测）。
  4. 订阅 `onEvent`（可选）→ `await session.prompt(init.task, { source: "interactive", expandPromptTemplates: true })`（continuation 自驱直到 oracle 判完成）。
  5. 返回 session 句柄。
- **deps 注入设计**：`runEngagement(input, { createSession?, bootstrap? })`——默认用真实实现；测试传 fake，断言"bootstrap 落盘 + env 正确设置 + createSession 收到 ENGAGEMENT_SOLVER+task + prompt 被调用"，无需 SDK/模型。

## 2. 导出 + CLI 子命令
- 从 `@tch/core` 导出 `runEngagement` / `prepareEngagementRun`（经 `packages/core/src/index.ts`）。
- `apps/cli/src/main.ts` 加 `engagement` 子命令（加法式，仿 `solver`）：
  - `engagement run --targets a,b --seeds u1,u2 --classes sqli,xss --depth <quick|standard|deep> --red-line <poc-safe|read-only> --workspace <dir> <task>`
  - action：拼 `TestPolicy`（classes/depth/red-line）→ `runEngagement({ bootstrap: {engagementId, workspaceDir, authorizedTargets, seeds, policy}, task, workspaceDir })`。
  - engagementId 默认取 workspace basename 或随机（随机在 action 层生成）。

## 3. docs/engagement-architecture.md
- 收录后端调用逻辑图：① 端到端启动流 ② Agent 主循环 + 3 extension 事件钩子 + 工具 ③ 子 agent fan-out ④ 磁盘状态 ⑤ 设计萃取对照（Observer/Solver/Manager）。
- 同时给 **Mermaid** 版（flowchart 用于 ①②④，sequenceDiagram 用于 ③ 的 spawn→submit→ingest），GitHub 可渲染。
- 明确标注：Campaign 多目标调度未接；RECON 真实执行为 solver+skills 现网能力。

## 4. 验收
- `prepareEngagementRun` 单测：env 含 ENGAGEMENT_ID/DIR + TCH_SOLVER_WORKSPACE(=workspaceDir) + TCH_SOLVER_SESSION_DIR；init.promptName==="ENGAGEMENT_SOLVER"。
- `runEngagement`（注入 fake deps）单测：bootstrap 被调/落盘、env 被设置、createSession 收到正确 init、session.prompt 被调用。
- engagement 全套 + scope-guard 测试仍绿；无回归。
- `tsc -p packages/core` 新文件 0 错误（仅保留 pre-existing 3 处生成文件错误）。CLI 在 apps/cli（不同 tsconfig）——保证语法/类型自洽，能被 `bun` 解析。
- `docs/engagement-architecture.md` 存在且 Mermaid 代码块语法正确。
- 不做：真正端到端跑一个真实 LLM（需模型/网络）、Campaign、UI。

## 5. 约定
- 纯 planner(`prepareEngagementRun`) SDK-free、可测；`runEngagement` 编排用可注入 deps 以便无 SDK 单测。
- 随机/时间不在纯函数内（solverId 随机、时间戳在编排/CLI 层注入）。
- 加法式：新 run.ts + 新 CLI 子命令 + 新 doc；不改 Slices 1-5b 行为。
- solver workspace = engagement workspace（务必设 TCH_SOLVER_WORKSPACE），否则 document_finding/run-state 会落到默认 solver 目录、与 oracle/报告脱节。
