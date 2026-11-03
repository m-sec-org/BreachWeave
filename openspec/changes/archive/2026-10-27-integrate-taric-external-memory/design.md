# Design

## Context

See `proposal.md` for motivation. BreachWeave's `ChallengeManager` currently owns file-backed Memory/Idea APIs used by manager prompts, solver board seeding, Observer host-bridge actions, and Web routes. The host bridge derives challenge identity from the registered Solver runtime and is the correct trust boundary; Solver containers must not connect to Taric or receive Taric credentials.

Taric HEAD `d20c18f2daa97ed75b51218fc3d63e700ea5a8c9` exposes API contract `1.2.0`, schema `1.0.0`, Core `1.0.1`, and storage contract `authority-storage/3`. Work/Coverage operations, proposal/capture flows, query, review, Artifact, subscription, TLS TCP, and HTTPS gateway contracts exist. The revision also standardizes bounded redacted diagnostics across Core, CLI, MCP, RPC, and SQLite/PostgreSQL drivers, adds an independent `--runtime-config` authority input, and authenticates `taric.gateway.status` / `taric.gateway.reload`. Taric is not a mutable Memory/Idea CRUD store: model changes are proposals, host observations use host-only capture, and Core has no general delete/import operation. The Bun path uses `AuthorityStore(new BunSqliteAuthorityDriver(path))` with `await createCoreService(...)`; `openRuntimeService()`'s SQLite path uses Node `node:sqlite`. The current release report validates local profiles, not this BreachWeave host.

## Goals / Non-Goals

**Goals:**

- Add a host-owned provider boundary while retaining local file storage as the default and full-CRUD legacy provider.
- Add strict project, mode, principal, and Engagement binding before any Taric operation.
- Preserve trust distinction: model-authored Memory/Idea content stays proposal/candidate data; host-captured tool/platform output is the only host observation path.
- Isolate Taric memory by a host-derived composite project identity and define an explicit, reviewable migration path for legacy records.
- Define bounded best-effort outbox and fail-closed required mode behavior, including daemon startup, shutdown, replay, and operator diagnostics.
- Keep model access through the existing host bridge and constrained projections; never mount Taric authority or credentials into containers.

**Non-Goals:**

- Change Taric Core, its operation contracts, or claim native certification for BreachWeave's Pi fork.
- Make Taric responsible for platform providers, Flag submission, Scope/ROE evaluation, egress enforcement, scheduler resource locks, target actions, human review, or report rendering.
- Treat `work.transition` as a resource mutex, `coverage.gate` as an authorization decision, or Artifact ingest as credential scanning/redaction.
- Bulk-import legacy facts as trusted observations or provide arbitrary mutation/deletion of Taric canonical records.
- Enable multi-host authority, container spool ingestion, or quality capability without separate profile evidence.

## Decisions

### 1. Put the provider boundary at ChallengeManager

Introduce an async memory provider interface used by `ChallengeManager` for Memory and Idea operations, startup seeding, and prompt context assembly. Keep the existing filesystem functions behind the legacy implementation so existing projects remain unchanged by default. Inject the selected provider when `DaemonManager` constructs the ChallengeManager; own one Taric Core service per daemon and close it with the daemon lifecycle.

**Alternative considered:** replace `memory.ts` storage functions with Taric calls. Rejected because Taric proposals and canonical evidence do not have the same mutable CRUD semantics, while that module also implements local lock/file behavior needed by legacy projects.

### 2. Map Taric trust states instead of emulating mutable CRUD

Map model/Observer Memory and Idea additions to Taric proposals with host-derived project and solver provenance. Map real tool and platform results to host-only `capture.observation` with stable request identity and evidence/Artifact references. Query admitted canonical facts as the trusted Memory projection; surface pending proposals separately with an explicit candidate status. Do not turn a model-authored `fact`, `verified` Idea status, or `result` into a host observation or verified canonical record.

In Taric mode, legacy update/delete methods SHALL NOT mutate canonical Taric state. A correction is a new proposal referring to the prior record; host/operator admission and any retention/deletion workflow remain explicit. The legacy provider continues to support current update/delete behavior. Bridge and UI responses must distinguish accepted proposal from admitted fact so callers do not mistake acknowledgment for verification.

**Alternative considered:** store old Memory/Idea rows as Taric canonical facts to preserve response shape. Rejected because this would grant model-originated content trust it does not have and bypass Taric's proposal/admission lifecycle.

### 3. Bind a project identity before enabling Taric

Use a discriminated project record and host-derived stable identity. Competition identity includes tenant, platform, competition, team, and challenge code. Authorized identity includes tenant and Engagement. Use the composite identity for all project-owned data touched by this change and for the Taric Engagement mapping. Requests contain an opaque project ID; the host resolves it to the trusted identity and never accepts Engagement or principal overrides from Solver input.

