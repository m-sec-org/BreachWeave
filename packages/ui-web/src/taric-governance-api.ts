import { randomBytes, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { chmod, mkdir } from "node:fs/promises"
import type {
    ArtifactMetadata,
    AuthorizedPentestGovernance,
    AuthorizedProjectSetup,
    CheckpointState,
    CloseRequest,
    CoverageStatus,
    EgressRequest,
    PolicyDecision,
    ReportSnapshot,
    ReviewDecision,
    ReviewSubmission,
    ReviewVerdict,
    TaricProposalInput,
    WorkRun,
} from "../../core/src/taric"
import { deriveCompositeProjectKey, validateAuthorizedProjectSetup } from "../../core/src/index"

type ApiRequest = Request & { params: Record<string, string> }
type ApiHandler = (req: ApiRequest) => Response | Promise<Response>
type ProposalState = "candidate" | "admitted" | "rejected" | "needs_evidence"
type GovernanceCloseResult = Awaited<ReturnType<AuthorizedPentestGovernance["close"]>>

interface GovernanceApiSession {
    setup: AuthorizedProjectSetup
    assertActionAllowed(request: EgressRequest): ReturnType<AuthorizedPentestGovernance["assertActionAllowed"]>
    createReportSnapshot(): Promise<ReportSnapshot>
    claimWork(workItemId: string, ownerOrTargetResourceId: string, targetResourceId?: string): Promise<WorkRun>
    transitionWork(runId: string, owner: string, generation: number, status: "running" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled"): Promise<void>
    commitCheckpoint(state: CheckpointState, owner?: string): Promise<unknown>
    commitArtifact(input: { bytes: Uint8Array; mediaType: string; redacted?: boolean; workRunId?: string; attemptId?: string; generation?: number }): Promise<ArtifactMetadata>
    captureObservation(input: { resourceRef: string; statement: string; artifactRefs?: Array<{ content_ref: string }>; workRunId: string; generation: number }): ReturnType<AuthorizedPentestGovernance["captureObservation"]>
    submitCandidateProposal(input: TaricProposalInput): Promise<unknown>
    recordCoverage(cellId: string, input: { expectedVersion: number; status: CoverageStatus; evidenceRefs?: readonly string[]; justification?: string }, actor?: "host" | "operator"): ReturnType<AuthorizedPentestGovernance["recordCoverage"]>
    listProposals(input?: { cursor?: string; pageSize?: number; maxPages?: number }): Promise<unknown>
    submitReview(input: ReviewSubmission): Promise<ReviewDecision>
    admit(proposalId: string, policyDigest: string): Promise<unknown>
    close(input: CloseRequest): ReturnType<AuthorizedPentestGovernance["close"]>
    /** Rebuildable authority projection; legacy test doubles may omit it. */
    rebuildProjection?(options?: { contextBudget?: number }): Promise<unknown>
    reconcileProjection?(localProjection?: Record<string, unknown>): Promise<unknown>
}

interface SessionRecord {
    id: string
    createdAt: string
    governance: GovernanceApiSession
    closed?: GovernanceCloseResult
    activeRuns: Map<string, WorkRun>
}

export interface RestoredGovernanceSession {
    setup: AuthorizedProjectSetup
    governance: GovernanceApiSession
    createdAt?: string
    closed?: GovernanceCloseResult
    activeRuns?: WorkRun[]
}

type LocalFixtureVerificationClassifier = (proposal: Readonly<Record<string, unknown>>) => boolean

export interface TaricGovernanceRoutesOptions {
    resolvePolicyDigest(): string | Promise<string>
    createGovernance(setup: AuthorizedProjectSetup, sessionId: string): Promise<GovernanceApiSession>
    registerDiscovery?(setup: AuthorizedProjectSetup, sessionId: string): Promise<void>
    /** Trusted host configuration may identify deterministic local verification records. */
    isLocalFixtureVerification?: LocalFixtureVerificationClassifier
    /** Rebuild a session from canonical Taric records after a process restart. */
    loadSession?(sessionId: string): Promise<RestoredGovernanceSession | undefined>
    /** Enumerate durable session locators for the Web list after a restart. */
    listSessionIds?(): Promise<string[]>
}

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_GOVERNANCE_CURSOR_CHARS = 64 * 1024

class ApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `${name} is required`)
    return value.trim()
}

