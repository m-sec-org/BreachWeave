# Tasks

## 1. Project contract and trusted configuration

- [x] 1.1 Add discriminated `competition`/`authorized_pentest` project types, `legacy_local`/`taric_best_effort`/`taric_required` validation, and host-derived `CompositeProjectKey`; verify invalid mode-policy pairs and bare challenge IDs are rejected by focused core tests.
- [x] 1.2 Extend trusted host configuration with non-secret Taric profile, authority path, Engagement binding, memory health policy, and compatibility manifest references; verify Taric credentials, DB paths, and writer/operator principals are never copied into solver environment or container binds.
- [x] 1.3 Add the locked Taric artifact/version manifest for API `1.2.0`, schema `1.0.0`, Core `1.0.1`, storage `authority-storage/3`, and the selected Bun driver artifact; verify a clean consumer resolves matching artifacts without workspace/path aliases.

## 2. Provider boundary and Taric lifecycle

- [x] 2.1 Introduce an async challenge memory provider interface covering list/query, proposal submission, host capture, checkpoint, and explicit unsupported mutation/deletion outcomes; verify the existing file-backed provider preserves current Memory/Idea CRUD behavior.
- [x] 2.2 Implement the Taric host module with direct Bun `AuthorityStore + BunSqliteAuthorityDriver` construction, exact contract/policy checks, trusted principal/Engagement binding, operation allowlist, health state, and `close()` lifecycle; verify startup failure cleans up resources and rejects mismatched bindings.
- [x] 2.3 Implement Taric provider projections: bounded canonical reads, candidate proposals for model/Observer writes, host-only observation capture, and evidence/Artifact references; verify model-supplied provenance cannot create a trusted observation and Taric-mode update/delete never mutates canonical facts.
- [x] 2.4 Add provider selection and defaulting so existing projects remain `legacy_local`, authorized projects require Taric, and competition projects explicitly opt into best-effort; verify Taric is initialized once per daemon and closed on daemon shutdown/reload.

## 3. Manager, solver, and host bridge integration

- [x] 3.1 Inject the selected provider into `ChallengeManager` and route memory/idea reads used by solver-board seeding, prompt construction, planner context, and Web-facing manager methods through the provider; verify startup context contains only the bound project projection.
- [x] 3.2 Bind host-bridge requests to the registered solver/project context and map memory/idea actions to provider operations without accepting challenge, Engagement, principal, or tenant overrides from request payloads; verify cross-project and model-to-host-only negative cases.
- [x] 3.3 Add mode-aware degraded/blocked errors to runtime and API responses, including Taric health, candidate/admitted state, and recovery status; verify `taric_required` blocks governed actions while competition platform control remains available in `taric_best_effort`.
- [x] 3.4 Add host-owned capture hooks around tool/platform results and report/attempt events with stable event IDs, source kind, run/generation, and evidence references; verify captured records are attributable to the host and do not log Flag or credential plaintext.

## 4. Composite identity and legacy migration

- [x] 4.1 Thread the composite project identity through challenge records, Memory, Idea, Attempt, Submission, archive, timeline/stat queries, planner cache, and solver startup binding; verify same-code projects from different teams/competitions/tenants cannot read or write each other’s state.
- [x] 4.2 Implement read-only legacy migration dry-run classification, sensitive-data warnings, content digests, conflict reporting, operator confirmation, and `legacy_unclassified` archive handling; verify ambiguous records cannot launch agents or target actions.
- [x] 4.3 Update project/challenge API and UI payloads to expose mode, provider, opaque project identity, memory mode, and health without exposing Taric secrets; verify local-practice scanned state, platform Flag state, and authorized coverage state remain separate.

## 5. Outbox, replay, and notification recovery

- [x] 5.1 Implement encrypted, bounded, append-only best-effort outbox records with stable event IDs, composite project binding, ordering, key/version metadata, and conflict status; verify payload limits, key absence, and overflow stop new deferred writes without deleting prior events.
- [x] 5.2 Implement ordered idempotent replay and reconciliation using Taric request results and confirmed `read_seq`; verify duplicate replay returns the original result, conflicts remain inspectable, and replay never writes the legacy provider.
- [x] 5.3 Consume Taric subscriptions only as refresh hints and recover authoritative deltas after loss, duplicate, reconnect, token revocation, or slow-consumer disconnect; verify no notification alone launches a solver, target action, or duplicate memory entry.
- [x] 5.4 Add operator diagnostics and runbook entries for Taric unavailable, version mismatch, degraded memory, outbox backlog, replay conflict, and recovery watermark; verify each state is visible through the host API and logs without secrets.

## 6. Integration verification

- [x] 6.1 Add focused provider, mode-isolation, host-bridge, migration, outage, replay, and lifecycle tests under the existing Bun test layout; verify legacy challenge tests remain green and new negative authorization cases are covered.
- [x] 6.2 Run a real Bun embedded Taric smoke using the selected locked artifacts, including startup, engagement binding, proposal/read projection, host capture, close, restart, and isolation; verify the result is recorded as a BreachWeave profile result rather than reusing Taric’s external candidate report.
- [x] 6.3 Run `bun run typecheck`, the focused challenge/runtime test suite, `bun test packages/core`, and the applicable build command; verify failures block enabling Taric mode and are reported with the selected profile and artifact digests.
- [x] 6.4 Document deployment and rollback procedures, including artifact source selection, outbox key/retention policy, Taric authority backup boundaries, legacy archive handling, and explicit unsupported profiles; verify the documented commands do not rely on workspace links or model-controlled secrets.

## Workflow follow-up

- Review the completed artifacts and implementation results before starting `/opsx:apply`.
- After implementation and review, archive the change with the OpenSpec archive workflow and update the main specs.
