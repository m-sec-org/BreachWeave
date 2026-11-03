# BreachWeave Taric 集成效果差距分析与改进方案

> **分析基线**：当前工作区中的 BreachWeave 源码、测试、OpenSpec 变更及 Taric runbook。
> **用途**：评估 `docs/Taric集成效果分析.md` 的运行结论，并区分代码能力、运行观测和待验证事项。
> **范围**：本地/竞赛 challenge 的 Taric-backed memory 集成，以及向授权渗透治理流程扩展的差距。本文不把 Taric 产品具备的能力等同于 BreachWeave 已接入的能力。

## 结论

BreachWeave 已实现可运行的 Taric 项目记忆适配：daemon 可启动本地 Taric gateway、为新 challenge 绑定项目身份、按项目选择 provider，并通过 Taric 读取已准入 claim、列出候选 proposal，以及把模型/Observer 提交转成候选 claim。代码也具备 principal 分流、健康状态、兼容性校验和 proposal outbox/replay。

当前集成应准确称为**项目级外置记忆与候选提案接入**，而不是 Taric 领域治理流程已完成。源分析中的 3 条 proposal、297 次 capture 失败、健康状态、任务时长/token 和对比任务结论属于 `f41e775a` 的运行态陈述；仓库没有随附该次 authority 数据库、原始日志或请求导出，因而不能仅靠当前源码复核这些数字。代码能确认 observation capture 存在契约映射风险，也能确认 capture 没有进入 outbox；需要以真实网关联调来确认该次失败率和具体 schema 错误。

按代码和测试证据分级：

| 能力 | 当前判断 | 依据/限制 |
|---|---|---|
| 项目身份与 provider 路由 | 已实现 | 判别式项目类型、复合键、trusted binding、Taric provider 选择；见 `project/types.ts`、`challenge/manager.ts`、`taric/provider-factory.ts` |
| Proposal 写入和候选/准入读取投影 | 已实现 | Memory/Idea 被提交为 claim proposal；读取 canonical claims 与 pending proposals 并标记 `admitted`/`candidate`；现有测试使用 mock adapter |
| Host observation capture | 已接线，真实契约未验证 | Manager 有 solver/report/attempt capture hook；当前观测字段会被直接扩展到 Taric observation，字段白名单和真实 Resource ref 映射不足 |
| Outbox/replay | 部分实现 | 模型/Observer proposal 可在 authority 不可用时入队并有序重放；host observation 未入队，因此该类事件不具备相同恢复保证 |
| Engagement 隔离 | 当前 profile 为共享 Engagement + 项目键过滤 | local gateway 明确采用共享 Engagement；projectKey 存在 claim 标题并在 BW 侧过滤，不等于 Taric Engagement 授权层隔离 |
| Coverage、WorkRun、Artifact/Evidence、admission/review、checkpoint 恢复 | 未接入业务闭环 | TaricHostModule 有受限查询、proposal、capture 和 checkpoint proposal 接口，但没有对应完整业务调用、状态迁移与验收流程 |

## 对原运行分析的校正

### 可保留但应标注来源的运行观测

原文报告该任务使用 `taric_best_effort`，authority 中有 3 条候选记忆，API 可回读这 3 条候选，并在任务期间报告健康。建议在正式归档原始证据后保留这些观察值，例如附脱敏网关日志、proposal ID、按 project/Engagement 的只读 authority 查询和 health 时间序列。否则应写成“原运行记录称”，不能写成“源码和仓库数据已实证”。

原文报告 297 次 observation capture 全部失败及 observation 表为空，也应视为该次运行记录，而不是现有测试结论。代码路径确有高风险：`captureSolverEvent` 把事件封装为 `solver_id/project_id/generation/event` 等字段；host module 再把输入 observation 展开到 Taric 记录顶层。代码未先投影到 Taric observation schema 的允许字段，也未为普通 host event 解析真实 Resource UUID。具体失败码、`unevaluatedProperties` 是否为该次拒绝原因，需要真实 adapter 的错误响应和 Taric contract 共同确认。

`memory-health=healthy` 只说明 health probe 成功，不能推出 observation capture 成功。健康和操作成功率应独立统计。

“本地 memory/ideas 文件不再产生”只适用于 challenge 级 memory/idea provider 路由：Taric mode 不用 legacy 文件 provider；但 solver session 仍会在 `.observer` 保存由 authority 读取后复制的本地 board snapshot。Taric 查询目前分别取 `resource.query` 和 `proposal.list` 的单页、最多 50 条，不跟随 cursor，因此一次任务中回显 3 条不证明全量查询或长期跨 solver 同步。

单 solver 单任务与另一条 legacy_local 任务的报告质量没有显著差异，不能用于证明 Taric 提高或没有提高解题质量。缺少匹配挑战、模型/提示词、预算、目标状态和重复样本控制；此次形态也没有触发跨 solver 复用、authority 中断恢复和并发治理等场景。

