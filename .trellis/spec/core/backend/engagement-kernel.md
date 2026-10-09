# Spec: Engagement Kernel（企业渗透内核，去-CTF 复用契约）

> 适用范围：`packages/core/src/solver/extension/**`（Observer / 续跑 / scope-guard / 上下文工程）与新增 `packages/core/src/engagement/**`。
> 目标：把 CTF 内核萃取为 engagement-mode 驱动、与 CTF 解耦的可复用 pi extensions。实现必须遵守本契约。

## 1. 模式门控（Mode Gating）
- 新增 `engagement/env.ts`：`ENGAGEMENT_ENV_ID`(`ENGAGEMENT_ID`) / `ENGAGEMENT_ENV_DIR`(`ENGAGEMENT_DIR`) 常量 + `isEngagementMode(): boolean`（`ENGAGEMENT_ID` 非空即真），与 `challenge/env.ts` 的 `isChallengeMode()` 并列。
- 内核 extension 激活条件从 `isChallengeMode()` 改为 `isChallengeMode() || isEngagementMode()`。**两模式互斥激活**：同进程只应存在其一。
- CTF 专属分支（host-bridge、flag、hint 工具）只在 challenge 模式走；engagement 模式走注入式 oracle/context。

## 2. 注入接口（替代 host-bridge）
实现时把 host-bridge 调用抽成接口，由模式适配器提供实现：

```ts
// 完成 oracle：替代 requestHostBridge("challenge_is_completed")
export interface CompletionOracle {
  isComplete(): Promise<boolean>
}
// engagement 实现 = computeEngagementComplete(coverage, backlog, budget)

// 上下文提供者：替代 requestHostBridge("challenge_get_state")
export interface EngagementContextProvider {
  getContext(): Promise<EngagementContext> // target/scope/phase/coverage/backlog 摘要
}

// 强触发 review：替代 challenge_get_hint 工具名硬判定
export type ForceReviewReason = "periodic" | "force" | "agent_end"
// "force" 由通用信号触发：新 finding / 新证据 / 知识库命中 / 策略切换
```

- `types.ts` 的 `ObserverReviewPayload.reason` 中 `"hint"` → `"force"`。
- oracle/context 通过 extension options 注入，**不得**在内核里直接 import `host-bridge-client`。

## 3. Observer sidecar 不变量（必须保留）
去-CTF 时以下机制**逐字保留**，只换 oracle/context/文案：
1. 异步 review 队列（enqueue → 独立 drain），review 不阻塞 solver 主链路。
2. 触发节奏：每 6 round 或 force；review 窗口最近 10 round。
3. 防唠叨：cooldown（6 round）+ message/activity 指纹去重。
4. 看板压力约束：memory ≤ 12、ideas ≤ 8；默认动作序 `NO_CHANGE > update > delete > add`。
5. 角色边界：**solver 对 ideas 只读**，ideas 仅由 observer 维护；solver 只 read + `memory_add`。
6. review 用独立 session（隔离 sessionManager），可用独立 `observerModel`。
7. 纠偏 `deliverAs:"steer"`；续跑 `sendMessage({triggerTurn:true})`。

## 4. 看板存储层：原样复用
- `board-store.ts` / `observer-store.ts` / `board-format.ts` / `challenge/memory.ts` 的 Idea/Memory CRUD **不改逻辑**（已 session 作用域、零 CTF 耦合）。
- 可选后续：把 `challenge/memory.ts` 重命名/re-export 为中性 `kernel/memory.ts`（非 Slice 1 必须）。

## 5. scope-guard 企业加固（enforce 为默认）
1. **授权匹配必须精确**：禁止子串匹配。实现 `isTargetInScope(command, allowed_targets)`：
   - 从命令中提取 URL host 与裸 IP；
   - host 命中规则：完全相等 或 授权域的子域后缀（`.corp.com` 边界，非 `includes`）；
   - IP 命中规则：等值 或 CIDR 包含；
   - 无法解析出 host/IP 且命令含网络动作 → 视为越界（fail-closed）。
2. **破坏性红线**：在 enforce 下拦截破坏性命令模式（数据删改 `DROP/TRUNCATE/DELETE FROM/rm -rf`、持久化 webshell 落地、横向/提权工具、DoS/压测），与 PoC 级取证边界一致。
3. **必须真正启用**：engagement 模式下 main 与 subagent 会话都要挂 `scopeGuardExtension({mode:"enforce", agentRole})`（当前 `session.ts` 中相关行是注释状态——必须取消注释并按模式接上）。
4. 全程 `audit.log` 保留；越界/破坏拦截写审计 + 结构化 block reason。

### 5.1 已知边界 / 教训（Slice 1+2 check 沉淀）
- **破坏性红线要覆盖长短两种 flag 写法**：`rm -rf` 与 `rm --recursive --force`/`rm --force --recursive` 必须都拦（教训：初版 `fs-rm` 只匹配短 flag，长 flag 绕过；已修为 `/\brm\s+(-[a-z]*[rf]|--(recursive|force|dir)\b)/i` + 回归测试）。新增破坏模式时，短写法/长写法/别名都要想到。
- **裸主机名（无 scheme）暂不纳入 scope 判定**（residual）：`isTargetInScope` 只从 `http(s)://` URL 与裸 IPv4 提取目标；`curl evil.com`（无 scheme、非授权域）当前不判越界。缓解：裸扫描器调用已被 `no_scan`+`forbidden_commands` 拦；robust 解析裸域名会误伤合法命令。→ 后续 slice 若要覆盖，需在"命令语义解析"层做（区分 host token vs 路径/文件名/flag），而非放宽正则。

## 6. 命名与放置约定
- 新内核目录：`solver/extension/engagement-observer/`（或将 `challenge-observer` 泛化重命名，二选一在实现前定；**倾向新目录 + 共享底层**以免动 CTF 现网）。
- 引擎侧 engagement 状态复用 `config/tools/pentest-workspace.ts` 的 `RunPolicy`/`RunState`/`HypothesisBacklog`。

## 7. 测试契约（Slice 1 验收）
- `isEngagementMode()`：在无 `CHALLENGE_*`、有 `ENGAGEMENT_ID` 时内核激活。
- `CompletionOracle` 注入：oracle 返回 true 时不续跑、不 review；false 时正常续跑。
- force-review：通用 force 信号触发 review（不依赖 `challenge_get_hint`）。
- scope-guard：`api.corp.com.evil.com`、querystring 藏目标 → 判越界拦截；`api.corp.com`/子域/CIDR 内 → 放行；破坏性命令 → 拦截。
- `bun run typecheck` + `bun test` 全绿；不删既有 observer 测试覆盖。
