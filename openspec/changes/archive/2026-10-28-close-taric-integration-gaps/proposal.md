# Proposal

## Why

BreachWeave now has a Taric-backed project memory provider, candidate proposals, trusted host bindings, compatibility checks, and proposal outbox replay. A review of the current implementation and the `f41e775a` run analysis found that this is a memory integration rather than an end-to-end Taric governance workflow. Host observations are not projected to a verified Taric schema contract and are not recoverable through the proposal outbox; queries stop after one page; a local deployment shares one Engagement; and authorized pentest workflows do not yet use Scope/ROE enforcement, WorkRun leases, Artifact/Evidence links, coverage gates, host admission, API close, or checkpoint recovery. Reported run counts are not all reproducible from the repository and must be separated from code-level evidence.

This change closes those BreachWeave-side gaps incrementally. A local adapter contract smoke is enough to begin development; real Taric profile checks are useful evidence when the environment provides them, but are not required to implement or enable local functionality.

## What Changes

- Add `taric-memory-reliability` for typed allowlisted observation DTOs, valid Resource and evidence references, operation-specific error handling, recoverable host capture, complete cursor pagination, stable read watermarks, and a defined solver-board refresh contract.
- Add `project-engagement-isolation` for an explicit Engagement authorization policy. Shared Engagement remains an explicitly documented deployment boundary for limited local use; a project-key title prefix alone is never treated as Taric authorization.
- Add an `authorized-pentest-governance` capability for host-enforced Scope/ROE and egress, Resource/WorkRun lifecycle, Artifact/Evidence provenance, manifest-driven coverage, host admission, API close, and recoverable checkpoints. These controls apply only to `authorized_pentest`; competition `scanned`, Flag, and solved semantics remain separate.
- Add a `taric-integration-evaluation` capability that distinguishes repository-verifiable behavior from optional run observations and keeps outcome reports descriptive.
- Run focused local type checks, unit tests, and smoke checks while implementing each stage. Real-profile, failure-injection, migration, and benchmark checks are optional follow-up work when the environment supports them.

## Capabilities

### New Capabilities

- `taric-memory-reliability` — make host capture contract-conformant and observable, recover deferred writes according to Taric operation semantics, and provide complete bounded reads.
- `project-engagement-isolation` — define which deployment profiles may share an Engagement and require project-bound authority where the security boundary demands it.
- `authorized-pentest-governance` — govern authorized target actions and completion through Scope, work, evidence, coverage, and host decisions.
- `taric-integration-evaluation` — record optional run evidence and descriptive integration observations without making repeated comparisons a release gate.

## Dependencies and Scope Boundaries

This proposal follows `integrate-taric-external-memory`; it does not rewrite that change's task history. The new capabilities can be implemented incrementally alongside the existing code, and predecessor verification can be completed separately when the relevant environment is available.

The change modifies BreachWeave and its deployment profile. It does not change Taric Core or invent Taric operation semantics. In particular, Taric's current registry marks `capture.observation` non-idempotent. BreachWeave MUST NOT claim exactly-once observation delivery from a stable client ID alone. If the deployed Taric profile cannot reconcile an ambiguous capture by a durable host event reference, the host must preserve an `indeterminate` outbox state for later reconciliation rather than automatically resend and risk a duplicate.

This change keeps target authorization, network enforcement, secret handling, scheduling, and retention in the host. Human role assignment and manual approval workflows are optional integrations rather than prerequisites for local development.

## Impact

- Core challenge lifecycle, Taric adapter/provider, project identity, solver event capture, runtime scheduling, artifact handling, and authorized project service boundaries.
- Web/API flows for capture diagnostics, proposal state, coverage status, incomplete work, and Engagement close.
- Host configuration for project-to-Engagement bindings, optional principal/token profiles, egress policy, Artifact retention, and encrypted outbox limits.
- Local adapter tests and smoke checks. Real-profile integration evidence and reproducible evaluation records may be added later; existing uncommitted changes and predecessor task history remain untouched.
