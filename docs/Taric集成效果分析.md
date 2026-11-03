我来收集 f41e775a 这个挑战的完整运行数据（记录、solver 活动、Taric 权威库写入），再对照 Taric 集成方案文档做能力预期评估。

任务确认跑在 `taric_best_effort` 模式（本地目录已无 memory/ideas 文件夹，符合 Taric 路由）。查 Taric 权威库里这个项目命名空间的实际数据：

关键发现需要交叉验证：任务书里 "当前 Memory 摘要： 无"（启动时为空是首次尝试的正常状态），写入侧 3 条已确认。现在验证**读取侧**是否真的把 Taric 数据喂回了 planner/solver，以及 host 侧观察捕获是否落库：

写入侧确认（3 条 memory 提案），但 records 表里**没有任何 observation 记录**——host 侧事件捕获链路需要核实。同时找读取侧的证据（API 列记忆）：

两个关键事实浮出：**297 次 host 侧事件捕获全部失败**（我之前的修复只补了缺失字段，但 observation 契约是封闭世界——把原始 solver 事件字段直接 spread 进记录，任何多余字段都会被 `unevaluatedProperties: false` 拒绝）；而 solver 侧桥接写入是通的。再验证读取侧回显和网关流量：

读取侧打通确认：API 经 Taric 查询路径回显了 3 条候选记忆（`source: taric:candidate`，候选与准入状态正确区分）。现在读集成方案文档，对照能力预期：

再核对文档 §14.4/14.5 的数据模型映射预期，这决定共享 Engagement 权宜与文档设计的偏差：

# 客观分析：Taric 在 f41e775a 中真实发挥了作用，但只激活了其能力模型的一小角——按集成方案的验收标准，当前处于 P1–P2 之间，离“渗透测试专属领域扩展”的预期还有实质距离

## 一、f41e775a 的 Taric 实际痕迹（全部有数据实证）

任务于 12:01–12:11 运行：`memory_mode: taric_best_effort`、trusted 项目绑定、1 solver（5dfbeb73）、2 份报告、29.4 万 tokens。Taric 侧的痕迹：

| 证据 | 数据 |
|---|---|
| 写入 | 权威库中 3 条该项目命名空间的提案（2 evidence + 1 fact）：union SQL 注入证据、登录流程事实、已证实漏洞清单——与报告内容一致，是 solver 工作过程的真实沉淀 |
| 读取 | challenge detail API 经 Taric 查询路径回显这 3 条，`source: taric:candidate`、`trustState: candidate`，候选态与准入态正确区分 |
| 健康 | memory-health 全程 healthy（TLS 网关 RPC 链路稳定） |
| 隔离 | 本地目录**不再产生** memory/ideas 文件——记忆确实搬到了权威层 |
| 缺失 | 记录表里**零条 observation**：host 侧事件捕获 **297 次全部失败**（我上一轮的修复只补了缺失字段，没解决封闭世界契约——原始 solver 事件字段被 spread 进记录后被 `unevaluatedProperties: false` 拒绝。这是 BreachWeave 侧未修完的 bug，如实报告） |

## 二、确实发挥了的四个作用（对照方案 §3 结构性防护）

1. **防“记忆丢失”（§3.1，Taric 第一价值主张）**：状态在权威层而非会话里。挑战结束、solver 容器销毁后，3 条记忆仍在 authority.sqlite，任何后续会话可查——“会话死了记忆还在”成立。
2. **防“模型直写”的底线（§3.3 的一半）**：solver 的记忆写入全部走 model principal 的 `proposal.submit` 进入**候选层**，幻觉无法直接污染事实层。这是四道防线中写入侧的那道，确实立住了。
3. **候选/准入分级可见**：回读时 pending candidate 与 admitted 明确区分（符合 runbook 的 operator 视图要求）。
4. **多 principal 网关治理**：host/model/operator 三身份经 TLS 网关鉴权隔离，模型侧拿不到 host 权限。

但必须指出：**本次单 solver、单 attempt、3 分钟的运行形态，恰好是 Taric 增益最难显现的形态**。对照上一次 legacy_local 模式的 dvwa 任务（4a0914b9），最终报告质量没有可见差异——因为跨 solver 记忆共享、中断恢复、并发治理这些 Taric 的核心增益场景本次根本没有被触发。

