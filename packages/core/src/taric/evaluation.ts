export type EvaluationMode = "legacy_local" | "taric_best_effort" | "taric_required"

export interface TaricBenchmarkManifest {
    format: "breachweave-taric-benchmark/1"
    targetRevision: string
    challengeRevision: string
    model: string
    promptDigest: string
    toolImage: string
    timeBudgetSeconds: number
    tokenBudget: number
    concurrency: number
}

export interface TaricRunControls {
    manifest: TaricBenchmarkManifest
    mode: EvaluationMode
    runId: string
    startedAt: string
    endedAt?: string
    status: "passed" | "failed" | "excluded"
    failureCategory?: string
}

export interface TaricEvaluationMetrics {
    attempted: number
    accepted: number
    deferred: number
    rejectedValidation: number
    rejectedAuthorization: number
    failedPermanent: number
    indeterminate: number
    queryComplete: number
    queryPartial: number
    queryFailed: number
    evidenceLinked: number
    evidenceTraceable: number
    duplicateWork: number
    recoverySucceeded: number
    recoveryAttempted: number
    candidateReused: number
    candidatesAdmitted: number
    admissionLatencyMs: number[]
    taskOutcomes: number[]
    costUnits: number[]
}

export interface TaricEvaluationReport {
    format: "breachweave-taric-evaluation/1"
    evidenceClass: "automated_test" | "deployment_observation" | "paired_evaluation" | "case_study"
    manifest: TaricBenchmarkManifest
    profiles: readonly EvaluationMode[]
    runCount: number
    failedRuns: number
    excludedRuns: number
    causalClaimAllowed: boolean
    metrics: TaricEvaluationMetrics
    limitations: readonly string[]
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} contains control characters`)
    return value.trim()
}

function positiveInteger(value: unknown, field: string, max: number): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${field} must be an integer between 1 and ${max}`)
    return Number(value)
}

export function validateTaricBenchmarkManifest(input: TaricBenchmarkManifest): TaricBenchmarkManifest {
    if (!input || input.format !== "breachweave-taric-benchmark/1") throw new Error("unsupported Taric benchmark manifest format")
    return {
        format: input.format,
        targetRevision: text(input.targetRevision, "targetRevision"),
        challengeRevision: text(input.challengeRevision, "challengeRevision"),
        model: text(input.model, "model"),
        promptDigest: text(input.promptDigest, "promptDigest"),
        toolImage: text(input.toolImage, "toolImage"),
        timeBudgetSeconds: positiveInteger(input.timeBudgetSeconds, "timeBudgetSeconds", 86_400),
        tokenBudget: positiveInteger(input.tokenBudget, "tokenBudget", 100_000_000),
        concurrency: positiveInteger(input.concurrency, "concurrency", 256),
    }
}

function nonNegative(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`)
    return value
}

function total(values: readonly number[], field: string): number[] {
    return values.map((value, index) => {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${field}[${index}] must be non-negative`)
        return value
    })
}

export function buildTaricEvaluationReport(input: {
    manifest: TaricBenchmarkManifest
    runs: readonly TaricRunControls[]
    metrics: TaricEvaluationMetrics
}): TaricEvaluationReport {
    const manifest = validateTaricBenchmarkManifest(input.manifest)
    if (input.runs.length === 0) throw new Error("at least one evaluation run is required")
    const runs = input.runs.map((run) => {
        if (!run.runId.trim()) throw new Error("runId is required")
        if (run.manifest.targetRevision !== manifest.targetRevision || run.manifest.challengeRevision !== manifest.challengeRevision || run.manifest.model !== manifest.model || run.manifest.promptDigest !== manifest.promptDigest || run.manifest.toolImage !== manifest.toolImage || run.manifest.timeBudgetSeconds !== manifest.timeBudgetSeconds || run.manifest.tokenBudget !== manifest.tokenBudget || run.manifest.concurrency !== manifest.concurrency) {
            throw new Error(`run ${run.runId} does not match the benchmark manifest`)
        }
        if (!Number.isFinite(Date.parse(run.startedAt))) throw new Error(`run ${run.runId} has an invalid start time`)
        return run
    })
    const metrics = { ...input.metrics, admissionLatencyMs: total(input.metrics.admissionLatencyMs, "admissionLatencyMs"), taskOutcomes: total(input.metrics.taskOutcomes, "taskOutcomes"), costUnits: total(input.metrics.costUnits, "costUnits") }
    for (const [field, value] of Object.entries(metrics)) {
        if (Array.isArray(value)) continue
        nonNegative(value as number, field)
    }
    const profiles = [...new Set(runs.map((run) => run.mode))]
    const failedRuns = runs.filter((run) => run.status === "failed").length
    const excludedRuns = runs.filter((run) => run.status === "excluded").length
    const paired = profiles.includes("legacy_local") && profiles.some((profile) => profile !== "legacy_local")
    const repeatedByProfile = profiles.every((profile) => runs.filter((run) => run.mode === profile && run.status === "passed").length >= 2)
    const successfulRuns = runs.filter((run) => run.status === "passed").length
    const causalClaimAllowed = paired && repeatedByProfile && successfulRuns >= 4 && failedRuns === 0 && excludedRuns === 0
    const limitations = causalClaimAllowed
        ? []
        : ["Runs are unmatched, insufficient, failed, or excluded; describe the result as a case study and do not make a causal outcome claim."]
    return {
        format: "breachweave-taric-evaluation/1",
        evidenceClass: paired && causalClaimAllowed ? "paired_evaluation" : runs.length === 1 ? "case_study" : "deployment_observation",
        manifest,
        profiles,
        runCount: runs.length,
        failedRuns,
        excludedRuns,
        causalClaimAllowed,
        metrics,
        limitations,
    }
}