### 对原设计差距判断的修订

1. **候选不等于永远 pending。** BreachWeave 当前路径没有 admission/review 操作，所以 BW 自身不会晋升这些 proposal；但 Taric operator 可通过 BW 外部流程处理它们。应表述为“BW 内尚无治理闭环”，不要断言 authority 中永远 pending。
2. **`scanned` 并非竞赛流程中的违规状态。** 当前它表示本地报告是否覆盖某个资产，并作为现有 challenge 完成条件。问题在于 authorized pentest 尚无独立 CoverageCell/`coverage.gate` 与 operator close，不能把 `scanned` 复用为授权测试完成状态。
3. **共享 Engagement 是当前部署折中，而非隐蔽配置事故。** `taric-deployment-runbook.md` 已说明本地 profile 共享 Engagement，原因是当前 gateway token 与 Engagement 绑定。项目复合键提供 BW 逻辑命名空间，但不能代替 Taric 授权边界。若目标要求每项目 Engagement，需要扩展 gateway 身份解析/凭据绑定和生命周期，再做迁移与隔离验收；不能仅改标题前缀或直接假设 Node bridge 会自动解决。
4. **原文引用的章节编号不能作为本仓库依据。** 原分析引用 §5.1、§14.4/14.5/14.7/14.9，而当前工作区差距方案是 v8、仅有第 1–8 节。本文改以现有文件、OpenSpec 任务和代码路径作为依据。
5. **模型可提交 proposal，不可直接写 admitted canonical fact。** Solver/Observer 通过 host bridge 调用 memory add 后，Taric provider 以 model principal 提交 claim proposal。它确实允许模型发起候选内容，但 authority admission 仍是单独信任边界；描述时需区分“提案写入”和“事实写入”。

## 已实现链路

```text
Daemon 启动
  -> ensureDefaultLocalTaricGateway（本地默认 profile）
  -> ChallengeManager + TaricMemoryProviderFactory
  -> trusted Project / CompositeProjectKey / memory_mode

Solver board / challenge detail
  -> resource.query(claim) + proposal.list（当前各一页）
  -> BW project key 过滤 -> admitted/candidate 投影
  -> 初始快照复制到 solver .observer board

Solver/Observer memory_add
  -> Host Bridge 校验 solver/project binding
  -> TaricMemoryProvider.appendMemory
  -> proposal.submit(subject_type=claim, model principal)
  -> candidate；Taric 不可用时 proposal 可进入加密 outbox 后重放

Solver event / report / attempt
  -> manager capture hook
  -> capture.observation(host principal)
  -> 当前缺少 schema 白名单映射；不在 proposal outbox 恢复路径内
```

实现证据集中在 `packages/core/src/index.ts`、`challenge/manager.ts`、`challenge/host-bridge-handler.ts`、`challenge/taric-memory-provider.ts`、`taric/host-module.ts`、`taric/local-gateway.ts`。OpenSpec `integrate-taric-external-memory/tasks.md` 中第 1–5 节和 6.1/6.2 已勾选，但 6.3 的 typecheck、完整 core 测试和构建仍未勾选；应把实现状态和完整交付验证状态分开。

## 差距矩阵