function errorResponse(error: unknown): Response {
    if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status })
    // Upstream errors may contain credentials or payload fragments. Project
    // bounded host-owned codes instead of reflecting arbitrary error text.
    if (isRecord(error) && error.code === "egress_denied") return Response.json({ error: "action is outside the authorized policy", code: "egress_denied" }, { status: 403 })
    if (isRecord(error) && error.outcome === "rejected_validation") return Response.json({ error: "governance request failed validation", code: "rejected_validation" }, { status: 400 })
    if (isRecord(error) && ["conflict", "stale_version", "stale_generation", "stale_checkpoint", "coverage_conflict", "report_snapshot_stale"].includes(String(error.code))) return Response.json({ error: "governance state changed; refresh before retrying", code: error.code }, { status: 409 })
    if (isRecord(error) && error.code === "TARIC_CONTROL_PLANE_CONTRACT_BLOCKED") return Response.json({ error: "pinned Taric contract cannot represent all required governance facts", code: "TARIC_CONTROL_PLANE_CONTRACT_BLOCKED" }, { status: 503 })
    if (isRecord(error) && (error.outcome === "rejected_authorization" || error.code === "TARIC_UNAVAILABLE")) return Response.json({ error: "governance authority is unavailable or access is denied", code: "governance_unavailable" }, { status: 503 })
    return Response.json({ error: "governance authority request failed", code: "authority_request_failed" }, { status: 502 })
}

function artifactMetadataResponse(metadata: ArtifactMetadata) {
    return {
        artifactId: metadata.artifactId,
        contentRef: metadata.contentRef,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        manifestHash: metadata.manifestHash,
        mediaType: metadata.mediaType,
        committedAt: metadata.committedAt,
        redacted: metadata.redacted,
        contentStatus: metadata.contentStatus,
        workRunId: metadata.workRunId,
        attemptId: metadata.attemptId,
        generation: metadata.generation,
        resourceId: metadata.resourceId,
        resourceRevision: metadata.resourceRevision,
        scopeRevision: metadata.scopeRevision,
    }
}

function decodeArtifactBase64(value: unknown): Uint8Array {
    if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) {
        throw new ApiError(400, "dataBase64 is required and must be within the artifact size limit")
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ApiError(400, "dataBase64 must be valid base64")
    const bytes = new Uint8Array(Buffer.from(value, "base64"))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new ApiError(413, "artifact size is outside the configured bound")
    return bytes
}

function unwrapPage(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new ApiError(502, "Taric returned an invalid proposal page")
    const data = isRecord(value.data) ? value.data : value
    return data
}

function authorityState(value: unknown): ProposalState {
    if (value === "admitted" || value === "accepted") return "admitted"
    if (value === "rejected") return "rejected"
    if (value === "needs_evidence" || value === "needs-evidence") return "needs_evidence"
    return "candidate"
}

interface AuthorityProposalProjection {
    state: ProposalState
    trustLevel?: "L0" | "L1" | "L2"
    canonicalId?: string
    evidenceClass?: "local_fixture"
}

/**
 * Derive the trust projection from the authority proposal envelope. Missing
 * fields remain unknown; local API response state never grants authority.
 */
