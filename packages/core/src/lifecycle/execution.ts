import { Type, type Static } from "typebox"
import { LifecycleFenceError, LifecycleValidationError, canonicalJson, parseStrict, sha256Digest } from "./validation"

const Id = Type.String({ minLength: 1 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const NonNegative = Type.Integer({ minimum: 0 })
const Positive = Type.Integer({ minimum: 1 })

export const RoleResourceManifestSchema = Type.Object({
    manifestId: Id,
    role: Type.Union([Type.Literal("solver"), Type.Literal("reviewer"), Type.Literal("planner"), Type.Literal("board_observer"), Type.Literal("writer"), Type.Literal("qa")]),
    revision: Positive,
    promptSkillArtifactRefs: Type.Array(Id),
    toolSchemaBindings: Type.Array(Type.Object({ toolName: Id, inputSchemaHash: Digest, outputSchemaHash: Digest }, { additionalProperties: false })),
    resourceContentHashes: Type.Array(Digest),
    toolImplementationDigests: Type.Array(Digest),
    mcpBindings: Type.Array(Id),
    scopePolicyRef: Id,
    modelPolicyRef: Id,
    budgetPolicyRef: Id,
    contentDigest: Digest,
    approvedBy: Id,
}, { additionalProperties: false })
export type RoleResourceManifest = Static<typeof RoleResourceManifestSchema>

export interface RoleResourceManifestInput extends Omit<RoleResourceManifest, "contentDigest"> {
    contentDigest?: never
}

export function createRoleResourceManifest(input: RoleResourceManifestInput): RoleResourceManifest {
    const contentDigest = sha256Digest(input)
    return parseStrict(RoleResourceManifestSchema, { ...input, contentDigest }, "RoleResourceManifest")
}

export function validateRoleResourceManifest(value: unknown): RoleResourceManifest {
    const manifest = parseStrict(RoleResourceManifestSchema, value, "RoleResourceManifest")
    const { contentDigest: _contentDigest, ...content } = manifest
    if (sha256Digest(content) !== manifest.contentDigest) throw new LifecycleValidationError("RoleResourceManifest contentDigest 不匹配")
    return manifest
}

export const NormalizedRequestSchema = Type.Object({
    requestId: Id,
    operation: Id,
    arguments: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false })
export type NormalizedRequest = Static<typeof NormalizedRequestSchema>

export const NormalizedResponseSchema = Type.Object({
    requestId: Id,
    status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("denied"), Type.Literal("unknown")]),
    result: Type.Optional(Type.Unknown()),
    outputBytes: NonNegative,
    modelProjection: Type.Optional(Type.Unknown()),
    diagnostic: Type.Optional(Id),
}, { additionalProperties: false })
export type NormalizedResponse = Static<typeof NormalizedResponseSchema>

export const ProviderRetryPolicySchema = Type.Object({
    maxRetries: NonNegative,
    deadlineMs: Positive,
}, { additionalProperties: false })
export type ProviderRetryPolicy = Static<typeof ProviderRetryPolicySchema>

export const RequestManifestSchema = Type.Object({
    requestId: Id,
    runId: Id,
    generation: Positive,
    managerEpoch: Positive,
    scopeRevision: Positive,
    resourceManifestHash: Digest,
    contextRevisionHash: Digest,
    normalizedInputHash: Digest,
    providerRetryPolicy: ProviderRetryPolicySchema,
    attempt: NonNegative,
}, { additionalProperties: false })
export type RequestManifest = Static<typeof RequestManifestSchema>

const HOST_BOUND_FIELDS = new Set(["assignmentId", "runId", "generation", "managerEpoch", "scopeRevision", "leaseToken", "principal", "manifestId", "policyDigest", "budgetNodeId"])

export function normalizeRequest(value: unknown, host: { operation: string }): NormalizedRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleValidationError("执行请求必须是对象")
    const record = value as Record<string, unknown>
    for (const key of HOST_BOUND_FIELDS) if (key in record) throw new LifecycleValidationError(`执行请求不得提供宿主字段 ${key}`)
    const request = parseStrict(NormalizedRequestSchema, value, "NormalizedRequest")
    if (request.operation !== host.operation) throw new LifecycleValidationError("执行操作与宿主绑定操作不一致")
    return request
}

export interface BudgetLimit {
    tokens: number
    timeMs: number
    cost: number
    concurrency: number
    outputBytes: number
    retries: number
}

export interface BudgetUsage {
    tokens: number
    timeMs: number
    cost: number
    concurrency: number
    outputBytes: number
    retries: number
}

export class BudgetExceededError extends Error {
    readonly code = "LIFECYCLE_BUDGET_EXCEEDED"
    readonly dimension: keyof BudgetLimit
    constructor(dimension: keyof BudgetLimit, message = `预算超限：${dimension}`) {
        super(message)
        this.name = "BudgetExceededError"
        this.dimension = dimension
    }
}

function zeroUsage(): BudgetUsage {
    return { tokens: 0, timeMs: 0, cost: 0, concurrency: 0, outputBytes: 0, retries: 0 }
}

