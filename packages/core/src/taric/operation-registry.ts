/** Exact source snapshot: Taric 1c466f4d8ad8f775f98bf867453b81230469287a, packages/schemas/src/registry.ts. */
export type TaricPrincipalRole = "model" | "host" | "reviewer" | "writer" | "operator"

export interface TaricRegistryOperation {
    operation: string
    roles: readonly TaricPrincipalRole[]
    request: string
    response: string
    errors: readonly string[]
    idempotent: boolean
    mutates_authority: boolean
    engagement_scoped: boolean
    capability?: string
}

export const TARIC_OPERATION_REGISTRY_SOURCE_DIGEST = "sha256:866a96b8fdb650c56c6edae59840b854930f4392f49edd5941ad67c6425b8603"

export const TARIC_OPERATION_REGISTRY: readonly TaricRegistryOperation[] = [
    {
        "operation": "engagement.init",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": false
    },
    {
        "operation": "engagement.status",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "engagement.close",
        "roles": [
            "operator"
        ],
        "request": "engagementCloseRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "engagement.reopen",
        "roles": [
            "operator"
        ],
        "request": "engagementReopenRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "scope.revise",
        "roles": [
            "operator"
        ],
        "request": "scopeRevisionRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "scope.invalidate",
        "roles": [
            "operator"
        ],
        "request": "scopeInvalidateRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "scope.query",
        "roles": [
            "host",
            "operator"
        ],
        "request": "scopeQueryRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "report.snapshot.commit",
        "roles": [
            "host",
            "operator"
        ],
        "request": "reportSnapshotCommitRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "capability.status",
        "roles": [
            "model",
            "host",
            "reviewer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "adapter.status",
        "roles": [
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "adapter.install",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "adapter.remove",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "adapter.config",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "context.build",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "context.query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "resource.query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "evidence.query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "proposal.submit",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "proposalEnvelope",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "proposal.list",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "capture.observation",
        "roles": [
            "host",
            "operator"
        ],
        "request": "observation",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "review.pack",
        "roles": [
            "host",
            "operator"
        ],
        "request": "reviewPackRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "review.submit",
        "roles": [
            "reviewer"
        ],
        "request": "reviewSubmitRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "admission.evaluate",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "admission.commit",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "admission.promote_l2",
        "roles": [
            "writer",
            "operator"
        ],
        "request": "promotionL2",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true,
        "capability": "writer"
    },
    {
        "operation": "control.observe",
        "roles": [
            "host",
            "operator"
        ],
        "request": "controlObservation",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "access.observe",
        "roles": [
            "host",
            "operator"
        ],
        "request": "accessDecisionObservation",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "control.list",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "host.state",
        "roles": [
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "work.claim",
        "roles": [
            "host"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "work.renew",
        "roles": [
            "host"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "work.reclaim",
        "roles": [
            "host"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "work.transition",
        "roles": [
            "host"
        ],
        "request": "workTransitionRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "work.resume",
        "roles": [
            "host"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "work.query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "workQueryRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "coverage.gate",
        "roles": [
            "host",
            "operator"
        ],
        "request": "coverageSnapshotRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "coverage.manifest.commit",
        "roles": [
            "operator"
        ],
        "request": "coverageManifestCommitRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "coverage.record",
        "roles": [
            "host",
            "operator"
        ],
        "request": "coverageRecordRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "coverage.query",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "coverageQueryRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "coverage.snapshot",
        "roles": [
            "host",
            "operator"
        ],
        "request": "coverageSnapshotRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "checkpoint.propose",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "checkpoint.commit",
        "roles": [
            "host"
        ],
        "request": "checkpoint",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "action.recommend",
        "roles": [
            "model",
            "host",
            "operator"
        ],
        "request": "actionIntent",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "action.host-decision",
        "roles": [
            "host"
        ],
        "request": "actionIntent",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "action.host-result",
        "roles": [
            "host"
        ],
        "request": "actionIntent",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "action.reconcile",
        "roles": [
            "host"
        ],
        "request": "actionIntent",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "action.audit.query",
        "roles": [
            "host",
            "operator"
        ],
        "request": "actionAuditQueryRequest",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.session.bind",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactSessionBinding",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.store.begin",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactStoreBegin",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.ingest_file",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactIngestFile",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.store.append",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactStoreAppend",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.store.commit",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactStoreCommit",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": true,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.metadata",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactContentRead",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.content.read",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactContentRead",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error",
            "unavailable_host"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true,
        "capability": "content_read"
    },
    {
        "operation": "artifact.content.list",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactContentList",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error",
            "unavailable_host"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "artifact.session.output",
        "roles": [
            "host",
            "operator"
        ],
        "request": "artifactSessionOutput",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error",
            "unavailable_host"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "audit.verify",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "audit.doctor",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": false
    },
    {
        "operation": "audit.reconcile",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": false
    },
    {
        "operation": "error.report",
        "roles": [
            "host"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "snapshot.export",
        "roles": [
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "invalid_cursor",
            "minimum_budget_required",
            "internal_error"
        ],
        "idempotent": false,
        "mutates_authority": false,
        "engagement_scoped": true
    },
    {
        "operation": "resource.revise",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "resource.patch",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "resource.relation",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    },
    {
        "operation": "resource.impact",
        "roles": [
            "host",
            "writer",
            "operator"
        ],
        "request": "apiSuccess",
        "response": "apiSuccess",
        "errors": [
            "validation_error",
            "authorization_error",
            "stale_version",
            "conflict",
            "unsupported_schema_version",
            "internal_error",
            "idempotency_conflict"
        ],
        "idempotent": false,
        "mutates_authority": true,
        "engagement_scoped": true
    }
]

export const TARIC_OPERATION_REGISTRY_DIGEST = "sha256:a37745ab273ccde0574d9c256cd5b984b58a5a98779d169280472f8b0301dd47"
