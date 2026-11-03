# Taric 1.0.4 local control-plane runbook

Updated 2026-11-03 for change `taric-103-recoverable-pentest-control-plane`. Taric source `1c466f4d8ad8f775f98bf867453b81230469287a` includes `6e173b4c6a57c1fdaaa465bfaa3eff32664f907f`. The lock records API1.4.0, adapter1.1, schema1.0.0, authority-storage/4, authority-sql/4, all66 operations, policy/registry digests and five package SRIs. Package source artifacts are locally packed; this does not establish registry publication.

The former ScopeRevision, complete Coverage, Action audit, ReportSnapshot and CloseDecision contract gaps are resolved. Authorized Planner/Solver context, Web, stats, report indexes, WorkRun recovery, cache deletion/rebuild, and supported host-mediated model transport are now covered by the local product smoke (9/9). OrbStack networkless egress/model mediation is covered by a separate 5/5 smoke. L2 remains reviewer-authority gated and is unavailable without an explicit reviewer transport. These are `local_development` results; they do not establish production, physical-host, power-loss, or independent-reviewer evidence. Static readiness never enables the product just because a registry operation exists.

## Reproduce

Run in the BreachWeave checkout; all fixture state is isolated in temporary directories. Existing user configuration and running target deployments are not used.

```sh
bun run verify:taric:clean-consumer --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-103-clean-consumer.json
bun run audit:taric:contract --taric-source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-103-contract-audit.json
bun scripts/smoke-taric-control-plane.ts --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-104-canonical-control-plane.json
bun run smoke:authorized-product --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-104-authorized-product.json
bun run smoke:authorized-egress --output=docs/artifacts/taric-104-authorized-solver-egress.json
bun run smoke:taric:unified -- --source=/Users/liuhongtao/development/Taric --output=docs/artifacts/taric-104-unified-smoke.json
bun run verify:taric:control-plane --source=/Users/liuhongtao/development/Taric
openspec validate taric-103-recoverable-pentest-control-plane --strict
```

The clean consumer exports the committed Taric checkout, builds and packs it in isolation, checks exact locked npm-packed SRIs, and records Bun packaging differences separately. Taric behavioral contract probes use copies of upstream tests with an explicit Bun SQLite constructor adaptation, and save original/adapted fixture digests. They are selected upstream contract tests, not a claim to have rerun all upstream workspaces unchanged.

The final verifier runs core/UI typechecks, core and governance tests, the platform build and all fixture commands. The report binds BreachWeave's tracked, dirty and untracked source files to a digest, checks the digest did not change during verification, and records fixture reports/hashes/counts separately. Tests that wrap optional live fixtures can be skipped in the unit suite; the explicit fixture commands remain required for service-path acceptance.

## Accepted local service paths

| Path | Current machine report | Meaning |
| --- | --- | --- |
| Contract audit | `taric-103-contract-audit.json` | Current registry/schema/backend behavior; no unresolved canonical fact mappings |
| Work | `taric-103-work-fixture.json` | Admission, pinned reads, lease/owner/generation fencing, checkpoint, new service recovery, reclaim, host slots and board |
| Artifact | `taric-103-artifact-fixture.json` | Managed credential/evidence bytes, hash verification and SIGKILL/restart recovery |
| Evidence | `taric-103-artifact-governance.json` | Canonical ordinary Evidence admission and committed Artifact linkage across restart |
| Action | `taric-104-unified-actions.json` | Actual controlled loopback HTTP, credential injection, ScopeRevision, observed socket provenance, WorkRun-bound target path, unknown reconciliation, fixed audit pages, stale result quarantine; 23/23 |
| Scope/Coverage/report | `taric-104-canonical-control-plane.json` | Immutable approved ROE binding, bootstrap replay, complete manifest pages, scoped checkpoint, loopback target-auth, pinned Action audit, report idempotency, stale close refusal, atomic close, independent-process rebuild and reopen, ChallengeManager projection deletion/rebuild; 20/20 assertions |
| PostgreSQL runtime and backup/restore | `taric-104-postgres-runtime-2026-11-02.json` | Taric current-source runtime/schema conformance, PostgreSQL 17.11, 12/12 scenarios, logical dump/restore with matching authority sequence 158 |
| Host source verification | `taric-104-host-verification-2026-11-02.json` | Source-bound typechecks, tests, repository build and OpenSpec validation; keeps overall product and production acceptance blocked/unverified |
| Two-container PostgreSQL recovery | `taric-104-multi-host-postgres-2026-11-02.json` | Independent host containers: one claim winner, expired-owner reclaim to generation 2, stale-generation rejection, current-generation renewal; one OrbStack workstation only |
| Authorized product projection recovery | `taric-104-authorized-product.json` | Solver Context/WorkRun heartbeat and completion fencing, Planner context, local snapshot/map deletion, fresh provider rebuild of Work/Coverage gaps/Evidence/report index/close, 9/9 |
| Authorized Solver host mediation | `taric-104-authorized-solver-egress.json` | Docker `network=none` blocks raw TCP/curl host and public paths; real pi-ai SSE crosses the host bridge with placeholder-to-host credential replacement, 5/5 |

