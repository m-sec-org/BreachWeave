import Dockerode from "dockerode"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import type {
    ContainerConfig,
    HostBridgeHandler,
    RuntimeMessageThread,
    RuntimeSolverDetails,
    SolverEventHandler,
    SolverInstance,
} from "./types"
import { ARCHIVE_SOLVERS_DIR, SOLVERS_DIR, solverDir, solverSessionDir, solverStartupPath, solverWorkspaceDir } from "./types"
import { ConfigManager, DEFAULT_CONFIG_DIR, TCH_AGENT_HOME_DIR } from "../config/index"
import { AUTHORIZED_MODEL_ORIGIN_ENV, AUTHORIZED_SOLVER_ENV, CHALLENGE_ENV_CHALLENGE_ID, CHALLENGE_ENV_PROJECT_ID } from "../challenge/env"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { Message } from "@earendil-works/pi-ai"
import type { HostBridgeRequestEvent } from "../challenge/host-bridge-types"
import type { RpcCommand, SolverInitPayload } from "../solver/rpc/rpc-types"
import type { Subprocess } from "bun"
import {
    DOCKERFILE_HASH_LABEL,
    RUNTIME_IMAGE_ARCH,
    ensureSolverBinary,
    getAgentEndError,
    getAssistantError,
    getStableSolverCreatedAt,
    hashDockerfileContent,
    pathExists,
    readMessagesFromSessionDir,
    readStartup,
    resolveDockerfilePath,
    resolveSolverInjection,
} from "./helpers"
const SOLVER_NAME_PREFIX = "tch-solver"
const DOCKER_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const
export const MODEL_BRIDGE_PLACEHOLDER = "TCH_MODEL_BRIDGE_PLACEHOLDER"

interface AuthorizedModelTransportBinding {
    origin: string
    pathPrefix: string
    providerId: string
    modelPrefId: string
    modelId: string
    apiKey: string
    configDir: string
}

interface AuthorizedModelRequest {
    controller: AbortController
    reader?: ReadableStreamDefaultReader<Uint8Array>
    total: number
    reading: boolean
}

const RESERVED_SOLVER_ENV_KEY = /^TCH_(?:TARIC_|AUTHORIZED_|MODEL_BRIDGE_)/i
const AUTHORIZED_TARIC_METADATA_KEYS = new Set([
    "TCH_TARIC_WORK_RUN_ID",
    "TCH_TARIC_WORK_GENERATION",
    "TCH_TARIC_ATTEMPT_ID",
    "TCH_TARIC_OWNER_AGENT_ID",
    "TCH_TARIC_SCOPE_ID",
    "TCH_TARIC_SCOPE_VERSION",
    "TCH_TARIC_SCOPE_REVISION_ID",
    "TCH_TARIC_RESOURCE_ID",
    "TCH_TARIC_TASK_SESSION_ID",
])
const SENSITIVE_CONFIG_KEY = /(?:api[-_]?key|headers?|authorization|credential|secret|token|cookie|password|private[-_]?key)/i
const SAFE_MODEL_REQUEST_HEADERS = new Set([
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "openai-beta",
    "user-agent",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-package-version",
    "x-stainless-retry-count",
    "x-stainless-timeout",
    "x-stainless-helper-method",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeAuthorizedConfig(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeAuthorizedConfig)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key))
        .map(([key, item]) => [key, sanitizeAuthorizedConfig(item)]))
}

