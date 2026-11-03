import { randomUUID } from "node:crypto"
import { request as httpsRequest } from "node:https"
import { connect as tlsConnect } from "node:tls"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, compareTaricCompatibility } from "./compatibility"
import { TaricOperationError } from "./types"
import type { TaricCompatibility, TaricHostBinding, TaricServiceAdapter } from "./types"

type JsonRpcResponse = {
    jsonrpc?: unknown
    id?: unknown
    result?: unknown
    error?: { code?: unknown; message?: unknown; data?: unknown; details?: unknown }
}

export type TaricNetworkTransport =
    | {
          kind: "https"
          url: string
          hostToken: string
          modelToken: string
          operatorToken?: string
          operatorPrincipalId?: string
          ca?: string | Uint8Array
          servername?: string
          timeoutMs?: number
      }
    | {
          kind: "tls_tcp"
          host: string
          port: number
          hostToken: string
          modelToken: string
          operatorToken?: string
          operatorPrincipalId?: string
          ca?: string | Uint8Array
          servername?: string
          timeoutMs?: number
      }

export interface NetworkTaricAdapterOptions {
    binding: TaricHostBinding
    transport: TaricNetworkTransport
    expectedCompatibility?: TaricCompatibility
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = 1024 * 1024
const MODEL_OPERATIONS = new Set([
    "context.query",
    "resource.query",
    "evidence.query",
    "coverage.query",
    "proposal.submit",
    "checkpoint.propose",
])

function isHostOperation(operation: string): boolean {
    return !MODEL_OPERATIONS.has(operation)
}

function requiredText(value: string, field: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${field} is required`)
    return text
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value))
}

function validateTimeout(value: number | undefined): number {
    const timeout = value ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > DEFAULT_TIMEOUT_MS) throw new Error("Taric network timeout must be between 100 and 30000 milliseconds")
    return timeout
}

function validateToken(value: string, field: string): string {
    const token = requiredText(value, field)
    if (token.length < 32) throw new Error(`${field} must contain at least 32 characters`)
    return token
}

function nodeCa(value: string | Uint8Array | undefined): string | Buffer | undefined {
    if (value === undefined || typeof value === "string" || Buffer.isBuffer(value)) return value
    return Buffer.from(value)
}

function validateCompatibility(value: TaricCompatibility): TaricCompatibility {
    const expected = { ...TARIC_COMPATIBILITY_BASELINE, ...value }
    const mismatches = compareTaricCompatibility(expected, value)
    if (mismatches.length > 0) throw new Error(`invalid expected Taric compatibility: ${mismatches.join(", ")}`)
    return value
}

function operationToken(transport: TaricNetworkTransport, operation: string, role?: "model" | "host"): string {
    return (role ?? (isHostOperation(operation) ? "host" : "model")) === "host" ? transport.hostToken : transport.modelToken
}

function unwrapResponse(value: JsonRpcResponse): unknown {
    if (value.error) throw new TaricOperationError(
        typeof value.error.code === "string" ? value.error.code.slice(0, 64) : "rpc_error",
        safeErrorText(value.error.message, "Taric gateway request failed"),
        safeDiagnosticDetails(value.error.details ?? value.error.data),
    )
    if (!Object.prototype.hasOwnProperty.call(value, "result")) throw new Error("Taric gateway returned an invalid JSON-RPC response")
    return value.result
}

function safeErrorText(value: unknown, fallback: string): string {
    if (typeof value !== "string" || !value.trim()) return fallback
    return value
        .replace(/((?:token|password|secret|credential|authorization|connection[_-]?string)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
        .replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/gi, "<redacted-connection-string>")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 256)
}

function safeDiagnosticDetails(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const details = value as Record<string, unknown>
    if (details.kind === "contract" && typeof details.contract_name === "string" && Array.isArray(details.violations)) {
        const violations = details.violations.slice(0, 16).flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return []
            const violation = item as Record<string, unknown>
            const params: Record<string, string | number | boolean> = {}
            if (violation.params && typeof violation.params === "object" && !Array.isArray(violation.params)) {
                for (const [key, param] of Object.entries(violation.params as Record<string, unknown>).slice(0, 8)) {
                    if (typeof param === "string") params[key.slice(0, 64)] = /token|password|secret|credential|authorization|private[_-]?key/i.test(param) ? "<redacted>" : safeErrorText(param, "")
                    else if (typeof param === "number" && Number.isFinite(param) || typeof param === "boolean") params[key.slice(0, 64)] = param
                }
            }
            return [{
                instance_path: safeErrorText(violation.instance_path, "").split("/").map((part) => /token|password|secret|credential|authorization|private[_-]?key/i.test(part) ? "<redacted>" : part).join("/").slice(0, 256),
                keyword: safeErrorText(violation.keyword, "validation").slice(0, 64),
                ...(Object.keys(params).length ? { params } : {}),
                message: safeErrorText(violation.message, "contract constraint failed"),
            }]
        })
        return violations.length ? { kind: "contract", contract_name: safeErrorText(details.contract_name, "unknown").slice(0, 128), violations } : undefined
    }
    if (details.kind === "compatibility" && ["sqlite", "postgresql", "unknown"].includes(String(details.backend))) {
        const safeMap = (map: unknown): Record<string, string> | undefined => {
            if (!map || typeof map !== "object" || Array.isArray(map)) return undefined
            const output: Record<string, string> = {}
            for (const [key, item] of Object.entries(map as Record<string, unknown>).slice(0, 8)) {
                if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") continue
                output[key.slice(0, 64)] = /token|password|secret|credential|authorization|connection[_-]?string/i.test(key) ? "<redacted>" : safeErrorText(String(item), "")
            }
            return output
        }
        const expected = safeMap(details.expected)
        if (!expected) return undefined
        const observed = safeMap(details.observed)
        const missing = Array.isArray(details.missing) ? details.missing.slice(0, 32).filter((item): item is string => typeof item === "string").map((item) => /token|password|secret|credential|authorization|private[_-]?key/i.test(item) ? "<redacted>" : item.slice(0, 256)) : undefined
        return {
            kind: "compatibility",
            backend: details.backend,
            expected,
            ...(observed ? { observed } : {}),
            ...(typeof details.failed_marker === "string" ? { failed_marker: safeErrorText(details.failed_marker, "compatibility") } : {}),
            ...(missing?.length ? { missing } : {}),
        }
    }
    return undefined
}

function assertSuccessfulRpc(value: unknown): asserts value is { ok: true; data?: unknown } {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) {
        const error = value && typeof value === "object" && !Array.isArray(value) ? (value as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error : undefined
        throw new TaricOperationError(
            typeof error?.code === "string" ? error.code.slice(0, 64) : "internal_error",
            safeErrorText(error?.message, "Taric gateway request failed"),
            safeDiagnosticDetails(error?.details),
        )
    }
}

function parseJsonResponse(body: string): JsonRpcResponse {
    if (Buffer.byteLength(body, "utf8") > MAX_FRAME_BYTES) throw new Error("Taric gateway response exceeds the 1 MiB JSON-RPC limit")
    try {
        const parsed = JSON.parse(body) as unknown
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response is not an object")
        return parsed as JsonRpcResponse
    } catch (error) {
        throw new Error(`invalid Taric gateway response: ${asError(error).message}`)
    }
}

async function invokeHttpsRpc(
    transport: Extract<TaricNetworkTransport, { kind: "https" }>,
    method: string,
    params: Record<string, unknown>,
    token: string,
): Promise<unknown> {
    const url = new URL(transport.url)
    if (url.protocol !== "https:") throw new Error("Taric HTTPS gateway URL must use https")
    const requestId = randomUUID()
    const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
    })
    if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) throw new Error("Taric gateway request exceeds the 1 MiB JSON-RPC limit")
    const timeoutMs = validateTimeout(transport.timeoutMs)
    const responseBody = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
        const request = httpsRequest(
            url,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload, "utf8"),
                },
                ca: nodeCa(transport.ca),
                servername: transport.servername || url.hostname,
                rejectUnauthorized: true,
            },
            (response) => {
                const chunks: Buffer[] = []
                let bytes = 0
                response.on("data", (part: Buffer | string) => {
                    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
                    bytes += chunk.byteLength
                    if (bytes > MAX_FRAME_BYTES) {
                        request.destroy(new Error("Taric gateway response exceeds the 1 MiB JSON-RPC limit"))
                        return
                    }
                    chunks.push(chunk)
                })
                response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
                response.on("error", reject)
            },
        )
        request.setTimeout(timeoutMs, () => request.destroy(new Error("Taric HTTPS gateway request timed out")))
        request.once("error", reject)
        request.end(payload)
    })
    const response = parseJsonResponse(responseBody.body)
    if (response.id !== requestId) throw new Error("Taric HTTPS gateway response id does not match the request")
    if (responseBody.statusCode !== undefined && (responseBody.statusCode < 200 || responseBody.statusCode >= 300)) {
        throw new Error(`Taric HTTPS gateway returned HTTP ${responseBody.statusCode}`)
    }
    return unwrapResponse(response)
}

async function invokeHttps(transport: Extract<TaricNetworkTransport, { kind: "https" }>, operation: string, requestBody: Record<string, unknown>, role?: "model" | "host"): Promise<unknown> {
    return invokeHttpsRpc(transport, "taric.dispatch", { operation, request: requestBody }, operationToken(transport, operation, role))
}

interface PendingRpc {
    resolve: (response: JsonRpcResponse) => void
    reject: (error: Error) => void
}

async function invokeTlsTcp(
    transport: Extract<TaricNetworkTransport, { kind: "tls_tcp" }>,
    operation: string,
    requestBody: Record<string, unknown>,
    principalId: string,
    engagementId: string | undefined,
    management?: { method: "taric.gateway.status" | "taric.gateway.reload"; role: "host" | "operator"; token: string },
    role?: "model" | "host",
): Promise<unknown> {
    const host = requiredText(transport.host, "Taric TLS TCP host")
    if (!Number.isSafeInteger(transport.port) || transport.port < 1 || transport.port > 65535) throw new Error("Taric TLS TCP port is invalid")
    const token = management?.token ?? operationToken(transport, operation, role)
    const timeoutMs = validateTimeout(transport.timeoutMs)
    const socket = tlsConnect({
        host,
        port: transport.port,
        servername: transport.servername || host,
        ca: nodeCa(transport.ca),
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
    })
    socket.setEncoding("utf8")
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Taric TLS TCP request timed out")))

    let buffer = ""
    let closed = false
    const pending: PendingRpc[] = []
    const queued: JsonRpcResponse[] = []
    let fatal: Error | undefined
    const wake = (error: Error) => {
        if (fatal) return
        fatal = error
        while (pending.length > 0) pending.shift()!.reject(error)
    }
    const read = async (expectedId?: string): Promise<JsonRpcResponse> => {
        if (fatal) return Promise.reject(fatal)
        const response = queued.shift()
        const result = response ?? await new Promise<JsonRpcResponse>((resolve, reject) => pending.push({ resolve, reject }))
        if (expectedId !== undefined && result.id !== expectedId) throw new Error("Taric TLS TCP gateway response id does not match the request")
        return result
    }
    const onData = (part: string | Buffer) => {
        buffer += typeof part === "string" ? part : part.toString("utf8")
        if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
            socket.destroy(new Error("Taric TLS TCP response exceeds the 1 MiB JSON-RPC limit"))
            return
        }
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "")
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf("\n")
            if (!line.trim()) continue
            try {
                const response = parseJsonResponse(line)
                const waiter = pending.shift()
                if (waiter) waiter.resolve(response)
                else queued.push(response)
            } catch (error) {
                socket.destroy(asError(error))
                return
            }
        }
    }
    socket.on("data", onData)
    socket.on("error", (error: Error) => wake(asError(error)))
    socket.on("close", () => {
        closed = true
        if (!fatal) wake(new Error("Taric TLS TCP gateway connection closed"))
    })
    try {
        await new Promise<void>((resolve, reject) => {
            const onSecureConnect = () => {
                socket.off("error", onError)
                resolve()
            }
            const onError = (error: Error) => {
                socket.off("secureConnect", onSecureConnect)
                reject(error)
            }
            socket.once("secureConnect", onSecureConnect)
            socket.once("error", onError)
        })
        const identifyId = randomUUID()
        const declaredRole = management?.role ?? (role ?? (isHostOperation(operation) ? "host" : "model"))
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: identifyId, method: "taric.identify", params: { token, declare: { role: declaredRole, principal_id: principalId, ...(engagementId ? { engagement_id: engagementId } : {}) } } })}\n`)
        const identified = unwrapResponse(await read(identifyId))
        assertSuccessfulRpc(identified)
        const requestId = randomUUID()
        const method = management?.method ?? "taric.dispatch"
        const params = management ? { token } : { token, operation, request: requestBody }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
        return unwrapResponse(await read(requestId))
    } finally {
        if (!closed) socket.end()
        socket.destroy()
    }
}