function addUsage(left: BudgetUsage, right: Partial<BudgetUsage>): BudgetUsage {
    return {
        tokens: left.tokens + (right.tokens ?? 0),
        timeMs: left.timeMs + (right.timeMs ?? 0),
        cost: left.cost + (right.cost ?? 0),
        concurrency: left.concurrency + (right.concurrency ?? 0),
        outputBytes: left.outputBytes + (right.outputBytes ?? 0),
        retries: left.retries + (right.retries ?? 0),
    }
}

function exceeds(usage: BudgetUsage, limit: BudgetLimit): keyof BudgetLimit | undefined {
    for (const dimension of ["tokens", "timeMs", "cost", "concurrency", "outputBytes", "retries"] as const) {
        if (usage[dimension] > limit[dimension]) return dimension
    }
}

interface BudgetNode {
    id: string
    parentId?: string
    limit: BudgetLimit
    usage: BudgetUsage
}

/** 父子预算同时记账；释放并发不会释放已经消耗的其他维度。 */
export class BudgetTree {
    private readonly nodes = new Map<string, BudgetNode>()
    addNode(id: string, limit: BudgetLimit, parentId?: string): void {
        if (this.nodes.has(id)) throw new LifecycleValidationError(`预算节点 ${id} 已存在`)
        if (parentId !== undefined && !this.nodes.has(parentId)) throw new LifecycleValidationError(`预算父节点 ${parentId} 不存在`)
        this.assertLimit(limit)
        this.nodes.set(id, { id, parentId, limit: { ...limit }, usage: zeroUsage() })
    }
    usage(id: string): BudgetUsage {
        const node = this.nodes.get(id)
        if (!node) throw new LifecycleValidationError(`预算节点 ${id} 不存在`)
        return { ...node.usage }
    }
    reserve(id: string, delta: Partial<BudgetUsage>): void {
        const chain = this.chain(id)
        const nextByNode = chain.map((node) => ({ node, usage: addUsage(node.usage, delta) }))
        for (const { node, usage } of nextByNode) {
            const exceeded = exceeds(usage, node.limit)
            if (exceeded) throw new BudgetExceededError(exceeded)
        }
        for (const { node, usage } of nextByNode) node.usage = usage
    }
    releaseConcurrency(id: string): void {
        const chain = this.chain(id)
        for (const node of chain) node.usage.concurrency = Math.max(0, node.usage.concurrency - 1)
    }
    private chain(id: string): BudgetNode[] {
        const result: BudgetNode[] = []
        let node = this.nodes.get(id)
        if (!node) throw new LifecycleValidationError(`预算节点 ${id} 不存在`)
        while (node) {
            result.push(node)
            node = node.parentId ? this.nodes.get(node.parentId) : undefined
        }
        return result
    }
    private assertLimit(limit: BudgetLimit): void {
        for (const dimension of ["tokens", "timeMs", "cost", "concurrency", "outputBytes", "retries"] as const) {
            if (!Number.isFinite(limit[dimension]) || limit[dimension] < 0) throw new LifecycleValidationError(`预算 ${dimension} 必须是非负数`)
        }
    }
}

export interface GatewayFence {
    runId: string
    runGeneration: number
    managerEpoch: number
    scopeRevision: number
    leaseToken: string
    policyDigest: string
    manifestDigest: string
}

export interface GatewayState extends GatewayFence {
    gateRevision: number
    terminalGateOpen: boolean
    fatalLatched: boolean
    budgetNodeId: string
}

export interface ToolDispatchRequest {
    requestId: string
    toolCallId: string
    operation: string
    normalizedArguments: Record<string, unknown>
    fence: GatewayFence
    budget: Partial<BudgetUsage>
    nested?: boolean
    codemode?: boolean
}

export interface ToolEffectReceipt {
    effectId: string
    requestId: string
    operation: string
    status: "succeeded" | "failed" | "result_pending" | "unknown" | "denied"
    gateRevision: number
    normalizedArgsHash: string
    executionIdentity: string
    diagnostic?: string
}

export class ToolGatewayError extends Error {
    readonly code: "GATEWAY_STALE" | "GATEWAY_DENIED" | "GATEWAY_NESTED_DISPATCH" | "GATEWAY_UNKNOWN"
    constructor(code: ToolGatewayError["code"], message: string) {
        super(message)
        this.name = "ToolGatewayError"
        this.code = code
    }
}

export type ToolExecutor = (request: ToolDispatchRequest) => Promise<{ status: "succeeded" | "failed" | "result_pending" | "unknown"; executionIdentity: string; diagnostic?: string }>

/** 确定性 Gateway：每次 dispatch 都在同一临界区重验 fence 与 terminal gate。 */
export class ToolGateway {
    private state: GatewayState
    private readonly budgetTree: BudgetTree
    private readonly receipts = new Map<string, ToolEffectReceipt>()
    private dispatching = false

