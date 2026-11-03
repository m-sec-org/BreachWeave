# Proposal

## Why

BreachWeave 当前的 Memory、Idea、Attempt 和报告状态主要按 `challengeId` 写入本地文件，无法提供 Taric 的 principal 绑定、版本校验、来源分级、可恢复查询和跨队伍隔离。Taric 的同步适配已经形成稳定的 `work.transition`、`coverage.record`、查询、Artifact 和订阅合同，现在需要在 BreachWeave host 建立真实消费边界，避免模型直接把未经治理的内容写成共享事实。

## What Changes

- 新增 Bun host 内的 `TaricHostModule`，统一管理 Taric Core 生命周期、API/schema/policy 版本校验、Engagement/principal 绑定、操作白名单、错误映射和关闭恢复。
- 新增项目级 `mode` 与 `memory_mode` 合同，区分 `competition` 的本地/远端竞赛事实和 `authorized_pentest` 的 Taric 权威记忆；禁止用 `scanned`、平台 solved 或一个裸 `challengeId` 混淆三种完成语义。
- 将本地项目、Memory、Idea、Attempt、Submission、timeline、planner cache 和 solver startup binding 统一迁移到稳定 `CompositeProjectKey`，阻断跨队伍、跨比赛、跨租户和跨模式读取。
- 为模型提供受限 Taric 查询/提案/checkpoint 工具；真实工具结果、平台响应和 Artifact 由 host capture 写入，模型不能直接执行 host-only 的 Work/Coverage/Artifact 写操作。
- 为 `taric_best_effort` 增加加密、有界、append-only outbox 和稳定事件 ID；Taric 故障时不从旧本地 store 双读双写，恢复后幂等重放并暴露冲突。
- 对 `taric_required`、Taric 版本不匹配、principal/Engagement 不一致和 authority 不可用执行 fail-closed；竞赛平台控制流可独立降级为 memory degraded。
- **BREAKING**：新项目 API、内部启动绑定和持久记录使用 mode-aware 联合和复合键；来源不明的旧记录迁移为 `legacy_unclassified`，在 operator 选择模式前不可启动。
- 本变更不修改 Taric Core，不把 Scope/ROE、egress、竞赛 provider、Flag 提交或客户报告逻辑移入 Taric；这些由后续 BreachWeave 任务或独立变更负责。

## Capabilities

### New Capabilities

- `taric-host-memory`: BreachWeave host 对 Taric authority 的生命周期、身份、查询/提案/capture、Artifact 引用、通知恢复和 best-effort outbox 集成。
- `project-mode-isolation`: competition/authorized_pentest 的项目联合、复合键隔离、迁移分类、记忆命名空间和完成状态分离。

### Modified Capabilities

无。当前 `openspec/specs/` 没有既有 capability spec；本变更创建两项新的行为契约。

## Impact

- **Core**：`packages/core/src/challenge/store.ts`、`memory.ts`、`manager.ts`、`api-client.ts`、`host-bridge-*`、runtime/solver startup binding，以及新增 `packages/core/src/taric/` host adapter。
- **Web/API**：项目创建/查询、challenge 状态、timeline、Memory/Idea、统计和错误状态需要返回 mode、opaque project id、memory health 与 provider 信息。
- **持久化/迁移**：本地 challenge 目录和记录格式改变；迁移必须先 dry-run，旧目录保留为只读 archive。
- **依赖和运行时**：首选 Taric `@taric/core`、`@taric/schemas`、`@taric/driver-bun-sqlite` 的锁定 tarball/内部 artifact；Bun 直接构造 `AuthorityStore + BunSqliteAuthorityDriver`。Node RPC proxy 仅作为受认证 fallback。
- **安全/运维**：需要密钥保护 outbox、Taric principal/Engagement 配置、版本 manifest、authority health、replay backlog/冲突指标和恢复 runbook。
- **验证**：新增隔离、权限、幂等、Taric down、重启恢复、outbox replay 和旧记录分类测试；执行 `bun run typecheck`、相关 `bun test` 和选定 Taric profile 的 clean-consumer smoke。
