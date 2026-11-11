export { ConfigManager } from "./config/index"
export { RuntimeManager } from "./runtime/runtime"
export { StopCoordinator, Supervisor, StartupRecovery, createRuntimeIdentity, createRuntimeEffect, reconcileRuntimeEffect } from "./runtime/lifecycle-supervision"
export type { RuntimeIdentity, RuntimeIdentityInput, RuntimeEffect as SupervisedRuntimeEffect, StopPolicy, StopRequest, StopCallbacks, StopResult, SupervisorState, ManagerLease, RecoveryAdapter, RecoveryResult } from "./runtime/lifecycle-supervision"
export { ManagerLifecycleService, EncryptedPendingCommitSpool, createManagerLifecycleService, validateFinalBatch } from "./challenge/lifecycle-service"
export type { LifecycleReportInput, LifecycleReportResult, LifecycleReportCode, LifecycleAssignmentInput, FinalBatchItem, LifecycleStopRequest, PendingCommitSpool, PendingCommitEntry } from "./challenge/lifecycle-service"
export * from "./lifecycle/domain"
export * from "./lifecycle/reducer"
export * from "./lifecycle/validation"
export * from "./lifecycle/ledger"
export * from "./lifecycle/execution"
export * from "./lifecycle/evaluation"
export {
    ReviewJobStore,
    ReviewService,
    ReviewContractError,
    assembleFrozenReviewPack,
    verifyFrozenReviewPack,
    runMechanicalReview,
    summarizeReviewVerdict,
    validatePlannerDecision,
    admitEvidence,
    continueAssignment,
} from "./lifecycle/reporting/review"
export type {
    EvidenceAdmission,
    ReviewResult,
    ReviewChecklistItem,
    FrozenReviewPack as ReviewFrozenReviewPack,
} from "./lifecycle/reporting/review"
export {
    FinalizationService,
    FinalizationContractError,
    validateEvidenceBoundFinding,
} from "./lifecycle/reporting/finalization"
export type {
    SealBlocker,
    SealIntent,
    SourceInput,
    AtomicClaim,
    ClaimRelation,
    ClaimRelationRecord,
    ReportIR,
    RenderedReport,
    QaIssue,
    FinalQa,
    PublishEffect,
    Finalization as ReportingFinalization,
    SourceManifest as ReportingSourceManifest,
} from "./lifecycle/reporting/finalization"
export {
    BoardService,
    BoardContractError,
    DiscoveryStore,
    HistoryIngestor,
    ContextRevisionStore,
} from "./lifecycle/board/service"
export type {
    BoardItemClass,
    BoardVisibility,
    BoardJobState,
    BoardItem,
    StrategyBoardRevision,
    BoardPatch,
    BoardJob,
    DiscoveryCandidate,
    ArtifactManifest,
    HistorySnapshot,
    ContextRevision as BoardContextRevision,
} from "./lifecycle/board/service"
export {
    createDeterministicTaricLifecycleAdapter,
    checkLifecycleCompatibility,
    assertLifecycleCompatibility,
    operationContract,
    validateLifecycleRegistry,
    rejectLegacyLifecycleWrite,
    assertLifecycleFence,
    assertLifecycleWriteAuthority,
    WorkerHarness,
    LifecycleTelemetry,
} from "./lifecycle/taric/index"
export type {
    LifecycleProfile,
    LifecycleAdapterKind,
    CompatibilityTuple,
    CompatibilityStatus,
    LifecycleOperation,
    LifecyclePrincipal,
    WatermarkDomain,
    LifecycleOperationRequest,
    TaricLifecycleOperationResult,
    TaricLifecycleAdapter,
    TaricLifecycleFence,
    WorkerDispatchRequest,
    LifecycleTelemetryEvent,
    LifecycleMetric,
} from "./lifecycle/taric/index"
export { runSolverCli, runSubagentCli, runSolverRpc } from "./solver/cli"
export type { SolverEventListener } from "./solver/cli"
export * from "./taric/index"
export * from "./project/index"

import { ConfigManager } from "./config/index"
import { ChallengeManager } from "./challenge/manager"
import { createChallengeHostBridgeHandler } from "./challenge/host-bridge-handler"
import { RuntimeManager } from "./runtime/runtime"
import { createTaricMemoryProviderFactory } from "./taric/provider-factory"
import { ensureDefaultLocalTaricGateway } from "./taric/local-gateway"
import { createAuthorizedChallengeProjectionProvider } from "./challenge/authorized-projection"
import { createManagerLifecycleService } from "./challenge/lifecycle-service"

export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly challenge: ChallengeManager
    readonly runtime: RuntimeManager

    private constructor(config: ConfigManager, challenge: ChallengeManager, runtime: RuntimeManager) {
        this.config = config
        this.challenge = challenge
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance
        const created = (async () => {
            const config = await ConfigManager.getInstance()
            await ensureDefaultLocalTaricGateway(config)
            let runtime: RuntimeManager | undefined
            const lifecycle = createManagerLifecycleService({
                stop: async ({ run }) => {
                    if (!runtime) return
                    await runtime.stopSolver(run.runtimeId)
                },
            })
            const challenge = new ChallengeManager(config, undefined, undefined, createTaricMemoryProviderFactory(config), createAuthorizedChallengeProjectionProvider(config), lifecycle)
            runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            runtime.onEvent((solverId, event) => {
                void challenge.captureSolverEvent(solverId, event)
            })
            // Recover canonical authorized WorkRuns before exposing the daemon
            // to Web/TUI lifecycle callers. This is idempotent and failures are
            // retained as a readiness block instead of falling back to files.
            await challenge.recoverAuthorizedStartup("daemon:startup")
            return new DaemonManager(config, challenge, runtime)
        })()
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }

    async reloadFromConfig(): Promise<void> {
        await this.challenge.reloadFromConfig()
        await this.runtime.reloadFromConfig()
        await this.challenge.recoverAuthorizedStartup("daemon:reload")
    }

    async close(): Promise<void> {
        await this.runtime.stopAll()
        await this.challenge.close()
    }
}
