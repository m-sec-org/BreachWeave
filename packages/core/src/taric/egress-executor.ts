import { lookup } from "node:dns/promises"
import { connect as connectTcp, isIP } from "node:net"
import { connect as connectTls } from "node:tls"
import type { TaricArtifactService } from "./artifact-service"
import type { EgressRequest, PolicyDecision } from "./governance"

export interface TaricEgressRunContext {
    engagementId: string
    actionId: string
    workRunId: string
    attemptId: string
    generation: number
    ownerHost: string
    scopeRevision: number
}

export interface TaricEgressAddress { address: string; family: 4 | 6 }

export interface TaricEgressDecision {
    context: TaricEgressRunContext
    hop: number
    method: string
    url: string
    resolvedAddresses: readonly string[]
    pinnedAddress?: string
    allowed: boolean
    reason: string
}

export interface TaricEgressResult {
    actionId: string
    outcome: "executed" | "denied" | "unknown"
    hopCount: number
    statusCode?: number
    responseHash?: string
    byteLength?: number
    decisionRefs: string[]
    failureCode?: string
    networkProvenance?: TaricActionNetworkProvenance
}

/** Observed by the HTTP client's connected socket, never inferred from DNS alone. */
export interface TaricActionNetworkProvenance {
    approved_addresses: string[]
    connected_address: string
    ip_family: "ipv4" | "ipv6"
    protocol: string
    port: number
    resolved_at: string
    connected_at: string
    completed_at?: string
    redirect_chain: Array<{ from: string; to: string; decision: "allowed" | "blocked"; decided_at: string }>
}

interface EgressExecutionState {
    hopCount: number
    requestStarted: boolean
    decisionRefs: string[]
    networkProvenance?: TaricActionNetworkProvenance
}

export interface TaricEgressInput {
    url: string
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    headers?: Readonly<Record<string, string>>
    body?: string | Uint8Array
    targetAuth?: { sessionId: string; contentRef: string }
}

