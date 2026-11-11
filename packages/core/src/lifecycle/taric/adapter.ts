import { checkLifecycleCompatibility, operationContract, rejectLegacyLifecycleWrite, assertLifecycleCompatibility, type CompatibilityStatus, type LifecycleAdapterKind, type LifecycleOperation, type LifecycleProfile, type CompatibilityTuple } from "./compatibility"

export type LifecyclePrincipal = "model" | "host" | "reviewer" | "writer"
export type WatermarkDomain = "authority" | "execution" | "catalog" | "index" | "evidence" | "history"
export interface TaricLifecycleFence { assignmentId: string; runId: string; generation: number; epoch: number; scopeRevision: number; leaseToken: string; terminalGate: boolean; budgetDigest: string; effectId: string }
export interface LifecycleOperationRequest { operation: LifecycleOperation; principal: LifecyclePrincipal; idempotencyKey: string; payloadHash: string; fence?: TaricLifecycleFence; expectedRevision?: number; readWatermarks?: Partial<Record<WatermarkDomain, number>>; payload: Record<string, unknown> }
export interface LifecycleResultData { payloadHash?: string; [key: string]: unknown }
export interface TaricLifecycleOperationResult { status: "accepted" | "replayed" | "pending" | "unknown" | "rejected"; operation: LifecycleOperation; operationKey: string; result?: LifecycleResultData; diagnostics?: readonly string[]; watermarks: Readonly<Record<WatermarkDomain, number>> }
export type LifecycleOperationResult = TaricLifecycleOperationResult
export type LifecycleFence = TaricLifecycleFence
export interface TaricLifecycleAdapter { readonly profile: CompatibilityStatus; invoke(request: LifecycleOperationRequest): Promise<TaricLifecycleOperationResult>; read(operation: LifecycleOperation, principal: LifecyclePrincipal, payload: Record<string, unknown>): Promise<unknown>; reconcile(operationKey: string): Promise<TaricLifecycleOperationResult | undefined>; watermarks(): Readonly<Record<WatermarkDomain, number>>; close(): Promise<void> }

export interface WorkerDispatchRequest { operation: "lifecycle.model.request" | "lifecycle.tool.dispatch"; principal: "model" | "host"; fence: TaricLifecycleFence; payload: Record<string, unknown>; payloadHash: string; idempotencyKey: string }

/** WorkerHarness 在每次真正调用 Pi/Tool Gateway 前重检所有边界。 */
export class WorkerHarness {
    constructor(private readonly adapter: TaricLifecycleAdapter, private currentFence: TaricLifecycleFence) {}
    updateFence(fence: TaricLifecycleFence): void { this.currentFence = { ...fence } }
    async dispatch(request: WorkerDispatchRequest): Promise<TaricLifecycleOperationResult> { assertLifecycleFence({ ...request }, this.currentFence); if (request.fence.terminalGate) throw new Error("terminal_gate_closed"); if (request.fence.effectId.length === 0 || request.fence.budgetDigest.length === 0) throw new Error("effect_or_budget_identity_missing"); return this.adapter.invoke({ operation: request.operation, principal: request.principal, idempotencyKey: request.idempotencyKey, payloadHash: request.payloadHash, payload: request.payload, fence: request.fence }) }
}

function hash(value: unknown): string { return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}` }
function text(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 无效`); return value.trim() }

export function createDeterministicTaricLifecycleAdapter(options: { profile?: LifecycleProfile; adapter?: LifecycleAdapterKind; compatibility?: Partial<CompatibilityTuple> } = {}): TaricLifecycleAdapter {
    const status = checkLifecycleCompatibility({ profile: options.profile ?? "test", adapter: options.adapter ?? "in_memory", actual: options.compatibility }); assertLifecycleCompatibility(status); const records = new Map<string, { hash: string; result: TaricLifecycleOperationResult }>(); const wm: Record<WatermarkDomain, number> = { authority: 0, execution: 0, catalog: 0, index: 0, evidence: 0, history: 0 }
    return {
        profile: status,
        async invoke(request) {
            if ("localStore" in request.payload || "rpcMethod" in request.payload || "sidecar" in request.payload) return { status: "rejected", operation: request.operation, operationKey: String(request.idempotencyKey), diagnostics: ["legacy_write_rejected"], watermarks: { ...wm } }
            const contract = operationContract(request.operation); if (!contract.roles.includes(request.principal as never)) return { status: "rejected", operation: request.operation, operationKey: text(request.idempotencyKey, "idempotencyKey"), diagnostics: ["principal_not_authorized"], watermarks: { ...wm } }
            const operationKey = text(request.idempotencyKey, "idempotencyKey"); const bodyHash = hash(request.payload); if (bodyHash !== request.payloadHash) return { status: "rejected", operation: request.operation, operationKey, diagnostics: ["payload_hash_mismatch"], watermarks: { ...wm } }
            if (request.fence && request.fence.terminalGate && /(?:launch|continue|dispatch|board\.patch)/.test(request.operation)) return { status: "rejected", operation: request.operation, operationKey, diagnostics: ["terminal_gate_closed"], watermarks: { ...wm } }
            const previous = records.get(operationKey); if (previous) { if (previous.hash !== hash(request.payload)) return { status: "rejected", operation: request.operation, operationKey, diagnostics: ["idempotency_conflict"], watermarks: { ...wm } }; if (!contract.idempotent) return { status: "unknown", operation: request.operation, operationKey, diagnostics: ["reconcile_before_replay"], watermarks: { ...wm } }; return { ...previous.result, status: "replayed" } }
            if (contract.mutates) wm.authority += 1
            if (/report|review|finalization|close/.test(request.operation)) wm.evidence += 1
            if (/history|context/.test(request.operation)) wm.history += 1
            if (/board/.test(request.operation)) wm.catalog += 1
            const result: TaricLifecycleOperationResult = { status: "accepted", operation: request.operation, operationKey, result: { committed: true, payloadHash: bodyHash }, watermarks: { ...wm } }; records.set(operationKey, { hash: bodyHash, result }); return result
        },
        async read(operation, principal, payload) { const contract = operationContract(operation); if (!contract.roles.includes(principal as never)) throw new Error("principal_not_authorized"); return { ...payload, watermarks: { ...wm } } },
        async reconcile(operationKey) { return records.get(operationKey)?.result },
        watermarks() { return { ...wm } },
        async close() { records.clear() },
    }
}

export function assertLifecycleFence(request: LifecycleOperationRequest, current: TaricLifecycleFence): void {
    if (!request.fence || request.fence.assignmentId !== current.assignmentId || request.fence.runId !== current.runId || request.fence.generation !== current.generation || request.fence.epoch !== current.epoch || request.fence.scopeRevision !== current.scopeRevision || request.fence.leaseToken !== current.leaseToken || request.fence.effectId !== current.effectId || request.fence.terminalGate !== current.terminalGate || request.fence.budgetDigest !== current.budgetDigest) throw new Error("stale_lifecycle_fence")
}

export function assertLifecycleWriteAuthority(operation: string, input?: Record<string, unknown>): void { if (!operation.startsWith("lifecycle.")) rejectLegacyLifecycleWrite(operation, input) }
