export { TARIC_ARTIFACT_MANIFEST, TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_CLEAN_CONSUMER_PROFILE, TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, TARIC_OPERATION_CONTRACTS, TARIC_PACKAGE_ARTIFACTS, TARIC_UPSTREAM_COMMIT, TARIC_UPSTREAM_COMPONENT_ARTIFACTS, compareTaricCompatibility, validateExpectedTaricCompatibility, validateTaricArtifactManifest, validateTaricOperationContracts } from "./compatibility"
export { getTaricOperationContract } from "./compatibility"
export type { TaricOperationContract, TaricReplayPolicy } from "./compatibility"
export { TARIC_OPERATION_REGISTRY, TARIC_OPERATION_REGISTRY_DIGEST, TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "./operation-registry"
export type { TaricPrincipalRole, TaricRegistryOperation } from "./operation-registry"
export { TARIC_CANONICAL_MAPPINGS, TaricControlPlaneContractError, assertTaricControlPlaneContract, inspectTaricControlPlaneContract } from "./control-plane-contract"
export type { TaricCanonicalFact, TaricCanonicalMapping, TaricControlPlaneContractDiagnostic } from "./control-plane-contract"
export { createTaricHostModule, TaricHostModule, TARIC_HOST_ONLY_OPERATIONS, TARIC_MODEL_PROPOSAL_OPERATIONS, TARIC_MODEL_QUERY_OPERATIONS } from "./host-module"
export { readGovernancePages } from "./governance-query-reader"
export type { GovernanceQueryBinding, GovernanceQueryContinuation, GovernanceQueryDiagnostics, GovernanceQueryKind, GovernanceQueryLimits, GovernanceQueryPage, GovernanceQueryReaderOptions, GovernanceQueryResult, GovernanceQueryStatus, GovernanceQueryTruncationReason } from "./governance-query-reader"
export { createEmbeddedTaricServiceAdapter, TARIC_EMBEDDED_DEPENDENCIES } from "./embedded-adapter"
export { createNetworkTaricServiceAdapter } from "./network-adapter"
export { assertProductionActivationSupported, createTaricHostModuleForProject, createTaricMemoryProviderFactory } from "./provider-factory"
export {
    TARIC_LOCAL_GATEWAY_DEFAULT_PORT,
    TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV,
    TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV,
    TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV,
    TARIC_LOCAL_GATEWAY_SERVER_NAME,
    createLocalTaricEngagement,
    ensureDefaultLocalTaricGateway,
    ensureLocalTaricGateway,
    getLocalTaricGatewayRuntime,
    localGatewayStateDir,
    parseEngagementId,
    pickFreeLoopbackPort,
    resolveTaricCliPath,
    LocalTaricGatewayUnavailableError,
} from "./local-gateway"
export type { EnsureLocalTaricGatewayOptions, LocalEngagementResult, LocalTaricGatewayRuntime } from "./local-gateway"
export type { EmbeddedTaricAdapterOptions, EmbeddedTaricRuntimeDependencies } from "./embedded-adapter"
export type { NetworkTaricAdapterOptions, TaricNetworkTransport } from "./network-adapter"
export type { TaricMemoryProviderFactory } from "./provider-factory"
export type {
    TaricAdapterProfile,
    TaricCompatibility,
    TaricHealth,
    TaricHealthStatus,
    TaricHostBinding,
    TaricHostModuleOptions,
    TaricHostObservationInput,
    TaricObservationDto,
    TaricArtifactReferenceDto,
    TaricCaptureDtoKind,
    TaricMemoryMode,
    TaricProposalInput,
    TaricCheckpointProposalInput,
    TaricQueryInput,
    TaricServiceAdapter,
} from "./types"
export {
    adaptAttemptCaptureDto,
    adaptCaptureDto,
    adaptPlatformCaptureDto,
    adaptReportCaptureDto,
    adaptSolverCaptureDto,
    CaptureDtoError,
    TARIC_CAPTURE_DTO_MAX_BYTES,
} from "./capture-dto"
export type { AdaptedCaptureDto, CaptureDtoAdapterInput, CaptureDtoDiagnostic } from "./capture-dto"
export { TaricOperationError, TaricUnavailableError } from "./types"
export { EncryptedTaricOutbox, TaricOutbox, TaricOutboxError } from "./outbox"
export { TaricSubscriptionRecovery } from "./outbox"
export { AuthorizedPentestGovernance, GovernanceError, evaluateEgress, validateAuthorizedProjectSetup } from "./governance"
export type {
    ArtifactMetadata,
    AuthorizedPentestGovernanceOptions,
    AuthorizedProjectSetup,
    CheckpointState,
    CloseRequest,
    CoverageCell,
    CoverageGate,
    CoverageStatus,
    EgressRequest,
    GovernanceDiagnostics,
    GovernanceOutcome,
    GovernanceReadOptions,
    HostObservationInput,
    ManifestItem,
    PolicyDecision,
    RecoveredWorkRun,
    ReportSnapshot,
    ReviewDecision,
    ReviewSubmission,
    ReviewVerdict,
    ScopePolicy,
    ScopeTarget,
    TestWindow,
    WorkRun,
    WorkRecoveryLocator,
    AuthorizedLifecycleMode,
    AuthorizedProjection,
    ProjectionReconciliation,
} from "./governance"
export { buildTaricDiagnostics } from "./diagnostics"
export { TaricArtifactService } from "./artifact-service"
export type { TaricArtifactSessionBinding, TaricArtifactRunFence, TaricArtifactServiceOptions, TaricArtifactEgressGrant, StoreTargetAuthInput, StoreTaricArtifactInput, CommittedTaricArtifact } from "./artifact-service"
export { TaricArtifactPolicy } from "./artifact-policy"
export type { ArtifactPolicyOptions, ArtifactRetentionRecord } from "./artifact-policy"
export { adaptTaricToolEvidence, buildTaricEvidenceCandidate } from "./artifact-evidence"
export type { TaricEvidenceBinding, TaricEvidenceInput, TaricEvidenceCandidate, TaricToolEvidenceResult } from "./artifact-evidence"
export { TaricAuthorityResourceService } from "./authority-resource-service"
export type { AuthorityResourceRevisionInput } from "./authority-resource-service"
export { TaricAuthorityProjectBootstrap } from "./authority-bootstrap"
export type { AuthorizedBootstrapManifestItem, AuthorizedProjectBootstrapInput, AuthorizedProjectBootstrapResult, AuthorityProjectBootstrapOptions, BootstrappedManifestItem, CanonicalScopeLocator } from "./authority-bootstrap"
export { TaricAuthorityScopeService } from "./authority-scope-service"
export type { AuthorityScopePolicy, AuthorityScopeServiceOptions, AuthorityScopeRevisionInput } from "./authority-scope-service"
export { TaricAuthorityCoverageService } from "./authority-coverage-service"
export type { AuthorityCoverageDimension, AuthorityCoverageStatus, AuthorityCoverageServiceOptions, AuthorityCoverageManifestInput, AuthorityCoverageRecordInput } from "./authority-coverage-service"
export type { AuthorityAssetIdentity, AuthorityResourceServiceOptions } from "./authority-resource-service"
export { TaricAuthorityWorkService, TaricAuthorityClaimError } from "./authority-work-service"
export type { AuthorityWorkServiceOptions, AuthorityWorkDefinition, AuthorityWorkCheckpointInput, AuthorityWorkRecovery } from "./authority-work-service"
export { TaricAuthorityBoard } from "./authority-board"
export type { AuthorityBoardOptions, AuthorityBoardRecord, AuthorityBoardSnapshot, AuthorityBoardStatus, AuthorityBoardRefreshReason, AuthorityProjectManifest } from "./authority-board"
export { TaricAuthorityScheduler, TaricHostWorkerReservations } from "./authority-scheduler"
export type { AuthoritySchedulerOptions, AuthorityScheduleRequest, HostWorkerReservation } from "./authority-scheduler"
export { TaricEgressExecutor } from "./egress-executor"
export type { TaricEgressRunContext, TaricEgressDecision, TaricEgressResult, TaricEgressInput, TaricEgressExecutorOptions, TaricEgressAddress, TaricActionNetworkProvenance } from "./egress-executor"
export { TaricAuthorityActionService } from "./authority-action-service"
export type { TaricAuthorityActionContext, TaricAuthorityActionOptions, TaricAuthorityActionHost, TaricAuthorityActionOutcome, TaricCanonicalActionOperation } from "./authority-action-service"
export { TaricAuthorityReportService } from "./authority-report-service"
export { TaricAuthorityAdmissionService } from "./authority-admission-service"
export type { AuthorityReportServiceOptions, AuthorityReportSnapshotInput, AuthorityCloseInput, AuthorityReopenInput, AuthorityReportProjection } from "./authority-report-service"
export { deriveStableHostRequestIdentity, assertBoundTaricIdentifiers, requireOpaqueHostId, requireTaricUuid, TaricIdentityError } from "./host-identity"
export type { StableHostIdentityInput, StableHostIdentityKind } from "./host-identity"
export { createAuthorityRecoveryCheckpoint, parseAuthorityRecoveryLocator, parseAuthorityRecoveryRun, validateAuthorityRecoveryPacket, TaricRecoveryError } from "./recovery-locator"
export type { RecoveryPremise, AuthorityRecoveryRun, AuthorityRecoveryLocator, AuthorityCheckpointContextSource } from "./recovery-locator"
export { readTaricSourceIdentity } from "./source-evidence"
export type { TaricSourceIdentity } from "./source-evidence"
export { TARIC_ACCEPTANCE_PROFILES, buildAuthorizedGovernanceReadiness } from "./governance-readiness"
export type { AuthorizedGovernanceReadiness, GovernanceCapabilityReadiness, GovernanceReadinessStatus } from "./governance-readiness"
export { assertTaricVerificationReport, getTaricArtifactDigests, validateTaricCleanConsumerReport, validateTaricVerificationReport, TARIC_VERIFICATION_CHECKS } from "./verification"
export type { TaricDeploymentProfile, TaricVerificationArtifact, TaricVerificationReport } from "./verification"
export type {
    TaricOutboxEvent,
    TaricOutboxEventStatus,
    TaricOutboxOptions,
    TaricOutboxReplayOptions,
    TaricOutboxReplayResponse,
    TaricOutboxReplayResult,
    TaricOutboxReplaySummary,
    TaricSubscriptionRefresh,
    TaricSubscriptionRefreshReason,
    TaricSubscriptionRefreshResponse,
    TaricSubscriptionRecoveryOptions,
    TaricSubscriptionRecoverySnapshot,
    TaricSubscriptionRecoveryState,
} from "./outbox"
export type { TaricDiagnostic, TaricDiagnosticCode, TaricDiagnosticReport, TaricDiagnosticSeverity, TaricDiagnosticsInput, TaricOutboxDiagnosticInput, TaricSelectedProfile } from "./diagnostics"
export { buildTaricEvaluationReport, validateTaricBenchmarkManifest } from "./evaluation"
export type { EvaluationMode, TaricBenchmarkManifest, TaricEvaluationMetrics, TaricEvaluationReport, TaricRunControls } from "./evaluation"
