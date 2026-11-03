# Taric Memory Operations Runbook

This runbook covers the BreachWeave host integration for `taric_best_effort` and `taric_required` projects. Taric remains the sole authority for these modes. The host may queue deferred events in its encrypted append-only outbox, but it never reads or writes the legacy local memory provider as a fallback.

## Read diagnostics

Use the host diagnostics endpoint or the equivalent `buildTaricDiagnostics` snapshot. The snapshot reports only mode, health, bounded counters, conflict state, and the confirmed `read_seq`; it must not include authority paths, credentials, raw observations, or Artifact bytes.

Taric Core, CLI, MCP, RPC, SQLite, and PostgreSQL diagnostics follow the same
bounded and redacted contract. Preserve the returned code, safe message,
follow-up, and compatibility summary when escalating an incident; do not add
raw request values or local paths.

Interpret the states as follows:

- `healthy`: the authority is available and the latest confirmed watermark is usable.
- `degraded`: Taric memory or notification recovery is unavailable in best-effort mode. Platform control may continue, while memory reads surface degraded state and deferred host events remain queued.
- `blocked`: a required project cannot perform governed actions, or the host has a version mismatch, outbox limit, or replay conflict to reconcile.

## Taric unavailable

1. Check the host health and compatibility diagnostics. Confirm the configured profile is the approved embedded Bun or authenticated proxy profile and that the authority or gateway is reachable. For a gateway, use authenticated `taric.gateway.status` and verify both liveness and readiness.
2. For `taric_required`, stop governed target actions and admission until health returns to `healthy`.
3. For `taric_best_effort`, leave the project in degraded mode. Do not create a local memory copy and do not delete the outbox.
4. After recovery, trigger an authoritative refresh and ordered outbox replay. Confirm the `read_seq` advances and pending count falls.

For gateway credential rotation, submit `taric.gateway.reload` with the
configured maintenance credential and wait for readiness to return. Existing
connections and the old credential must fail after replacement; if replacement
fails, confirm the previous listener set is serving and resolve the reported
reload diagnostic.

## Version or policy mismatch

Stop the affected project. Install the exact locked Taric packages and policy manifest from the approved internal registry, then restart the host. Do not bypass the compatibility check or accept a workspace/path alias as a production artifact.

## Outbox backlog or key failure

The outbox is encrypted with the deployment-provided 32-byte host key. A missing key must stop deferred writes; it must never cause plaintext persistence. Restore the same key, verify available disk capacity, and replay in sequence. When the configured event or byte bound is reached, resolve or replay existing events before accepting more writes.

## Replay conflict

A conflict preserves the event and stops later events from overtaking it. Inspect the event ID, project binding, request result, and current Taric version through host diagnostics. Reconcile the proposal against current authority state and submit an explicit correction. Never mark a conflict as accepted by editing the JSONL file and never replay it into the legacy provider.

## Notification loss or reconnect

Taric subscription messages are refresh hints only. On duplicate, loss, reconnect, token revocation, or slow-consumer disconnect, query authoritative state from the last confirmed `read_seq` and apply the returned delta idempotently. A notification alone must not launch a solver, perform a target action, or create a memory entry.

## Rollback

Rollback changes project routing to a retained `legacy_local` archive after pending Taric events and conflicts are recorded. Do not delete the Taric authority, merge candidate proposals into local facts, or expose Taric credentials to a solver container.
