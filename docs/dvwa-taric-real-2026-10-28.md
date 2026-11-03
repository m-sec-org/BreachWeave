# DVWA Taric Real Run (2026-10-28)

This is a single-run authenticated practice case study for `close-taric-integration-gaps`. The target was limited to `http://10.5.207.26:4280/`, using the user-supplied DVWA credentials out of band. Credentials, cookies, CSRF tokens, model keys, and raw HTTP bodies are absent from the repository artifact.

The isolated BreachWeave deployment ran at `127.0.0.1:3000` with the local Taric authenticated proxy at `127.0.0.1:8849` and state under `/tmp/breachweave-dvwa-home`. The Zhipu provider was corrected from the generic `/api/v1` endpoint to `https://open.bigmodel.cn/api/coding/paas/v4`; the configured `glm-5.3` probe returned `ok`. The deployment used the `authenticated_proxy` profile and the shared development Engagement boundary.

The direct authenticated smoke preserved DVWA's session-bound hidden token. The login page returned `200`, login POST returned `302`, authenticated `/index.php` returned `200` with the DVWA welcome marker, logout returned `302`, and a subsequent `/index.php` request returned `302`. After authentication, the harness set DVWA security to low and collected baseline responses for SQLi, reflected XSS, command injection, file inclusion, and brute force entry points. The artifact records only status codes and response markers.

The three reported findings were independently rechecked in a fresh temporary session: a benign command-injection suffix produced a `uid=` marker, a SQLi boolean payload returned database rows, and a reflected XSS marker appeared in the response. All three returned `200`; only booleans and markers are recorded here.

Taric challenge `2c955c04` launched two solver attempts. The first solver (`58f8db76`) logged in and lowered DVWA security, then its generated follow-up command-injection script failed a Python syntax check. A planner race launched a second solver (`b50d4c6e`) before the disabled state took effect; that solver performed real authenticated checks and confirmed command injection RCE, a SQL injection UNION query, and reflected XSS at low security. Raw shell output, database values, cookies, and any credential-shaped material were omitted. Neither solver submitted a report. Both were stopped after evidence collection, and the challenge planner is now disabled.

The challenge memory API accepted one sanitized evidence note as a Taric candidate. A subsequent challenge read returned it, while canonical records remained empty; memory health was `healthy`, diagnostics were `complete`, and the candidate watermark was `7`. The host audit file contains `187` validation-rejected records with `code=host_audit_only`. This is expected for the current contract because the automatic solver/tool events do not carry a trusted Taric Resource UUID and committed artifact references. No accepted solver, attempt, or report observation capture is claimed.

This run is not a paired benchmark and does not close the remaining authorized-pentest provisioning, egress, scheduler, artifact admission, report close, restart recovery, or full release-gate tasks. The machine-readable evidence is in [docs/artifacts/dvwa-taric-real-2026-10-28.json](artifacts/dvwa-taric-real-2026-10-28.json).

## Deployment Refresh Follow-up (2026-10-28)

After rebuilding and restarting the Web process from the current worktree with the same isolated config directory, `127.0.0.1:3000` returned `200`. Startup adopted the existing authenticated-proxy gateway; a fresh host health check returned `healthy`. The configured Zhipu `glm-5.3` probe returned the expected `OK` response. Typecheck, focused tests, all Core tests, and the macOS build passed.

A fresh DVWA login-page request returned `200` and contained a session-bound token, but the login POST redirected back to `login.php` with a `Login failed` marker. No authenticated module request or vulnerability payload was sent during this follow-up. The earlier authenticated findings above remain historical evidence and were not reproduced in this refresh. Sanitized details are in [docs/artifacts/dvwa-deployment-refresh-2026-10-28.json](artifacts/dvwa-deployment-refresh-2026-10-28.json).