/**
 * Build a client for Taric's authenticated network gateway. HTTPS is stateless;
 * TLS TCP opens a short-lived connection per request and authenticates it with
 * the connection-level identify frame.
 */
export function createNetworkTaricServiceAdapter(options: NetworkTaricAdapterOptions): TaricServiceAdapter {
    const expectedCompatibility = validateCompatibility(options.expectedCompatibility ?? {
        ...TARIC_COMPATIBILITY_BASELINE,
        policyDigest: TARIC_DEFAULT_POLICY_DIGEST,
        bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
    })
    const binding = { ...options.binding }
    const transport = options.transport
    validateToken(transport.hostToken, "Taric host gateway token")
    validateToken(transport.modelToken, "Taric model gateway token")
    if (transport.kind === "https") {
        const url = new URL(requiredText(transport.url, "Taric HTTPS gateway URL"))
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
            throw new Error("Taric HTTPS gateway URL must use https without user info, query, or fragment")
        }
    }

    const invoke = async (operation: string, request: Record<string, unknown>, role?: "model" | "host"): Promise<unknown> => {
        const principalRole = role ?? (isHostOperation(operation) ? "host" : "model")
        if (transport.kind === "https") return invokeHttps(transport, operation, request, principalRole)
        const principalId = principalRole === "host" ? binding.hostPrincipalId : binding.modelPrincipalId
        return invokeTlsTcp(transport, operation, request, principalId, binding.engagementId, undefined, principalRole)
    }

    const gatewayStatus = async (): Promise<unknown> => {
        const result = transport.kind === "https"
            ? await invokeHttpsRpc(transport, "taric.gateway.status", {}, transport.hostToken)
            : await invokeTlsTcp(transport, "taric.gateway.status", {}, binding.hostPrincipalId, binding.engagementId, { method: "taric.gateway.status", role: "host", token: transport.hostToken })
        assertSuccessfulRpc(result)
        return result
    }

    const gatewayReload = async (): Promise<unknown> => {
        const operatorToken = transport.operatorToken
        if (!operatorToken) throw new TaricOperationError("authorization_error", "Taric gateway reload requires an operator credential")
        validateToken(operatorToken, "Taric gateway operator token")
        const result = transport.kind === "https"
            ? await invokeHttpsRpc(transport, "taric.gateway.reload", {}, operatorToken)
            : await invokeTlsTcp(
                  transport,
                  "taric.gateway.reload",
                  {},
                  requiredText(transport.operatorPrincipalId ?? "", "Taric gateway operator principal id"),
                  undefined,
                  { method: "taric.gateway.reload", role: "operator", token: operatorToken },
              )
        assertSuccessfulRpc(result)
        return result
    }

    return {
        transportProfile: "authenticated_proxy",
        async getProfile() {
            return { status: "verified", compatibility: expectedCompatibility }
        },
        async getBinding() {
            return { ...binding }
        },
        async checkHealth() {
            const gateway = await gatewayStatus()
            const gatewayData = (gateway as { data?: unknown }).data
            if (!gatewayData || typeof gatewayData !== "object" || Array.isArray(gatewayData) || (gatewayData as { readiness?: unknown }).readiness !== true) {
                const readinessCode = gatewayData && typeof gatewayData === "object" && !Array.isArray(gatewayData) ? (gatewayData as { readiness_code?: unknown }).readiness_code : undefined
                throw new TaricOperationError("unavailable_host", `Taric gateway is not ready${typeof readinessCode === "string" ? ` (${readinessCode.slice(0, 64)})` : ""}`)
            }
            const result = await invoke("engagement.status", { engagement_id: binding.engagementId })
            assertSuccessfulRpc(result)
            const data = result.data
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Taric gateway returned invalid health data")
            const health = data as { schema_version?: unknown; api_contract_version?: unknown }
            if (health.schema_version !== expectedCompatibility.schemaVersion || health.api_contract_version !== expectedCompatibility.apiContractVersion) {
                throw new Error("Taric gateway API/schema version does not match the locked compatibility manifest")
            }
        },
        async invoke(operation, request) {
            return invoke(operation, request)
        },
        gatewayStatus,
        gatewayReload,
        async close() {
            // Connections are request-scoped; no persistent transport to close.
        },
    }
}