    constructor(state: GatewayState, budgetTree: BudgetTree) {
        this.state = { ...state }
        this.budgetTree = budgetTree
    }
    updateState(state: GatewayState): void { this.state = { ...state } }
    receipt(effectId: string): ToolEffectReceipt | undefined { const result = this.receipts.get(effectId); return result ? { ...result } : undefined }
    async dispatch(request: ToolDispatchRequest, execute: ToolExecutor): Promise<ToolEffectReceipt> {
        if (request.nested || request.codemode) throw new ToolGatewayError("GATEWAY_NESTED_DISPATCH", "禁止隐藏嵌套或 codemode 外部调度")
        if (this.dispatching) throw new ToolGatewayError("GATEWAY_DENIED", "Gateway 正在处理另一项外部副作用")
        this.assertFence(request.fence)
        if (!this.state.terminalGateOpen) throw new ToolGatewayError("GATEWAY_DENIED", "终态门已关闭")
        if (this.state.fatalLatched) throw new ToolGatewayError("GATEWAY_DENIED", "FatalLatch 已锁定")
        const effectId = `effect:${request.toolCallId}`
        const normalizedArgsHash = sha256Digest(request.normalizedArguments)
        const existing = this.receipts.get(effectId)
        if (existing) {
            if (existing.normalizedArgsHash !== normalizedArgsHash || existing.operation !== request.operation) throw new ToolGatewayError("GATEWAY_DENIED", "effect identity 已绑定冲突 payload")
            return { ...existing }
        }
        if (request.budget) this.budgetTree.reserve(this.state.budgetNodeId, request.budget)
        this.dispatching = true
        try {
            // 执行前再次校验，阻止 preflight 后的 lease/gate 变化。
            this.assertFence(request.fence)
            if (!this.state.terminalGateOpen) throw new ToolGatewayError("GATEWAY_STALE", "dispatch 前终态门已变化")
            const outcome = await execute(request)
            const receipt: ToolEffectReceipt = {
                effectId,
                requestId: request.requestId,
                operation: request.operation,
                status: outcome.status,
                gateRevision: this.state.gateRevision,
                normalizedArgsHash,
                executionIdentity: outcome.executionIdentity,
                ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
            }
            this.receipts.set(effectId, receipt)
            return { ...receipt }
        } catch (error) {
            if (error instanceof ToolGatewayError) throw error
            const receipt: ToolEffectReceipt = {
                effectId,
                requestId: request.requestId,
                operation: request.operation,
                status: "unknown",
                gateRevision: this.state.gateRevision,
                normalizedArgsHash,
                executionIdentity: "unknown",
                diagnostic: "外部效果结果未知",
            }
            this.receipts.set(effectId, receipt)
            throw new ToolGatewayError("GATEWAY_UNKNOWN", "外部效果结果未知，必须通过 reconcile 对账")
        } finally {
            this.dispatching = false
        }
    }
    private assertFence(fence: GatewayFence): void {
        for (const field of ["runId", "runGeneration", "managerEpoch", "scopeRevision", "leaseToken", "policyDigest", "manifestDigest"] as const) {
            if (fence[field] !== this.state[field]) throw new LifecycleFenceError(field, this.state[field], fence[field])
        }
    }
}

export interface DynamicMcpBinding {
    principal: string
    grant: string
    engagementId: string
    registryDigest: string
    tools: ReadonlyArray<{ name: string; schema: unknown }>
}

export class DynamicMcpBindings {
    private current: DynamicMcpBinding | undefined
    refresh(binding: DynamicMcpBinding): void {
        if (!binding.principal || !binding.grant || !binding.engagementId || !binding.registryDigest) throw new LifecycleValidationError("MCP binding 缺少宿主身份")
        this.current = { ...binding, tools: binding.tools.map((tool) => ({ name: tool.name, schema: structuredClone(tool.schema) })) }
    }
    snapshot(): DynamicMcpBinding | undefined { return this.current ? structuredClone(this.current) : undefined }
    assertApproved(name: string): { name: string; schema: unknown } {
        const tool = this.current?.tools.find((entry) => entry.name === name)
        if (!tool) throw new LifecycleValidationError(`MCP 工具 ${name} 不在当前宿主批准目录中`)
        return structuredClone(tool)
    }
}

export class FatalLatch {
    private failure: { code: string; message: string } | undefined
    latch(code: string, message: string): void {
        if (!this.failure) this.failure = { code, message }
    }
    get isLatched(): boolean { return this.failure !== undefined }
    get diagnostic(): { code: string; message: string } | undefined { return this.failure ? { ...this.failure } : undefined }
    assertOpen(): void {
        if (this.failure) throw new LifecycleValidationError(`FatalLatch 已锁定：${this.failure.code}`)
    }
    assertOrdinaryExecutionAllowed(): void { this.assertOpen() }
    /** 终态 intake 使用独立控制路径，不因普通执行 latch 被拒绝。 */
    allowTerminalIntake(): true { return true }
}

export function contentDigest(value: unknown): string {
    return sha256Digest(canonicalJson(value))
}
