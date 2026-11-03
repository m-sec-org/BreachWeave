# Taric-103 local transport and role-routing

The selected transport for Taric-103 local governance is **embedded Bun**, selected through the `embedded_bun` configuration profile and reported as `bun_in_process` by the adapter, with a single-host SQLite authority. `createEmbeddedTaricServiceAdapter` loads the locked `@taric/core`, `@taric/schemas`, and `@taric/driver-bun-sqlite` packages in process, creates the authority store from `authorityPath`, and creates host/model principals from the trusted project binding. An operator principal exists only when trusted host configuration explicitly supplies operatorPrincipalId. The adapter does not open a network listener, Unix socket, or loopback TLS endpoint.

This is the selected `local_development` transport/deployment pair:

| Dimension | Selected value | Boundary |
| --- | --- | --- |
| BreachWeave acceptance profile | `local_development` | Fixture identities and a shared development Engagement are allowed by the local profile. |
| Taric authority profile | `single_host_sqlite` | One Bun process owns the authority store and local Artifact root. |
| Host configuration profile | `embedded_bun` | Explicit selection is required; the provider factory's omitted-profile default is `authenticated_proxy`. |
| Transport profile | `bun_in_process` | The host calls Taric Core directly; there is no authenticated remote transport claim. |
| Production profile | `multi_host_authority` / `production_hardened` | Separate enablement and conformance work; local evidence does not promote this profile. |

## Role-routing contract

The adapter resolves each operation against the locked Taric 1.0.4 registry (`66` operations; the authoritative digest is exported as `TARIC_OPERATION_REGISTRY_DIGEST`). Callers use an explicit `model` or `host` role; the omitted role defaults to `model` for compatibility with the service interface, so host-only operations must be called with `host`. Before `dispatch`, the adapter rejects:

- an operation absent from the registry (`validation_error`);
- a role that is absent from that operation's registry role list (`authorization_error`);
- a request whose `engagement_id` differs from the trusted embedded binding (`authorization_error`).

The adapter selects the principal from the trusted binding. It never reads a caller-supplied `principal_id`, `role`, or `capabilities` field from the request body. The host principal is used for health checks and host-owned mutations; the model principal is used for model query/proposal calls.

The current local governance surfaces route as follows:

| Local surface | Operations | Embedded principal |
| --- | --- | --- |
| `TaricHostModule.query` | `context.query`, `resource.query`, `evidence.query`, `coverage.query`, `work.query` | `model` |
| `TaricHostModule.submitProposal` / `proposeCheckpoint` | `proposal.submit`, `checkpoint.propose` | `model` |
| Host observation/work/coverage/checkpoint paths | `capture.observation`, `resource.revise`, `work.claim`, `work.renew`, `work.reclaim`, `work.transition`, `coverage.record`, `coverage.gate`, `checkpoint.commit`, `work.resume` | `host` |
| Host proposal/review/admission paths | `proposal.list`, `review.pack`, `review.submit`, `admission.evaluate`, `admission.commit` | `host` is requested by the existing host surface; the registry is authoritative (see below) |
| Host Artifact service | `artifact.session.bind`, `artifact.store.begin`, `artifact.store.append`, `artifact.store.commit`, `artifact.metadata`, `artifact.ingest_file`, `artifact.content.read`, `artifact.content.list`, `artifact.session.output` | `host` |
| Host-readable query paths | `coverage.query`, `work.query` | `host` when called through `invokeHost`; `model` when called through `query` |
| Adapter health | `engagement.status` | `host` |

`review.submit` is intentionally shown as a failed local route: Taric's registry permits `reviewer` only, while the existing host module includes it in its host operation surface. The embedded adapter rejects a host dispatch before Taric Core sees it. A fixture host is not silently promoted to reviewer, and the adapter does not invent a reviewer principal. Supplying a reviewer adapter/principal is a separate governance change.

Writer/reviewer operations still fail closed. Operator-only operations use the separate invokeOperator route and require an explicitly configured operator identity; request bodies cannot grant that identity. For example, `admission.promote_l2` is not callable as host or model. Operations outside the local governance surface are still checked against the complete registry by the conformance test.

The locked Action registry allows model/host recommendations and host-only decisions/results/reconcile. The canonical controlled loopback bridge now records full ActionEvent history and observed peer provenance, recovered through action.audit.query. Scope and report/close services use the new operator route for scope.revise/invalidate, coverage.manifest.commit and engagement.close/reopen. These services do not activate the unconverted Planner/Solver/Web lifecycle.

Role routing does not grant capabilities. In particular, an allowed host dispatch to `artifact.content.read` remains subject to Taric's separate `content_read` capability and Artifact/session/run authorization. Model/body fields never grant raw-byte access. The adapter does not implement Taric's model projection logic or claim that a routing test verifies Work owner/generation redaction.

## Conformance evidence

`packages/core/src/taric/embedded-adapter.test.ts` injects a small Core/schema/driver runtime so routing can be verified without installing Taric packages. The tests verify:

1. `bun_in_process` profile selection, host health routing, compatibility, binding, and close behavior;
2. every operation currently exposed by the host/model local governance surfaces is present in the registry and dispatches only with an allowed role;
3. both `host` and `model` routing for all 66 registry operations, including rejection for roles unavailable to the embedded transport;
4. host/model Work query routing, trusted principal selection despite forged request identity fields, unsupported operation rejection, wrong-role rejection, and binding isolation;
5. pre-dispatch authorization errors remain business errors and preserve host health.

The checked matrix has 31 unique local governance operations and 33 requested operation/role pairs: 32 dispatch with an allowed role and the host `review.submit` pair rejects. The full registry matrix tests 114 operation/role pairs: 61 dispatch with an allowed local role and 53 reject before dispatch. These are routing counts, not successful authority mutation counts.

Run the focused evidence with:

```sh
bun test packages/core/src/taric/embedded-adapter.test.ts packages/core/src/taric/host-module.test.ts
bun run typecheck
```

The 2026-10-31 local run passes 20 tests across the two files (316 assertions) and `bun run typecheck`. The typecheck includes the repository's no-new-directory-import check. No installed `@taric/*` packages were available for this routing run, so the injected-runtime evidence is recorded separately from package/authority conformance.

This evidence verifies adapter routing and local binding behavior. It does not claim upstream Taric Core schema/storage conformance when the locked Taric packages are unavailable to this adapter test, and it does not unblock the existing canonical Scope/ROE, action-audit, report/close, or production activation gates. Locked-artifact integrity is verified separately by the isolated clean-consumer report.