export interface TaricEgressExecutorOptions {
    evaluateEgress: (request: EgressRequest, context: TaricEgressRunContext) => PolicyDecision | Promise<PolicyDecision>
    assertFence: (context: TaricEgressRunContext) => void | Promise<void>
    /** Must durably record a host decision and return its authority reference before any socket is opened. */
    onDecision: (decision: TaricEgressDecision) => Promise<{ decisionRef: string }>
    /** The host persists this with the trusted run/generation, including unknown outcomes. */
    recordResult: (result: TaricEgressResult, context: TaricEgressRunContext) => Promise<void>
    artifactService?: Pick<TaricArtifactService, "consumeTargetAuth">
    resolveAddresses?: (hostname: string) => Promise<readonly TaricEgressAddress[]>
    /** Private host Evidence consumer; never route this callback or its bytes to an ordinary API. */
    consumeResponse?: (response: { statusCode: number; bytes: Uint8Array; context: TaricEgressRunContext }) => Promise<void>
    timeoutMs?: number
    maxRequestBytes?: number
    maxResponseBytes?: number
    maxRedirects?: number
    now?: () => number
    /** Known host configuration inventory, never a source of request credentials. */
    configurationSecrets?: readonly string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FORBIDDEN_HEADER = /^(?:authorization|proxy-authorization|cookie|cookie2|host|connection|content-length|transfer-encoding|upgrade|te|trailer)$|(?:token|secret|api[-_]?key)/i
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

class EgressFailure extends Error {
    constructor(readonly code: string) { super(code) }
}

function positive(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
    return value
}

function snapshotContext(value: TaricEgressRunContext): TaricEgressRunContext {
    for (const field of ["engagementId", "actionId", "workRunId", "attemptId"] as const) if (!UUID.test(value[field])) throw new EgressFailure("invalid_run_context")
    if (!value.ownerHost || value.ownerHost.length > 128 || /[\r\n\0]/.test(value.ownerHost)) throw new EgressFailure("invalid_run_context")
    positive(value.generation, "generation")
    positive(value.scopeRevision, "scopeRevision")
    return Object.freeze({ engagementId: value.engagementId, actionId: value.actionId, workRunId: value.workRunId, attemptId: value.attemptId, generation: value.generation, ownerHost: value.ownerHost, scopeRevision: value.scopeRevision })
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new EgressFailure("timeout"))
    return new Promise<T>((resolve, reject) => {
        function abort() { reject(new EgressFailure("timeout")) }
        signal.addEventListener("abort", abort, { once: true })
        operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
}

function ensureActive(signal: AbortSignal): void { if (signal.aborted) throw new EgressFailure("timeout") }

/** An explicitly scoped HTTP client. This is not a firewall for arbitrary shell commands or other sockets. */
export class TaricEgressExecutor {
    private readonly options: TaricEgressExecutorOptions
    private readonly timeoutMs: number
    private readonly maxRequestBytes: number
    private readonly maxResponseBytes: number
    private readonly maxRedirects: number

    constructor(options: TaricEgressExecutorOptions) {
        this.options = { ...options, configurationSecrets: [...options.configurationSecrets ?? []] }
        this.timeoutMs = positive(options.timeoutMs ?? 10_000, "timeoutMs")
        this.maxRequestBytes = positive(options.maxRequestBytes ?? 64 * 1024, "maxRequestBytes")
        this.maxResponseBytes = positive(options.maxResponseBytes ?? 1024 * 1024, "maxResponseBytes")
        this.maxRedirects = options.maxRedirects ?? 5
        if (!Number.isSafeInteger(this.maxRedirects) || this.maxRedirects < 0 || this.maxRedirects > 20) throw new Error("maxRedirects must be between 0 and 20")
    }

    async execute(input: TaricEgressInput, trustedContext: TaricEgressRunContext): Promise<TaricEgressResult> {
        const context = snapshotContext(trustedContext)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        const state: EgressExecutionState = { hopCount: 0, requestStarted: false, decisionRefs: [] }
        let body: Uint8Array | undefined
        let result: TaricEgressResult
        try {
            for (const value of Object.values(context)) if (typeof value === "string") this.assertNoConfigurationSecret(value)
            const allowedFields = new Set(["url", "method", "headers", "body", "targetAuth"])
            if (Object.keys(input).some((field) => !allowedFields.has(field))) throw new EgressFailure("invalid_request")
            const method = input.method ?? "GET"
            if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new EgressFailure("invalid_method")
            if (input.body !== undefined && typeof input.body !== "string" && !(input.body instanceof Uint8Array)) throw new EgressFailure("invalid_body")
            body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body === undefined ? undefined : new Uint8Array(input.body)
            if (body && (body.byteLength > this.maxRequestBytes || method === "GET" || method === "HEAD")) throw new EgressFailure("request_body_limit")
            if (body) {
                const content = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
                if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && content.includes(Buffer.from(secret)))) throw new EgressFailure("configuration_secret_denied")
            }
            const headers: Record<string, string> = {}
            let headerBytes = 0
            for (const [name, value] of Object.entries(input.headers ?? {})) {
                if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_HEADER.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value) || value.length > 8192) throw new EgressFailure("invalid_header")
                this.assertNoConfigurationSecret(name)
                this.assertNoConfigurationSecret(value)
                headers[name] = value
                headerBytes += new TextEncoder().encode(`${name}:${value}\r\n`).byteLength
            }
            if (Object.keys(headers).length > 32 || headerBytes > 16 * 1024) throw new EgressFailure("header_limit")
            const targetAuth = input.targetAuth ? { ...input.targetAuth } : undefined
            const initialUrl = input.url
            const execute = async (authorization?: string) => this.perform(initialUrl, method, headers, body, authorization, context, controller.signal, state)
            if (targetAuth) {
                if (!this.options.artifactService || Object.keys(targetAuth).some((field) => !["sessionId", "contentRef"].includes(field))) throw new EgressFailure("target_auth_unavailable")
                let privateResult: TaricEgressResult | undefined
                await abortable(this.options.artifactService.consumeTargetAuth(targetAuth, async (bytes) => {
                    ensureActive(controller.signal)
                    if (bytes.byteLength > 8192) throw new EgressFailure("invalid_target_auth")
                    let authorization: string
                    try { authorization = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new EgressFailure("invalid_target_auth") }
                    if (!authorization || /[\x00-\x1f\x7f]/.test(authorization)) throw new EgressFailure("invalid_target_auth")
                    this.assertNoConfigurationSecret(authorization)
                    privateResult = await execute(authorization)
                }), controller.signal)
                if (!privateResult) throw new EgressFailure("target_auth_unavailable")
                result = privateResult
            } else {
                result = await execute()
            }
        } catch (error) {
            result = { actionId: context.actionId, outcome: state.requestStarted ? "unknown" : "denied", hopCount: state.hopCount, decisionRefs: [...state.decisionRefs], failureCode: error instanceof EgressFailure ? error.code : "host_or_transport_failure" }
        } finally {
            clearTimeout(timer)
            body?.fill(0)
        }
        if (state.networkProvenance) result.networkProvenance = { ...state.networkProvenance, completed_at: new Date((this.options.now ?? Date.now)()).toISOString() }
        // No automatic retry, even when persistence itself fails after an ambiguous network result.
        await this.options.recordResult({ ...result, decisionRefs: [...result.decisionRefs] }, context)
        return result
    }

    private async perform(initialUrl: string, method: string, headers: Record<string, string>, body: Uint8Array | undefined, authorization: string | undefined, context: TaricEgressRunContext, signal: AbortSignal, state: EgressExecutionState): Promise<TaricEgressResult> {
        let nextUrl = initialUrl
        let previousUrl: URL | undefined
        const credentialValues = authorization ? [...new Set([authorization, ...authorization.split(/\s+/).slice(1)])] : []
        function assertNoTargetCredential(value: string): void {
            if (credentialValues.some((credential) => credential.length > 0 && value.includes(credential))) throw new EgressFailure("target_auth_metadata_denied")
        }
        for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
            ensureActive(signal)
            let url: URL
            try { url = new URL(nextUrl) } catch { throw new EgressFailure("invalid_url") }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new EgressFailure("invalid_url")
            this.assertNoConfigurationSecret(url.toString())
            assertNoTargetCredential(url.toString())
            if (url.hash || [...url.searchParams.keys()].some((key) => /password|passwd|secret|credential|token|cookie|authorization|api[_-]?key|session[_-]?id/i.test(key))) throw new EgressFailure("inline_credentials_denied")
            for (const [key, value] of url.searchParams) { this.assertNoConfigurationSecret(value); assertNoTargetCredential(key); assertNoTargetCredential(value) }
            try { const path = decodeURIComponent(url.pathname); this.assertNoConfigurationSecret(path); assertNoTargetCredential(path) } catch (error) { if (error instanceof EgressFailure) throw error; throw new EgressFailure("invalid_url") }
            if (previousUrl && authorization && url.origin !== previousUrl.origin) return this.deny(context, state, "credential_redirect_denied")
            if (previousUrl?.protocol === "https:" && url.protocol !== "https:") return this.deny(context, state, "tls_downgrade_denied")
            const hostname = url.hostname.replace(/^\[|\]$/g, "")
            const literalFamily = isIP(hostname)
            const answers = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : await abortable((this.options.resolveAddresses ?? defaultResolveAddresses)(hostname), signal)
            const resolved = answers.map((entry) => ({ address: entry.address, family: entry.family }))
            if (!resolved.length || resolved.length > 64 || resolved.some((entry) => (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family)) throw new EgressFailure("invalid_dns_answers")
            const addresses = [...new Set(resolved.map((entry) => entry.address))]
            const pinned = resolved[0]!
            const resolvedAt = new Date((this.options.now ?? Date.now)()).toISOString()
            const policyRequest = { url: url.toString(), resolvedAddresses: addresses, at: new Date((this.options.now ?? Date.now)()).toISOString() }
            await abortable(Promise.resolve(this.options.assertFence(context)), signal)
            const decision = await abortable(Promise.resolve(this.options.evaluateEgress(policyRequest, context)), signal)
            const recorded = await abortable(this.options.onDecision({ context, hop, method, url: url.toString(), resolvedAddresses: addresses, pinnedAddress: pinned.address, allowed: decision.allowed === true, reason: this.safeReason(decision.reason) }), signal)
            if (typeof recorded.decisionRef !== "string" || !recorded.decisionRef || recorded.decisionRef.length > 256 || /[\r\n\0]/.test(recorded.decisionRef)) throw new EgressFailure("invalid_decision_reference")
            this.assertNoConfigurationSecret(recorded.decisionRef)
            state.decisionRefs.push(recorded.decisionRef)
            if (decision.allowed !== true) return this.deny(context, state, "scope_denied")
            // Re-check live ownership, scope and time after the durable decision and immediately before opening a socket.
            await abortable(Promise.resolve(this.options.assertFence(context)), signal)
            const finalDecision = await abortable(Promise.resolve(this.options.evaluateEgress({ ...policyRequest, at: new Date((this.options.now ?? Date.now)()).toISOString() }, context)), signal)
            if (finalDecision.allowed !== true) {
                const rejected = await abortable(this.options.onDecision({ context, hop, method, url: url.toString(), resolvedAddresses: addresses, pinnedAddress: pinned.address, allowed: false, reason: this.safeReason(finalDecision.reason) }), signal)
                this.assertNoConfigurationSecret(rejected.decisionRef)
                state.decisionRefs.push(rejected.decisionRef)
                return this.deny(context, state, "scope_changed_before_send")
            }
            ensureActive(signal)
            const redirected = state.networkProvenance?.redirect_chain.at(-1)
            if (previousUrl && redirected?.to === url.toString()) redirected.decision = "allowed"
            state.hopCount += 1
            const response = await abortable(this.request(url, method, headers, body, authorization, pinned, signal, () => { state.requestStarted = true }, (address) => {
                state.networkProvenance = { approved_addresses: addresses, connected_address: address, ip_family: pinned.family === 4 ? "ipv4" : "ipv6", protocol: url.protocol.slice(0, -1), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), resolved_at: resolvedAt, connected_at: new Date((this.options.now ?? Date.now)()).toISOString(), redirect_chain: state.networkProvenance?.redirect_chain ?? [] }
            }, async () => {
                // TCP/TLS handshakes can outlive a lease or policy window.
                // Refresh authority and time after connection, before HTTP bytes.
                await abortable(Promise.resolve(this.options.assertFence(context)), signal)
                const connectedDecision = await abortable(Promise.resolve(this.options.evaluateEgress({ ...policyRequest, at: new Date((this.options.now ?? Date.now)()).toISOString() }, context)), signal)
                if (connectedDecision.allowed !== true) throw new EgressFailure("scope_changed_before_send")
            }), signal)
            try {
                if (response.location && REDIRECT_STATUSES.has(response.statusCode) && (method === "GET" || method === "HEAD")) {
                    let redirect: URL
                    try { redirect = new URL(response.location, url) } catch { throw new EgressFailure("invalid_redirect") }
                    if (redirect.username || redirect.password || redirect.hash || [...redirect.searchParams.keys()].some((key) => /password|passwd|secret|credential|token|cookie|authorization|api[_-]?key|session[_-]?id/i.test(key))) throw new EgressFailure("inline_credentials_denied")
                    this.assertNoConfigurationSecret(redirect.toString())
                    assertNoTargetCredential(redirect.toString())
                    for (const [key, value] of redirect.searchParams) { this.assertNoConfigurationSecret(value); assertNoTargetCredential(key); assertNoTargetCredential(value) }
                    try { const path = decodeURIComponent(redirect.pathname); this.assertNoConfigurationSecret(path); assertNoTargetCredential(path) } catch (error) { if (error instanceof EgressFailure) throw error; throw new EgressFailure("invalid_redirect") }
                    if (state.networkProvenance) state.networkProvenance.redirect_chain.push({ from: url.toString(), to: redirect.toString(), decision: "blocked", decided_at: new Date((this.options.now ?? Date.now)()).toISOString() })
                    if (hop === this.maxRedirects) return this.deny(context, state, "redirect_limit")
                    previousUrl = url
                    nextUrl = redirect.toString()
                    continue
                }
                const responseHash = `sha256:${new Bun.CryptoHasher("sha256").update(response.bytes).digest("hex")}`
                await abortable(this.options.consumeResponse?.({ statusCode: response.statusCode, bytes: response.bytes, context }) ?? Promise.resolve(), signal)
                return { actionId: context.actionId, outcome: "executed", hopCount: state.hopCount, statusCode: response.statusCode, responseHash, byteLength: response.bytes.byteLength, decisionRefs: [...state.decisionRefs] }
            } finally { response.bytes.fill(0) }
        }
        return this.deny(context, state, "redirect_limit")
    }

    private deny(context: TaricEgressRunContext, state: { hopCount: number; decisionRefs: string[] }, failureCode: string): TaricEgressResult {
        return { actionId: context.actionId, outcome: "denied", hopCount: state.hopCount, decisionRefs: [...state.decisionRefs], failureCode }
    }

    private assertNoConfigurationSecret(value: string): void {
        if (this.options.configurationSecrets?.some((secret) => secret.length > 0 && value.includes(secret))) throw new EgressFailure("configuration_secret_denied")
    }

    private safeReason(reason: string): string {
        if (typeof reason !== "string" || reason.length > 256 || /[\r\n\0]|bearer\s+\S+|(?:password|secret|token|cookie|authorization|api[_-]?key)\s*[:=]/i.test(reason) || this.options.configurationSecrets?.some((secret) => secret.length > 0 && reason.includes(secret))) return "host policy decision"
        return reason
    }

    private request(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | undefined, authorization: string | undefined, pinned: TaricEgressAddress, signal: AbortSignal, onStarted: () => void, onConnected: (address: string) => void, beforeSend: () => Promise<void>): Promise<{ statusCode: number; location?: string; bytes: Uint8Array }> {
        return new Promise((resolve, reject) => {
            let received = Buffer.alloc(0)
            let settled = false
            let requestSent = false
            const maxResponseBytes = this.maxResponseBytes
            const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
            // Bun's node:http compatibility socket has no remoteAddress. A real
            // TCP/TLS socket both enforces DNS pinning and exposes its peer.
            const socket = url.protocol === "https:" ? connectTls({ host: pinned.address, port, family: pinned.family, servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname, rejectUnauthorized: true }) : connectTcp({ host: pinned.address, port, family: pinned.family })
            function cleanup() {
                signal.removeEventListener("abort", abort)
                received.fill(0)
                socket.destroy()
            }
            function fail(error: unknown) {
                if (settled) return
                settled = true
                cleanup()
                reject(error)
            }
            function abort() { fail(new EgressFailure("timeout")) }
            function finish(ended: boolean) {
                if (settled) return
                try {
                    const response = parseHttpResponse(received, method, maxResponseBytes, ended)
                    if (!response) return
                    settled = true
                    cleanup()
                    resolve(response)
                } catch (error) { fail(error) }
            }
            socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
                if (settled) return
                const address = socket.remoteAddress?.replace(/^::ffff:/, "")
                if (address !== pinned.address) { fail(new EgressFailure("connected_address_mismatch")); return }
                onConnected(address)
                void beforeSend().then(() => {
                    if (settled || signal.aborted) return
                    const requestHeaders = { ...headers, Host: url.host, Connection: "close", ...(body ? { "Content-Length": String(body.byteLength) } : {}), ...(authorization ? { Authorization: authorization } : {}) }
                    onStarted()
                    requestSent = true
                    const head = Buffer.from(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`)
                    socket.write(head, () => head.fill(0))
                    if (body) socket.write(body)
                }).catch(fail)
            })
            socket.on("data", (chunk: Buffer) => {
                if (settled) return
                if (!requestSent) { fail(new EgressFailure("response_before_request")); return }
                if (received.byteLength + chunk.byteLength > maxResponseBytes + 192 * 1024) { fail(new EgressFailure("response_body_limit")); return }
                const previous = received
                received = Buffer.concat([received, chunk])
                previous.fill(0)
                finish(false)
            })
            socket.on("error", fail)
            socket.on("end", () => { finish(true); if (!settled) fail(new EgressFailure("response_aborted")) })
            socket.on("close", () => { if (!settled) fail(new EgressFailure("response_aborted")) })
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
        })
    }
}

/** Strict bounded HTTP/1.1 framing; payload/headers never enter provenance. */
function parseHttpResponse(received: Buffer, method: string, maxBytes: number, ended: boolean): { statusCode: number; location?: string; bytes: Uint8Array } | undefined {
    const headerEnd = received.indexOf("\r\n\r\n")
    if (headerEnd < 0) {
        if (received.byteLength > 64 * 1024) throw new EgressFailure("response_header_limit")
        return
    }
    if (headerEnd > 64 * 1024) throw new EgressFailure("response_header_limit")
    const lines = received.subarray(0, headerEnd).toString("latin1").split("\r\n")
    const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(lines.shift() ?? "")
    if (!status) throw new EgressFailure("invalid_response")
    const statusCode = Number(status[1])
    const headers = new Map<string, string>()
    for (const line of lines) {
        const colon = line.indexOf(":")
        const name = line.slice(0, colon).toLowerCase()
        if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || headers.has(name) && ["content-length", "transfer-encoding", "location"].includes(name)) throw new EgressFailure("invalid_response")
        headers.set(name, line.slice(colon + 1).trim())
    }
    const payload = received.subarray(headerEnd + 4)
    if (statusCode < 200) {
        if (statusCode === 101) throw new EgressFailure("unsupported_upgrade")
        return parseHttpResponse(payload, method, maxBytes, ended)
    }
    const location = headers.get("location")
    const response = (bytes: Uint8Array) => ({ statusCode, ...(location ? { location } : {}), bytes })
    if (method === "HEAD" || statusCode === 204 || statusCode === 304) return response(new Uint8Array())
    const length = headers.get("content-length")
    const encoding = headers.get("transfer-encoding")
    if (encoding && length) throw new EgressFailure("invalid_response")
    if (encoding) {
        if (encoding.toLowerCase() !== "chunked") throw new EgressFailure("invalid_response")
        let offset = 0
        let total = 0
        const chunks: Buffer[] = []
        for (let count = 0; count < 8192; count += 1) {
            const lineEnd = payload.indexOf("\r\n", offset)
            if (lineEnd < 0) return
            const sizeText = payload.subarray(offset, lineEnd).toString("ascii").split(";")[0]!
            if (!/^[a-f0-9]{1,8}$/i.test(sizeText)) throw new EgressFailure("invalid_response")
            const size = Number.parseInt(sizeText, 16)
            total += size
            if (total > maxBytes) throw new EgressFailure("response_body_limit")
            offset = lineEnd + 2
            if (size === 0) {
                if (payload.subarray(offset, offset + 2).toString("ascii") === "\r\n" || payload.indexOf("\r\n\r\n", offset) >= 0) return response(Buffer.concat(chunks))
                return
            }
            if (payload.byteLength < offset + size + 2) return
            if (payload.subarray(offset + size, offset + size + 2).toString("ascii") !== "\r\n") throw new EgressFailure("invalid_response")
            chunks.push(payload.subarray(offset, offset + size))
            offset += size + 2
        }
        throw new EgressFailure("response_chunk_limit")
    }
    if (length !== undefined) {
        if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new EgressFailure("invalid_response")
        if (Number(length) > maxBytes) throw new EgressFailure("response_body_limit")
        if (payload.byteLength < Number(length)) return
        return response(Buffer.from(payload.subarray(0, Number(length))))
    }
    if (payload.byteLength > maxBytes) throw new EgressFailure("response_body_limit")
    if (ended) return response(Buffer.from(payload))
}

async function defaultResolveAddresses(hostname: string): Promise<readonly TaricEgressAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true })
    return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }))
}
