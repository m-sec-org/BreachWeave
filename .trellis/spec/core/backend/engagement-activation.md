# Spec: Engagement 激活层（Slice 2 契约）

> 适用：新增 `packages/core/src/engagement/policy.ts` 与 `engagement/bootstrap.ts`。
> 目标：把"结构化测试策略 + 授权范围 + 种子"编译并落成一个 ready 的 engagement workspace，让 Slice 1 内核可启动。承接 Slice 1 的 `oracle.ts` / `scope-guard-policy.ts` / `pentest-workspace.ts`。

## 1. TestPolicy（结构化勾选式策略，decision #4）
`engagement/policy.ts` 定义：
```ts
export type OwaspClass =
  | "sqli" | "xss" | "ssrf" | "auth" | "access-control" | "injection"
  | "ssti" | "xxe" | "deserialization" | "idor" | "file-upload" | "path-traversal"
export type TestDepth = "quick" | "standard" | "deep"
export type RedLine = "read-only" | "poc-safe"
export interface TestPolicy {
  vulnClasses: OwaspClass[]
  depth: TestDepth
  exclusions?: { paths?: string[]; params?: string[] }
  redLine: RedLine                 // decision #3 (default poc-safe)
  rateLimit?: { maxToolCalls?: number; maxDurationMs?: number }  // budget backstop (feeds oracle)
}
```

## 2. compileTestPolicy —— 纯函数（可测）
`compileTestPolicy(policy: TestPolicy, authorizedTargets: string[]): RunPolicy`（复用 `pentest-workspace` 的 `RunPolicy`/`DEFAULT_RUN_POLICY`）。映射规则：
- `authorizedTargets` → `RunPolicy.allowed_targets`（scope-guard 消费；host/子域/CIDR 由 scope-guard-policy 精确匹配）。
- `depth` → `recon.profile`（quick→quick / standard→standard / deep→deep）+ `max_tool_calls`（deep 档最高、quick 最低，按角色）。
- `redLine==="read-only"` → `no_scan=true` 且 `forbidden_commands` 包含利用型工具（sqlmap/nuclei 的利用模式、metasploit 等）；`poc-safe` → 保留 `DEFAULT_RUN_POLICY.forbidden_commands`（重扫描器仍禁，破坏性由 scope-guard 的 `commandIsDestructive` 兜底）。
- `reentry` 用 `DEFAULT_RUN_POLICY.reentry`。
- **不变量**：编译结果必须能被 `readRunPolicy` 原样读回（字段/类型一致）。

## 3. bootstrapEngagement —— 落盘 + env
`bootstrapEngagement(input): Promise<{ env: Record<string,string> }>`，input = `{ engagementId, workspaceDir, authorizedTargets, seeds: string[], policy: TestPolicy }`：
1. `ensurePentestWorkspace(workspaceDir)`（复用）。
2. 写 `run-policy.json` = `compileTestPolicy(policy, authorizedTargets)`（覆盖默认）。
3. 写 `engagement-policy.json`（完整 TestPolicy + authorizedTargets + seeds，供 solver/observer 读取原始策略意图）。
4. 初始化 `state/run-state.json`（phase=SCOPE；复用 `readRunState` 的默认结构或 `writeRunState`）。
5. 返回 `env = { ENGAGEMENT_ID: engagementId, ENGAGEMENT_DIR: workspaceDir }`（与 `engagement/env.ts` 常量一致）。
- 幂等：workspace 已存在时不覆盖已有 findings；run-policy/engagement-policy 可覆盖为最新。

## 4. 测试契约（Slice 2 验收）
- `compileTestPolicy`：deep→recon deep + 更高预算；read-only→`no_scan=true` 且 forbidden 含利用工具；authorizedTargets→allowed_targets；结果可被 `readRunPolicy` 读回。
- `bootstrapEngagement`（写 tmp 目录）：生成 run-policy.json（allowed_targets 正确）、engagement-policy.json（vulnClasses 保留）、state/run-state.json（phase=SCOPE）；返回 env 含 ENGAGEMENT_ID/DIR。
- 与 Slice 1 联动：用 bootstrap 产物 + `readEngagementCompletion(dir)` 应得 in_progress（新建 engagement 未完成）。
- `bun test` 绿；新文件无 tsc 错误（`tsc -p packages/core` 仅保留 pre-existing 的 3 处 generated-assets 错误）。
- 不做：UI、真实 recon 执行、report 导出（后续 slice）。

## 5. 约定
- 纯映射逻辑放 `policy.ts`（无 SDK 依赖，便于单测）；`bootstrap.ts` 只做 I/O 编排（Bun.file/Bun.write）。
- 不修改 Slice 1 已交付文件的行为；仅新增。
