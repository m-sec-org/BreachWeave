# Spec: Engagement 证据/报告层（Slice 3 契约）

> 适用：新增 `packages/core/src/engagement/finding.ts` + `report.ts`；小幅**加法式**扩展 `config/tools/document-finding.ts`（仅新增可选字段，向后兼容）。
> 目标：把 `findings.ndjson` 提升为带 严重级/置信度/修复建议 的企业级发现，并产出 人读报告 + SARIF 导出（decision #5）。承接 Slice 2 的 `engagement-policy.json` / `pentest-workspace`。

## 1. finding.ts —— SDK-free 共享类型 + 解析（可测）
- `Severity = "critical" | "high" | "medium" | "low" | "info"`。
- `ReportFinding`：现有 `FindingRecord` 字段（target, kind, entry_point, hypothesis, hypothesis_id, status, evidence, evidence_refs[], source_agent, source_artifact, notes, timestamp）**+ 可选** `severity?: Severity`、`confidence?: number(0..1)`、`remediation?: string`、`request?: string`、`response?: string`（请求/响应证据，可选；也可继续用 evidence_refs 指向抓包文件）。
- `parseFindingsNdjson(content: string): ReportFinding[]`——逐行 JSON.parse，容忍空行/坏行（丢弃）。
- `deriveSeverity(f: ReportFinding): Severity`——缺省推导：有 `severity` 用之；否则按 `status`（verified→"high"、candidate→"medium"、rejected→"info"）兜底。
- `severityToSarifLevel(s): "error"|"warning"|"note"`——critical/high→error、medium→warning、low/info→note。
- **无 `@mariozechner/*` import**（保证单测无需 SDK）。

## 2. report.ts —— 渲染 + 导出（SDK-free 逻辑，I/O 用 Bun）
- `renderReportMarkdown(findings, meta): string`——人读报告：① Executive Summary（按 severity 与 status 计数表）② 按 severity 分组的 finding 明细（severity/confidence/status/target/entry_point/evidence/证据refs/remediation/hypothesis_id 溯源）。空 findings 给出占位报告。
- `toSarif(findings, meta): SarifLog`——SARIF 2.1.0：`version:"2.1.0"`、`$schema`、`runs[0].tool.driver{name:"BreachWeave", rules:[按 kind 去重]}`、`runs[0].results[]`（每 finding 一条：`ruleId=kind`、`level=severityToSarifLevel`、`message.text=hypothesis`、`locations[0].physicalLocation.artifactLocation.uri=target`（entry_point 进 region 或 message）、`properties{confidence,status,evidence_refs,hypothesis_id}`）。
- `writeEngagementReport(cwd, meta): Promise<{ markdownPath: string; sarifPath: string; count: number }>`——读 `findings.ndjson`（用 finding.ts 解析）→ 写 `report.md` + `report.sarif.json`。`meta` 至少含 `engagementId`、`generatedAt`（调用方传时间戳，勿在纯函数里 new Date；Bun 层可 new Date）。
- 幂等：可重复生成（覆盖 report.md / report.sarif.json）。

## 3. document-finding.ts —— 加法式扩展（向后兼容）
- `DocumentFindingParams` 新增**可选** `severity`(枚举同 Severity)、`confidence`(0..1)、`remediation`(string)、`request`(string)、`response`(string)。
- `FindingRecord` 用 `ReportFinding`（从 finding.ts import 类型），写入时带上这些可选字段（未提供则省略）。
- 现有校验/去重/渲染逻辑不变；旧 findings.ndjson 仍可解析（缺字段走 deriveSeverity 兜底）。

## 4. 测试契约（Slice 3 验收）
- `parseFindingsNdjson`：解析多行、跳过坏行；`deriveSeverity` 按 status 兜底正确。
- `renderReportMarkdown`：含 Executive Summary + 计数；按 severity 分组；含 remediation/evidence/hypothesis_id 溯源；空集给占位。
- `toSarif`：`version=2.1.0`、每 finding 一条 result、level 映射正确（critical/high→error…）、ruleId=kind、rules 去重、properties 带 confidence/status。
- `writeEngagementReport`（写 tmp 目录，预置 findings.ndjson）：生成 report.md + report.sarif.json，count 正确；SARIF 可被 `JSON.parse` 读回且结构合法。
- 无 SDK 依赖跑绿；`tsc -p packages/core` 新文件 0 错误（仅保留 pre-existing 3 处生成文件错误）。
- 不做：UI 展示、真实抓包、工单系统对接（后续 slice）。

## 5. 约定
- 纯逻辑（类型/解析/渲染/SARIF 构建）放 finding.ts / report.ts（SDK-free、可测）；只有 `writeEngagementReport` 做 Bun.file/write I/O。
- 时间戳由调用方注入（`meta.generatedAt`），纯函数内不调 `new Date()`。
- 不改 document-finding.ts 既有行为，仅加可选字段。