## 三、对照方案文档的能力预期，差距是结构性的

**§5.1 九个黑板分区，激活了一个半**：

| 分区 | 预期 | 实际 |
|---|---|---|
| 治理壳（Engagement/Scope） | ✓ | ✓ 运行中 |
| 结论事实区 | 提案→admission→L1→复核→L2 | 只有提案，**永远 pending**——没有任何 admission/review 流程在运行 |
| 观察结果区 | 宿主 capture.observation 代写 | **297 次全败，区域为空**（BreachWeave 侧 bug） |
| 覆盖状态区 | CoverageCell + 覆盖闸门 | 完全未用，完成判据仍是 `scanned` 布尔（§14.9 明令禁止双写的状态） |
| 原始证据区 | Artifact→Evidence 引用链 | 未用；evidence 是**裸字符串提案**（§14.4 明确“不接受裸字符串”） |
| 任务规划/执行区 | WorkItem 提案化 + work.claim 租约 | 未用；planner 仍直接启动容器（§14.6 时序的三处差异之一） |
| 恢复区 | checkpoint/resume | 未用 |

**§14.7 五阶段验收定位**：P1（只读黑板）大半达成——读路径通、按项目隔离、无跨项目泄漏；P2（提案闭环）形式达成实质未达——提案化 ✓ 但无 admission，提案永不落地；P3（执行协作）、P4（reviewer/覆盖闸门）、P5 未开始。

## 四、与文档设计的三处实质偏差（需要决策层面知晓）

1. **共享 Engagement 违反 §14.4 明文映射**：“一个项目一个 Engagement，**禁止跨项目共享**”。当前因网关 token fail-closed 模型被迫共享，靠 BreachWeave 的 projectKey 标题前缀做软隔离——用约定隔离替代了 Taric 的 engagement 硬隔离边界，是安全语义上的降级。文档推荐的拓扑其实是 **Node bridge（§14.2/§14.5 #14）**：bridge 进程内 `openRuntimeService` 直连 DB，天然支持每项目独立 engagement，不存在 token--engagement 配对问题。我们选的 authenticated_proxy 形态适合多主机远端接入，不适合当前“一机一库”的本地部署。
2. **§14.9 第一条处于灰色地带**：“不要让 Solver 模型直接写 challenge_memory_add 后再由宿主‘补一个提案’”——当前 `challenge_memory_add` → 自动 proposal.submit 恰是这个模式。底线（不进事实层）守住了，但“等于放弃 Taric 核心价值”的警告针对的独立治理环节确实缺席。
3. **数据模型映射未做**：`MemoryEntry.kind` 到 Taric 领域实体的映射（fact 区分“工具观察 vs 模型归纳”、evidence 挂 Artifact、failure→NegativeObservation、idea→TestHypothesis 且 verified 不能直接映射 supported）全部未实施，所有 kind 一律当 claim 处理——Taric 的**领域语义层**没有用到。

## 五、最终判定

**“外置记忆底座”成立，“渗透测试专属领域扩展”未成立。** 当前状态等价于：把 BreachWeave 的记忆从本地文件搬进了带身份治理的权威库（这本身是有意义的里程碑——零直写、分级可见、断会话不丢），但 Taric 区别于“一个带鉴权的数据库”的那些渗透测试领域专属能力——覆盖矩阵与完成闸门、Artifact→Evidence→Claim→Finding 证据链、work 租约并发控制、checkpoint 断点恢复、独立 reviewer 晋升——**一项都还没有进入 BreachWeave 的工作流**。用方案自己的话说：三处关键时序差异（报告不再翻转布尔、Observer 不再直写、Planner 不再直接启动容器）一处都还没落地。

如果要向 P3 推进，优先级建议：先修观察捕获的封闭世界 bug（观察区是覆盖矩阵和宿主代写的数据源，堵住它后面整条链都动不了），再按 §14.5 #6/#7 把完成判据切到覆盖闸门——这两步做完，Taric 才开始提供 legacy_local 模式给不了的东西。需要我起草这个推进计划或先修观察捕获 bug 的话，说一声。