# Taric Deployment and Rollback Runbook

This runbook covers the supported BreachWeave Taric profile. Taric is optional:
projects using `legacy_local` do not load Taric packages and continue to use the
local memory provider.

## Local default deployment

On a local deployment (`bun run web` / `bun run dev`) the daemon starts a local
Taric gateway by default and binds every new challenge to a shared-Engagement
`taric_best_effort` project. The supervisor lives in
`packages/core/src/taric/local-gateway.ts` and is idempotent:

- State directory `~/.tch-agent/taric-gateway/` holds the authority database
  (`authority.sqlite`), self-signed TLS material (`ca.crt`, `server.key`,
  `server.crt`, generated with `openssl`), `gateway.json` (0600) with the
  listener/token table, and an independent `runtime.json` (0600) with the
  pinned SQLite authority, content root, and optional maintenance principal.
  The gateway file holds the host/model/maintenance tokens, the pinned shared Engagement, and
  the outbox key.
  `state.json` keeps the stable principal ids, port, and shared Engagement id.
- The taric CLI is resolved from `tch.taric.localCliPath`, then `TARIC_CLI`,
  then a `Taric` checkout next to BreachWeave, then `taric` on `PATH`. The
  gateway process runs under `node` (Taric core requires `node:sqlite`).
- Tokens and the outbox key reach the daemon only through
  `TARIC_GATEWAY_HOST_TOKEN`, `TARIC_GATEWAY_MODEL_TOKEN`,
  `TARIC_GATEWAY_OPERATOR_TOKEN`, and `TARIC_OUTBOX_KEY`; they are never
  written to `settings.json`. The
  non-secret endpoint fields (host, port, CA file, server name, principal ids)
  are filled into `tch.taric` by `ConfigManager.applyLocalTaricDefaults`,
  which never overrides existing operator values or `enabled: false`.
- The gateway resolver fail-closes on token/Engagement mismatch, so one local
  deployment shares one Engagement; every challenge's project binds to it and
  records are namespaced by the composite project key.
- Host settings expose this boundary as `engagementBoundary: "shared_development"`.
  Selecting `project_bound` requires project-bound credentials and causes
  authorized projects to fail closed until those credentials are verified.
- Creating a challenge with `memoryMode: "legacy_local"` opts a single
  challenge out of the default binding; setting `tch.taric.enabled: false`
  disables the whole local gateway flow (the documented rollback path).

If the gateway cannot start (missing openssl/node/CLI), startup logs a warning
and memory routing falls back to `legacy_local`; it never blocks the daemon.

## Supported deployment profile

The implementation contains Bun in-process Taric and authenticated proxy
transport adapters. The current deployment profile is authenticated proxy;
the historical real smoke evidence covers the older profile only. The source
is now locked to API `1.3.0`, adapter `1.1`, schema `1.0.0`, Core `1.0.3`,
storage `authority-storage/3`, SQL `authority-sql/4`, and the driver integrity
recorded in `packages/core/src/taric/compatibility.ts`. A fresh 1.0.3 host
smoke is required before enabling `verificationRequired`. The proxy supports Taric's bounded
TLS TCP JSON-RPC transport and HTTPS `POST /rpc` gateway.
Taric CLI, MCP, Schemas, Core, and Bun SQLite driver components are all pinned
to upstream `1.0.3`; only Core, Schemas, and the Bun driver are
BreachWeave runtime package imports.

## Engagement boundary profiles

The transport profile (`embedded_bun` or `authenticated_proxy`) does not define
the project authorization boundary. The current local gateway provisions one
shared Engagement and one host/model principal set. A separate maintenance
token may be configured for gateway status/reload, but is not a feature
implementation prerequisite:

| BreachWeave profile | Taric boundary | Current support |
| --- | --- | --- |
| Single-tenant development or practice | Projects share the deployment's Engagement and gateway principals. The composite project key and title prefix are BreachWeave namespaces and filters, not Taric authorization. | Supported for local development. Treat the host configuration and shared authority as the deployment boundary. |
| `authorized_pentest` | Uses the local shared Engagement and host-derived project identity by default; project-bound credentials and `taric_required` remain optional hardening. | Local project setup, scope checks, capture, admission, and API close are supported. Egress enforcement and durable multi-tenant governance are follow-up profiles. |
| Multi-tenant | Requires tenant/project-bound Engagement and principal credentials, revocation, and lifecycle cleanup. | Not supported. Do not use the shared local gateway as a tenant boundary. |

Do not infer project isolation from the opaque project ID, title prefix, or a
successful provider query. The current shared profile can filter records inside
BreachWeave, but Taric authorization still applies to the shared Engagement.
Provisioning a different `taric_engagement_id` in project data alone does not
create or authorize a project-bound Taric identity.

## Governance integration status

The repository contains a standalone `AuthorizedPentestGovernance` helper under
`packages/core/src/taric/governance.ts`. Its unit-tested code includes basic
setup validation, a scope decision function, WorkRun claim/transition calls,
local encrypted artifact storage, coverage writes/gate queries, review/admission
calls, close checks, and checkpoint commit. The helper is exported by the Taric
package, but the daemon, challenge manager, solver runtime, host bridge, and Web
API do not construct or call it. These methods are not an end-to-end
authorized-pentest service.

