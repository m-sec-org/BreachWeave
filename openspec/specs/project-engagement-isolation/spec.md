# project-engagement-isolation Specification

## Purpose
Clarify the authorization boundary between BreachWeave project namespaces and Taric Engagements, while preserving separate competition and authorized-pentest state.

## Requirements

### Requirement: Cross-boundary reads and writes are denied

The host SHALL verify the trusted project identity, mode, principal, and Engagement for every persistent operation. Cross-project, mode, or Engagement access SHALL fail closed. Project keys and title prefixes are application namespaces, not Taric authorization. A shared Engagement with host-derived filtering is permitted for the local development path.

#### Scenario: A caller supplies a forged project namespace

- **WHEN** a model or client supplies a project key, title, tenant, principal, or Engagement that differs from the host's trusted launch context
- **THEN** the host rejects the request before calling Taric or mutating local state

#### Scenario: Shared Engagement is configured

- **WHEN** a single-tenant development or practice deployment uses the documented shared-Engagement profile
- **THEN** operator-facing configuration identifies it as a shared authority boundary and every returned record is filtered and audited against the host-derived project identity

#### Scenario: Shared Engagement is configured locally

- **WHEN** a single-host development deployment uses a shared Development Engagement
- **THEN** operator-facing configuration identifies it as a shared authority boundary and every query, write, projection, and outbox replay is filtered and audited against the host-derived project identity

#### Scenario: An authorized project uses the local shared authority

- **WHEN** an authorized pentest project runs in `local_development` without project-bound credentials
- **THEN** Taric operations use the host-derived project identity and shared Engagement filter, and the deployment is reported as local/shared

#### Scenario: Two projects share a challenge code

- **WHEN** two teams or projects use the same challenge code under a shared local Engagement
- **THEN** their query, proposal, capture, Artifact, Coverage, and outbox replay results remain filtered by their host-derived project identities

### Requirement: Completion states remain domain-specific

The host SHALL expose local report coverage, platform Flag progress, team solved summaries, and authorized coverage as distinct states. Competition `scanned` SHALL retain its existing meaning and SHALL NOT be converted to platform solved, a Finding, or authorized coverage. An authorized Engagement may close through the host governance API after the coverage gate; an explicit human operator decision is optional in the local profile.

#### Scenario: A local report is submitted

- **WHEN** a solver submits a local-practice report for an asset
- **THEN** the asset may become `scanned` while platform Flag and authorized coverage states remain unchanged

#### Scenario: Authorized coverage is complete

- **WHEN** Taric coverage gate reports a closable state for an authorized Engagement
- **THEN** the host can close through the local governance API and records available coverage details; additional human disclosures are optional metadata
