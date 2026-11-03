# Taric Internal Registry Profile

BreachWeave resolves the Bun embedded Taric adapter from the `@taric` scoped
registry configured in `bunfig.toml`. Registry credentials are deployment
inputs, not repository configuration.

Set these variables before installing a Taric-enabled deployment:

```sh
export TARIC_REGISTRY_URL="https://registry.example.internal/"
export TARIC_REGISTRY_TOKEN="<short-lived-read-token>"
```

The adapter now expects these locked packages at version `1.0.3` from Taric
HEAD `23148800ca08595ffce0c7ee83a88f190c245633`:

- `@taric/schemas`
- `@taric/core`
- `@taric/driver-bun-sqlite`

Taric CLI and MCP components are also `1.0.3` at this revision. Their locally
packed tarball integrity is recorded separately as an upstream component
reference in the manifest; BreachWeave does not import either package as a
runtime dependency.

Their SRI values are frozen in `packages/core/src/taric/compatibility.ts` and
are checked against the recorded `taric-clean-consumer/1` profile. That profile
verified isolated tarball imports, Core restart reads, and the Bun driver query
without workspace links. The production install must resolve those packages
from the internal registry, without workspace links or source path aliases. The
runtime dynamically imports the packages so legacy-local projects can still run
when Taric is disabled.

Run the manifest check before enabling the Taric profile:

```sh
bun test packages/core/src/taric/compatibility.test.ts
```

The clean-consumer evidence validates local packed artifacts and dependency
closure; it does not claim registry publication or BreachWeave host smoke
coverage.

`docs/taric-verification.json` was regenerated on 2026-10-30 against the
current worktree and the 1.0.3 manifest. It proves typecheck, focused/core
tests, and build; it does not prove a live gateway, target execution, or
multi-host deployment. Regenerate it with
`bun run verify:taric -- --profile=authenticated_proxy` after source changes,
and run a separate current 1.0.3 gateway smoke before setting
`verificationRequired`.

This Taric revision also supplies bounded, redacted structured diagnostics
through Core, CLI, MCP, RPC, and the SQLite/PostgreSQL drivers. Keep the
diagnostic payloads as operator evidence only; they must not be expanded with
credentials, authority paths, or raw observations. The gateway's authenticated
`taric.gateway.status` and `taric.gateway.reload` operations expose readiness,
configuration replacement, connection revocation, and failure recovery. Pass
the independent runtime authority file with `--runtime-config`; do not reuse
the listener configuration as a runtime authority source. Runtime authority
settings are frozen at gateway startup; reload replaces listener/token settings
and a failed replacement is reported separately as `reload_failure`.

Embedded Taric host settings require `authorityPath`, `hostPrincipalId`, and
`modelPrincipalId`. Authenticated proxy settings use `gatewayTransport`, a
gateway endpoint, host/model token environment variables, and a separate
operator token environment variable for gateway management instead of
`authorityPath`. Best-effort outbox writes require a 32-byte
`TARIC_OUTBOX_KEY` supplied by the host secret manager. These values are never
copied into solver environment variables or container binds.