| Control | Present in code | Available in the current runtime |
| --- | --- | --- |
| Scope and egress | `evaluateEgress` checks supplied URLs, redirects, DNS answers, addresses, protocol, port, and time window. | No enforced network egress hook, DNS pinning, proxy-path enforcement, or connection-time policy check is wired to solver/tool traffic. The helper's decision is advisory until that enforcement exists. |
| WorkRun | Host operations include claim, renew, reclaim, transition, and resume; the helper currently calls claim and transition and keeps reservations in memory. | No scheduler integration, lease renewal/reclaim/resume lifecycle, durable host resource locks, or generation check on every solver/tool action. |
| Artifact and evidence | A helper can encrypt bytes locally, hash them, and gate reads on an explicit capability. | No integrated Taric Artifact ingest/reference lifecycle, durable metadata recovery, retention enforcement, or end-to-end Evidence link. `retentionDays` is configuration validation, not a deletion scheduler. |
| Coverage and reports | The helper creates in-memory cells and calls coverage record/gate operations. | No manifest-to-Resource/WorkItem workflow, revision reconciliation, authoritative same-watermark report snapshot, or operator UI/API. |
| Review, close, and recovery | The helper can submit review/admission calls, perform local close checks, and commit an allowlisted checkpoint. | No operator review UI/API, authoritative Engagement close operation, durable decision lifecycle, or checkpoint restore/restart recovery. A local close result is not proof that Taric closed an Engagement. |

The local helper paths can be used for development and functional checks. A
deployment that needs network-enforced authorization, durable multi-tenant
governance, or authoritative Taric close must add and validate those controls
before treating the profile as production-ready.

The approved registry is configured outside the repository. Before installing a
Taric-enabled deployment, provide a short-lived read token without printing it
in shell history or CI logs:

```sh
export TARIC_REGISTRY_URL="https://registry.example.internal/"
export TARIC_REGISTRY_TOKEN="<short-lived-read-token>"
bun install --frozen-lockfile
```

The install must resolve the exact pinned artifacts from the scoped registry.
Workspace links, TypeScript path aliases, and checked-in source directories are
not valid production inputs. A deployment is not ready until a clean consumer
can dynamically import all three packages and the compatibility check passes.

When starting the Taric gateway, pass `--config` for listener and token
settings and a separate `--runtime-config` for the authority backend. The
runtime file is independently resolved and frozen at startup; its source,
digest, and precedence are reported by authenticated `taric.gateway.status`.
Changing the authority runtime file requires a gateway restart.
After upgrading a gateway process that predates `--runtime-config`, restart it
once so the supervisor can verify the explicit runtime source and digest before
adopting the listener.
Use `taric.gateway.reload` with an operator credential for listener/token
rotation. A successful replacement closes existing connections and invalidates
old credentials; a failed replacement restores the previous listener set and
reports the failure in `reload_failure`, while readiness remains a separate
signal.

## Host configuration

Configure Taric in trusted host settings. `authorityPath`,
`hostPrincipalId`, and `modelPrincipalId` are host values; they must not be
accepted from a solver request, copied to a solver environment, or mounted into
a solver container. Keep the authority database on a host-managed volume with
permissions limited to the daemon.

The local profile does not require a generated verification report. Set
`verificationRequired: true` only when a deployment intentionally wants the
full typecheck/build/artifact verification gate before starting a required Taric
project.

For `taric_best_effort`, configure a 32-byte `TARIC_OUTBOX_KEY` through the
host secret manager. Do not use a checked-in value, a model-provided value, or
an unencrypted key file. Set explicit `outboxMaxBytes` and `outboxMaxEvents`
limits and alert when the backlog approaches either limit. Missing keys disable
deferred writes; previously persisted events are retained for later reconciliation.

For `authenticated_proxy`, set `profile` to `authenticated_proxy`, choose
`gatewayTransport` as `https` or `tls_tcp`, and configure the gateway endpoint,
CA file, host/model token environment variable names, and the separate
operator token environment variable (`gatewayOperatorTokenEnv`) for gateway
status/reload. Tokens stay in the host secret manager and are never written to
`settings.json`. HTTPS endpoints must use TLS
and an absolute path without a query or fragment. When `outboxPath` is absent,
the host stores the encrypted outbox below the host config directory using a
hash of the trusted project identity.

The current daemon supports competition projects using `legacy_local` or
`taric_best_effort`. Although project validation requires `taric_required` for
`authorized_pentest`, this is not sufficient to enable that mode: the current
runtime has no project-bound provisioning or enforced scope/egress workflow.
Keep authorized projects out of this runtime until those controls and the
project-bound Taric credentials are deployed and verified. Never accept a
project or Engagement identifier supplied by a solver as trusted configuration.

