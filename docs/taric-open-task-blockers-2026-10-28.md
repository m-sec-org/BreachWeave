# Taric Open Task Blockers (2026-10-28)

This matrix records follow-up work for the unchecked items in
`openspec/changes/close-taric-integration-gaps/tasks.md`. It distinguishes the
local development path from hardening that needs a Taric authority, a network
enforcement point, or a controlled deployment. These follow-ups do not block
local feature implementation.

| Tasks | Current repository state | Blocking evidence | Minimum support needed |
| --- | --- | --- | --- |
| 3.3-3.4 Engagement isolation | Project identity validation and shared-development scoping exist. | Per-project principal/token rotation, revocation, cleanup, and cross-tenant authority fixtures are not available. | Add project-bound authority when a multi-tenant deployment needs it; shared local development remains supported. |
| 4.2-4.4 Scope and egress | `evaluateEgress` validates URL, redirect, DNS answers, address family, protocol, port, and time window. | No solver/tool network path invokes it at connection time. A prompt or container network mode cannot prove DNS pinning, redirect enforcement, proxy-path enforcement, or rebinding resistance. | A host-controlled egress proxy/firewall or equivalent connector, DNS resolver/pinning hook, connection policy callback, and isolated redirect/DNS-rebinding/IPv6/proxy-bypass test targets. |
| 5.1-5.2 WorkRun and scheduler | Governance helper claims/transitions WorkRuns and keeps in-process target reservations. | The daemon scheduler does not create WorkItems from a manifest or renew/reclaim/resume leases on restart. Reservations and generation state are lost with the process. | A scheduler integration point, authoritative WorkRun fixture with lease lifecycle, and a restart-capable state store or recovery contract. |
| 5.3-5.4 Artifacts and evidence | Local encrypted artifact helper, digest checks, bounded reads, and observation DTO validation exist. | The helper is not wired to Taric Artifact session/begin/append/commit or durable metadata recovery; no end-to-end Evidence link is captured from solver events. | A verified Taric Artifact profile or approved host artifact store, retention/deletion policy executor, and a trusted Resource/WorkRun fixture with committed artifact references. |
| 5.6-5.7 Reports and coverage | Host-only coverage record/query/gate and CAS tests exist. | No authoritative report snapshot binds manifest, Scope/Resource revisions, and one gate watermark; no runtime lock-contention or stale-snapshot integration fixture exists. | Operator report snapshot contract, stable `read_seq` query support, revision-change fixture, and scheduler/resource-lock test harness. |
| 6.1-6.3 Review, admission, close | Host admission and local close checks are available, with an optional separate reviewer adapter. | Durable decision lifecycle and authoritative Taric close are not wired. | Add role-separated UI/API only when the deployment needs human workflow; local host admission/close is sufficient for development. |
| 6.4-6.5 Recovery | Checkpoint allowlist and generation/lease checks exist in memory. | Checkpoints, leases, reservations, and review state are not restored from authority after daemon restart; no real role/auth/restart fixture exists. | Authoritative `work.resume`/checkpoint recovery fixture, durable host metadata, and restart/expired-lease test environment. |
| 7.2-7.3 Evaluation | Benchmark manifest and report validator exist; single local smoke observations are supported. | Paired repeated runs and full cost/outcome telemetry are not recorded. | Add controlled trials only when outcome comparison is needed. |
| 7.5 Release gate | Local typecheck, focused tests, Core tests, and build are the functional checks. | Security-negative, migration/restart, egress, and real role/auth checks are optional follow-up validation. | Add external fixtures only for a hardened deployment profile. |

## Optional follow-up inputs

1. A disposable Taric authority/gateway profile for project-bound Engagement tests, without putting token values in the repository or ordinary settings.
2. The supported egress enforcement mechanism and its connection-time policy hook, including DNS pinning and proxy routing details.
3. A trusted Resource UUID and disposable WorkRun/Artifact fixture for authenticated integration tests.
4. Fixed evaluation inputs: target/challenge revision, prompt digest, model id, tool image digest, budgets, concurrency, and permission for repeated DVWA practice runs. The current DVWA login rejects the supplied account; restore a working test account in the isolated environment and keep its secret in the local secret store rather than source control or ordinary chat.
5. A disposable environment for restart and recovery checks; no production or shared authority should be used.

Until those are available, the related hardening remains unverified while local
authorized-pentest launch, action, admission, and close paths can use the
development profile.

The current redacted task status is available through the authenticated
`GET /api/taric/governance-readiness` endpoint. The endpoint reports local
capabilities separately from optional external hardening; it does not expose
token values or token environment variable names.
