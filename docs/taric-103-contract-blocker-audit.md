# Taric control-plane contract audit — 1.0.4

2026-11-01，锁定源码 `1c466f4d8ad8f775f98bf867453b81230469287a`（包含 `6e173b4`）。此前1.0.3的缺失合同探针已替换为当前合同存在性与实际行为验证。当前 `missingFacts=[]`；未发现仍阻塞这些本地服务路径的上游核心合同缺口。

| 原阻塞 | 当前合同与本地接入 |
| --- | --- |
| Scope/ROE不可变修订 | `scope.revise/query/invalidate`；verified ROE Artifact、ScopeRevision ID与policy digest绑定；过期/旧修订拒绝恢复 |
| 完整Coverage域 | `coverage.manifest.commit`、`coverage.snapshot`、同水位gate；包含inconclusive、missing项、visibility/truncation disclosure |
| 完整Action历史 | `action.audit.query`；append-only ActionEvent、ScopeRevision、实际socket peer provenance、unknown/reconcile及迟到结果隔离 |
| ReportSnapshot | `report.snapshot.commit`绑定manifest、Scope/Resource修订、Coverage/Evidence水位摘要及已提交Artifact |
| CloseDecision | `engagement.close/reopen`；CAS校验、原子完成状态、不可变关闭历史与独立进程重建 |

复现：

```sh
bun run audit:taric:contract --taric-source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-103-contract-audit.json
bun scripts/smoke-taric-control-plane.ts --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-104-canonical-control-plane.json
bun run smoke:taric:actions --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-103-actions.json
bun run verify:taric:control-plane --source=/Users/liuhongtao/development/Taric
```

审计机器报告保存源码/build摘要、operation/schema/storage tuple、原始及Bun driver适配测试摘要。15个审计检查包含20个选定上游行为断言；这不是“所有上游测试套件原样通过”的声明。SQLite服务烟测、干净tarball consumer、产品切换及生产部署是不同证据。

剩余阻塞分类：

- **BreachWeave实现**：authorized Planner/Solver启动与双读切换、所有capture/publication调用方、reviewer L2工作流，以及Web/stat/report projections替换。当前旧Web session/local Map引擎不能因新合同存在而自动启用；readiness继续报告 `governed_agent_lifecycle_incomplete`。
- **本机环境**：OrbStack报告Running，但Docker Unix socket请求和PostgreSQL协议响应超时。`scripts/diagnose-taric-orbstack.ts`和`docs/artifacts/taric-104-orbstack-diagnostics.json`给出有界复现。未重启引擎/现有Mongo/数据库，未修改上游来绕过故障。
- **生产证据**：独立物理主机分区、身份撤销、持久egress、配套DB/content/cursor key恢复和DR尚未验证。这些不阻塞独立本地SQLite服务验收。

当前没有继续保留为“Taric缺少核心合同”的旧阻塞。若后续真实调用发现新的上游缺口，应记录确切operation、principal、请求前提、源码摘要、错误code与无副作用复现；不能沿用旧1.0.3报告作为1.0.4失败证据。完整产品验收仍未通过，变更不可归档。
