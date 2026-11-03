# BreachWeave 外置记忆（Taric）集成：差距分析与完善方案

> **版本**：v8（2026-10-25）
> **结论性质**：源码和方案审查稿，不代表 BreachWeave 已完成 Taric 接入。
> **BreachWeave 基线**：当前工作区 `pentest` 分支 `6957a55`，重点核对 `packages/core/src/challenge`、runtime、solver、config、ui-web。
> **Taric 基线**：`main` HEAD `d20c18f2daa97ed75b51218fc3d63e700ea5a8c9`。该提交增加有界脱敏结构化诊断、独立 `--runtime-config` 以及认证的 `taric.gateway.status` / `taric.gateway.reload`；核心包版本为 `1.0.1`。
> **证据口径**：当前 clean-consumer 验证从 d20c18f 打包 `1.0.1` 的 schemas/Core/Bun driver，三项 integrity 已锁定在 BreachWeave manifest；它验证本地 tarball 和依赖闭包，不代表 registry 发布或 BreachWeave host smoke。历史审计和旧候选 release report 只作背景，不能覆盖当前源码和 profile 文档。

## 结论

Taric 的同步适配公共合同和主要实现已经完成，BreachWeave 已接入本地 host module、版本锁定和受认证网络 client。当前不应再把 `work.transition`、`coverage.record`、分页、gate 双读或 API 版本升级列为 Taric 的待开发项；这些能力已经进入 registry、schema、dispatch、CLI 和兼容矩阵。剩余工作分为三层：

1. **Taric 已实现且有本机候选证据**：API `1.2.0`、schema `1.0.0`、Core `1.0.1`、存储合同 `authority-storage/3`、57 个公开 operation；Bun SQLite driver、Work/Coverage 查询与 gate、订阅、Artifact ingest、review pack/submit、Pi adapter 和 gateway 均有代码和测试。
2. **按部署 profile 验收**：候选报告已验证 tarball clean consumer、Node Core/CLI、Bun driver、本地 Node CLI 到 Bun RPC、PostgreSQL 单 authority（`host_count=1`）、proxy restart/replay；真实 BreachWeave host、容器 Artifact spool、remote gateway、双进程/多 host 仍是 `not_verified`。三个核心包保留 `private: true`，registry 发布为 `unsupported`，不等于 tarball consumer 未验证。
3. **BreachWeave 仍有外围任务**：竞赛 remote provider、Flag 提交动作、Scope/ROE 与 egress、coverage manifest、双模式 prompt/tool 和真实 gateway/恢复联调仍需按部署 profile 单独验收。

推荐继续采用“双模式、同一核心、不同策略”：`competition` 保留现有竞赛能力并可选择 Taric 复盘；`authorized_pentest` 使用 Taric 作为权威治理记忆。两种模式必须有不同的命名空间、principal、凭据边界和完成判据。

Taric 的质量 capability 因当前样本为 30 条 synthetic、0 条人工标注且没有 human baseline 而保持 `disabled/unsupported`，release report 因此为 `blocked`。这不表示同步适配技术门失败，也不阻塞 BreachWeave 采用基础 authority、work、coverage、evidence 和 artifact 能力；只有在 BreachWeave 依赖该质量能力时才需要另设门禁。

## 目录