Current remote challenge mapping uses challenge code as `challengeId` and does not supply all team/competition identity fields. Therefore Taric-backed remote competition projects remain unavailable until trusted provider/team identity is configured. Unknown legacy records are `legacy_unclassified` and cannot launch under Taric mode. This change does not silently infer tenant/team from model input.

**Alternative considered:** use `challengeId` as Taric's partition key. Rejected because teams or competitions can reuse a challenge code, causing cross-project recall.

### 4. Keep Taric configuration in the trusted host

Persist the selected memory mode and non-secret Taric profile settings through host configuration. Resolve package versions and artifact integrity from the dependency lock/compatibility manifest. Keep credentials, writer/operator principals, DB paths, and content roots out of `solverEnv`, container mounts, prompts, and model-visible settings. Create model principals from trusted runtime registration; model requests cannot choose their identity.

Use the matching Taric `@taric/core`, `@taric/schemas`, and `@taric/driver-bun-sqlite` `1.0.1` artifacts and recorded SRI values from a clean tarball or controlled internal artifact source. Do not rely on Taric's workspace or source paths. The Bun host directly constructs the Bun driver and Core service, while the authenticated proxy profile uses Taric's bounded TLS TCP or HTTPS gateway transport. Enforce exact API/schema/policy matching and fail before project startup on mismatch. Gateway listener settings and the independent `--runtime-config` authority input must remain separate.

**Alternative considered:** MCP as the host integration transport. Rejected for host-only capture, work/coverage, and lifecycle calls: Taric MCP exposes only six model tools. The existing BreachWeave host bridge remains the model-facing transport.

### 5. Make outage policy part of the project mode

Default existing and new unconfigured projects to `legacy_local`. `taric_required` blocks governed launch/actions/close if authority validation fails. `taric_best_effort` is permitted only where product policy allows platform control to continue; it still has no local query fallback. During an outage, append only encrypted, bounded events with stable IDs and project binding to a local outbox; after recovery, replay in order and preserve conflicts for operator resolution.

The outbox is a transport buffer, not a second authority. It does not answer reads, grant trusted status, or merge with legacy files. Reaching the bound, losing the encryption key, or encountering a conflict stops further memory writes and surfaces degraded health.

### 6. Stage migration and rollback without false promotion

Run a read-only dry-run that classifies legacy records, reports counts/content digests/sensitive-data warnings/conflicts, and leaves source files unchanged. Confirmed migration preserves legacy identity, source, and observation time through Taric's ordinary proposal/evidence flows; imported text remains candidate data and is never submitted as a current host observation. Taric has no public `snapshot.import` or general migration API.

Keep the legacy directory as a read-only archive after cutover. Rollback changes provider routing only. Do not delete Taric records, merge outbox events into legacy facts, or infer a trusted downgrade. A project with an incomplete migration remains on the source provider or becomes blocked until explicitly resolved.

## Risks / Trade-offs

- [Taric's proposal/canonical model differs from Memory/Idea CRUD] → Return typed candidate/admitted states and reject in-place mutation in Taric mode; keep legacy CRUD only in the local provider.
- [Missing team/tenant identity can leak cross-project memory] → Disable Taric mode until trusted identity is available; test positive and negative composite-key pairs.
- [Bun package artifacts or Core dependencies differ at runtime] → Pin matching tarballs and hashes; run clean-consumer and Bun embedding smoke in the BreachWeave build profile.
- [Outbox may contain sensitive solver output] → Minimize payloads, encrypt with host-managed key, bound size/age, never mount into containers, and provide explicit purge/inspection policy.
- [Legacy migration may overstate confidence] → Convert legacy material to proposals/evidence with provenance; require separate admission for trusted canonical visibility.
- [Taric down can stall a required project] → Show health and blocking reason in API/UI; preserve platform controls only for best-effort competition policy.
- [One project maps to an Engagement with mismatched scope] → Host provisioning validates trusted scope/resource metadata before binding; Taric memory does not authorize any target action.

## Migration Plan

1. Add provider and project identity types without changing the default file-backed behavior.
2. Add Taric configuration and strict version/authority startup validation; test failure cleanup and Core close.
3. Add Taric provider mapping for bounded reads, model proposals, host capture, and read-only canonical projections; keep unsupported CRUD explicit.
4. Add composite identity and the dry-run classifier; migrate only after an operator confirms the report and the Engagement binding.
5. Enable Taric first in an isolated test project; exercise memory queries, proposals, host capture, restart, outbox replay, and cross-project denial.
6. Roll back by switching the project provider to its retained local/archive path after resolving or preserving the outbox. Never remove the Taric authority as part of rollback.

## Open Questions

- The selected production artifact source is the approved internal `@taric` scoped registry, configured through `TARIC_REGISTRY_URL` and `TARIC_REGISTRY_TOKEN`. The registry must publish the exact pinned packages and pass the clean-consumer check before release packaging.
- The outbox encryption key lifecycle and retention limit must be supplied by the deployment's host-secret policy before enabling `taric_best_effort` in production.
