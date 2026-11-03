# f41e775a Evidence Inventory

This inventory records the evidence available in the repository for the
historical Taric run described by `f41e775a`. It separates source and automated
verification from run-specific claims.

| Evidence item | Status | Repository reference | Interpretation |
| --- | --- | --- | --- |
| Sanitized run summary | available | `docs/artifacts/dvwa-taric-smoke-2026-10-27.json` | One authenticated-proxy practice case study; no causal outcome claim. |
| Verification commands and artifact digests | available | `docs/taric-verification.json` | Captured at generation time; profile and worktree digest are recorded. |
| Deployment/runbook profile | available | `docs/taric-deployment-runbook.md` | Documents shared Engagement practice boundary and unsupported governed runtime paths. |
| Raw solver/host event log | unavailable | no checked-in artifact | Capture counts and failure categories cannot be reconstructed from source. |
| Taric authority database/export | unavailable | no checked-in artifact | Proposal/observation counts cannot be independently queried. |
| Version/config manifest for the historical run | partial | verification and smoke JSON | Locked artifact references exist; complete runtime configuration is not present. |
| Paired legacy/Taric benchmark | unavailable | no checked-in benchmark manifest or paired runs | No quality improvement or degradation claim is permitted. |

The smoke artifact records `solverEvaluation.status: not-run` and explicitly
limits itself to a single practice case study. The source documents' historical
claims about proposal counts, capture failures, token usage, and task quality
remain **unverified** until sanitized logs and an authority query/export are
attached. Missing evidence is not inferred from implementation tests.