Taric is enabled only after the BreachWeave verification gate passes for the
selected profile. Run `bun run verify:taric --profile=authenticated_proxy` (or
`embedded_bun`) after the clean install. The command records the typecheck,
focused challenge/runtime tests, full `packages/core` suite, and host build
results in `taric-verification.json`, together with the selected profile and
the locked package SRI digests. A missing report, failed check, profile
mismatch, or digest mismatch blocks gateway startup and Taric provider
creation. The report is host/operator evidence; it does not contain tokens or
authority contents.

For a live authenticated-proxy capture/query smoke, provision a trusted
Resource UUID through the operator bootstrap process and run
`TARIC_REAL_SMOKE_RESOURCE_ID=<uuid> bun run verify:taric:integration -- --live`.
The command records accepted solver/attempt/report observations, query-back,
health, and redaction outcomes in a sanitized artifact. It does not launch a
solver or execute target traffic. The current daemon does not declare a live
Bun embedded deployment, so do not use this artifact as embedded-profile
evidence.

## Health and operation

The Web API exposes the opaque host-derived `project_id`, `mode`, `provider`,
`memory_mode`, and `memory_health`. It never exposes the full project identity,
Taric credentials, outbox key, or authority contents. `healthy` means the
provider query succeeded. A best-effort outage is reported as `degraded` and
does not fall back to the local store. A required-project outage is reported as
`blocked` and Taric-backed provider operations return a sanitized unavailable
response. This health behavior does not provide authorized-pentest egress
enforcement; see the governance integration limits below.

Model and Observer writes are proposals. Host observations are captured by the
host principal. Pending candidate records must remain visibly distinct from
admitted records in operator views and exports.

Structured diagnostics from the Taric revision are bounded and redacted. Keep
them in operator logs and health responses, and do not treat diagnostic details
as authority data or expose them to solver containers.

## Authorized-project incident limits

- If an authorized test needs connection-time egress enforcement, configure the
  corresponding host policy layer before sending target traffic. The local
  scope helper remains useful for development checks but is advisory by itself.
- A healthy provider query does not confirm that observation capture, artifact
  commit, coverage, or review succeeded. Check each operation result separately.
  A capture with unknown commit status is `indeterminate`; preserve it for
  later reconciliation and do not automatically resend it.
- The governance helper keeps WorkRuns, target reservations, coverage cells,
  artifact metadata, and review decisions in process memory. After a daemon
  restart, treat active work and those projections as unreconciled. Local
  development may resume after the project and run state have been checked;
  durable generation recovery is optional hardening.
- The helper's artifact encryption and hash checks do not enforce retention or
  deletion policy. Do not treat `retentionDays` as active cleanup. Target
  credentials and sensitive evidence must not enter canonical records,
  metadata, logs, model context, or diagnostics; an explicitly authorized
  host/operator may store opaque target bytes in a bound Taric task-session
  Artifact, with `content_read` ACL and host-owned encryption, retention,
  deletion, rotation, and revocation.
- A helper coverage gate or local close result is a host workflow result. It is
  distinct from an authoritative Taric Engagement close when that remote
  operation is enabled; a separate human decision is optional locally.

## Backups and retention

Back up the Taric authority database using the deployment's SQLite backup or
filesystem snapshot procedure while the daemon is quiesced. Treat the backup as
authoritative state and protect it with the same access controls as the live
database. Back up the encrypted outbox separately when best-effort mode is in
use; never copy its key into the backup. Verify restore into an isolated path
before a production cutover.

Keep the legacy challenge directory as a read-only archive during migration.
Do not delete it as part of enabling Taric, and do not submit its records as
admitted Taric observations. Legacy records without a trusted composite project
binding remain `legacy_unclassified` and cannot launch a Taric-governed action.

## Rollback

1. Stop new Taric-backed operations and record the current Taric health and
   outbox backlog. Record a checkpoint only if it was produced and verified by
   an independently supported workflow; this runtime does not restore helper
   checkpoints after restart.
2. Resolve or preserve pending/conflicting outbox events. Do not replay them to
   the legacy provider and do not delete them to make the rollback appear clean.
3. Switch the affected project to its retained `legacy_local` provider (or stop
   the project if policy requires Taric) and restart the daemon so provider
   routing is rebuilt.
4. Keep the Taric authority and its backup intact. Re-enable Taric only after
   the artifact compatibility, principal/Engagement binding, and health checks
   pass again.

Rollback changes provider routing; it does not merge Taric state into local
files or remove Taric records. Any migration of legacy content requires a
separate dry-run and ordinary Taric proposal/evidence flows.

## Unsupported profiles

Multi-host authority, project-bound authorized/multi-tenant Engagement
provisioning, enforced authorized-pentest egress, scheduler-integrated WorkRun
recovery, end-to-end Artifact/Evidence governance, human review/close UI,
container Artifact spool ingestion, quality capability, direct SQLite writes,
and workspace-linked Taric packages remain unsupported by this BreachWeave
profile. The authenticated proxy is supported only through the bounded TLS TCP
and HTTPS transports described above; it does not enable remote file-path
Artifact ingestion or supply the missing project governance lifecycle.