export function authorityProposalProjection(value: Record<string, unknown>, isLocalFixtureVerification?: LocalFixtureVerificationClassifier): AuthorityProposalProjection {
    // Proposal content is model-controlled. Only authority envelope fields may
    // describe admission or independent verification.
    const rawStatus = value.status
    const state = authorityState(rawStatus)
    const canonicalId = typeof value.canonical_id === "string" && value.canonical_id.trim()
        ? value.canonical_id
        : undefined
    const explicitTrust = value.trust_level === "L0" || value.trust_level === "L1" || value.trust_level === "L2"
        ? value.trust_level
        : undefined
    const rawTrustPhase = value.trust_phase
    const trustPhase = rawTrustPhase === "independently_verified" || rawTrustPhase === "machine_approved" || rawTrustPhase === "proposal"
        ? rawTrustPhase
        : undefined
    const trustLevel = state === "admitted"
        ? canonicalId && (explicitTrust === "L2" || trustPhase === "independently_verified") ? "L2" : "L1"
        : "L0"
    const evidenceClass = trustLevel === "L2" && isLocalFixtureVerification?.(value) ? "local_fixture" : undefined
    return { state, ...(trustLevel ? { trustLevel } : {}), ...(canonicalId ? { canonicalId } : {}), ...(evidenceClass ? { evidenceClass } : {}) }
}

function reviewState(verdict: ReviewVerdict): ProposalState {
    if (verdict === "reject") return "rejected"
    if (verdict === "needs_evidence" || verdict === "defer") return "needs_evidence"
    return "candidate"
}

function selectedProposal(session: SessionRecord, value: unknown, isLocalFixtureVerification?: LocalFixtureVerificationClassifier): Record<string, unknown> | undefined {
    if (!isRecord(value)) return
    const content = isRecord(value.content) ? value.content : {}
    const title = typeof value.title === "string" ? value.title : typeof content.title === "string" ? content.title : ""
    const projectKey = deriveCompositeProjectKey(session.governance.setup.project)
    if (!title.startsWith(`BreachWeave [${projectKey}] `)) return
    const id = typeof value.id === "string" ? value.id : typeof content.id === "string" ? content.id : undefined
    if (!id) return
    const projection = authorityProposalProjection(value, isLocalFixtureVerification)
    return {
        id,
        title,
        ...(typeof value.subject_type === "string" ? { subject_type: value.subject_type } : {}),
        ...(typeof value.status === "string" ? { authority_status: value.status } : {}),
        ...(typeof value.created_at === "string" ? { created_at: value.created_at } : {}),
        ...(typeof value.updated_at === "string" ? { updated_at: value.updated_at } : {}),
        // The authority status is the only read source. If Taric omits it,
        // authorityState conservatively reports candidate and trust stays
        // unknown rather than consulting process-local mutation history.
        state: projection.state,
        ...(projection.trustLevel ? { trustLevel: projection.trustLevel } : {}),
        ...(projection.canonicalId ? { canonicalId: projection.canonicalId } : {}),
        ...(projection.evidenceClass ? { evidenceClass: projection.evidenceClass } : {}),
    }
}

