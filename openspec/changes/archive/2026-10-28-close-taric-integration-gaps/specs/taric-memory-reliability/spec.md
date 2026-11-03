# Spec Delta

## Purpose

Strengthen the existing Taric host-memory contract so observations are schema-conformant and recoverable, and so reads are complete, bounded, and freshness-aware.

## ADDED Requirements

### Requirement: Host capture preserves provenance

The host SHALL build each capture from a schema-approved operation allowlist and bind the trusted project/Engagement, source kind, and origin event identity. Resource and committed Artifact/Evidence references SHALL be validated. Raw solver/report/model fields SHALL NOT enter canonical observations, and model provenance SHALL NOT elevate a proposal. Run metadata and person-specific owner fields are optional locally.

#### Scenario: A solver tool result is captured

- **WHEN** the host receives a solver event associated with a trusted Resource and active WorkRun
- **THEN** it emits only the approved observation fields, the trusted Resource reference, host provenance, and the current WorkRun/generation

#### Scenario: A report contains unsupported or sensitive fields

- **WHEN** a report event contains fields not approved for Taric or values excluded by host policy
- **THEN** the host stores an approved bounded summary or host-managed artifact reference and does not forward the raw object or excluded values

#### Scenario: A Resource reference cannot be resolved

- **WHEN** the event is resource-bound but the host has no valid Taric Resource UUID
- **THEN** the host does not substitute a synthetic identifier and records the capture as rejected or host-audit-only according to the event policy

#### Scenario: A model claims an observation is trusted

- **WHEN** a model submits content containing host, verified, or trusted source claims without a matching host capture
- **THEN** the claim remains a proposal and cannot enter the host observation path solely because of model fields

### Requirement: Deferred Taric events are bounded and operation-aware

The host SHALL encrypt and bound append-only deferred events with trusted project/Engagement, operation, order, and replay state. Replay MUST follow Taric's idempotency contract; stable IDs alone do not make non-idempotent writes exactly once. Ambiguous writes should be reconciled when possible or remain `indeterminate` for later inspection. On conflict, limit, or key failure, the host SHALL stop new deferred writes and preserve queued events.

#### Scenario: An idempotent proposal is deferred

- **WHEN** a proposal submission fails due to a transient authority outage
- **THEN** the encrypted outbox replays it in order using the same Taric idempotency key and records the confirmed result or conflict

#### Scenario: A non-idempotent observation has an unknown outcome

- **WHEN** the connection fails after an observation request may have committed
- **THEN** the host checks for the durable origin reference; if it cannot prove whether the write committed, it preserves an `indeterminate` event and leaves retry to the configured local policy

#### Scenario: A capture fails validation or authorization

- **WHEN** Taric rejects an observation for schema, binding, or permission reasons
- **THEN** the host classifies the failure as permanent, surfaces a diagnostic, and does not place the payload in transient-outage replay

#### Scenario: The outbox reaches a configured limit

- **WHEN** the outbox reaches its event or byte limit, or its encryption key is unavailable
- **THEN** the host rejects additional deferred writes and preserves pending and conflicting events for later reconciliation

### Requirement: Taric reads are complete within explicit budgets

The host SHALL follow Taric keyset cursors for canonical and candidate queries, apply a configured maximum page and total record/byte budget, and preserve a consistent `read_seq` when the Taric query contract supports it. If a budget is reached before exhaustion, the host SHALL mark the result truncated or degraded and SHALL NOT present it as a complete project board.

#### Scenario: A project has more records than one page

- **WHEN** a memory or proposal query returns a next cursor
- **THEN** the host fetches subsequent pages within the configured bound and returns each record at most once

#### Scenario: The query budget is exhausted

- **WHEN** the authority has more records than the host's configured budget
- **THEN** the API identifies the result as partial and exposes the watermark/cursor needed for a later refresh

### Requirement: Solver boards refresh from authoritative state

The host SHALL distinguish the initial solver board snapshot from the authoritative Taric state. It SHALL define a refresh mechanism using a bounded host-bridge query or subscription hints followed by authoritative query from a confirmed watermark. Notifications alone SHALL NOT mutate trusted state, trigger target actions, or launch work.

#### Scenario: A proposal arrives while a solver is active

- **WHEN** a new project proposal is accepted or an authority notification arrives
- **THEN** the host refreshes the bound board according to policy and marks candidate versus admitted state without treating the notification as the record itself

#### Scenario: Notification recovery detects a gap

- **WHEN** a subscription reconnects after missed or duplicate notifications
- **THEN** the host re-queries from its last confirmed `read_seq` before publishing refreshed state