- [1. 范围和不变量](#1-范围和不变量)
- [2. BreachWeave 当前事实](#2-breachweave-当前事实)
- [3. Taric 当前状态](#3-taric-当前状态)
- [4. 双模式集成设计](#4-双模式集成设计)
- [5. BreachWeave 差距和任务单](#5-breachweave-差距和任务单)
- [6. 接入拓扑](#6-接入拓扑)
- [7. 分阶段路线](#7-分阶段路线)
- [8. 验收、故障和回滚](#8-验收故障和回滚)
- [附录：证据索引](#附录证据索引)

## 1. 范围和不变量

### 1.1 适用范围

本文只讨论 BreachWeave 如何消费 Taric 的通用 authority、记忆、证据、coverage、work、lease、checkpoint、review 和 Artifact 合同。Taric 不接管 BreachWeave 的竞赛平台、agent loop、调度器、目标动作或 UI。

任务创建时显式选择：

```text
mode = competition | authorized_pentest
```

项目记录使用判别联合，`mode`、租户、比赛、队伍、Engagement 和 provider 由受信任宿主创建，模型不能提交或修改：

```text
CompetitionProject = {
  mode: "competition";
  provider: "remote" | "local_practice";
  tenant_id: string;
  platform_id: string;
  competition_id: string;
  team_id: string;
  challenge_code: string;
  instance_generation?: number;
  memory_mode: "legacy_local" | "taric_best_effort";
  taric_engagement_id?: string;
}

AuthorizedEngagement = {
  mode: "authorized_pentest";
  tenant_id: string;
  engagement_id: string;
  scope_revision: number;
  coverage_manifest_id: string;
  memory_mode: "taric_required";
  taric_engagement_id: string;
}
```

### 1.2 不变量

1. 模型只能向 Taric 提交 proposal 或 checkpoint proposal；工具结果、平台响应、Artifact 字节和动作结果由 host 捕获。模型不能直接写权威事实。
2. Taric 不运行模型、启动 agent、调度工具、执行目标动作、管理凭据或替宿主决定 HITL。`resource_refs` 是查询/调度提示，不是资源锁。
3. host 在每次写入前绑定 `mode`、租户、principal、Engagement、WorkRun/Attempt/generation；Taric 再执行角色、归属、CAS、租约和审计校验。
4. 竞赛 token、flag、客户凭据、Cookie 和 Authorization 不进入 Taric、普通日志或默认 UI。必须保存原文时，使用独立加密 transcript/secret store；Taric Artifact 内容仍按 opaque 处理。
5. `taric_required` 下 Taric 不可用时阻断授权模式的目标动作、Finding admission 和 operator close。`taric_best_effort` 下 Taric 仍是唯一事实源，故障期间只进入加密、有界、append-only outbox，不读取旧文件作为查询后端，也不双写。
6. 订阅是 best-effort hint，不是可靠消息队列；丢失、重复、重连或断线都必须通过 `host.state`、查询和 `read_seq` 恢复。

## 2. BreachWeave 当前事实

### 2.1 现有竞赛链路

| 能力 | 当前事实 | 修订后的处置 |
|---|---|---|
| 3 个活动实例槽位 | `packages/core/src/challenge/manager.ts:65` 的 `MAX_ACTIVE_CHALLENGES=3` | `competition` 保留；授权模式改用 resource/lease 调度 |
| 本地 list/start/stop/hint | manager 当前构造 `ChallengeApiClient.createLocal()` | 保留为 `provider=local_practice`，不能伪装成远端竞赛 |
| 远端 API client | `challenge/api-client.ts` 已有 create/list/start/stop/hint 请求，但 manager 没有接入 `create()` | `provider=remote` 作为 BW-02 接线任务；缺配置必须失败，不得静默回本地 |
| Flag/solved/score | 平台文档有逐题 flag 字段和 team 汇总 solved；当前 host 没有 `/api/submit` 闭环 | 新增 host-only `challenge_submit_flag`；逐题 Flag 状态、team solved 和本地 scanned 分开保存 |
| 报告提交 | `submitReport` 写本地提交记录并翻转 asset `scanned` | 仅表示本地报告覆盖，不表示平台 Flag 成功或授权 coverage gate 通过 |
| planner/solver/observer | Manager、runtime、host bridge 和 Observer memory/idea 工具已经存在 | 按 mode 提供不同 prompt/tool，保留 CTF 工作流 |

当前共享存储主要按 `challengeId` 分区。相同 challenge code 的不同比赛、队伍或租户可能发生碰撞；Taric 接入不能掩盖这一点，必须先贯穿复合键。

### 2.2 两种完成判据不能合并

| 模式 | 权威事实 | 完成条件 |
|---|---|---|
| `competition` | 远端 provider 的 challenge/instance/flag 状态；`local_practice` 使用本地报告状态 | 远端逐题 Flag 结果和平台汇总 solved 分开显示；local practice 可按 `scanned` 完成 |
| `authorized_pentest` | Taric Scope、Resource、Coverage、Evidence、Finding、Artifact 和 operator 状态 | `coverage.gate` 通过、未测/受阻项已披露、operator 显式 close |

`scanned` 永远表示本地资产报告已提交，不能转换为平台 solved、Finding 或 coverage close。CTF hint/扣分属于竞赛事实，不能写入授权 Engagement。

## 3. Taric 当前状态

### 3.1 当前合同和发布证据

Taric HEAD `d20c18f` 的源码与当前文档确认：

- `packages/schemas/src/registry.ts` 的 `API_CONTRACT_VERSION` 为 `1.2.0`，schema 为 `1.0.0`，registry 包含 57 个 operation；Core 为 `1.0.1`，存储合同为 `authority-storage/3`。Core/CLI/MCP/RPC 及 SQLite/PostgreSQL 驱动均输出有界脱敏诊断；gateway 的 `status` / `reload` 受认证保护，运行时 authority 必须从独立 `--runtime-config` 读取。
- `work.transition` 为 host-only、幂等、带 owner/generation/lease fencing、审计和事务约束的 WorkRun 状态迁移；`coverage.record` 为 host/operator L1 写操作，支持 create、`expected_version` CAS、稳定维度保护、幂等和审计。CoverageCell 本身不携带 WorkRun/generation，若 host 需要运行归属，应通过证据/host 关联保存，而不是假设 Taric 已有该字段。
- `work.query`、`coverage.query` 和 `coverage.gate` 已进入公共 API。Work/Coverage 查询使用受限 keyset 分页；gate 与 visibility 在同一 maintenance snapshot 中返回一个 `read_seq`。旧审计所述 dense/sparse/empty 分页跳项和 gate 双水位问题已被当前实现修复。
- Core subscription 和 authenticated adapter RPC 已实现 `delta`、`l1_backlog`、`impact_pending`、`lease_expiry`、`artifact_integrity` 等 topic，通知只含 `{topic, engagement_id, read_seq, emitted_at}`；含重鉴权、去抖、队列上限、慢消费者断开和 lease timer。MCP 仍只有六个模型工具，没有 resources/subscription/Tasks，也不暴露 host-only 写操作。
- `artifact.ingest_file` 使用绑定 session root、显式 `authorize_spool_access:true`、稳定 descriptor 单次读取、哈希和发布前身份核对；内容 opaque，当前 `source_deleted=false`，源文件由 host/operator 清理。普通 RPC 行上限与二进制 Artifact listener 的 64 MiB chunk profile 不是同一传输能力。
- review pack/submit 已绑定 admission evidence snapshot、policy digest 和外部 reviewer attestation；CLI 拒绝 `--model`、`--provider-url` 等模型/provider 参数。模型、人审、verdict 和 SLA 仍属于宿主。
- Bun driver、Core exports、compatibility matrix、Pi adapter 和 gateway 已有实现。Bun 进程内路径应显式构造 `AuthorityStore(new BunSqliteAuthorityDriver(path))` 并通过 `createCoreService`；`openRuntimeService()` 的默认 SQLite 路径使用 Node `node:sqlite`，不能把它直接当成 Bun SQLite 入口。BreachWeave 已接入受认证 TLS TCP/HTTPS gateway client，真实远程部署仍需单独验收。
- Taric `docs/agent-integration.md` 的旧概览表仍有一行称 Bun in-process SQLite 不可用；该行与文档后续 Bun embedding 章节、`host-integration-profiles.md` 和当前候选报告不一致。本文按具体 profile 文档及报告记录状态。

历史候选 release report 记录：Schemas 10/10、Core 350/350、CLI 29/29、MCP 12/12、Hermes 5/5、Bun driver 11/11；clean build/typecheck/docs/matrix、tarball clean consumer、26 次 CLI/RPC 调用和 2 次 proxy restart/replay、PostgreSQL 单 authority 12 个 runtime 场景及 backup/restore 均通过。该报告绑定 base `5808a09` 和 dirty source digest，不能写成 d20c18f 上的 clean release。当前 d20c18f 的三项 `1.0.1` 包已由独立 clean-consumer 重新打包验证；release report 的质量 capability 结论仍只适用于其原始环境。

### 3.2 Profile 矩阵

| Profile/能力 | 当前状态 | BreachWeave 采用门槛 |
|---|---|---|
| Taric Core/API/治理 | 已实现；registry、schema、dispatch、CLI、matrix 同步 | 使用匹配 API/schema/policy digest；不得直接写 SQLite |
| Bun in-process SQLite | 本机 driver、Core exports、tarball clean consumer 已验证 | 使用 `AuthorityStore + BunSqliteAuthorityDriver`；再做 BW 生命周期、重启和容器联调 |
| Node Core/CLI 与本地 RPC | 候选 proxy restart/replay 已验证 | 适合作为 Bun 嵌入失败时的受认证 fallback；须绑定 principal/Engagement |
| PostgreSQL single authority | 当前候选已验证，`host_count=1` | 选择该 profile 时固定 schema、runtime report 和数据库连接健康 |
| PostgreSQL 双 host/multi-host | `not_verified` | 首期不启用；启用前补两 host fencing、断线重连和迁移演练 |
| remote gateway | gateway/token/principal 代码和测试存在，真实远程部署 `not_verified` | 启用前补撤权、重连、跨租户拒绝和慢连接报告 |
| 容器 Artifact spool | Taric contract 已实现，真实 BreachWeave mount `not_verified` | 先验证路径映射、权限、替换/增长/中断和 source retention |
| registry 分发 | package manifest 仍为 `private`，registry 发布 `unsupported` | 使用锁定 tarball 或受控内部 artifact；不能把 workspace link 当生产安装 |
| quality capability | `disabled/unsupported` | 不作为基础记忆接入的依赖；需要时单独取得人工标注和 baseline |

### 3.3 Taric 的永久边界

Taric 不提供 Scope/ROE 解析、网络 egress、凭据管理、目标工具执行、agent 调度、跨 WorkItem 资源互斥、竞赛平台 provider、Flag/score/solved 状态机、客户报告模板或人工审核编排。`resource_refs` 不是锁；host 必须自己实现单写者 scheduler 和资源 reservation。Taric Artifact 不扫描、脱敏或自动删除原文；订阅不替代权威查询；公开 `snapshot.import`、通用 migration、`remote.push` 等不构成旧 BreachWeave 记忆自动迁移入口。

## 4. 双模式集成设计

### 4.1 `competition`

```text
竞赛 provider（remote 或 local_practice）
  ├─ list/start/stop/hint/submit_flag
  ├─ instance_generation 与 endpoint allowlist
  └─ 平台 snapshot、Flag attempt 和 team solved
        ↓
BreachWeave competition adapter
  ├─ 3 槽位、平台限频、重试、unknown/reconcile
  ├─ planner/solver/observer 调度
  └─ legacy_local 或 Taric best-effort 复盘投影
```

竞赛默认 `memory_mode=legacy_local`；需要跨进程治理时显式使用 `taric_best_effort`。Taric 故障不阻断平台 start/stop/Flag 控制流，但 memory query 应返回 degraded，不得读旧文件冒充 Taric 权威。outbox 只保存脱敏事件、稳定 event ID、顺序和重放状态。Flag 原文在模型当前上下文/submit 参数之外只保存 HMAC fingerprint、结果和 attempt 状态；超时为 `unknown`，平台没有 submission lookup/idempotency 时不得宣称 exactly-once。

### 4.2 `authorized_pentest`

初始化至少包括租户、Engagement UUID、Scope/ROE、测试窗口、允许/禁止目标和技术、凭据引用、manifest 版本、报告及保留策略。所有 solver 网络出口经 host 强制 egress gateway/firewall；容器不能依赖当前 host-network 默认直连。每次 DNS 解析、redirect hop、IPv4/IPv6、TCP/UDP 和代理出口都重新按 `scope_revision` 判断。`scope-guard` 只能作为早期提示，不能替代 host 网络边界。

资源发现先形成 Resource/ResourceRevision proposal，经 host admission 才进入执行队列。工具运行绑定 `work_run_id/attempt_id/generation`，输出先由 host capture 写入 Artifact 或外部 evidence，再允许模型提交 proposal。覆盖完整不等于项目自动完成；operator 必须确认窗口、残余风险、未测/受阻项后 close。

### 4.3 覆盖 manifest

WSTG、ASM 和其他测试字典留在 BreachWeave；Taric 的 `test_category` 保持 opaque。manifest 至少包含版本、测试项 ID、适用条件、证据要求、允许终态、风险类别和裁剪规则。以 `manifest_version × ResourceRevision × scope_revision` 生成预期 CoverageCell/WorkItem；空 manifest、缺 cell、未经批准的 `not_applicable` 或漏生成 WorkItem 不可 close。

`coverage.record` 写入后，host 读取 `coverage.gate` 返回的单一快照和 `read_seq`，并将该 gate 结果、manifest hash、Scope revision 及资源 revision 一起固定到报告快照。不要把独立资源查询声称为同一个 Taric read snapshot。资产 revision 变化时重开受影响 cell，保留旧版本结果。模型只能查询 coverage 或提交 proposal，不能直接调用 host-only `coverage.record`。

### 4.4 记忆和信任层

| 内容 | 竞赛 | 授权渗透 |
|---|---|---|
| 原始工具/平台输出 | host-only spool 或受限 opaque Artifact | host capture + Artifact，按客户 ACL/保留策略 |
| 模型总结 | L0/L1 复盘候选 | L0 proposal，经 admission/reviewer 才能成为 L1/L2 |
| 结论 | 平台观察/复盘，不等价于得分 | 必须绑定 evidence、Scope、freshness 和复核 |
| 凭据/Flag | secret store；普通审计仅 fingerprint | secret store；不进入 Taric 普通召回 |

## 5. BreachWeave 差距和任务单

Taric 公共合同不再作为 BreachWeave 的“待 Taric 开发”任务。以下任务全部属于 BreachWeave 或联合 profile 验收。

| ID | 责任边界 | 交付物 | 完成定义 |
|---|---|---|---|
| BW-01 | BreachWeave | `mode` 联合、`CompositeProjectKey`、opaque project id、legacy_unclassified 和 dry-run migration | 同 challenge code 的不同 team/competition/tenant 在文件、API、cache、session、timeline、archive 全部隔离；未知来源记录不能 launch |
| BW-02 | BreachWeave | remote/local provider wiring、team token limiter、platform snapshot | remote 缺配置失败；local 明示本地模式；start/stop/list/hint 不静默降级；API 总限频不超平台约束 |
| BW-03 | BreachWeave | `challenge_submit_flag`、Flag attempt journal、hint confirmation、unknown/reconcile | 正确/错误/timeout/重复结果可审计；Flag 原文不进普通日志/Taric/UI；未知结果不伪造成功 |
| BW-04 | BreachWeave/联合 | `TaricHostModule`、principal/Engagement binding、operation allowlist、lifecycle、error mapping | 一个 daemon 只初始化一个 Core；模型走 proposal；host capture 有真实来源；Taric down 按 memory_mode 阻断或 degraded |
| BW-05 | BreachWeave | Taric memory/query/proposal/capture/checkpoint adapter、加密 outbox | request 带 mode/project/Engagement/Run binding；重放幂等；不直接写 Taric 表；outbox 有界、可告警、可恢复 |
| BW-06 | BreachWeave | Scope revision、ROE evaluator、egress gateway/firewall、工具启动授权 | shell/curl、redirect、DNS rebinding、IPv6、TCP/UDP、proxy 和窗口过期不能绕过出口；未通过绕过测试前只允许 dry-run |
| BW-07 | BreachWeave | WSTG/ASM manifest、cell/work 生成、coverage close evaluator、报告 snapshot | manifest 全量性、Scope revision、cell 数量、同 `read_seq` gate 和报告一致；operator close 是显式动作 |
| BW-08 | 联合 profile | Bun host/Node proxy fallback、容器镜像、Pi/SDK/协议 compatibility manifest | 版本不匹配启动失败；Bun driver、Core lifecycle、host restart、solver/observer bridge smoke 通过 |
| BW-09 | BreachWeave | scheduler 单写者、slot/resource reservation、Taric WorkRun recovery | 并发 launch 不超 3 槽、不重复占用 resource；重启后从 active WorkRun 和平台 snapshot 重建 reservation；不把 `resource_refs` 当锁 |
| BW-10 | 联合 profile | Artifact 选型、spool mount、reviewer/writer/operator 边界 | 默认优先 host-managed external reference；启用 Taric spool 时验证 root、descriptor、权限、替换/增长/中断、`source_deleted=false`；reviewer 不由 Taric 运行模型 |

### 5.1 复合键和迁移

```text
CompositeProjectKey =
  competition: tenant_id + platform_id + competition_id + team_id + challenge_code
  authorized: tenant_id + engagement_id
```

路径使用规范化稳定编码或 SHA-256 摘要，不直接拼接用户输入；记录同时保存完整复合键，读写时校验目录键和记录键一致。迁移先 dry-run，输出分类依据、数量、摘要、疑似凭据和冲突；来源不明记录为 `legacy_unclassified`，operator 选择模式后才可运行。旧目录迁移后只读 archive，不把 `scanned` 转换成 solved 或 coverage。

### 5.2 兼容性和 Pi 边界

Taric 当前认证 Pi 是 `@earendil-works/pi-coding-agent` `1.4.0`/commit `4a08025`。BreachWeave 当前使用 `@earendil-works/pi-*`，不应宣称为 Taric certified native Pi host；可先走 generic Core/RPC/Bun embedding，后续再做 Pi adapter 认证。host、容器、Taric API/schema/driver 和 RPC event shape 必须进入一个 compatibility manifest；不匹配时启动失败或显式降级为只读。

## 6. 接入拓扑

### 6.1 推荐路径

```text
Bun BreachWeave host
  ├─ competition/authorized adapter
  ├─ scheduler + action policy + host capture
  └─ TaricHostModule
       ├─ @taric/core + @taric/schemas
       └─ @taric/driver-bun-sqlite

solver/observer container
  └─ JSONL host bridge → 受限 taric_* action
     不挂 Taric authority DB，不持有 operator/writer token
```

Bun host 进程内嵌优先使用：

```ts
const driver = new BunSqliteAuthorityDriver(dbPath)
const store = new AuthorityStore(driver)
const service = await createCoreService(store)
```

实际导入和生命周期以 Taric `agent-integration.md`、`host-integration-profiles.md` 为准。`openRuntimeService()` 默认 SQLite driver 使用 Node `node:sqlite`，不能直接作为 Bun SQLite 入口。若 Bun in-process profile 不满足部署条件，使用认证 Node proxy/RPC fallback；fallback 仍需 principal、Engagement、审计、Scope 和单写者约束。

### 6.2 分发和数据边界

Taric 三个包仍 `private`，但当前 tarball clean consumer 已通过；生产采用锁定 tarball 或受控内部 artifact，不依赖 workspace link、TS path alias 或仓库内未锁定 `dist`。Core、schema、driver、API、policy、Pi 和容器版本一起 pin。

容器只可使用按角色拆分的动作，例如 `taric_context_query`、`taric_resource_query`、`taric_evidence_query`、`taric_coverage_query`、`taric_proposal_submit`、`taric_checkpoint_propose`。`caller` 只是 provenance，host bridge session registry 和认证 transport 才是身份来源。MCP 模型面只提供 Taric 的六个模型工具，不暴露 capture、admission、work/coverage 写入、host.state 或原始 Artifact。

| 宿主目的 | Taric operation | 调用身份/边界 |
|---|---|---|
| 模型读取上下文、资源、证据和覆盖 | `context.query`、`resource.query`、`evidence.query`、`coverage.query` | model principal；只返回白名单投影和受限引用 |
| 提交假设、checkpoint 草案或动作建议 | `proposal.submit`、`checkpoint.propose`、`action.recommend` | model principal；只形成候选，不构成权威状态或动作授权 |
| 捕获真实工具/平台观察 | `capture.observation` | host-only；来源和 principal 由已认证 host transport 绑定 |
| 查询/认领/续租/接管 WorkRun | `work.query`、`work.claim`、`work.renew`、`work.reclaim`、`work.transition`、`work.resume` | host 负责 scheduler；Taric lease 只 fencing 同一 WorkRun，不锁目标资源 |
| 提交/检查 coverage | `coverage.record`、`coverage.query`、`coverage.gate` | host/operator 写入或 gate；模型仅可读受限 coverage 视图 |
| 提交已验证 checkpoint 或 Artifact | `checkpoint.commit`、`artifact.store.*`、可选 `artifact.ingest_file` | host/operator；原始内容读取需额外 capability，且由 host 承担脱敏和保留策略 |

### 6.3 Artifact 和通知

默认采用 host-managed external Artifact reference；需要 Taric spool 时，显式 bind task session、每次请求 `authorize_spool_access:true`，并让 host 负责脱敏、扫描、ACL、保留和删除。普通 RPC 1 MiB line 上限不能承载 64 MiB binary append；大文件应使用 Taric 对应 Artifact transport 或外部 reference。

通知仅作为低延迟提示。host 维护最后确认的 `read_seq`，收到通知后查询 authoritative delta；断线、重鉴权失败、慢消费者断开或丢通知都不改变事实恢复路径。

## 7. 分阶段路线

| 阶段 | 工作包 | 退出门 |
|---|---|---|
| S0 合同冻结 | BW-01、mode/provider/memory_mode、CompositeProjectKey、Taric compatibility manifest | 数据联合、完成判据、principal 和迁移格式评审通过 |
| S1 存储隔离 | BW-01、legacy migration、timeline/stats/archive/cache/session binding | 两队同题、跨租户和跨模式负向测试通过；旧竞赛页面回归通过 |
| S2 竞赛闭环 | BW-02/BW-03/BW-09 | remote/local 明确分流；限频、三槽位、hint 扣分、Flag unknown/reconcile 通过 |
| S3 Taric host module | BW-04/BW-05、Bun driver 与受认证 TLS TCP/HTTPS client、memory/query/proposal/capture | host restart/replay 幂等；Taric down 按策略处理；无直接数据库写入 |
| S4 授权安全基线 | BW-06 | egress bypass、Scope revision、窗口结束和高风险动作测试通过前仅 dry-run |
| S5 覆盖和证据闭环 | BW-07/BW-10 | manifest/cell 全量性、evidence 来源门、gate/read_seq、Artifact/reviewer 边界通过 |
| S6 运营和交付 | UI/API、报告、审计、备份恢复、profile runbook | 竞赛与授权页面分流；授权报告可复核；选定 profile 的 clean install/restart/restore 演练通过 |

首期支持单 BreachWeave scheduler daemon、Bun host in-process Taric 和 authenticated proxy 的 TLS TCP/HTTPS client；多 host、remote gateway 的真实部署、Taric spool 和 quality capability 仍在 manifest 中标为 `not_verified`，不能据此宣称部署验收完成。

## 8. 验收、故障和回滚

### 8.1 Taric 基础和宿主联调

Taric 基础实现直接引用当前候选证据，不重复把已通过的合同当作开发任务。BreachWeave 联调必须重新验证：

1. API `1.2.0`、schema `1.0.0`、Core `1.0.1`、storage `authority-storage/3` 和 57-operation matrix 与注入 manifest 一致；旧 `1.1.0` host 明确拒绝，不做隐式 downgrade。三项 `1.0.1` tarball 的 integrity 必须与 `packages/core/src/taric/compatibility.ts` 一致。
2. Bun host 使用 `AuthorityStore + BunSqliteAuthorityDriver` 完成 startup、migration、close、restart、Core dispatch 和权限边界；若使用 Node proxy，验证 token、principal、Engagement 绑定和撤权。
3. host capture 的真实工具/平台结果保留 `source_kind`、run/generation、Artifact/evidence refs；model principal 不能调用 host-only operation。
4. WorkRun transition、coverage record、query、gate 负向测试覆盖 owner/generation、lease、CAS、幂等、错误 Engagement 和同一 `read_seq`；CoverageCell 的 run attribution 不得假设为 Taric 原生字段。
5. 订阅丢失、重复、乱序、慢连接、断线和 lease expiry 只触发查询；host 能以 query/read_seq 恢复，通知不被当作事实队列。
6. Artifact 采用外部 reference 时验证 host ACL/保留；采用 Taric ingest 时验证 session root、descriptor、替换、增长/缩短、中断、哈希、幂等和 `source_deleted=false`。
7. Taric quality capability 保持 disabled，除非部署同时提供人工标注样本、baseline 和匹配的 quality release report。

### 8.2 竞赛模式

1. 第四个活动实例被拒，stop/restart 能释放并重新占槽；并发 start 不重复开实例。
2. `provider=remote` 缺 URL/token 时失败；`local_practice` 明示本地，不返回伪造平台 score/solved。
3. team token 共享限频器；429、Retry-After、4xx、5xx、超时有操作专属重试和 reconcile。
4. hint 只在平台确认后更新扣分/缓存；Flag timeout 为 unknown，不盲目重试。
5. 同 challenge code 的不同 team/competition/tenant 的 challenge、memory、idea、attempt、submission、archive、timeline、planner cache 全部隔离。
6. Taric best-effort 故障时 outbox 加密、有界、有序、幂等；恢复冲突可见，不从旧本地文件双读双写。

### 8.3 授权模式

1. bash/curl、子进程 scanner、DNS rebinding、redirect、IPv4/IPv6、TCP/UDP、proxy 和非窗口连接均不能绕过 egress gateway。
2. Scope revision 未批准、窗口已结束、资源 revision 变化或凭据绑定失效时阻断新动作并终止长时工具。
3. manifest 空值、缺 cell、未经 operator 批准的 `not_applicable`、缺 evidence 和未生成 WorkItem 均不能 close。
4. coverage gate、报告、manifest hash、Scope revision 和 `read_seq` 可相互复核；operator 显式 close。
5. compaction、宿主重启、Taric 通知丢失和 lease 过期后，Scope、资源 revision、proposal、evidence、checkpoint 和下一步可恢复；旧 generation 写入被拒。

### 8.4 故障和回滚

- Taric authority 不可用、版本不匹配、principal/Engagement 不一致、Scope/egress 缺失或证据完整性失败时，授权模式 fail closed。
- 竞赛模式可以继续平台控制流，但 Taric memory degraded 不能冒充查询成功；outbox 超限、密钥不可用或 replay 冲突时停止新的记忆写入并告警。
- 回滚只切换新请求路由，不删除 Taric authority、Artifact、审计或迁移前只读 archive。禁止把未提交模型总结导入旧本地事实库。
- 迁移 dry-run 或摘要校验失败时保留原目录并停止切换；旧记录未分类时禁用 launch。

### 8.5 验证命令

BreachWeave：

```sh
bun run typecheck
bun test packages/core/src/challenge/api-client.test.ts \
  packages/core/src/challenge/manager.test.ts \
  packages/core/src/challenge/store.test.ts \
  packages/core/src/challenge/memory.test.ts \
  packages/core/src/challenge/host-bridge-handler.test.ts
bun test packages/core
bun run build:linux
```

Taric 当前候选验证已由其 release report 记录；BreachWeave 不应把下列命令的本地重跑结果描述为当前 Taric release 证明。需要复验选定 profile 时，从 Taric root 执行：

```sh
npm run build
npm run typecheck
npm test
npm run verify:matrix
npm pack packages/schemas
npm pack packages/core
npm pack packages/driver-bun-sqlite
```

tarball 应安装到隔离空目录，验证实际 Bun host 或 Node proxy 的启动、关闭、重启和权限；PostgreSQL 双 host、remote gateway、真实容器 mount 只有在对应环境实际运行后才能标为 `verified`。

## 附录：证据索引

### BreachWeave

| 主题 | 位置 |
|---|---|
| 竞赛记录、asset/scanned | `packages/core/src/challenge/store.ts` |
| 3 槽位、provider 和调度 | `packages/core/src/challenge/manager.ts` |
| 远端 API client 与环境配置 | `packages/core/src/challenge/api-client.ts`、`env.ts` |
| host bridge 与 Observer memory | `packages/core/src/challenge/host-bridge-handler.ts`、`solver/extension/challenge-observer/tools.ts` |
| 容器 JSONL runtime | `packages/core/src/runtime/runtime.ts`、`challenge/host-bridge-client.ts` |
| scope guard/compaction | `packages/core/src/solver/extension/scope-guard.ts`、`pentest-compaction.ts` |
| Web 竞赛 API/统计 | `packages/ui-web/src/server.ts` 及 challenge 页面 |

### Taric

| 主题 | 位置 |
|---|---|
| API 合同和 57 operation registry | `packages/schemas/src/registry.ts`（`API_CONTRACT_VERSION=1.2.0`） |
| Work/Coverage dispatch、query、gate、订阅 | `packages/core/src/service.ts`、`store.ts`、`coverage.ts` |
| Bun driver 和 Core exports | `packages/driver-bun-sqlite/`、`packages/core/src/index.ts`、`packages/core/src/sql-driver.ts` |
| Artifact ingest | `packages/core/src/service.ts`、`docs/taric-api.md` Artifact 章节 |
| review pack/submit | `packages/core/src/store.ts`、`packages/cli/src/review.ts` |
| Pi 认证和兼容矩阵 | `packages/core/src/pi-adapter.ts`、`compatibility-matrix.json` |
| host profile 和分发边界 | `docs/host-integration-profiles.md`、`docs/agent-integration.md` |
| 当前同步状态和实施计划 | `docs/Taric同步适配未完成项与落地计划.md` |
| API 操作、权限、Artifact 和通知细节 | `docs/taric-api.md` |
| 候选发布证据 | `openspec/changes/harden-taric-authority-runtime/release-report.md`、`release-report.json` |
| 历史审计，仅作背景 | `docs/taric-host-sync-adaptation-audit.md` |