async function proposalPage(session: SessionRecord, cursor?: string, pageSize = 50, isLocalFixtureVerification?: LocalFixtureVerificationClassifier) {
    if (cursor !== undefined && (!cursor.trim() || cursor.length > MAX_GOVERNANCE_CURSOR_CHARS)) throw new ApiError(400, "proposal cursor is invalid")
    const raw = await session.governance.listProposals({ cursor, pageSize, maxPages: 1 })
    const page = unwrapPage(raw)
    const proposals = page.proposals
    if (!Array.isArray(proposals)) throw new ApiError(502, "Taric returned an invalid proposal page")
    const items = proposals.flatMap((proposal) => {
        const selected = selectedProposal(session, proposal, isLocalFixtureVerification)
        return selected ? [selected] : []
    })
    const nextCursor = page.next_cursor
    if (nextCursor !== undefined && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > MAX_GOVERNANCE_CURSOR_CHARS)) {
        throw new ApiError(502, "Taric returned an invalid proposal cursor")
    }
    const rawDiagnostics = page.diagnostics
    const diagnostics = isRecord(rawDiagnostics)
        ? {
            ...(["complete", "unpinned", "truncated", "failed"].includes(String(rawDiagnostics.status)) ? { status: rawDiagnostics.status } : {}),
            ...(Number.isSafeInteger(rawDiagnostics.pages) && Number(rawDiagnostics.pages) >= 0 ? { pages: rawDiagnostics.pages } : {}),
            ...(Number.isSafeInteger(rawDiagnostics.records) && Number(rawDiagnostics.records) >= 0 ? { records: rawDiagnostics.records } : {}),
            ...(Number.isSafeInteger(rawDiagnostics.bytes) && Number(rawDiagnostics.bytes) >= 0 ? { bytes: rawDiagnostics.bytes } : {}),
            ...(typeof rawDiagnostics.snapshotPinned === "boolean" ? { snapshotPinned: rawDiagnostics.snapshotPinned } : {}),
            ...(typeof rawDiagnostics.hasMore === "boolean" ? { hasMore: rawDiagnostics.hasMore } : {}),
            ...(typeof rawDiagnostics.continuationSafe === "boolean" ? { continuationSafe: rawDiagnostics.continuationSafe } : {}),
            ...(typeof rawDiagnostics.reconnectRequired === "boolean" ? { reconnectRequired: rawDiagnostics.reconnectRequired } : {}),
            ...(Number.isSafeInteger(rawDiagnostics.readSeq) && Number(rawDiagnostics.readSeq) >= 0 ? { readSeq: rawDiagnostics.readSeq } : {}),
        }
        : undefined
    return {
        proposals: items,
        readSeq: Number.isSafeInteger(page.read_seq) && Number(page.read_seq) >= 0 ? Number(page.read_seq) : undefined,
        ...(typeof nextCursor === "string" ? { nextCursor } : {}),
        ...(diagnostics ? { readDiagnostics: diagnostics } : {}),
    }
}

async function assertProjectProposal(session: SessionRecord, proposalId: string, isLocalFixtureVerification?: LocalFixtureVerificationClassifier): Promise<void> {
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = await proposalPage(session, cursor, 50, isLocalFixtureVerification)
        if (page.proposals.some((proposal) => proposal.id === proposalId)) return
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) break
        seenCursors.add(page.nextCursor)
        cursor = page.nextCursor
    }
    throw new ApiError(404, "proposal not found in this project")
}

async function requireAuthorityProposal(session: SessionRecord, proposalId: string, isLocalFixtureVerification?: LocalFixtureVerificationClassifier): Promise<Record<string, unknown>> {
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const page = await proposalPage(session, cursor, 50, isLocalFixtureVerification)
        const proposal = page.proposals.find((item) => item.id === proposalId)
        if (proposal) return proposal
        if (!page.nextCursor || seenCursors.has(page.nextCursor)) break
        seenCursors.add(page.nextCursor)
        cursor = page.nextCursor
    }
    throw new ApiError(409, "proposal authority state is not available; refresh before retrying")
}

