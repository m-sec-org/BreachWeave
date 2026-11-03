# Taric Integration Review

This review records the verification run used while resuming
`close-taric-integration-gaps`.

| Field | Value |
| --- | --- |
| Source revision | `6957a55f15e0d585f4b728c831021a34f7e02891` |
| Selected profile | `authenticated_proxy` |
| Verification report | `docs/taric-verification.json` |
| Report status | `passed` |
| Core suite | 274 passed, 0 failed |
| Real target case study | [`docs/artifacts/dvwa-taric-real-2026-10-28.json`](artifacts/dvwa-taric-real-2026-10-28.json) |
| Case study digest | `sha256:aea98d25e0c0fe899a804e81db9051238eecc615400f141d1b7d471b932d9d73` |
| Accepted capture smoke | [`docs/artifacts/taric-real-integration-smoke.json`](artifacts/taric-real-integration-smoke.json) |
| Accepted smoke digest | `sha256:f27166fb03c8c75905e1076c6b5022cacf314e3ee2e633d412ff364e72c0644f` |
| Worktree | dirty; report records the current path count and digest |

The report contains the exact commands for typecheck, focused tests, the full
`packages/core` suite, and the host build, along with locked Taric artifact
versions and SRI digests. The case study records a real authenticated-proxy
run against the supplied DVWA target, including model health, login, module
findings, Taric candidate query-back, and redacted host-audit outcomes. The
automatic solver/attempt/report events were rejected as host-audit-only because
they lacked trusted Resource and Artifact references, so this evidence does not
close the legacy ChallengeManager capture path. The dedicated authorized host
smoke now demonstrates accepted solver/attempt/report observations, proposal
query-back, health metrics, and secret rejection after a trusted Resource was
provisioned. Authorized egress enforcement, scheduler wiring, durable
governance close, and paired outcome trials remain optional hardening items in
`openspec/changes/close-taric-integration-gaps/tasks.md`; they do not block the
local development feature path.
