# Design

## Context and Baseline

The predecessor change, `integrate-taric-external-memory`, introduced project identities, Taric host/provider boundaries, proposal projections, a proposal outbox, and manager capture hooks. This proposal adds focused reliability and Engagement-isolation capabilities alongside that baseline, then adds the authorized-pentest workflow and evaluation contracts described in `docs/BreachWeave-Taric集成效果差距分析与改进方案.md`. The work can proceed incrementally in the local development profile.

The repository currently has a single local deployment profile with a shared Taric Engagement and project-key filtering in BreachWeave. `TaricMemoryProvider` maps Memory and Idea writes to `claim` proposals; canonical claims and candidate proposals are read separately, with a hard limit of one 50-record page. Solver startup copies a board snapshot into the session `.observer` directory. Solver events, attempt events, and report submissions call host capture hooks, but arbitrary event fields can reach the Taric observation object. Only proposal writes use the encrypted outbox. `coverage.query` is allowlisted, while WorkRun, coverage writes/gates, Artifact ingestion, admission/review, and restore are not connected to the challenge workflow.

Run-specific assertions in the original analysis (including proposal counts, capture failure counts, health intervals, token usage, and task quality comparisons) are operational evidence, not facts recoverable from source. Implementation reports may attach sanitized logs/queries when available; otherwise they should describe the result as a local observation.

## Goals

- Make every BreachWeave-to-Taric write use a typed, bounded, host-owned contract with visible outcomes.
- Recover from transient Taric outages without silently losing observations or pretending non-idempotent writes are exactly once.
- Make reads complete and explain their authority watermark and freshness.
- State and enforce the actual Engagement authorization boundary.
- Deliver an authorized pentest workflow whose target actions, evidence, coverage, and recovery work in the host development profile.
- Preserve the competition workflow and report Taric effects as descriptive observations unless controlled evaluation data is available.

## Non-Goals

- Changing Taric Core or its public schema/operation idempotency contract.
- Replacing the competition provider, Flag submission, or CTF solved state machine.
- Treating Taric WorkRun leases as locks on targets, tools, or host resources.
- Treating Artifact ingestion as automatic redaction, malware scanning, authorization, or retention enforcement.
- Promoting existing Memory/Idea status values directly into admitted Taric facts.
- Claiming production/multi-host/remote-gateway support without clearly naming the unverified profile.

## Decisions

### 1. Keep predecessor work independent

Do not edit or re-check boxes in `integrate-taric-external-memory` as part of this change. Its checks, review, and archival can be completed independently and do not block local implementation here.

### 2. Use explicit event DTOs and distinguish capture outcomes

Create separate adapters for solver/tool events, attempt lifecycle events, and report/platform results. Each adapter constructs only schema-approved fields; no raw event object is spread into a Taric record. Resolve a real Taric Resource UUID before writing a resource-bound observation. Events without an appropriate Resource or Taric record type remain in the host audit store until a valid mapping exists. Artifact references are accepted only after the artifact is committed and its identifier is validated.

Classify outcomes as `accepted`, `deferred`, `rejected_validation`, `rejected_authorization`, `indeterminate`, or `failed_permanent`. Transient connectivity failures can enter the encrypted bounded outbox. Validation, authorization, and compatibility failures cannot be automatically retried. Since the current Taric registry declares `capture.observation` non-idempotent, stable `dispatch_id` values are correlation keys, not an exactly-once guarantee. After a timeout with unknown commit status, the host should reconcile against Taric when possible and otherwise retain an `indeterminate` record for later retry or inspection.

### 3. Extend outbox semantics by operation contract

Keep ordered replay for operations that Taric declares idempotent, including proposal submissions, using the existing idempotency mechanism. Observation events use a separate replay policy that respects their non-idempotent contract. Encrypt and bound all deferred payloads, bind them to project, Engagement, event type, and operation order, and stop new deferred writes at a limit or key failure. Outbox state never answers queries or becomes a second authority.

### 4. Make reads complete and snapshots explicit

Follow keyset cursors for both canonical claims and proposals, apply an overall host budget, and pin related pages to a consistent `read_seq` where Taric supports it. Return an explicit truncated/degraded result if the query budget is reached; do not return an apparently complete list. Establish an authoritative initial board snapshot and a documented refresh policy: direct host-bridge refresh or subscription hints followed by authoritative query. Notifications alone never mutate solver state or launch work.

### 5. Treat Engagement isolation as a deployment decision