export function createTaricGovernanceRoutes(options: TaricGovernanceRoutesOptions): Record<string, Record<string, ApiHandler>> {
    const sessions = new Map<string, SessionRecord>()

    async function requireSession(sessionId: string): Promise<SessionRecord> {
        const existing = sessions.get(sessionId)
        if (existing) return existing
        const restored = await options.loadSession?.(sessionId)
        if (!restored) throw new ApiError(404, "governance session not found in authority")
        const session: SessionRecord = {
            id: sessionId,
            createdAt: restored.createdAt ?? new Date().toISOString(),
            governance: restored.governance,
            ...(restored.closed ? { closed: restored.closed } : {}),
            activeRuns: new Map((restored.activeRuns ?? []).map((run) => [run.runId, run])),
        }
        sessions.set(sessionId, session)
        return session
    }

    return {
        "/api/taric/governance/sessions": {
            async GET() {
                try {
                    const restoredIds = await options.listSessionIds?.() ?? []
                    await Promise.all(restoredIds.filter((id) => !sessions.has(id)).map(async (id) => {
                        try { await requireSession(id) } catch { /* an unavailable authority session is omitted */ }
                    }))
                    const rows = await Promise.all([...sessions.values()].map(async (session) => {
                        const proposals = await proposalPage(session, undefined, 50, options.isLocalFixtureVerification)
                        return {
                            sessionId: session.id,
                            createdAt: session.createdAt,
                            tenantId: session.governance.setup.project.tenant_id,
                            engagementId: session.governance.setup.project.engagement_id,
                            closed: Boolean(session.closed),
                            proposals: proposals.proposals,
                            ...(proposals.readSeq !== undefined ? { proposalReadSeq: proposals.readSeq } : {}),
                            ...(proposals.nextCursor ? { proposalNextCursor: proposals.nextCursor } : {}),
                            ...(proposals.readDiagnostics ? { proposalReadDiagnostics: proposals.readDiagnostics } : {}),
                            ...(session.closed ? { close: session.closed, reportSnapshot: session.closed.snapshot } : {}),
                        }
                    }))
                    return Response.json({ sessions: rows })
                } catch (error) {
                    return errorResponse(error)
                }
            },
            async POST(req) {
                try {
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body) || !isRecord(body.setup)) throw new ApiError(400, "setup is required")
                    const policyDigest = await options.resolvePolicyDigest()
                    const setup = validateAuthorizedProjectSetup({ ...body.setup, policyDigest } as AuthorizedProjectSetup)
                    if (setup.project.engagement_id !== setup.project.taric_engagement_id) {
                        throw new ApiError(400, "authorized project Engagement must match the Taric Engagement")
                    }
                    const id = randomUUID()
                    const governance = await options.createGovernance(setup, id)
                    await options.registerDiscovery?.(setup, id)
                    const session: SessionRecord = { id, createdAt: new Date().toISOString(), governance, activeRuns: new Map() }
                    sessions.set(id, session)
                    return Response.json({ sessionId: id, createdAt: session.createdAt, projectId: deriveCompositeProjectKey(setup.project) }, { status: 201 })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId": {
            async GET(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    const [reportSnapshot, proposals] = await Promise.all([
                        session.closed ? Promise.resolve(session.closed.snapshot) : session.governance.createReportSnapshot(),
                        proposalPage(session, new URL(req.url).searchParams.get("cursor") ?? undefined, 50, options.isLocalFixtureVerification),
                    ])
                    const projection = session.governance.rebuildProjection ? await session.governance.rebuildProjection() : undefined
                    return Response.json({
                        sessionId: session.id,
                        createdAt: session.createdAt,
                        closed: Boolean(session.closed),
                        reportSnapshot,
                        ...(session.closed ? { close: session.closed } : {}),
                        ...(projection !== undefined ? { projection } : {}),
                        ...proposals,
                    })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/projection": {
            async GET(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (!session.governance.rebuildProjection) throw new ApiError(503, "authority projection is unavailable")
                    const budgetText = new URL(req.url).searchParams.get("context_budget")
                    const contextBudget = budgetText === null ? undefined : Number(budgetText)
                    if (contextBudget !== undefined && (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 50_000)) throw new ApiError(400, "context_budget is invalid")
                    const projection = await session.governance.rebuildProjection(contextBudget === undefined ? {} : { contextBudget })
                    return Response.json(projection)
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/authorize-action": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "action body must be an object")
                    if (body.at !== undefined) throw new ApiError(400, "action time is host-controlled")
                    const url = requiredText(body.url, "url")
                    const stringList = (value: unknown, field: string): string[] | undefined => {
                        if (value === undefined) return
                        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(400, `${field} must be an array of strings`)
                        return value as string[]
                    }
                    const resolvedAddresses = stringList(body.resolvedAddresses, "resolvedAddresses")
                    const redirectChain = stringList(body.redirectChain, "redirectChain")
                    const action: EgressRequest = {
                        url,
                        ...(resolvedAddresses ? { resolvedAddresses } : {}),
                        ...(redirectChain ? { redirectChain } : {}),
                    }
                    const decision: PolicyDecision = await session.governance.assertActionAllowed(action)
                    return Response.json({ ...decision, enforcement: "preflight_only" })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/work-runs": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "work run body must be an object")
                    const workItemId = requiredText(body.workItemId, "workItemId")
                    const targetResourceId = requiredText(body.targetResourceId, "targetResourceId")
                    const run = await session.governance.claimWork(workItemId, targetResourceId)
                    session.activeRuns.set(run.runId, run)
                    const { owner: _owner, ...publicRun } = run
                    return Response.json(publicRun, { status: 201 })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/work-runs/:runId/transition": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const run = session.activeRuns.get(req.params.runId)
                    if (!run) throw new ApiError(404, "active work run not found")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "transition body must be an object")
                    const status = body.status
                    const allowedStatuses = ["running", "checkpointed", "blocked", "completed", "failed", "cancelled"] as const
                    if (typeof status !== "string" || !allowedStatuses.includes(status as typeof allowedStatuses[number])) throw new ApiError(400, "work run status is invalid")
                    await session.governance.transitionWork(run.runId, run.owner, run.generation, status as typeof allowedStatuses[number])
                    if (["completed", "failed", "cancelled"].includes(status)) session.activeRuns.delete(run.runId)
                    return Response.json({ ok: true, runId: run.runId, status })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/checkpoints": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "checkpoint body must be an object")
                    const workRunId = requiredText(body.workRunId, "workRunId")
                    const run = session.activeRuns.get(workRunId)
                    if (!run) throw new ApiError(404, "active work run not found")
                    if (body.generation !== run.generation) throw new ApiError(409, "checkpoint generation does not match the active work run")
                    const stringList = (value: unknown, field: string): string[] => {
                        if (value === undefined) return []
                        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(400, `${field} must be an array of strings`)
                        return value as string[]
                    }
                    if (!Number.isSafeInteger(body.sourceReadSeq) || Number(body.sourceReadSeq) < 0) throw new ApiError(400, "sourceReadSeq must be a non-negative integer")
                    const checkpoint: CheckpointState = {
                        workRunId,
                        attemptId: run.attemptId,
                        generation: run.generation,
                        completedSteps: stringList(body.completedSteps, "completedSteps"),
                        nextSteps: stringList(body.nextSteps, "nextSteps"),
                        observationRefs: stringList(body.observationRefs, "observationRefs"),
                        evidenceRefs: stringList(body.evidenceRefs, "evidenceRefs"),
                        unresolvedWork: stringList(body.unresolvedWork, "unresolvedWork"),
                        sourceReadSeq: Number(body.sourceReadSeq),
                    }
                    const result = await session.governance.commitCheckpoint(checkpoint, run.owner)
                    return Response.json(result)
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/artifacts": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "artifact body must be an object")
                    const bytes = decodeArtifactBase64(body.dataBase64)
                    if (body.redacted !== undefined && typeof body.redacted !== "boolean") throw new ApiError(400, "redacted must be boolean")
                    if (body.workRunId !== undefined && typeof body.workRunId !== "string") throw new ApiError(400, "workRunId must be a string")
                    if (body.attemptId !== undefined && typeof body.attemptId !== "string") throw new ApiError(400, "attemptId must be a string")
                    if (body.generation !== undefined && (!Number.isSafeInteger(body.generation) || Number(body.generation) < 1)) throw new ApiError(400, "generation must be a positive integer")
                    const metadata = await session.governance.commitArtifact({
                        bytes,
                        mediaType: requiredText(body.mediaType, "mediaType"),
                        ...(typeof body.redacted === "boolean" ? { redacted: body.redacted } : {}),
                        ...(typeof body.workRunId === "string" ? { workRunId: body.workRunId } : {}),
                        ...(typeof body.attemptId === "string" ? { attemptId: body.attemptId } : {}),
                        ...(Number.isSafeInteger(body.generation) ? { generation: Number(body.generation) } : {}),
                    })
                    return Response.json(artifactMetadataResponse(metadata), { status: 201 })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/observations": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "observation body must be an object")
                    const artifactRefs = body.artifactRefs
                    if (artifactRefs !== undefined && !Array.isArray(artifactRefs)) throw new ApiError(400, "artifactRefs must be an array")
                    const refs = (artifactRefs as unknown[] | undefined)?.map((ref) => {
                        if (typeof ref === "string") return { content_ref: ref }
                        if (isRecord(ref) && typeof ref.content_ref === "string") return { content_ref: ref.content_ref }
                        throw new ApiError(400, "artifactRefs must contain committed content references")
                    })
                    if (!Number.isSafeInteger(body.generation) || Number(body.generation) < 1) throw new ApiError(400, "generation must be a positive integer")
                    const result = await session.governance.captureObservation({
                        resourceRef: requiredText(body.resourceRef, "resourceRef"),
                        statement: requiredText(body.statement, "statement"),
                        ...(refs ? { artifactRefs: refs } : {}),
                        workRunId: requiredText(body.workRunId, "workRunId"),
                        generation: Number(body.generation),
                    })
                    return Response.json(result)
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/proposals": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body) || !isRecord(body.content)) throw new ApiError(400, "candidate content is required")
                    if (body.subjectType !== "claim" && body.subjectType !== "test_hypothesis") throw new ApiError(400, "subjectType must be claim or test_hypothesis")
                    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new ApiError(400, "expectedVersion must be a non-negative integer")
                    const projectKey = deriveCompositeProjectKey(session.governance.setup.project)
                    const title = typeof body.content.title === "string" ? body.content.title : "candidate"
                    const prefix = `BreachWeave [${projectKey}] `
                    const content = { ...body.content, title: title.startsWith(prefix) ? title : `${prefix}${title}` }
                    const result = await session.governance.submitCandidateProposal({
                        eventId: typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : randomUUID(),
                        subjectType: body.subjectType,
                        expectedVersion: Number(body.expectedVersion),
                        content,
                        ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
                    })
                    const page = unwrapPage(result)
                    const proposalId = typeof page.id === "string" ? page.id : undefined
                    return Response.json({ result, ...(proposalId ? { proposalId } : {}), state: "candidate", trustLevel: "L0" }, { status: 201 })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/coverage/:cellId": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const cellId = requiredText(req.params.cellId, "cellId")
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "coverage body must be an object")
                    const expectedVersion = body.expectedVersion
                    const status = body.status
                    const validStatuses: CoverageStatus[] = ["not_tested", "queued", "in_progress", "tested_no_observation", "positive", "inconclusive", "blocked", "blocked_by_control", "not_applicable"]
                    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) throw new ApiError(400, "expectedVersion must be a non-negative integer")
                    if (typeof status !== "string" || !validStatuses.includes(status as CoverageStatus)) throw new ApiError(400, "coverage status is invalid")
                    if (body.evidenceRefs !== undefined && (!Array.isArray(body.evidenceRefs) || body.evidenceRefs.some((item) => typeof item !== "string"))) throw new ApiError(400, "evidenceRefs must be strings")
                    if (body.justification !== undefined && typeof body.justification !== "string") throw new ApiError(400, "justification must be a string")
                    const cell = await session.governance.recordCoverage(cellId, {
                        expectedVersion: Number(expectedVersion),
                        status: status as CoverageStatus,
                        ...(Array.isArray(body.evidenceRefs) ? { evidenceRefs: body.evidenceRefs as string[] } : {}),
                        ...(typeof body.justification === "string" ? { justification: body.justification } : {}),
                    }, "host")
                    return Response.json(cell)
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/proposals/:proposalId/review": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const proposalId = requiredText(req.params.proposalId, "proposalId")
                    await assertProjectProposal(session, proposalId, options.isLocalFixtureVerification)
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "review body must be an object")
                    const verdict = body.verdict
                    if (verdict !== "pass" && verdict !== "reject" && verdict !== "needs_evidence" && verdict !== "defer") {
                        throw new ApiError(400, "verdict must be pass, reject, needs_evidence, or defer")
                    }
                    const inputHash = requiredText(body.inputHash, "inputHash")
                    const evidenceSnapshotHash = requiredText(body.evidenceSnapshotHash, "evidenceSnapshotHash")
                    const decision = await session.governance.submitReview({
                        proposalId,
                        verdict,
                        inputHash,
                        evidenceSnapshotHash,
                        policyDigest: session.governance.setup.policyDigest,
                    })
                    const state = reviewState(verdict)
                    return Response.json({ decision, state })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/proposals/:proposalId/admit": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) throw new ApiError(409, "governance session is closed")
                    const proposalId = requiredText(req.params.proposalId, "proposalId")
                    await assertProjectProposal(session, proposalId, options.isLocalFixtureVerification)
                    const result = await session.governance.admit(proposalId, session.governance.setup.policyDigest)
                    const proposal = await requireAuthorityProposal(session, proposalId, options.isLocalFixtureVerification)
                    return Response.json({
                        proposalId,
                        result,
                        state: proposal.state,
                        ...(typeof proposal.trustLevel === "string" ? { trustLevel: proposal.trustLevel } : {}),
                        ...(typeof proposal.canonicalId === "string" ? { canonicalId: proposal.canonicalId } : {}),
                        ...(typeof proposal.evidenceClass === "string" ? { evidenceClass: proposal.evidenceClass } : {}),
                        ...(typeof proposal.authority_status === "string" ? { authorityStatus: proposal.authority_status } : {}),
                    })
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
        "/api/taric/governance/sessions/:sessionId/close": {
            async POST(req) {
                try {
                    const session = await requireSession(req.params.sessionId)
                    if (session.closed) return Response.json(session.closed)
                    const body = await req.json().catch(() => ({}))
                    if (!isRecord(body)) throw new ApiError(400, "close body must be an object")
                    const reportDigest = body.reportDigest === undefined ? undefined : requiredText(body.reportDigest, "reportDigest")
                    if (body.residualRisks !== undefined && (!Array.isArray(body.residualRisks) || body.residualRisks.some((item) => typeof item !== "string"))) throw new ApiError(400, "residualRisks must be an array of strings")
                    if (body.disclosures !== undefined && (!Array.isArray(body.disclosures) || body.disclosures.some((item) => typeof item !== "string"))) throw new ApiError(400, "disclosures must be an array of strings")
                    const close = await session.governance.close({
                        ...(reportDigest ? { reportDigest } : {}),
                        ...(Array.isArray(body.residualRisks) ? { residualRisks: body.residualRisks as string[] } : {}),
                        ...(Array.isArray(body.disclosures) ? { disclosures: body.disclosures as string[] } : {}),
                    })
                    session.closed = close
                    return Response.json(close)
                } catch (error) {
                    return errorResponse(error)
                }
            },
        },
    }
}

export async function loadLocalGovernanceArtifactKey(configDir: string, sessionId: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requiredText(sessionId, "sessionId"))) {
        throw new ApiError(400, "sessionId must be a UUID")
    }
    const keyDir = resolve(configDir, "taric", "governance-keys")
    await mkdir(keyDir, { recursive: true, mode: 0o700 })
    await chmod(keyDir, 0o700)
    const keyPath = resolve(keyDir, `${sessionId}.key`)
    const file = Bun.file(keyPath)
    if (await file.exists()) {
        const key = new Uint8Array(await file.arrayBuffer())
        if (key.byteLength !== 32) throw new ApiError(500, "local governance artifact key is invalid")
        return key
    }
    const key = new Uint8Array(randomBytes(32))
    await Bun.write(keyPath, key)
    await chmod(keyPath, 0o600)
    return key
}

export function localGovernanceArtifactRoot(configDir: string, sessionId: string): string {
    return resolve(configDir, "taric", "governance-artifacts", sessionId)
}