| 差距 | 当前行为 | 影响 | 目标 |
|---|---|---|---|
| Observation contract 投影 | 业务事件字段直接成为 observation 扩展字段；默认 Resource ref 也不是已验证 UUID | 真实 Taric schema 可能拒绝；best-effort 下 capture 失败不会阻断 solver，且错误可能仅日志可见 | 构造严格 schema allowlist DTO，绑定有效 resource/evidence refs，真实 gateway contract smoke 通过 |
| Observation 可靠性 | observation 失败不写 outbox；异步 solver event hook 使用 `void`；best-effort unavailable 可静默 | authority 短暂不可用或捕获校验失败时丢失，运行数据无法完整解释 | 有界加密 event outbox、稳定幂等 ID、按序 replay；区分 unavailable、validation、authorization 并提供指标/diagnostic |
| 查询完整性与时效 | 两个查询固定 page_size=50，不读取 next_cursor；board 初始复制，后续并非自动订阅更新 | 记忆超过一页会漏；运行 solver 可能看到陈旧快照 | 按 cursor 分页、绑定 read_seq；明确刷新/订阅策略与恢复查询 |
| Engagement 硬隔离 | 一个本地部署共享 Engagement，project key 以标题编码并由 BW 二次过滤 | authority 级别无法按项目授权/撤权，标题约定成为隔离的一部分 | 如需求要求一项目一 Engagement，则做每项目身份/令牌映射；否则正式接受 shared Engagement，并加强查询合同和审计测试 |
| 领域实体映射 | 所有 MemoryKind、Idea 都作为 `claim`；Idea 状态被投影成 pending；refs 要求现成 UUID | Evidence/Observation/Hypothesis/NegativeObservation 等语义与来源无法可靠区分 | 明确 kind -> Taric entity/proposal 映射，使用 Artifact/Evidence 引用，不把 `verified` 等本地状态直接提升为支持结论 |
| Admission/review | BW 可提交、查询候选/准入，但没有 admission、review、人工处置 UI/workflow | 候选与结论之间缺少可操作闭环，不能从 BW 审查和追责 | 引入受信 operator/reviewer workflow、evidence snapshot、审计和拒绝/修订路径 |
| Coverage/完成判据 | CTF 仍按所有 asset `scanned` 完成；没有 authorized CoverageCell/gate/close | 授权项目不能证明测试项覆盖、未测原因和 gate 同快照 | 只在 authorized_pentest 模式实现 manifest、coverage record/query/gate 和显式 operator close；保留竞赛 scanned 语义 |
| Work/并发/恢复 | Planner 直接调用 manager 启停 solver/容器；Taric work lease/transition 未接线；checkpoint 仅有 proposal API wrapper | 不能由 authority fencing 调度代次、接管与断点恢复；现有 slot 限制不能表达资源互斥 | BW scheduler 接 WorkRun lease/transition，并保留本地资源 reservation；checkpoint 持久化敏感数据策略和恢复校验 |
| Artifact/Evidence 原始证据链 | report 和 event 可被装入捕获负载，但没有 artifact ingest/保存/查证引用闭环 | 不能保证原始证据完整性、ACL、保留和 finding 的证据支撑 | host-managed artifact spool/external reference + hash + evidence proposal；先定义脱敏、权限和保留策略 |
| 集成验收 | provider 测试多使用 mock adapter；OpenSpec 6.3 未完成 | 单元边界通过不能证明真实 gateway/schema、构建与全套测试就绪 | 真实 gateway smoke、契约负向测试、完整 typecheck/core test/build 和脱敏运行报告 |

## 改进方案

### P0：恢复并证明 Observation Capture

1. **定义 Taric DTO 白名单。** 将 solver event、attempt、report 分成不同事件适配器，仅保留稳定 ID、事件类型、时间、有限摘要、经确认的 Resource UUID、Artifact/Evidence refs 和来源信息。禁止把任意 solver event 或完整 report 直接 spread 到 Taric schema 对象。
2. **确定资源引用策略。** 如果事件没有真实 Taric Resource UUID，就先建立/查询受信 Resource 映射；不要用 `host-event:<id>` 伪装 Taric Resource ref。非目标类 host event 可映射到明确支持的事件合同，或只留在 host audit store。
3. **补齐失败持久化。** 将 capture 纳入现有 encrypted outbox 协议，保留 event ID、project/Engagement、source kind 和有界 payload；仅对可重试的 authority unavailable 排队。schema、权限或绑定错误应立即可见且不可盲目重放。
4. **提高运行可观测性。** 记录 operation、event ID、错误分类和成功/失败计数；普通日志不写原始响应、Cookie、token、Flag、完整工具输出或报告正文。best-effort 也不能无声丢弃。
5. **真实联调。** 用真实固定版本 Taric gateway 分别提交 solver tool result、attempt、report 三类 capture；正向确认写入与 query 回读，负向确认无效 UUID、未知字段、越权 principal、重复 event 和超限 payload 的预期错误。

**验收条件**：capture 成功率在已确认的 smoke 事件中为 100%；重复请求幂等；authority 短暂中断后 replay 不丢不重；校验类错误在 API/diagnostics 中可定位；脱敏检查确认敏感内容未进入普通日志或 Taric。

### P1：收紧身份隔离并完成 Memory 查询闭环

1. 对 shared Engagement 做显式架构选择。若保持当前单机共享 profile，应把它定性为部署级安全边界，并测试 query/proposal/outbox 的项目过滤和不可伪造标题。若要求一项目一 Engagement，则实现按项目创建 Engagement、token/Principal 与 Engagement 动态绑定、撤销/清理和历史数据迁移后再启用。
2. 在 `resource.query` 与 `proposal.list` 实现 bounded cursor pagination，遵循 Taric 返回的 cursor 和稳定 `read_seq`；超限时返回明确状态，不能悄悄截断。
3. 定义 solver board 的刷新模型：启动快照之后由 challenge bridge 查询权威状态，或消费订阅提示再作权威刷新。订阅只作刷新 hint，不能直接推进 solver/目标动作。
4. 让 Taric outbox 对 proposal 和 observation 使用统一的项目绑定、加密、序号、幂等和冲突处理合同；保持 Taric mode 不回落到旧文件 authority。