function isWithinPath(parent: string, path: string): boolean {
    const relativePath = relative(resolve(parent), resolve(path))
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

export { getAgentEndError, hashDockerfileContent } from "./helpers"

function isHostBridgeRequestEvent(value: unknown): value is HostBridgeRequestEvent {
    if (!value || typeof value !== "object") return false
    const event = value as { type?: unknown; request_id?: unknown; action?: unknown }
    return event.type === "host_bridge_request" && typeof event.request_id === "string" && typeof event.action === "string"
}

function getMessageTimestamp(message: { timestamp?: unknown }): number | undefined {
    return typeof message.timestamp === "number" ? message.timestamp : undefined
}

function normalizeToolResultContent(payload: unknown): Array<{ type: "text"; text: string } | Record<string, unknown>> {
    if (payload && typeof payload === "object" && "content" in payload) {
        const content = (payload as { content?: unknown }).content
        if (Array.isArray(content)) {
            return content.filter((item): item is { type: "text"; text: string } | Record<string, unknown> => !!item && typeof item === "object")
        }
    }

    if (typeof payload === "string" && payload.trim()) {
        return [{ type: "text", text: payload }]
    }

    if (payload == null) return []

    try {
        return [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    } catch {
        return [{ type: "text", text: String(payload) }]
    }
}

function buildRuntimeToolResultMessage(event: AgentSessionEvent): Message | undefined {
    if (event.type !== "tool_execution_end") return
    if (!event.toolCallId || !event.toolName) return

    const payload = event.result
    const message = {
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(payload),
        isError: event.isError === true,
        timestamp: "timestamp" in event && typeof event.timestamp === "number" ? event.timestamp : Date.now(),
    } as Message & { details?: unknown }

    if (payload && typeof payload === "object" && "details" in payload) {
        message.details = (payload as { details?: unknown }).details
    }

    return message
}

function upsertToolResultMessage(messages: Message[], nextMessage: Message): Message[] {
    const toolCallId = "toolCallId" in nextMessage && typeof nextMessage.toolCallId === "string" ? nextMessage.toolCallId : ""
    if (!toolCallId) return [...messages, nextMessage]

    const index = messages.findIndex(
        (message) => message.role === "toolResult" && "toolCallId" in message && typeof message.toolCallId === "string" && message.toolCallId === toolCallId,
    )
    if (index < 0) return [...messages, nextMessage]

    const merged = [...messages]
    merged[index] = {
        ...merged[index],
        ...nextMessage,
    }
    return merged
}

function mergeMainThreadMessages(baseMessages: Message[], liveMessages: Message[]): Message[] {
    if (liveMessages.length === 0) return baseMessages

    let merged = [...baseMessages]
    for (const liveMessage of liveMessages) {
        merged = upsertToolResultMessage(merged, liveMessage)
    }

    return merged
        .map((message, index) => ({ message, index }))
        .sort((left, right) => {
            const leftTs = getMessageTimestamp(left.message)
            const rightTs = getMessageTimestamp(right.message)
            if (leftTs === undefined && rightTs === undefined) return left.index - right.index
            if (leftTs === undefined) return 1
            if (rightTs === undefined) return -1
            if (leftTs === rightTs) return left.index - right.index
            return leftTs - rightTs
        })
        .map((item) => item.message)
}

function getTextContent(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object" && "type" in item)
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim()
}

function getObserverReasonLabel(message: { role?: unknown; content?: unknown }, index: number): string {
    if (message.role !== "user") return `Observer #${index + 1}`
    const text = getTextContent(message.content)
    const reason = text.match(/本次触发原因:\s*([^\n]+)/)?.[1]?.trim()
    return reason ? `Observer ${reason}` : `Observer #${index + 1}`
}

function splitObserverThreads(
    solverId: string,
    session: { sessionId?: string; createdAt?: number; messages: Array<{ role?: unknown; timestamp?: unknown; content?: unknown }> },
): RuntimeMessageThread[] {
    const groups: Array<Array<{ role?: unknown; timestamp?: unknown; content?: unknown }>> = []
    let current: Array<{ role?: unknown; timestamp?: unknown; content?: unknown }> = []

    for (const message of session.messages) {
        if (message.role === "user" && current.length > 0) {
            groups.push(current)
            current = [message]
            continue
        }
        current.push(message)
    }

    if (current.length > 0) {
        groups.push(current)
    }

    return groups.map((messages, index) => {
        const firstMessage = messages[0]
        return {
            id: `${solverId}:observer:${index + 1}`,
            solverId,
            kind: "observer",
            label: getObserverReasonLabel(firstMessage ?? {}, index),
            promptName: "observer",
            sessionId: session.sessionId,
            createdAt: getMessageTimestamp(firstMessage ?? {}) ?? session.createdAt,
            messages: messages as RuntimeMessageThread["messages"],
        }
    })
}

function readDockerBuildProxyArgs(): string[] {
    const args: string[] = []
    for (const key of DOCKER_PROXY_ENV_KEYS) {
        const value = process.env[key]?.trim()
        if (!value) continue
        args.push("--build-arg", `${key}=${value}`)
    }
    return args
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error)
}

function solverStartupLogPath(solverId: string): string {
    return resolve(solverDir(solverId), "startup.log")
}

export class RuntimeManager {
    private docker: Dockerode
    private config: ContainerConfig
    private solvers = new Map<string, SolverInstance>()
    private procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()
    private solverEnvs = new Map<string, Record<string, string>>()
    private authorizedModelBindings = new Map<string, AuthorizedModelTransportBinding>()
    private authorizedModelRequests = new Map<string, Map<string, AuthorizedModelRequest>>()
    private liveMainThreadMessages = new Map<string, Message[]>()
    private hostBridgeHandlers: HostBridgeHandler[]
    private hostConfig: ConfigManager
    private ready: Promise<void>
    private eventHandlers: SolverEventHandler[] = []
    private statusHandlers: Array<(solverId: string, status: SolverInstance["status"]) => void> = []

    constructor(config: ConfigManager, hostBridgeHandlers: HostBridgeHandler[]) {
        this.docker = new Dockerode()
        this.config = {
            image: "tch-agent:latest",
            binds: [`${DEFAULT_CONFIG_DIR}:/root/.tch-agent/config:ro`],
        }
        this.hostConfig = config
        this.hostBridgeHandlers = hostBridgeHandlers
        this.ready = this.reloadFromConfig()
    }

    private async ensureReady(): Promise<void> {
        await this.ready
    }

    async reloadFromConfig(): Promise<void> {
        const hostSettings = await this.hostConfig.getHostSettings()
        this.config = { ...this.config, ...hostSettings.runtime }
    }

    async init(onProgress?: (message: string) => void) {
        await this.ensureReady()
        await this.ensureImage(onProgress)
        const execName = basename(process.execPath).toLowerCase()
        if (execName === "bun" || execName === "bun.exe") {
            onProgress?.("Compiling runtime solver binary...")
            await ensureSolverBinary()
        }
    }

    onEvent(handler: SolverEventHandler) {
        this.eventHandlers.push(handler)
    }

    onStatusChange(handler: (solverId: string, status: SolverInstance["status"]) => void) {
        this.statusHandlers.push(handler)
    }

    private setSolverStatus(solver: SolverInstance, status: SolverInstance["status"]): void {
        if (solver.status === status) return
        solver.status = status
        for (const handler of this.statusHandlers) {
            try {
                handler(solver.id, status)
            } catch {
                // ignore handler errors
            }
        }
    }

    private emit(solverId: string, event: AgentSessionEvent) {
        const liveMessage = buildRuntimeToolResultMessage(event)
        if (liveMessage) {
            const current = this.liveMainThreadMessages.get(solverId) ?? []
            this.liveMainThreadMessages.set(solverId, upsertToolResultMessage(current, liveMessage))
        }
        for (const handler of this.eventHandlers) {
            try {
                handler(solverId, event)
            } catch {
                // ignore handler errors
            }
        }
    }

    private recordAgentEnd(solverId: string, errorMessage?: string) {
        const solver = this.solvers.get(solverId)
        if (solver) {
            if (errorMessage) solver.error = errorMessage
            else delete solver.error
        }
    }

    private clearSolverRuntimeState(solverId: string): void {
        for (const request of this.authorizedModelRequests.get(solverId)?.values() ?? []) {
            request.controller.abort()
            void request.reader?.cancel().catch(() => {})
        }
        this.authorizedModelRequests.delete(solverId)
        this.procs.delete(solverId)
        this.solverEnvs.delete(solverId)
        const authorizedBinding = this.authorizedModelBindings.get(solverId)
        if (authorizedBinding) {
            authorizedBinding.apiKey = ""
            void rm(authorizedBinding.configDir, { recursive: true, force: true }).catch(() => {})
        }
        this.authorizedModelBindings.delete(solverId)
        this.liveMainThreadMessages.delete(solverId)
    }

    private async appendSolverStartupLog(solverId: string, line: string): Promise<void> {
        const text = line.trim()
        if (!text) return
        try {
            await appendFile(solverStartupLogPath(solverId), `${new Date().toISOString()} ${text}\n`)
        } catch (error) {
            console.error(`[runtime:${solverId}] failed to append startup log`, formatError(error))
        }
    }

    private normalizeSolverEnv(solverEnv?: Record<string, string>): Record<string, string> {
        if (!solverEnv) return {}
        const normalized: Record<string, string> = Object.create(null)
        for (const [rawKey, rawValue] of Object.entries(solverEnv)) {
            const key = rawKey.trim()
            if (!key) continue
            if (typeof rawValue !== "string") continue
            normalized[key] = rawValue
        }
        return normalized
    }

    private assertNoReservedSolverEnv(solverEnv: Record<string, string>): void {
        const reserved = Object.keys(solverEnv).find((key) => RESERVED_SOLVER_ENV_KEY.test(key))
        if (reserved) throw new Error(`solver environment key is reserved: ${reserved}`)
    }

    private async copyAuthorizedDirectory(sourceDir: string, destinationDir: string): Promise<void> {
        const entries = await readdir(sourceDir, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules" || SENSITIVE_CONFIG_KEY.test(entry.name)) continue
            const sourcePath = resolve(sourceDir, entry.name)
            const destinationPath = resolve(destinationDir, entry.name)
            if (entry.isDirectory()) {
                await mkdir(destinationPath, { recursive: true, mode: 0o700 })
                await this.copyAuthorizedDirectory(sourcePath, destinationPath)
                await chmod(destinationPath, 0o700)
                continue
            }
            if (!entry.isFile()) continue
            const info = await lstat(sourcePath)
            if (info.size > 2 * 1024 * 1024) continue
            await copyFile(sourcePath, destinationPath)
            await chmod(destinationPath, 0o600)
        }
    }

    private async stageAuthorizedConfig(promptName: string, modelPrefId: string, model: Record<string, unknown>, providerId: string): Promise<{ configDir: string; apiKey: string }> {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(promptName)) throw new Error("authorized Solver prompt name is invalid")
        const prompt = await this.hostConfig.getPrompt(promptName)
        if (!prompt || prompt.meta.model !== modelPrefId) throw new Error("authorized Solver prompt must pin its selected model")
        const modelPrefs = await this.hostConfig.listModelPrefs()
        const modelPref = modelPrefs.find((item) => item.id === modelPrefId)
        if (!modelPref) throw new Error(`model config ${modelPrefId} not found`)
        const providerConfig = await this.hostConfig.getProvider(providerId)
        if (!providerConfig) throw new Error(`model provider ${providerId} not found`)
        const auth = await this.hostConfig.models.getApiKeyAndHeaders(model as never)
        if (!auth.ok || typeof auth.apiKey !== "string" || !auth.apiKey.trim()) throw new Error("authorized Solver model credential is unavailable")
        if (auth.headers && Object.keys(auth.headers).length > 0) throw new Error("authorized Solver models cannot use custom request headers")

        const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl.trim() : ""
        const modelUrl = new URL(baseUrl)
        if (!/^https?:$/.test(modelUrl.protocol) || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash) {
            throw new Error("authorized Solver model must use a pinned HTTP(S) base URL")
        }

        await mkdir(TCH_AGENT_HOME_DIR, { recursive: true })
        const configDir = await mkdtemp(resolve(TCH_AGENT_HOME_DIR, "authorized-config-"))
        try {
            await chmod(configDir, 0o700)
            const promptsDir = resolve(configDir, "prompts")
            const skillsDir = resolve(configDir, "skills")
            await mkdir(promptsDir, { recursive: true, mode: 0o700 })
            await mkdir(skillsDir, { recursive: true, mode: 0o700 })

            const promptSource = resolve(this.hostConfig.dir, "prompts", `${promptName}.md`)
            const promptDestination = resolve(promptsDir, `${promptName}.md`)
            const promptInfo = await lstat(promptSource).catch(() => undefined)
            if (!promptInfo?.isFile() || promptInfo.size > 1024 * 1024) throw new Error("authorized Solver prompt file is unavailable")
            await copyFile(promptSource, promptDestination)
            await chmod(promptDestination, 0o600)

            const skillRoot = resolve(this.hostConfig.dir, "skills")
            for (const skillName of prompt.meta.skills ?? []) {
                const skill = this.hostConfig.getSkill(skillName)
                if (!skill || !isWithinPath(skillRoot, skill.baseDir)) continue
                const relativeSkillPath = relative(skillRoot, resolve(skill.baseDir))
                const destinationPath = resolve(skillsDir, relativeSkillPath)
                const sourceInfo = await lstat(skill.baseDir).catch(() => undefined)
                if (!sourceInfo?.isDirectory()) continue
                await mkdir(destinationPath, { recursive: true, mode: 0o700 })
                await this.copyAuthorizedDirectory(skill.baseDir, destinationPath)
            }

            const providerPrefs = await this.hostConfig.listProviderPrefs()
            const providerPref = modelPref.providerId ? providerPrefs.find((item) => item.id === modelPref.providerId) : undefined
            const stagedProvider = sanitizeAuthorizedConfig(providerConfig) as Record<string, unknown>
            delete stagedProvider.headers
            stagedProvider.apiKey = MODEL_BRIDGE_PLACEHOLDER
            const stagedModel = sanitizeAuthorizedConfig(model) as Record<string, unknown>
            delete stagedModel.headers
            delete stagedModel.apiKey
            stagedProvider.models = [stagedModel]

            await Bun.write(resolve(configDir, "auth.json"), JSON.stringify({
                [providerId]: { type: "api_key", key: MODEL_BRIDGE_PLACEHOLDER },
            }, null, 2))
            await Bun.write(resolve(configDir, "models.json"), JSON.stringify({ providers: { [providerId]: stagedProvider } }, null, 2))
            await Bun.write(resolve(configDir, "model-prefs.json"), JSON.stringify({ models: [sanitizeAuthorizedConfig(modelPref)] }, null, 2))
            await Bun.write(resolve(configDir, "provider-prefs.json"), JSON.stringify({ providers: providerPref ? [sanitizeAuthorizedConfig(providerPref)] : [] }, null, 2))
            await Bun.write(resolve(configDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2))
            for (const fileName of ["auth.json", "models.json", "model-prefs.json", "provider-prefs.json", "mcp.json"]) {
                await chmod(resolve(configDir, fileName), 0o600)
            }

            return { configDir, apiKey: auth.apiKey }
        } catch (error) {
            await rm(configDir, { recursive: true, force: true }).catch(() => {})
            throw error
        }
    }

    private getSolverEnvValue(solverId: string, key: string): string | undefined {
        const solverEnv = this.solverEnvs.get(solverId)
        if (!solverEnv) return
        const value = solverEnv[key]
        if (typeof value !== "string") return
        const text = value.trim()
        return text || undefined
    }

    private async executeHostBridgeAction(solverId: string, action: HostBridgeRequestEvent["action"], params: unknown): Promise<unknown> {
        if (action === "authorized_model_fetch") return this.executeAuthorizedModelFetch(solverId, params)
        if (action === "authorized_model_read") return this.readAuthorizedModelResponse(solverId, params)
        if (action === "authorized_model_cancel") {
            this.cancelAuthorizedModelRequest(solverId, params)
            return { ok: true }
        }
        for (const handler of this.hostBridgeHandlers) {
            const result = await handler.handle({
                solverId,
                action,
                params,
                getSolverEnvValue: (key: string) => this.getSolverEnvValue(solverId, key),
                getSolver: () => this.get(solverId),
                getSolverStartup: () => readStartup(solverStartupPath(solverId)),
                listSolvers: () => this.list(),
                sendCommand: (targetSolverId, command) => this.sendCommand(targetSolverId, command),
            })
            if (result.handled) {
                return result.data
            }
        }
        throw new Error(`unsupported host bridge action: ${action}`)
    }

    private async executeAuthorizedModelFetch(solverId: string, params: unknown): Promise<{ status: number; headers: Record<string, string> }> {
        const binding = this.authorizedModelBindings.get(solverId)
        if (!binding || !binding.apiKey || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("authorized model transport is unavailable")
        const input = params as Record<string, unknown>
        if (typeof input.transportId !== "string" || !/^[a-f0-9-]{36}$/.test(input.transportId)) throw new Error("authorized model transport id is invalid")
        if (typeof input.url !== "string" || typeof input.method !== "string" || input.method !== "POST" || typeof input.bodyBase64 !== "string" || input.bodyBase64.length > 3 * 1024 * 1024 || !input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw new Error("authorized model request is invalid")
        const url = new URL(input.url)
        if (url.origin !== binding.origin || !url.pathname.startsWith(binding.pathPrefix) || url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("authorized model request destination is not approved")
        const body = Buffer.from(input.bodyBase64, "base64")
        if (body.byteLength > 2 * 1024 * 1024 || body.toString("base64") !== input.bodyBase64) throw new Error("authorized model request body is invalid")
        const headers = new Headers()
        const inputHeaders = Object.entries(input.headers as Record<string, unknown>)
        if (inputHeaders.length > 64) throw new Error("authorized model request has too many headers")
        let authorizationHeaderSeen = false
        for (const [name, value] of inputHeaders) {
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string" || value.length > 16 * 1024 || /[\r\n\0]/.test(value)) throw new Error("authorized model request header is invalid")
            const normalizedName = name.toLowerCase()
            if (normalizedName === "authorization") {
                if (authorizationHeaderSeen || value !== `Bearer ${MODEL_BRIDGE_PLACEHOLDER}`) throw new Error("authorized model request credential is invalid")
                authorizationHeaderSeen = true
                headers.set("authorization", `Bearer ${binding.apiKey}`)
                continue
            }
            if (normalizedName === "x-api-key") {
                if (authorizationHeaderSeen || value !== MODEL_BRIDGE_PLACEHOLDER) throw new Error("authorized model request credential is invalid")
                authorizationHeaderSeen = true
                headers.set("x-api-key", binding.apiKey)
                continue
            }
            if (!SAFE_MODEL_REQUEST_HEADERS.has(normalizedName)) throw new Error("authorized model request header is not allowed")
            headers.set(normalizedName, value)
        }
        if (!authorizationHeaderSeen) throw new Error("authorized model request credential is missing")
        const requests = this.authorizedModelRequests.get(solverId) ?? new Map<string, AuthorizedModelRequest>()
        if (requests.size >= 4 || requests.has(input.transportId)) throw new Error("authorized model request concurrency exceeds its bound")
        const transportId = input.transportId
        const request: AuthorizedModelRequest = { controller: new AbortController(), total: 0, reading: false }
        requests.set(transportId, request)
        this.authorizedModelRequests.set(solverId, requests)
        try {
            const response = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(10 * 60_000)]) })
            request.controller.signal.throwIfAborted()
            if (response.status >= 300 && response.status < 400) throw new Error("authorized model transport does not follow redirects")
            request.reader = response.body?.getReader()
            const safeHeaders: Record<string, string> = {}
            for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
                const value = response.headers.get(name)
                if (value) safeHeaders[name] = value
            }
            return { status: response.status, headers: safeHeaders }
        } catch (error) {
            this.cancelAuthorizedModelRequest(solverId, { transportId })
            throw error
        } finally {
            body.fill(0)
        }
    }

    private cancelAuthorizedModelRequest(solverId: string, params: unknown): void {
        if (!isRecord(params) || typeof params.transportId !== "string") throw new Error("authorized model transport id is invalid")
        const request = this.authorizedModelRequests.get(solverId)?.get(params.transportId)
        if (!request) return
        request.controller.abort()
        void request.reader?.cancel().catch(() => {})
        this.authorizedModelRequests.get(solverId)?.delete(params.transportId)
    }

    private async readAuthorizedModelResponse(solverId: string, params: unknown): Promise<{ done: boolean; bodyBase64?: string }> {
        if (!isRecord(params) || typeof params.transportId !== "string") throw new Error("authorized model transport id is invalid")
        const requests = this.authorizedModelRequests.get(solverId)
        const request = requests?.get(params.transportId)
        if (!request || request.reading) throw new Error("authorized model response is unavailable")
        request.reading = true
        try {
            const chunk = await request.reader?.read()
            if (!chunk || chunk.done) {
                request.reader?.releaseLock()
                requests?.delete(params.transportId)
                return { done: true }
            }
            request.total += chunk.value.byteLength
            if (request.total > 16 * 1024 * 1024) throw new Error("authorized model response exceeds its bound")
            return { done: false, bodyBase64: Buffer.from(chunk.value).toString("base64") }
        } catch (error) {
            this.cancelAuthorizedModelRequest(solverId, params)
            throw error
        } finally {
            request.reading = false
        }
    }

    private async handleHostBridgeRequest(solverId: string, request: HostBridgeRequestEvent): Promise<void> {
        const commandId = `host-bridge-${request.request_id}`
        try {
            const data = await this.executeHostBridgeAction(solverId, request.action, request.params)
            try {
                this.sendCommand(solverId, {
                    id: commandId,
                    type: "host_bridge_response",
                    request_id: request.request_id,
                    success: true,
                    data,
                })
            } catch (sendError) {
                console.error(`[runtime:${solverId}] failed to send host bridge success response`, formatError(sendError))
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            try {
                this.sendCommand(solverId, {
                    id: commandId,
                    type: "host_bridge_response",
                    request_id: request.request_id,
                    success: false,
                    error: message,
                })
            } catch (sendError) {
                console.error(`[runtime:${solverId}] failed to send host bridge error response`, formatError(sendError))
            }
        }
    }

    /** Check if Docker daemon is accessible */
    async ping(): Promise<boolean> {
        try {
            await this.docker.ping()
            return true
        } catch {
            return false
        }
    }

    /** Check if the configured image exists locally */
    async hasImage(image?: string): Promise<boolean> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            await img.inspect()
            return true
        } catch {
            return false
        }
    }

    private async getDockerfileHash(dockerfilePath: string): Promise<string> {
        const content = await Bun.file(dockerfilePath).text()
        return hashDockerfileContent(content)
    }

    private async getImageDockerfileHash(image?: string): Promise<string | undefined> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            const inspect = await img.inspect()
            return inspect.Config?.Labels?.[DOCKERFILE_HASH_LABEL]
        } catch {
            return
        }
    }

    private async getImageArchitecture(image?: string): Promise<string | undefined> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            const inspect = await img.inspect()
            return inspect.Architecture
        } catch {
            return
        }
    }

    /**
     * Ensure the solver image exists. If not, build it from the Dockerfile.
     *
     * Dockerfile resolution order:
     *   1. ~/.tch-agent/config/Dockerfile  (user-customizable)
     *   2. Built-in Dockerfile bundled with the package
     *
     * If the user copy doesn't exist, the built-in one is copied there first.
     */
    async ensureImage(onProgress?: (message: string) => void): Promise<void> {
        const dockerfilePath = await resolveDockerfilePath(onProgress)
        const imageExists = await this.hasImage()

        if (imageExists) {
            const actualArchitecture = await this.getImageArchitecture()
            if (actualArchitecture === RUNTIME_IMAGE_ARCH) return
            onProgress?.(`Image ${this.config.image} has wrong architecture (${actualArchitecture ?? "unknown"}); rebuilding...`)
        }

        const expectedDockerfileHash = await this.getDockerfileHash(dockerfilePath)
        onProgress?.(`Building image ${this.config.image} from ${dockerfilePath}...`)

        const contextDir = dirname(dockerfilePath)
        const proxyArgs = readDockerBuildProxyArgs()
        const proc = Bun.spawn(
            [
                "docker",
                "buildx",
                "build",
                "--platform",
                "linux/amd64",
                "--load",
                "-t",
                this.config.image,
                "-f",
                dockerfilePath,
                "--label",
                `${DOCKERFILE_HASH_LABEL}=${expectedDockerfileHash}`,
                ...proxyArgs,
                contextDir,
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
            },
        )

        const decoder = new TextDecoder()
        const readProgress = async (stream: ReadableStream<Uint8Array> | null) => {
            if (!stream) return
            const reader = stream.getReader()
            let buffer = ""
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value)
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""
                for (const line of lines) {
                    const text = line.trim()
                    if (text) onProgress?.(text)
                }
            }
            const tail = buffer.trim()
            if (tail) onProgress?.(tail)
        }

        await Promise.all([readProgress(proc.stdout), readProgress(proc.stderr)])
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new Error(`Failed to build image ${this.config.image} (exit ${exitCode})`)
        }

        const builtArchitecture = await this.getImageArchitecture()
        if (builtArchitecture !== RUNTIME_IMAGE_ARCH) {
            throw new Error(`Image ${this.config.image} built with wrong architecture: ${builtArchitecture ?? "unknown"} (expected ${RUNTIME_IMAGE_ARCH})`)
        }

        onProgress?.(`Image ${this.config.image} built successfully`)
    }

    /** Start a new solver container for a given prompt */
    async launch(promptName: string, task: string, solverEnv?: Record<string, string>, options?: { solverId?: string }): Promise<SolverInstance> {
        const normalizedSolverEnv = this.normalizeSolverEnv(solverEnv)
        this.assertNoReservedSolverEnv(normalizedSolverEnv)
        return this.launchInternal(promptName, task, normalizedSolverEnv, options)
    }

    async launchAuthorized(promptName: string, task: string, solverEnv: Record<string, string>, modelPrefId: string, options?: { solverId?: string }): Promise<SolverInstance> {
        const normalizedSolverEnv = this.normalizeSolverEnv(solverEnv)
        for (const key of Object.keys(normalizedSolverEnv)) {
            if (!RESERVED_SOLVER_ENV_KEY.test(key)) continue
            if (AUTHORIZED_TARIC_METADATA_KEYS.has(key)) continue
            throw new Error(`solver environment key is reserved: ${key}`)
        }

        await this.ensureReady()
        const { model } = await this.hostConfig.resolveModelPref(modelPrefId)
        const supportedModelApis = new Set([
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "mistral-conversations",
            "pi-messages",
        ])
        if (!supportedModelApis.has(model.api)) throw new Error("authorized Solver model API is not supported")
        const modelUrl = new URL(typeof model.baseUrl === "string" ? model.baseUrl : "")
        if (!/^https?:$/.test(modelUrl.protocol) || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash) {
            throw new Error("authorized Solver model must use a pinned HTTP(S) base URL")
        }

        const providerId = model.provider
        if (!providerId) throw new Error("authorized Solver model provider is unavailable")
        const stagedConfig = await this.stageAuthorizedConfig(
            promptName,
            modelPrefId,
            model as unknown as Record<string, unknown>,
            providerId,
        )
        const binding: AuthorizedModelTransportBinding = {
            origin: modelUrl.origin,
            pathPrefix: `${modelUrl.pathname.replace(/\/+$/, "") || ""}/`,
            providerId,
            modelPrefId,
            modelId: model.id,
            apiKey: stagedConfig.apiKey,
            configDir: stagedConfig.configDir,
        }
        const authorizedSolverEnv = {
            ...normalizedSolverEnv,
            [AUTHORIZED_SOLVER_ENV]: "1",
            [AUTHORIZED_MODEL_ORIGIN_ENV]: binding.origin,
        }
        try {
            return await this.launchInternal(promptName, task, authorizedSolverEnv, options, binding)
        } catch (error) {
            await rm(binding.configDir, { recursive: true, force: true }).catch(() => {})
            throw error
        }
    }

    private async launchInternal(
        promptName: string,
        task: string,
        normalizedSolverEnv: Record<string, string>,
        options?: { solverId?: string },
        authorizedBinding?: AuthorizedModelTransportBinding,
    ): Promise<SolverInstance> {
        await this.ensureReady()
        await this.ensureImage()

        const id = options?.solverId?.trim() || crypto.randomUUID().slice(0, 8)
        const name = `${SOLVER_NAME_PREFIX}-${id}`

        const solver: SolverInstance = {
            id,
            containerId: name,
            name,
            promptName,
            task,
            challengeId: normalizedSolverEnv[CHALLENGE_ENV_CHALLENGE_ID]?.trim() || undefined,
            projectId: normalizedSolverEnv[CHALLENGE_ENV_PROJECT_ID]?.trim() || undefined,
            status: "starting",
            createdAt: Date.now(),
        }
        this.solvers.set(id, solver)
        this.solverEnvs.set(id, normalizedSolverEnv)
        if (authorizedBinding) this.authorizedModelBindings.set(id, authorizedBinding)

        const baseDir = solverDir(id)
        const sessionDir = solverSessionDir(id)
        const workspaceDir = solverWorkspaceDir(id)
        const containerRuntimeDir = "/runtime"
        const containerSessionDir = `${containerRuntimeDir}/session`
        const containerWorkspaceDir = "/root/workspace"

        await mkdir(baseDir, { recursive: true })
        await mkdir(sessionDir, { recursive: true })
        await mkdir(workspaceDir, { recursive: true })

        const authorizedSolver = Boolean(authorizedBinding)
        const binds = [
            ...(authorizedBinding ? [`${authorizedBinding.configDir}:/root/.tch-agent/config:ro`] : (this.config.binds ?? [])),
            `${baseDir}:${containerRuntimeDir}`,
            `${workspaceDir}:${containerWorkspaceDir}`,
        ]

        const injection = await resolveSolverInjection()
        binds.push(...injection.binds)

        try {
            const command = this.buildSolverRpcCommand(
                injection.cmd,
                {
                    ...normalizedSolverEnv,
                    TCH_SOLVER_BASE_DIR: containerRuntimeDir,
                    TCH_SOLVER_SESSION_DIR: containerSessionDir,
                    TCH_SOLVER_WORKSPACE: containerWorkspaceDir,
                },
            )
            const args = this.buildDockerArgs(name, binds, command, containerWorkspaceDir, authorizedSolver)

            const proc = Bun.spawn(args, {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            })

            this.procs.set(id, proc)
            this.setSolverStatus(solver, "running")

            // Start reading JSONL, wait for init handshake to complete
            const initReady = this.readStream(id, proc)
            const initPayload: SolverInitPayload = { solverId: id, promptName, task, challengeId: solver.challengeId, projectId: solver.projectId }
            proc.stdin.write(JSON.stringify(initPayload) + "\n")
            await initReady

            // Init done — task prompt is auto-executed by RPC server

            return solver
        } catch (err) {
            solver.error = err instanceof Error ? err.message : String(err)
            this.setSolverStatus(solver, "error")
            await this.appendSolverStartupLog(id, `[launch-error] ${solver.error}`)
            this.clearSolverRuntimeState(id)
            throw err
        }
    }

    /** Build `docker run` CLI arguments from config */
    private buildDockerArgs(name: string, binds: string[], cmd: string[], workdir: string, authorizedSolver = false): string[] {
        const args: string[] = [
            "docker",
            "run",
            "-i",
            "--platform",
            "linux/amd64",
            "--network",
            authorizedSolver ? "none" : this.config.networkMode ?? "host",
            "--name",
            name,
            "-w",
            workdir,
        ]

        args.push("--rm")

        for (const bind of binds) args.push("-v", bind)

        if (!authorizedSolver) for (const envVar of this.buildEnv()) args.push("-e", envVar)

        args.push(this.config.image, ...cmd)
        return args
    }

    /** Send an RPC command to a solver's stdin */
    sendCommand(solverId: string, command: RpcCommand) {
        const proc = this.procs.get(solverId)
        if (!proc) throw new Error(`No process for solver ${solverId}`)
        proc.stdin.write(JSON.stringify(command) + "\n")
    }

    /** Stop a solver container */
    async stopSolver(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (!solver) throw new Error(`Solver ${solverId} not found`)
        if (solver.status === "stopped" && !this.procs.has(solverId)) return

        const previousStatus = solver.status
        this.setSolverStatus(solver, "stopping")

        try {
            const exitCode = await this.stopContainer(solver.containerId)
            if (exitCode !== 0) throw new Error(`Failed to stop solver ${solverId}: docker stop exited with code ${exitCode}`)
        } catch (error) {
            if (this.procs.get(solverId)?.exitCode === null) {
                solver.error = error instanceof Error ? error.message : String(error)
                this.setSolverStatus(solver, previousStatus)
                throw error
            }
            // A process that already exited needs no further Docker stop.
        }
        delete solver.error
        this.clearSolverRuntimeState(solverId)
        this.setSolverStatus(solver, "stopped")
    }

    private async stopContainer(containerId: string): Promise<number> {
        const stop = Bun.spawn(["docker", "stop", containerId], {
            stdout: "ignore",
            stderr: "ignore",
        })
        return stop.exited
    }

    /** List all tracked solver instances */
    list(): SolverInstance[] {
        return [...this.solvers.values()]
    }

    async listAll(): Promise<SolverInstance[]> {
        const items = new Map<string, SolverInstance>()
        for (const solver of this.solvers.values()) items.set(solver.id, solver)

        let solverIds: string[] = []
        try {
            solverIds = (await readdir(SOLVERS_DIR, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
        } catch {
            return [...items.values()].sort((a, b) => b.createdAt - a.createdAt)
        }

        for (const solverId of solverIds) {
            if (items.has(solverId)) continue
            const startup = await readStartup(solverStartupPath(solverId))
            const mainSession = await readMessagesFromSessionDir(solverSessionDir(solverId))
            const startupInit =
                startup && typeof startup === "object" && "init" in startup
                    ? (startup as { init?: { promptName?: string; task?: string; challengeId?: string; projectId?: string } }).init
                    : undefined
            const status = getAssistantError(mainSession.messages) ? "error" : "stopped"
            const createdAt = await getStableSolverCreatedAt(solverId, startup, mainSession.createdAt)
            items.set(solverId, {
                id: solverId,
                containerId: `${SOLVER_NAME_PREFIX}-${solverId}`,
                name: `${SOLVER_NAME_PREFIX}-${solverId}`,
                promptName: startupInit?.promptName ?? "unknown",
                task: startupInit?.task ?? "",
                challengeId: startupInit?.challengeId?.trim() || undefined,
                projectId: startupInit?.projectId?.trim() || undefined,
                status,
                createdAt,
                error: getAssistantError(mainSession.messages),
            })
        }

        return [...items.values()].sort((a, b) => b.createdAt - a.createdAt)
    }

    /** Get a solver by ID */
    get(solverId: string): SolverInstance | undefined {
        return this.solvers.get(solverId)
    }

    async getDetails(solverId: string): Promise<RuntimeSolverDetails | undefined> {
        const solver = this.get(solverId) ?? (await this.listAll()).find((item) => item.id === solverId)
        if (!solver) return undefined

        const startup = await readStartup(solverStartupPath(solverId))
        const mainSession = await readMessagesFromSessionDir(solverSessionDir(solverId))
        const threads: RuntimeMessageThread[] = [
            {
                id: `${solverId}:main`,
                solverId,
                kind: "main",
                label: "Main",
                promptName: solver.promptName,
                task: solver.task,
                sessionId: mainSession.sessionId,
                createdAt: mainSession.createdAt,
                messages: mergeMainThreadMessages(mainSession.messages, this.liveMainThreadMessages.get(solverId) ?? []),
            },
        ]

        const subagentsDir = resolve(solverWorkspaceDir(solverId), ".subagents")
        try {
            const entries = await readdir(subagentsDir, { withFileTypes: true })
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const subagentDir = resolve(subagentsDir, entry.name)
                const subStartup = await readStartup(resolve(subagentDir, "startup.json"))
                const subSession = await readMessagesFromSessionDir(resolve(subagentDir, "session"))
                const init =
                    subStartup && typeof subStartup === "object" && "init" in subStartup
                        ? (subStartup as { init?: { promptName?: string; task?: string; parentToolCallId?: string } }).init
                        : undefined
                threads.push({
                    id: `${solverId}:subagent:${entry.name}`,
                    solverId,
                    kind: "subagent",
                    label: entry.name,
                    parentToolCallId: init?.parentToolCallId?.trim() || undefined,
                    promptName: init?.promptName,
                    task: init?.task,
                    sessionId: subSession.sessionId,
                    createdAt: subSession.createdAt,
                    messages: subSession.messages,
                })
            }
        } catch {}

        const observerSessionDir = resolve(solverSessionDir(solverId), ".observer")
        if (await pathExists(observerSessionDir)) {
            const observerSession = await readMessagesFromSessionDir(observerSessionDir)
            threads.push(...splitObserverThreads(solverId, observerSession))
        }

        threads.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        return { solver, threads, startup }
    }

    /** Remove a stopped solver from tracking */
    remove(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (solver && (solver.status === "stopped" || solver.status === "error")) {
            this.solvers.delete(solverId)
            this.clearSolverRuntimeState(solverId)
        }
    }

    async deleteSolver(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (solver && (solver.status === "running" || solver.status === "starting" || solver.status === "stopping")) {
            throw new Error(`Solver ${solverId} is still running`)
        }

        this.solvers.delete(solverId)
        this.clearSolverRuntimeState(solverId)

        const sourceDir = solverDir(solverId)
        if (!(await pathExists(sourceDir))) return

        await mkdir(ARCHIVE_SOLVERS_DIR, { recursive: true })
        let archiveDir = resolve(ARCHIVE_SOLVERS_DIR, solverId)
        if (await pathExists(archiveDir)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-")
            archiveDir = resolve(ARCHIVE_SOLVERS_DIR, `${solverId}-${stamp}`)
        }
        await rename(sourceDir, archiveDir)
    }

    /** Stop all running solvers */
    async stopAll() {
        const running = [...this.solvers.values()].filter((s) => s.status === "running" || s.status === "starting")
        await Promise.allSettled(running.map((s) => this.stopSolver(s.id)))
    }

    private buildSolverRpcCommand(baseCmd: string[], solverEnv?: Record<string, string>): string[] {
        if (!solverEnv) return baseCmd
        const args = [...baseCmd]
        for (const [key, value] of Object.entries(solverEnv)) {
            if (!key.trim()) continue
            if (typeof value !== "string") continue
            if (!value.trim()) continue
            args.push("--env", `${key}=${value}`)
        }
        return args
    }

    private buildEnv(): string[] {
        const env: string[] = []
        if (this.config.env) {
            for (const [k, v] of Object.entries(this.config.env)) {
                if (RESERVED_SOLVER_ENV_KEY.test(k.trim())) continue
                env.push(`${k}=${v}`)
            }
        }
        return env
    }

    private readStream(solverId: string, proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
        const decoder = new TextDecoder()

        // Promise resolves when init response is received
        let resolveInit!: () => void
        let rejectInit!: (err: Error) => void
        const initReady = new Promise<void>((res, rej) => {
            resolveInit = res
            rejectInit = rej
        })

        // Read stdout for JSONL events
        ;(async () => {
            const reader = proc.stdout.getReader()
            let buffer = ""
            let initResolved = false
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value)
                    const parts = buffer.split("\n")
                    buffer = parts.pop()!
                    for (const line of parts) {
                        if (!line.trim()) continue
                        try {
                            const parsed = JSON.parse(line)
                            if (isHostBridgeRequestEvent(parsed)) {
                                await this.handleHostBridgeRequest(solverId, parsed)
                                continue
                            }
                            if (parsed.type === "response") {
                                if (!initResolved && parsed.command === "init") {
                                    initResolved = true
                                    if (parsed.success) {
                                        resolveInit()
                                    } else {
                                        rejectInit(new Error(parsed.error ?? "init failed"))
                                    }
                                }
                                continue
                            }
                            const event = parsed as AgentSessionEvent
                            const finalError = getAgentEndError(event)
                            if (event.type === "agent_end") {
                                this.recordAgentEnd(solverId, finalError)
                            }
                            this.emit(solverId, event)
                        } catch {
                            // ignore malformed stdout lines
                        }
                    }
                }
            } catch (error) {
                console.error(`[runtime:${solverId}] stdout reader failed`, formatError(error))
                const solver = this.solvers.get(solverId)
                if (solver && !solver.error) {
                    solver.error = error instanceof Error ? error.message : String(error)
                }
                await this.appendSolverStartupLog(solverId, `[stdout-reader-failed] ${formatError(error)}`)
                if (!initResolved) {
                    rejectInit(error instanceof Error ? error : new Error(String(error)))
                }
            } finally {
                if (!initResolved) {
                    rejectInit(new Error("solver process exited before init response"))
                }
                const solver = this.solvers.get(solverId)
                this.clearSolverRuntimeState(solverId)
                if (solver && (solver.status === "running" || solver.status === "starting" || solver.status === "stopping")) {
                    this.setSolverStatus(solver, solver.error ? "error" : "stopped")
                }
            }
        })().catch((error) => {
            console.error(`[runtime:${solverId}] stdout loop crashed`, formatError(error))
        })

        // Read stderr (log for debugging)
        ;(async () => {
            try {
                const reader = proc.stderr.getReader()
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    const text = decoder.decode(value).trim()
                    if (!text) continue
                    console.error(`[solver:${solverId}:stderr]`, text)
                    await this.appendSolverStartupLog(solverId, `[stderr] ${text}`)
                }
            } catch (error) {
                console.error(`[runtime:${solverId}] stderr reader failed`, formatError(error))
                await this.appendSolverStartupLog(solverId, `[stderr-reader-failed] ${formatError(error)}`)
            }
        })().catch((error) => {
            console.error(`[runtime:${solverId}] stderr loop crashed`, formatError(error))
        })

        return initReady
    }
}