The report fixture declares authentication/authorization cells `not_applicable` with explicit reasons for a protocol-only loopback descriptor. It validates governance semantics; it makes no vulnerability-testing or coverage-quality claim. Work/run/Artifact/action fixtures separately exercise actual execution and Evidence paths. A new Bun process opens the same authority and content roots with no parent object maps or local report/checkpoint/index files. It discovers terminal checkpoints from session execution locators and retrieves their content through `work.resume`; terminal historical checkpoints are not represented as resumable active workers.

## Authority and roles

Use `embedded_bun` with `single_host_sqlite` for independent local verification. Provider configuration otherwise defaults to `authenticated_proxy`. A shared Development Engagement is a local application-filtering boundary, not production project isolation.

`invokeHost` cannot perform operator-only writes. Scope revise/invalidate, Coverage manifest commit and Engagement close/reopen use `invokeOperator`, backed by an explicitly configured operator identity. Missing operator configuration fails before dispatch and does not degrade a healthy host. Body fields cannot choose principals or capabilities. This grants neither `reviewer` nor `writer`; `review.submit` and L2 promotion keep their separate upstream roles. The governance service refuses review when no explicit reviewer authority is configured and never falls back to the host principal.

The trusted embedded fixture supplies `operatorPrincipalId` and a stable transport session. `work.claim.task_session_ref` must equal that trusted session; callers cannot assign a different task session. Production token rotation/revocation remains separate.

## Recovery and mutation discipline

Persist/reconstruct Scope ID/version, immutable ScopeRevision ID and policy digest. Recovery locator v2 and checkpoints carry that pair plus ResourceRevision, WorkItem, WorkRun, Attempt, generation, owner, transport session and Pi session. Missing/changed Scope/Resource premises, incomplete pages, pending unknown Actions or invalid checkpoints require replan. Renew and active/completing transitions also check current Resource premises. Failed/cancelled cleanup remains available under the upstream fence.

Query fresh canonical state before scheduling or close. The scheduler requires an explicit trusted host authorization callback even when all contracts are available. Leases do not release local target/worker reservations until the host confirms its worker stopped. Notifications invalidate projections and trigger full queries.

Keep the exact request, idempotency key and watermark when reconciling an ambiguous report/close operation. Report Artifact publication, ReportSnapshot and CloseDecision are separate durable stages. A committed Artifact never implies closure. Refresh the authority watermark before reopen; Artifact reads can create audit events and advance it.

Unknown network outcomes are never automatically retried against the target. Reconcile the same canonical Action with trusted execution evidence. Stale-generation results are quarantined in ActionEvent history and cannot change current Coverage or the Action projection. Model text, URLs and audit metadata must not contain target credentials.

## Credentials, retention and rollback

Target credentials use Taric-managed `target-auth` Artifacts in explicit host-session or run-bound sessions. Only the trusted egress-host content_read grant can consume raw bytes, directly in memory. Web/operator metadata responses never return credential bytes. Authority-critical evidence and reports use verified committed bytes; an external host_ref is not an equivalent recovery source.

Artifact expiry/retention is host policy. Preserve authority DB, content root, cursor key and non-secret configuration digest together for any production restore, verify integrity/doctor first, then fence/reissue leases. Local process-crash fixtures do not certify power-loss durability or production DR.

Rollback disables governed scheduling/egress and preserves Taric authority, audit, content and indeterminate outbox entries. Do not restore challenge JSON or local Maps as another authority. Competition scanned/platform-solved flows remain separate.

## Current environment and remaining work

OrbStack is responsive on 2026-11-03: Docker Unix-socket ping and PostgreSQL SSLRequest protocol checks passed. PostgreSQL 17.11 runtime/schema conformance passed all 12 scenarios, and an isolated logical backup/restore recovered the same authority sequence with audit verification. The two-container verifier passed its lease/recovery/fencing checks. The unified report is `docs/artifacts/taric-104-unified-smoke.json`; it records 14/14 commands, including the 9/9 authorized product projection and 5/5 networkless host-mediated model transport checks. The two-container test shared one workstation and Compose network; physical hosts and network partition/reconnect remain unverified. No existing containers were restarted or removed.

The local 5.4 work is complete: authorized startup/Planner/Solver/Web/stats/report reads cut over to Taric projections, local maps and report indexes are disposable, and the Solver model path is host-mediated with a networkless container. Unsupported provider APIs and arbitrary shell/socket clients remain blocked. Independent reviewer projections, per-project production identities, physical-host partition tests, persistent production egress, retention and DR remain separate tasks. This change is ready for OpenSpec verification; it is not a production deployment attestation.
