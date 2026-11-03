# Spec Delta

## Purpose

为 BreachWeave 提供受信任的 Taric host 集成边界，使模型只能访问受限记忆投影和候选提案，而真实观察、证据和恢复状态由 host 以可审计、可恢复的方式提交。

## ADDED Requirements

### Requirement: Taric authority requires a bound host context

The host SHALL establish a matching Taric contract, authority, Engagement, and host principal before exposing Taric-backed memory to a project. A request, solver, or model SHALL NOT select or override the Engagement, principal, mode, or tenant binding.

#### Scenario: Project starts with a valid Taric binding

- **WHEN** the host starts a project with matching API/schema/policy versions and a trusted Engagement/principal binding
- **THEN** the project may expose the configured Taric memory operations and records the selected binding in its runtime state

#### Scenario: Binding is missing or mismatched

- **WHEN** the host cannot validate the authority, contract version, tenant, Engagement, or principal binding
- **THEN** `taric_required` blocks the project launch and the host returns a diagnostic without creating an unbound Taric session

### Requirement: Model memory access is bounded and proposal-only

The host SHALL expose only bounded, engagement-scoped Taric projections to model processes. Model-originated writes SHALL create proposals or checkpoint proposals; host-only capture, WorkRun transition, coverage recording, admission, and raw Artifact operations SHALL require a trusted host principal.

#### Scenario: Model queries shared memory

- **WHEN** a model requests memory for its bound project and budget
- **THEN** the host returns only allowlisted metadata/references within that Engagement and does not return credentials, raw Artifact bytes, or another project’s records

#### Scenario: Model attempts a host-only write

- **WHEN** a model request targets a host-only operation or supplies a different principal/Engagement
- **THEN** the host rejects the request and records the authorization failure without forwarding it as a host operation

### Requirement: Host capture preserves provenance

The host SHALL attach the trusted project, principal, source kind, WorkRun/Attempt/generation when available, and evidence or Artifact references to captured observations. Model-supplied provenance fields SHALL NOT elevate a proposal to a trusted observation.

#### Scenario: Tool output is captured

- **WHEN** a trusted host receives a tool or platform result for an active run
- **THEN** it stores the result or an approved opaque reference with host-derived provenance and a stable request identity

#### Scenario: Model claims an observation is trusted

- **WHEN** a model submits content containing host, verified, or trusted source claims without a matching host capture
- **THEN** the claim remains a proposal and cannot enter the host observation path solely because of model fields

### Requirement: Memory mode defines authority and outage behavior

The host SHALL support explicit `legacy_local`, `taric_best_effort`, and `taric_required` modes. `legacy_local` SHALL use only the existing local provider; the two Taric modes SHALL treat Taric as the sole authority and SHALL NOT silently fall back to a second query backend.

#### Scenario: Legacy local mode is selected

- **WHEN** a project is configured with `legacy_local`
- **THEN** reads and writes use the local provider and no Taric authority is presented to its solver or observer

#### Scenario: Best-effort Taric becomes unavailable

- **WHEN** a `taric_best_effort` project loses Taric connectivity
- **THEN** platform control flow may continue, memory reads report degraded availability, and new host events are queued for later replay rather than written to the local provider

#### Scenario: Required Taric becomes unavailable

- **WHEN** a `taric_required` project loses Taric authority or fails its health check
- **THEN** new governed target actions, host-only admission, and operator close are blocked until the authority is restored

### Requirement: Deferred Taric events are bounded and idempotent

The host SHALL store best-effort deferred events in an encrypted, append-only, bounded outbox with stable event IDs, project binding, ordering metadata, and replay status. Replaying an already accepted event SHALL return its original result and SHALL NOT create a duplicate fact.

#### Scenario: Events replay after recovery

- **WHEN** Taric becomes available and the host replays deferred events in order
- **THEN** accepted events are applied once, the replay watermark advances, and the project exposes the recovered memory state

#### Scenario: Replay conflicts or the outbox limit is reached

- **WHEN** an event conflicts with Taric state or the outbox reaches its configured bound/key is unavailable
- **THEN** the host stops accepting additional deferred memory writes, surfaces an operator-visible error, and preserves the conflicting event for inspection

### Requirement: Taric notifications are hints with query recovery

The host MAY consume Taric subscription signals for low-latency refresh, but SHALL treat them as best-effort hints. The last confirmed `read_seq` SHALL be used to recover authoritative state after reconnect, duplicate, loss, or slow-consumer disconnect.

#### Scenario: Notification is lost or duplicated

- **WHEN** a Taric signal is lost, duplicated, or arrives after reconnect
- **THEN** the host re-queries from the last confirmed watermark and does not create duplicate memory or infer an action from the signal alone
