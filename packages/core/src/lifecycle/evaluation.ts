export type LifecycleEvaluationStatus = "accepted" | "rejected" | "pending" | "indeterminate" | "reconciled" | "stale" | "blocked" | "decision_needed"

export interface LifecycleEvaluationEvidence {
    id: string
    profile: "development" | "test" | "governed-production"
    backend: "in_memory" | "fixture_gateway" | "local_sqlite" | "taric_authority"
    scenario: string
    status: LifecycleEvaluationStatus
    operations: readonly string[]
    durableState: Readonly<Record<string, unknown>>
    limitations: readonly string[]
    createdAt: string
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} 不能为空`)
    return value.trim()
}

export function createLifecycleEvaluationEvidence(input: Omit<LifecycleEvaluationEvidence, "id" | "createdAt"> & { id?: string }): LifecycleEvaluationEvidence {
    return Object.freeze({
        id: input.id?.trim() || `evaluation:${crypto.randomUUID()}`,
        profile: input.profile,
        backend: input.backend,
        scenario: text(input.scenario, "scenario"),
        status: input.status,
        operations: Object.freeze(input.operations.map((operation) => text(operation, "operation"))),
        durableState: structuredClone(input.durableState),
        limitations: Object.freeze(input.limitations.map((limitation) => text(limitation, "limitation"))),
        createdAt: new Date().toISOString(),
    })
}

export async function archiveLifecycleEvaluation(path: string, evidence: LifecycleEvaluationEvidence): Promise<void> {
    const target = text(path, "path")
    await Bun.write(target, `${JSON.stringify(evidence, null, 2)}\n`)
}

export async function readLifecycleEvaluation(path: string): Promise<LifecycleEvaluationEvidence> {
    const value = await Bun.file(text(path, "path")).json()
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("评估证据格式无效")
    const record = value as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.scenario !== "string" || !Array.isArray(record.operations) || !Array.isArray(record.limitations)) throw new TypeError("评估证据字段不完整")
    return record as unknown as LifecycleEvaluationEvidence
}