The local gateway currently provisions a shared Engagement because its credentials are Engagement-bound. Allow that profile for local development and keep host-derived project filtering on every query and write. Project-bound Engagement/principal credentials, provisioning, rotation, cleanup, and real-gateway isolation checks are optional hardening for multi-tenant deployments; they are not prerequisites for the local feature path. A title prefix or client filter is not a substitute for project identity when a stronger deployment profile is later enabled.

### 6. Add authorized pentest as a separate host workflow

`authorized_pentest` is distinct from `competition`. Project creation records the available Engagement, scope revision, test window, manifest, and credential references. The local host policy engine evaluates tool actions and can run with the local Taric adapter; stronger `taric_required` and network egress enforcement remain deployment options. UI-level guards and `scope-guard` prompts are advisory when an egress enforcement layer is configured.

The host scheduler owns slot limits, target/resource reservations, and solver lifecycle. Taric WorkRun claims and transitions can provide additional fencing, while a single local worker may use host run IDs without person-specific ownership management. Work inputs derive from approved manifest/resource state. Revisions may invalidate affected work and coverage cells.

Raw output is stored in an explicitly selected host-managed Artifact store or a verified Taric spool profile. The host applies access control, encryption, redaction decisions, retention, and deletion. Taric observations/evidence refer to committed artifacts and carry provenance. Models may submit claims/findings as proposals but may not create host observations, mark coverage, admit proposals, or close an Engagement.

Coverage cells are generated from a versioned manifest and ResourceRevision. The host records result and evidence references, queries `coverage.gate`, and may bind the gate's `read_seq`, scope revision, and manifest digest to the report snapshot. A passing gate can close the local workflow through the host API; human review and disclosure fields are optional metadata.

Review and admission use host services. A single local host actor or automatic admission path may be used in development, with evidence and policy metadata recorded when available. `IdeaStatus.verified` is not admission evidence. Checkpoints use an allowlisted recoverable state; secrets, tokens, cookies, and raw credentials are excluded.

### 7. Separate correctness verification from outcome evaluation

The local check first verifies contracts, project filtering, basic recovery, and build health. Outcome evaluation is optional and may start with a single smoke run using the available challenge/model/tool setup. Report the observed behavior and limitations; do not turn an unmatched run into a causal quality claim.

## Data Flow

```text
authorized project setup
  -> trusted Scope/ROE + manifest + Engagement binding
  -> host egress decision + scheduler reservation
  -> optional Taric WorkRun claim/transition
  -> host launches tool/solver and captures bounded output
  -> committed Artifact -> host Observation/Evidence reference
  -> proposal -> host decision or optional review -> admission
  -> coverage.record -> coverage.gate(read_seq)
  -> report snapshot -> host API close
```

Configured scope and window checks still protect target actions. In the local development profile, temporary Taric unavailability may use the existing degraded path; production-style fail-closed egress and lease checks are optional deployment hardening. Competition runs continue through their existing platform/report path and never interpret `scanned` as authorized coverage or platform success.

## Migration and Rollout

1. Keep predecessor and local changes independently reviewable.
2. Mark unavailable `f41e775a` evidence as unavailable; do not fabricate missing logs or database exports.
3. Ship observation contract and memory-read hardening with local adapter smoke checks.
4. Use the shared local Engagement with host-derived project filtering; add project-bound credentials when a stronger deployment is needed.
5. Implement the authorized workflow behind `authorized_pentest` project creation only; do not reinterpret existing competition records.
6. Exercise scope, artifact, coverage, and recovery paths with focused local tests. Additional gateway and security checks can follow.
7. Record optional evaluation observations. Rollback disables new governed actions while preserving Taric authority, host audit, artifacts, and outbox for reconciliation.

## Risks and Mitigations

- **Ambiguous capture commit can duplicate on retry.** Taric capture is currently non-idempotent; preserve `indeterminate` and surface it for later reconciliation.
- **Shared Engagement allows authority-level cross-project reads for the shared principal.** Keep shared deployment boundaries explicit, or implement and prove per-project principals/Engagements before claiming stronger isolation.
- **Artifacts can contain secrets or customer data.** Minimize capture, apply host-side controls, require retention/ACL policy, and never expose raw content to model queries by default.
- **Coverage manifest drift can make a gate misleading.** Pin manifest and ResourceRevision, regenerate affected cells on revision change, and bind the report snapshot to one gate watermark.
- **Long scope can stall delivery.** Keep optional hardening separate from the local feature path; competition behavior remains independently deployable.