**验收条件**：同 challenge code 的两个团队/项目不能互相读取、写入或 replay；数据超过 50 条时分页无重复/漏项；solver 在新增候选后按文档策略及时刷新，authority unavailable/恢复过程状态可观察。

### P2：建立授权渗透测试治理工作流

本阶段只对 `authorized_pentest` 开放，竞赛模式继续使用当前平台与 `scanned` 语义。

1. 引入独立 `authorized_pentest` 创建与 Scope/ROE/测试窗口校验。目标动作由 host egress enforcement 授权，memory mode 必须 `taric_required`；Taric unavailable 或 Scope 校验失败时 fail closed。
2. 在 BreachWeave 落地 manifest -> Resource/Revision -> WorkItem/WorkRun -> host tool execution 的状态模型，调用 Taric work claim/renew/transition，并由 BW scheduler 维护 solver slot 与目标资源互斥。Taric lease 是 WorkRun fencing，不替代目标锁。
3. 把工具输出存入 host-managed Artifact 或经验证的 Taric Artifact spool，再以 UUID 引用形成 Observation/Evidence/Claim/Finding 链。明确原始内容 ACL、脱敏、加密、保留和删除策略。
4. 对每项 manifest × ResourceRevision 生成 coverage cell；host 写入真实结果，读取 coverage gate 的同一 `read_seq` 快照，并将 gate、scope revision、manifest hash 固定到报告快照。operator 显式确认未测/受阻项后 close。
5. 增加独立 reviewer/admission 流程。模型只提交 proposal；reviewer/operator 按证据与策略作出准入/拒绝/要求补测决定并可追溯。`IdeaStatus.verified` 不直接转成 Taric admitted/supported。
6. 定义 checkpoint 内容的可恢复白名单与敏感数据策略，绑定 WorkRun/generation；重启或租约失效后先从 authority 重建状态，再恢复 solver，不允许旧 generation 写回。

**验收条件**：竞赛 `scanned` 不影响授权 coverage；所有目标动作可追溯到已授权 Scope 和 WorkRun/generation；coverage gate 与报告快照使用同一 authority 水位；关闭前未测项和风险有 operator 记录；重启后旧 generation 被拒，活跃工作可幂等恢复。

### P3：验证集成收益

先完成基础正确性，再用同一挑战集运行 `legacy_local` 与 Taric 模式对照。每种条件重复多轮，固定模型、prompt、工具镜像、目标版本、时间/token 预算和并发度。分别测量：已有候选复用率、capture 成功率、proposal admission 时间、重复测试率、覆盖完整率、恢复成功率、报告中可复核 evidence 比例和任务完成率。报告方差与失败样本；单次任务只能形成案例记录，不作为质量改善的因果证据。

## 分阶段交付顺序

| 阶段 | 交付 | 入口门槛 |
|---|---|---|
| S0 运行证据归档 | 补充 `f41e775a` 原始脱敏日志、authority 查询结果、版本/配置摘要；区分观测和推断 | 不修改历史运行事实，只补证据来源与范围 |
| S1 Observation 修复 | P0 schema adapter、幂等 capture outbox、错误分类、真实 gateway smoke | 可重复提交三类事件，契约与脱敏校验通过 |
| S2 Memory 完整性 | pagination/read_seq、刷新策略、项目隔离验收、共享 Engagement 决策 | 多项目负向用例和 >50 条分页用例通过 |
| S3 Authorized workflow | Scope/egress、WorkRun、Artifact/Evidence、coverage gate、review/close、checkpoint recovery | 独立 authorized profile 与失效 fail-closed 测试通过 |
| S4 收益评估 | 配对基准、重复运行和指标报告 | 先锁定实验变量、基准集和指标定义 |

## 代码与测试核查索引

| 主题 | 位置 |
|---|---|
| Daemon 启动与 solver event hook | `packages/core/src/index.ts` |
| 项目/provider 路由、捕获、planner、report/scanned 完成状态 | `packages/core/src/challenge/manager.ts`、`packages/core/src/challenge/store.ts` |
| Taric memory projection、claim proposal、单页查询、outbox/replay | `packages/core/src/challenge/taric-memory-provider.ts` |
| Observation DTO 构造及 operation allowlist | `packages/core/src/taric/host-module.ts` |
| 默认 shared Engagement 与 gateway token 绑定 | `packages/core/src/taric/local-gateway.ts`、`docs/taric-deployment-runbook.md` |
| Project 身份与复合键 | `packages/core/src/project/types.ts` |
| Mock contract/provider tests | `packages/core/src/challenge/taric-memory-provider.test.ts`、`packages/core/src/taric/host-module.test.ts` |
| 已计划但仍需完成的集成验证 | `openspec/changes/integrate-taric-external-memory/tasks.md`（6.3） |
