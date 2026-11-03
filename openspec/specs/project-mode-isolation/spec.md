# project-mode-isolation Specification

## Purpose
让竞赛项目和授权渗透 Engagement 使用明确、互不混淆的身份与完成语义，避免相同 challenge code、旧本地记录或单一 `scanned` 字段造成跨租户记忆泄漏和错误收敛。

## Requirements

### Requirement: Projects use an explicit mode and valid memory policy

Every runnable project SHALL declare `mode` as `competition` or `authorized_pentest`, a provider where applicable, and one valid memory policy. `competition` SHALL use `legacy_local` or `taric_best_effort`; `authorized_pentest` SHALL use `taric_required`.

#### Scenario: A valid competition project is created

- **WHEN** an operator creates a competition project with `remote` or `local_practice` and a permitted memory policy
- **THEN** the host persists the mode/provider pair and exposes only competition capabilities to its agents

#### Scenario: An invalid mode and policy pair is submitted

- **WHEN** a request selects an unknown mode, omits the required authorized memory policy, or supplies mode fields from model input
- **THEN** project creation is rejected before any solver, provider, or Taric session starts

### Requirement: Persistent state is keyed by a composite project identity

The host SHALL derive one stable project identity from the tenant and mode-specific fields. Competition identity SHALL include tenant, platform, competition, team, and challenge; authorized identity SHALL include tenant and Engagement. Memory, ideas, attempts, submissions, archives, timelines, statistics, planner caches, and solver bindings SHALL use this identity.

#### Scenario: Two teams use the same challenge code

- **WHEN** two teams create projects for the same challenge code in the same or different competitions
- **THEN** their reads, writes, caches, timelines, submissions, and Taric Engagement bindings remain isolated

#### Scenario: A request addresses only a challenge code

- **WHEN** a read or write omits the required composite project identity
- **THEN** the host rejects it instead of selecting a project by bare challenge code

### Requirement: Cross-boundary reads and writes are denied

The host SHALL verify the record identity, request identity, authenticated user/tenant, mode, and Taric Engagement before every persistent read or write. Cross-team, cross-competition, cross-tenant, cross-mode, and cross-Engagement access SHALL fail closed.

#### Scenario: A solver reuses a stale project binding

- **WHEN** a solver or host bridge request carries a project identity that differs from its launch binding
- **THEN** the request is rejected and no Memory, Idea, Attempt, Submission, or Taric record is changed

#### Scenario: A Taric query targets another Engagement

- **WHEN** the host receives a query or proposal for an Engagement outside the authenticated project binding
- **THEN** the host rejects it without forwarding the request to Taric

### Requirement: Legacy records are classified before use

The host SHALL provide a dry-run migration that classifies existing records by verifiable source and reports counts, summaries, conflicts, and sensitive-data warnings. Records without a verifiable mode/source SHALL become `legacy_unclassified` and SHALL be read-only until an operator selects a mode.

#### Scenario: Migration finds a verifiable competition record

- **WHEN** a legacy record contains a verifiable platform, competition, team, and challenge identity
- **THEN** the dry-run assigns the competition identity without changing the source directory, and the confirmed migration preserves its original timestamp and source reference

#### Scenario: Migration finds an ambiguous record

- **WHEN** a legacy record lacks enough source information or conflicts with another identity
- **THEN** it remains in a read-only archive as `legacy_unclassified` and cannot launch agents or target actions

### Requirement: Completion states remain domain-specific

The host SHALL expose local report coverage, platform Flag progress, team solved summaries, and authorized coverage separately. Competition `scanned` SHALL mean only its existing local report state and SHALL NOT become platform solved, a Finding, or authorized coverage. An authorized Engagement SHALL close only through an authority-backed Coverage gate and host report snapshot; a deterministic fixture host/verification actor is used for local development.

#### Scenario: A local report is submitted

- **WHEN** a solver submits a local-practice report for an asset
- **THEN** the asset may become `scanned` while platform Flag, Taric Work, and authorized Coverage states remain unchanged

#### Scenario: Authorized coverage is complete

- **WHEN** Taric Coverage gate reports a closable state for an authorized Engagement and the host report snapshot matches its watermark and revisions
- **THEN** the host may close through the local governance API and records untested, blocked, not-applicable, and residual-risk disclosures

#### Scenario: A competition state is used for authorization

- **WHEN** a caller supplies `scanned` or platform solved as proof for an authorized action or close
- **THEN** the host rejects it and requires the authorized Scope, WorkRun, Evidence, Coverage, and gate contracts

### Requirement: Taric namespaces do not cross domain boundaries

Competition Taric projections, if enabled, SHALL be bound to the competition composite identity and separate principals/retention from authorized Engagements. Cross-challenge knowledge reuse SHALL require explicit operator-approved, sanitized import through normal proposal/evidence flows.

#### Scenario: A competition memory is queried from an authorized project

- **WHEN** an authorized project requests a competition memory or a cross-project recall
- **THEN** the host returns no record unless an operator-approved sanitized transfer exists under the authorized Engagement
