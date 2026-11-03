# Tasks

## 0. Establish a local baseline

- [x] 0.1 Run the local typecheck, focused challenge/runtime tests, and the relevant Taric adapter smoke checks.
- [x] 0.2 Keep predecessor review and archival independent from this change; do not block local implementation on external artifacts.
- [x] 0.3 Record available run notes when useful and describe unavailable evidence as unavailable.
- [x] 0.4 Keep compatibility checks for operations used by the local adapter; pin external artifact details only when that profile is enabled.

## 1. Observation contract and recovery

- [x] 1.1 Define versioned allowlist DTOs for solver/tool, attempt, and report/platform observations. Validate each DTO locally and against the pinned Taric schema; reject unknown fields and sensitive values before dispatch.
- [x] 1.2 Add trusted Resource UUID resolution and committed Artifact/Evidence reference validation. Route events without a valid Resource or supported Taric record type to host audit storage instead of fabricating a reference.
- [x] 1.3 Preserve source event, project, Engagement, and origin dispatch ID in approved provenance fields; cover malformed refs and oversized events with focused local tests.
- [x] 1.4 Add operation-specific capture outcome states and diagnostics for accepted, deferred, validation rejection, authorization rejection, indeterminate, and permanent failure. Ensure best-effort mode cannot silently discard failed captures.
- [x] 1.5 Extend the bounded outbox for transient capture failures and preserve ambiguous outcomes as indeterminate; use the configured local retry policy.
- [x] 1.6 Cover the main deferred/accepted/error paths with focused local tests. Failure-injection matrices and duplicate-delivery checks are optional follow-up work.
- [x] 1.7 Add a local host smoke for solver event, attempt, and report capture. Real-profile query-back and redaction checks are optional when a gateway is available.

## 2. Complete reads and project freshness

- [x] 2.1 Implement bounded keyset pagination for canonical claims and candidate proposals, with cursor validation, duplicate suppression, maximum records/bytes, and explicit truncation status.
- [x] 2.2 Pin combined reads to a consistent `read_seq` where the selected Taric query contract supports it; return the watermark, page status, and last cursor in API diagnostics.
- [x] 2.3 Define and implement solver-board refresh after initial seeding. Use host-bridge authoritative refresh or subscription hints followed by a query; never infer state or actions from notifications alone.
- [x] 2.4 Test multi-page reads, stable ordering, and no cross-project projection leakage. Notification reconnect and cursor-gap matrices are optional follow-up work.

## 3. Resolve Engagement isolation policy

- [x] 3.1 Record the local profile: shared Engagement is allowed for development, with host-derived project filtering.
- [x] 3.2 Ensure canonical/candidate queries, cache, board refresh, and outbox replay use the host-derived project identity.

## 4. Authorized pentest foundation and action controls

- [x] 4.1 Add an authorized project setup contract for tenant, Engagement, Scope/ROE revision, window, allowed/denied target policy, manifest version, credential references, retention profile, and `taric_required`; keep secret values outside Taric ordinary records, logs, UI, and solver environment.
- [x] 4.2 Add host Scope/ROE preflight for DNS answers, redirects, IPv4/IPv6, protocol, port, and time window. Network-level interception remains optional deployment hardening.
- [x] 4.3 Expose the host preflight, Taric readiness, admission, and close checks through the authenticated local governance API.
- [x] 4.4 Cover scope, address, redirect, protocol/port, and time-window behavior with focused helper/API tests. Live DNS rebinding and proxy-bypass tests are optional.

## 5. WorkRun, scheduler, evidence, and coverage

- [x] 5.1 Generate local coverage cells from the approved manifest and Scope revision; validate non-empty manifests and Resource UUIDs.
- [x] 5.2 Expose single-worker host WorkRun claim/transition for existing Taric WorkItems without person-specific owner input; full scheduler and lease automation are optional.
- [x] 5.3 Persist bounded encrypted local artifacts with metadata recovery, integrity checks, retention tombstones, and deletion.
- [x] 5.4 Link committed artifacts to host observations and candidate Claims with Resource/Scope/WorkRun provenance and redaction metadata.
- [x] 5.5 Implement host-only `coverage.record`, query, and gate flows with CAS/idempotency, explicit terminal statuses, evidence requirements, scope/resource revision handling, and a stable gate `read_seq`.
- [x] 5.6 Persist report snapshots bound to manifest digest, Scope/Resource revisions, coverage gate watermark, and report digest; leave competition state unchanged.
- [x] 5.7 Test the local coverage record/query/gate path, including version conflict and close invalidation.

## 6. Review, admission, close, and recovery

- [x] 6.1 Add host-mediated proposal review/admission using available evidence and policy metadata; use the local host identity by default.
- [x] 6.2 Expose candidate/admitted/rejected/needs-evidence states through the authenticated API and keep model APIs proposal-only.
- [x] 6.3 Implement API close against a current local report snapshot and coverage gate without requiring a human actor field.
- [x] 6.4 Expose allowlisted secret-free checkpoint commits bound to the project and active local WorkRun.
- [x] 6.5 Cover local admission, close, checkpoint, stale-generation, and secret-rejection paths with focused tests.

## 7. Runbooks, optional evaluation, and follow-up validation

- [x] 7.1 Update deployment, migration, incident, artifact retention, shared/per-project Engagement, outbox indeterminate, and rollback runbooks for the implemented profiles.
- [x] 7.4 Attach sanitized operational artifacts to any run-specific claim; mark missing artifacts unavailable/unverified and describe unmatched single runs as case studies only.
- [x] 7.5 Run `bun run typecheck`, focused Taric/UI governance tests, `bun test packages/core`, and applicable builds. Real-profile smoke and security-negative/migration/restart matrices remain optional follow-up validation.

## Future deployment hardening (non-blocking)

- Project-bound Engagement provisioning, token rotation/revocation, lifecycle cleanup, migration, and real-gateway isolation tests for multi-tenant deployments.
- Connection-time egress proxy/firewall enforcement; the local API reports a scope preflight decision and does not claim to bind DNS results to a later socket.
- Paired repeated outcome benchmarks and full denominator, variance, and cost analysis.
