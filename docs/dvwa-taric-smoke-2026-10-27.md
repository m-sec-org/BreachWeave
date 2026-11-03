# DVWA and Taric Practice Smoke (2026-10-27)

## Scope

This is a single-run practice smoke for the `close-taric-integration-gaps` work. It checks the local BreachWeave deployment, an authenticated DVWA login, a Taric-backed memory write/read, and project separation inside the configured shared practice Engagement. It is not a solver benchmark or an authorized-pentest acceptance run.

The target was limited to `http://10.5.207.26:4280/`. DVWA's supplied `admin` account was used only for its login flow. No flags, vulnerability payloads, destructive actions, or report submissions were attempted.

## Deployment

BreachWeave Web and its Taric authenticated proxy were started locally on `127.0.0.1:3000` and `127.0.0.1:8849`. The deployment used an isolated temporary home under `/tmp/breachweave-dvwa-home`; the pre-existing user Taric authority was left untouched after its storage metadata failed the current compatibility check.

The challenge was created as `competition` / `local_practice`, with `taric_best_effort`, the DVWA URL as its only target, and the planner disabled. Taric health returned `healthy`. A memory candidate was written through BreachWeave's authenticated challenge API and appeared in the same challenge's subsequent memory read.

## Observations

| Check | Result |
| --- | --- |
| DVWA login page | `GET /login.php` returned the login form and a session-bound `user_token`. |
| DVWA authentication | Posting `admin` / the supplied password together with the session cookie and `user_token` returned `302`; the authenticated `/index.php` returned `200` and the DVWA welcome page. |
| Logout | Returned to the login page. |
| BreachWeave to Taric write/read | One candidate memory entry was accepted and read back through the challenge API; health was `healthy`. |
| Practice project isolation | Two challenges in the shared practice Engagement each read back only their own one candidate entry (`1` / `1`). |
| Read diagnostics API | After deployment restart, challenge detail returned `memory_diagnostics.status=complete`, shared `watermark=4`, 2 total pages, and complete canonical/candidate sources. |
| Solver run | Not run. The isolated deployment had no API credential for its configured model provider, so no model request or solver action was started. |

The first direct DVWA POST omitted the session token and produced PHP warnings. Repeating the request with the hidden token and matching cookie completed the expected login flow. This confirmed that the test harness must preserve DVWA's per-session token instead of treating a static credential POST as the full login contract.

## Improvement Made

Taric capture now rejects every observation without a host-resolved Resource UUID, regardless of source kind. Generic tool events without a supported Taric record no longer pass through the permissive path; BreachWeave records their capture outcome in the per-challenge host audit file. A focused regression test verifies that an unsupported tool event is rejected before adapter dispatch.

Memory reads use bounded keyset pagination, stable merge ordering, duplicate suppression, cursor checks, and explicit page/record/byte truncation diagnostics. The cross-project API smoke above exercises the host-derived project binding against the live local Taric gateway.

## Limits and Follow-Up

This run does not demonstrate vulnerability discovery, solver event/attempt/report capture, finding review/admission, WorkRun scheduling, evidence linkage, or coverage closure. The challenge and its Taric memory survived restarting the local BreachWeave/Taric processes, but this does not verify recovery of active WorkRuns, governance projections, or checkpoints. The governance module is not yet wired into the challenge scheduler or runtime egress path. Shared Engagement is the local development profile; project-bound authority credentials and mandatory network egress enforcement remain optional hardening for authorized and multi-tenant deployments.

Do not use this run as a paired `legacy_local` versus Taric efficacy result. It is one bounded integration case study. The sanitized verification and runtime facts are also recorded in [dvwa-taric-smoke-2026-10-27.json](artifacts/dvwa-taric-smoke-2026-10-27.json). The verification report includes both the repository HEAD and a digest covering the current tracked diff and untracked files.
