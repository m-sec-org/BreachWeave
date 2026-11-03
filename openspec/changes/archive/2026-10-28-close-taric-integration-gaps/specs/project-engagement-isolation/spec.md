# Spec Delta

## Purpose

Clarify the authorization boundary between BreachWeave project namespaces and Taric Engagements, while preserving separate competition and authorized-pentest state.

## ADDED Requirements

### Requirement: Cross-boundary reads and writes are denied

The host SHALL verify the trusted project identity, mode, and Engagement for every persistent operation. Cross-project, mode, or Engagement access SHALL fail closed. Project keys and title prefixes are application namespaces, not Taric authorization. Shared Engagement with host-derived project filtering is supported for local development; project-bound credentials remain the recommended option for multi-tenant deployments rather than a local development prerequisite.

#### Scenario: A caller supplies a forged project namespace

- **WHEN** a model or client supplies a project key, title, tenant, principal, or Engagement that differs from the host's trusted launch context
- **THEN** the host rejects the request before calling Taric or mutating local state

#### Scenario: Shared Engagement is configured

- **WHEN** a single-tenant development or practice deployment uses the documented shared-Engagement profile
- **THEN** operator-facing configuration identifies it as a shared authority boundary and every returned record is filtered and audited against the host-derived project identity

#### Scenario: An authorized project uses the local shared authority

- **WHEN** an authorized pentest project runs in the documented local development profile without project-bound credentials
- **THEN** Taric-backed operations use the host-derived project identity and shared Engagement filter; the deployment is reported as local/shared rather than production-isolated

### Requirement: Completion states remain domain-specific

The host SHALL expose local report coverage, platform Flag progress, team solved summaries, and authorized coverage as distinct states. Competition `scanned` SHALL retain its existing meaning and SHALL NOT be converted to platform solved, a Finding, or authorized coverage. An authorized Engagement may close through the host governance API after the coverage gate; an explicit human operator decision is optional in the local profile.

#### Scenario: A local report is submitted

- **WHEN** a solver submits a local-practice report for an asset
- **THEN** the asset may become `scanned` while platform Flag and authorized coverage states remain unchanged

#### Scenario: Authorized coverage is complete

- **WHEN** Taric coverage gate reports a closable state for an authorized Engagement
- **THEN** the host can close through the local governance API and records available coverage details; additional human disclosures are optional metadata
