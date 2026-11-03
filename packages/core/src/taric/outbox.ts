import { appendFile, mkdir } from "fs/promises"
import { dirname } from "path"
import { TARIC_OPERATION_CONTRACTS } from "./compatibility"

export type TaricOutboxEventStatus = "pending" | "replayed" | "conflict" | "accepted" | "deferred" | "rejected_validation" | "rejected_authorization" | "indeterminate" | "failed_permanent"

export interface TaricOutboxEvent<T = unknown> {
    eventId: string
    projectId: string
    sequence: number
    createdAt: string
    payload: T
    status: TaricOutboxEventStatus
    result?: unknown
    conflict?: string
    indeterminate?: string
    readSeq?: number
    replayedAt?: string
    attempts?: number
    lastError?: string
    operation?: string
    idempotencyKey?: string
    dispatchState?: "pre_dispatch" | "after_dispatch"
    automaticRetryBlocked?: boolean
    preDispatchRetries?: number
}

export interface TaricOutboxReplayResponse<TResult = unknown> {
    result: TResult
    /** The authority read watermark confirmed by the successful request. */
    readSeq: number
}

export interface TaricOutboxReplayOptions<TPayload = unknown, TResult = unknown> {
    projectId?: string
    apply: (event: TaricOutboxEvent<TPayload>) => Promise<TaricOutboxReplayResponse<TResult>>
    isConflict?: (error: unknown) => boolean
}

export interface TaricOutboxReplayResult<TResult = unknown> {
    eventId: string
    status: TaricOutboxEventStatus
    result?: TResult
    conflict?: string
    readSeq?: number
}

export interface TaricOutboxReplaySummary<TResult = unknown> {
    replayed: number
    conflicts: number
    stopped: boolean
    watermark: number
    results: TaricOutboxReplayResult<TResult>[]
}

export type TaricSubscriptionRefreshReason = "signal" | "reconnect" | "slow_consumer" | "token_revoked" | "manual"

export interface TaricSubscriptionRefresh<TRecord = unknown> {
    projectId: string
    afterReadSeq: number
    reason: TaricSubscriptionRefreshReason
}

export interface TaricSubscriptionRefreshResponse<TRecord = unknown> {
    records: readonly TRecord[]
    /** The authority watermark after applying the returned authoritative delta. */
    readSeq: number
}

export interface TaricSubscriptionRecoveryOptions<TRecord = unknown> {
    projectId: string
    initialReadSeq?: number
    query: (request: TaricSubscriptionRefresh<TRecord>) => Promise<TaricSubscriptionRefreshResponse<TRecord>>
    apply?: (response: TaricSubscriptionRefreshResponse<TRecord>) => Promise<void> | void
}

export type TaricSubscriptionRecoveryState = "idle" | "refreshing" | "healthy" | "degraded" | "closed"

export interface TaricSubscriptionRecoverySnapshot {
    projectId: string
    state: TaricSubscriptionRecoveryState
    confirmedReadSeq: number
    lastRefreshAt?: string
    lastError?: string
}

export interface TaricOutboxOptions {
    path: string
    key?: Uint8Array
    maxBytes?: number
    maxEvents?: number
    /** Protected host configuration values that must never enter ordinary records. */
    configurationSecrets?: readonly string[]
}

export class TaricOutboxError extends Error {
    readonly code: "TARIC_OUTBOX_KEY_UNAVAILABLE" | "TARIC_OUTBOX_FULL" | "TARIC_OUTBOX_CONFLICT" | "TARIC_OUTBOX_VALIDATION"

    constructor(code: TaricOutboxError["code"], message: string) {
        super(message)
        this.name = "TaricOutboxError"
        this.code = code
    }
}

interface StoredRecord {
    type: "append" | "status"
    eventId: string
    keyVersion: 1
    nonce: string
    ciphertext: string
}

interface StoredStatus {
    status: TaricOutboxEventStatus
    result?: unknown
    conflict?: string
    readSeq?: number
    replayedAt?: string
    attempts?: number
    lastError?: string
    indeterminate?: string
    dispatchState?: "pre_dispatch" | "after_dispatch"
    automaticRetryBlocked?: boolean
    preDispatchRetries?: number
}

function encode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url")
}

function decode(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64url"))
}

function requireKey(key: Uint8Array | undefined): Uint8Array {
    if (!key || key.byteLength !== 32) throw new TaricOutboxError("TARIC_OUTBOX_KEY_UNAVAILABLE", "Taric outbox encryption key is unavailable")
    return key
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function encrypt(value: unknown, key: Uint8Array): Promise<{ nonce: string; ciphertext: string }> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const cryptoKey = await crypto.subtle.importKey("raw", asArrayBuffer(key), "AES-GCM", false, ["encrypt"])
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(nonce) }, cryptoKey, asArrayBuffer(plaintext)))
    return { nonce: encode(nonce), ciphertext: encode(ciphertext) }
}

async function decrypt(record: StoredRecord, key: Uint8Array): Promise<unknown> {
    const cryptoKey = await crypto.subtle.importKey("raw", asArrayBuffer(key), "AES-GCM", false, ["decrypt"])
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asArrayBuffer(decode(record.nonce)) }, cryptoKey, asArrayBuffer(decode(record.ciphertext)))
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown
}

/** Encrypted JSONL transport buffer. Status changes append records and never rewrite history. */
export class EncryptedTaricOutbox {
    private readonly path: string
    private readonly key: Uint8Array | undefined
    private readonly maxBytes: number
    private readonly maxEvents: number
    private readonly configurationSecrets: readonly string[]
    private nextSequence = 1
    private appendQueue: Promise<void> = Promise.resolve()
    private replayQueue: Promise<void> = Promise.resolve()

    constructor(options: TaricOutboxOptions) {
        this.path = options.path
        this.key = options.key
        this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024
        this.maxEvents = options.maxEvents ?? 10_000
        this.configurationSecrets = [...options.configurationSecrets ?? []].filter(Boolean)
        if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("outbox maxBytes must be positive")
        if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) throw new Error("outbox maxEvents must be positive")
    }

    async append<T>(input: { eventId: string; projectId: string; payload: T; operation?: string; idempotencyKey?: string }): Promise<TaricOutboxEvent<T>> {
        return this.withAppendLock(async () => {
        const key = requireKey(this.key)
        const eventId = requiredText(input.eventId, "eventId")
        const projectId = requiredText(input.projectId, "projectId")
        const payloadRecord = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : undefined
        const operation = input.operation ?? (typeof payloadRecord?.operation === "string" ? payloadRecord.operation : undefined)
        const idempotencyKey = input.idempotencyKey
        if (input.operation !== undefined && typeof payloadRecord?.operation === "string" && input.operation !== payloadRecord.operation) throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Outbox operation does not match its payload")
        if (idempotencyKey !== undefined && !idempotencyKey.trim()) throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Outbox idempotency key is required")
        if (operation === "artifact.store.append" || operation === "artifact.ingest_file") throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Artifact payloads cannot enter the ordinary outbox")
        assertOrdinaryPayload(input.payload, this.configurationSecrets)
        const current = await this.list()
        if (current.some((event) => event.eventId === eventId)) {
            const existing = current.find((event) => event.eventId === eventId) as TaricOutboxEvent<T>
            if (existing.projectId !== projectId) throw new TaricOutboxError("TARIC_OUTBOX_CONFLICT", "eventId is already bound to another project")
            if (existing.operation !== operation || existing.idempotencyKey !== idempotencyKey) throw new TaricOutboxError("TARIC_OUTBOX_CONFLICT", "eventId is already bound to another operation or retry key")
            return existing
        }
        if (current.length >= this.maxEvents) throw new TaricOutboxError("TARIC_OUTBOX_FULL", "Taric outbox event limit reached")
        const event: TaricOutboxEvent<T> = {
            eventId,
            projectId,
            sequence: this.nextSequence++,
            createdAt: new Date().toISOString(),
            payload: input.payload,
            status: "pending",
            ...(operation ? { operation } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
        }
        const encrypted = await encrypt(event, key)
        const record: StoredRecord = { type: "append", eventId: event.eventId, keyVersion: 1, ...encrypted }
        const line = `${JSON.stringify(record)}\n`
        const file = Bun.file(this.path)
        const size = file.size
        if (size + Buffer.byteLength(line) > this.maxBytes) throw new TaricOutboxError("TARIC_OUTBOX_FULL", "Taric outbox byte limit reached")
        await mkdir(dirname(this.path), { recursive: true })
        await appendFile(this.path, line, { encoding: "utf8" })
        return event
        })
    }

    async list<T = unknown>(): Promise<TaricOutboxEvent<T>[]> {
        const key = requireKey(this.key)
        const file = Bun.file(this.path)
        if (!(await file.exists())) return []
        const records = (await file.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredRecord)
        const events = new Map<string, TaricOutboxEvent<T>>()
        for (const record of records) {
            if (record.keyVersion !== 1) throw new Error(`unsupported outbox key version: ${record.keyVersion}`)
            const value = (await decrypt(record, key)) as TaricOutboxEvent<T> | { status: TaricOutboxEventStatus; result?: unknown; conflict?: string }
            if (record.type === "append") events.set(record.eventId, value as TaricOutboxEvent<T>)
            else {
                const event = events.get(record.eventId)
                if (event) Object.assign(event, value)
            }
        }
        const result = [...events.values()].sort((a, b) => a.sequence - b.sequence)
        this.nextSequence = Math.max(this.nextSequence, ...result.map((item) => item.sequence + 1), 1)
        return result
    }

    async pending<T = unknown>(projectId?: string): Promise<TaricOutboxEvent<T>[]> {
        return (await this.list<T>()).filter((event) => (event.status === "pending" || event.status === "deferred") && (!projectId || event.projectId === projectId))
    }

    async markReplayed(eventId: string, result?: unknown): Promise<void> {
        assertOrdinaryPayload(result, this.configurationSecrets)
        await this.appendStatus(eventId, { status: "replayed", result, replayedAt: new Date().toISOString() })
    }

    async markConflict(eventId: string, conflict: string): Promise<void> {
        const diagnostic = safeDiagnostic(conflict, this.configurationSecrets)
        await this.appendStatus(eventId, { status: "conflict", conflict: diagnostic })
        throw new TaricOutboxError("TARIC_OUTBOX_CONFLICT", diagnostic)
    }

    /** Preserve an ambiguous non-idempotent write for operator reconciliation. */
    async markIndeterminate(eventId: string, reason: string): Promise<void> {
        const diagnostic = safeDiagnostic(reason, this.configurationSecrets)
        await this.appendStatus(eventId, { status: "indeterminate", indeterminate: diagnostic, lastError: diagnostic, automaticRetryBlocked: true })
    }

    /** Record a confirmed authority disposition without scheduling automatic replay. */
    async markOutcome(eventId: string, status: "accepted" | "rejected_validation" | "rejected_authorization" | "failed_permanent"): Promise<void> {
        await this.appendStatus(eventId, { status, automaticRetryBlocked: true })
    }

    /**
     * Replays pending events in sequence order. A conflict stops the queue so
     * later events cannot overtake a stale authority version. Already replayed
     * events are returned from the stored result without invoking `apply`.
     */
    async replayOrdered<TPayload = unknown, TResult = unknown>(options: TaricOutboxReplayOptions<TPayload, TResult>): Promise<TaricOutboxReplaySummary<TResult>> {
        const projectId = options.projectId?.trim()
        return this.withReplayLock(async () => {
            const events = await this.list<TPayload>()
            const matching = events.filter((event) => !projectId || event.projectId === projectId)
            const results: TaricOutboxReplayResult<TResult>[] = []
            let replayed = 0
            let conflicts = 0
            let stopped = false
            let watermark = matching.reduce((max, event) => Math.max(max, event.readSeq ?? 0), 0)
            for (const event of matching) {
                if (event.status === "replayed" || event.status === "accepted") {
                    results.push({ eventId: event.eventId, status: event.status, result: event.result as TResult, ...(event.readSeq !== undefined ? { readSeq: event.readSeq } : {}) })
                    continue
                }
                if (event.status === "conflict") {
                    results.push({ eventId: event.eventId, status: "conflict", conflict: event.conflict ?? "outbox event is in conflict" })
                    conflicts += 1
                    stopped = true
                    break
                }
                if (event.status === "indeterminate" || event.status === "rejected_validation" || event.status === "rejected_authorization" || event.status === "failed_permanent" || event.automaticRetryBlocked) {
                    results.push({ eventId: event.eventId, status: event.status, conflict: event.indeterminate ?? event.lastError ?? "outbox event requires operator reconciliation" })
                    stopped = true
                    break
                }
                const contract = TARIC_OPERATION_CONTRACTS.find((item) => item.operation === event.operation)
                const replaySafe = contract?.idempotent === true && contract.replayPolicy === "idempotent_replay" && Boolean(event.idempotencyKey)
                // A durable dispatch marker also handles a process crash before acknowledgement.
                if (event.dispatchState === "after_dispatch" && !replaySafe) {
                    await this.markIndeterminate(event.eventId, "Previous non-idempotent dispatch requires reconciliation")
                    results.push({ eventId: event.eventId, status: "indeterminate" })
                    stopped = true
                    break
                }
                if ((event.attempts ?? 0) >= 2) {
                    await this.appendStatus(event.eventId, { status: "deferred", automaticRetryBlocked: true, lastError: "Bounded dispatch retry budget is exhausted" })
                    results.push({ eventId: event.eventId, status: "deferred" })
                    stopped = true
                    break
                }
                let retry = true
                while (retry) {
                    retry = false
                    event.attempts = (event.attempts ?? 0) + 1
                    await this.appendStatus(event.eventId, { status: "deferred", dispatchState: "after_dispatch", attempts: event.attempts, preDispatchRetries: event.preDispatchRetries ?? 0 })
                    try {
                        const response = await options.apply(event)
                        validateReadSeq(response.readSeq)
                        if (response.readSeq < watermark) throw new Error("Taric replay read_seq moved backwards")
                        assertOrdinaryPayload(response.result, this.configurationSecrets)
                        await this.appendStatus(event.eventId, {
                            status: "replayed", result: response.result, readSeq: response.readSeq,
                            replayedAt: new Date().toISOString(), automaticRetryBlocked: true,
                        })
                        watermark = response.readSeq
                        replayed += 1
                        results.push({ eventId: event.eventId, status: "replayed", result: response.result, readSeq: response.readSeq })
                    } catch (error) {
                        const code = errorCode(error)
                        const diagnostic = `Taric outbox dispatch: ${code}`
                        const preDispatch = isPreDispatch(error)
                        let status: TaricOutboxEventStatus
                        if (isOutboxConflict(error, options.isConflict)) {
                            status = "conflict"
                            conflicts += 1
                        } else if (["validation_error", "TARIC_OUTBOX_VALIDATION"].includes(code)) status = "rejected_validation"
                        else if (["authorization_error", "forbidden", "unauthorized"].includes(code)) status = "rejected_authorization"
                        else if (preDispatch) {
                            event.preDispatchRetries = (event.preDispatchRetries ?? 0) + 1
                            retry = event.preDispatchRetries <= 1
                            status = "deferred"
                        } else if (replaySafe && isTransient(code, contract?.transientErrors)) {
                            retry = event.attempts < 2
                            status = "deferred"
                        } else if (contract?.permanentErrors.includes(code)) status = "failed_permanent"
                        else status = "indeterminate"
                        await this.appendStatus(event.eventId, {
                            status, lastError: diagnostic, dispatchState: preDispatch ? "pre_dispatch" : "after_dispatch",
                            preDispatchRetries: event.preDispatchRetries ?? 0, automaticRetryBlocked: !retry,
                            ...(status === "indeterminate" ? { indeterminate: diagnostic } : {}),
                            ...(status === "conflict" ? { conflict: diagnostic } : {}),
                        })
                        if (!retry) {
                            results.push({ eventId: event.eventId, status, conflict: diagnostic })
                            stopped = true
                        }
                    }
                }
                if (stopped) break
            }
            return {
                replayed,
                conflicts,
                stopped,
                watermark,
                results,
            }
        })
    }

    /** Return the greatest authority watermark confirmed for the project. */
    async confirmedReadSeq(projectId?: string): Promise<number> {
        const project = projectId?.trim()
        return (await this.list()).reduce((max, event) => {
            if (project && event.projectId !== project) return max
            return Math.max(max, event.readSeq ?? 0)
        }, 0)
    }

    private async appendStatus(eventId: string, status: StoredStatus): Promise<void> {
        await this.withAppendLock(async () => {
        const key = requireKey(this.key)
        const events = await this.list()
        if (!events.some((event) => event.eventId === eventId)) throw new Error(`outbox event "${eventId}" not found`)
        const encrypted = await encrypt(status, key)
        const record: StoredRecord = { type: "status", eventId, keyVersion: 1, ...encrypted }
        const line = `${JSON.stringify(record)}\n`
        const file = Bun.file(this.path)
        if (file.size + Buffer.byteLength(line) > this.maxBytes) throw new TaricOutboxError("TARIC_OUTBOX_FULL", "Taric outbox byte limit reached")
        await appendFile(this.path, line, { encoding: "utf8" })
        })
    }

    private async withAppendLock<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.appendQueue
        let release = () => {}
        this.appendQueue = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await action()
        } finally {
            release()
        }
    }

    private async withReplayLock<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.replayQueue
        let release = () => {}
        this.replayQueue = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await action()
        } finally {
            release()
        }
    }
}

/**
 * Subscription notifications are hints. This helper always queries the
 * authority from the last confirmed watermark and coalesces signals received
 * while a recovery query is in flight.
 */
export class TaricSubscriptionRecovery<TRecord = unknown> {
    private readonly options: TaricSubscriptionRecoveryOptions<TRecord>
    private stateValue: TaricSubscriptionRecoveryState = "idle"
    private confirmedReadSeqValue: number
    private lastRefreshAtValue: string | undefined
    private lastErrorValue: string | undefined
    private refreshAgain = false
    private nextReason: TaricSubscriptionRefreshReason = "signal"
    private refreshPromise: Promise<TaricSubscriptionRefreshResponse<TRecord>> | undefined

    constructor(options: TaricSubscriptionRecoveryOptions<TRecord>) {
        const projectId = requiredText(options.projectId, "projectId")
        const initialReadSeq = options.initialReadSeq ?? 0
        validateReadSeq(initialReadSeq)
        this.options = { ...options, projectId }
        this.confirmedReadSeqValue = initialReadSeq
    }

    snapshot(): TaricSubscriptionRecoverySnapshot {
        return {
            projectId: this.options.projectId,
            state: this.stateValue,
            confirmedReadSeq: this.confirmedReadSeqValue,
            ...(this.lastRefreshAtValue ? { lastRefreshAt: this.lastRefreshAtValue } : {}),
            ...(this.lastErrorValue ? { lastError: this.lastErrorValue } : {}),
        }
    }

    get confirmedReadSeq(): number {
        return this.confirmedReadSeqValue
    }

    /** Request an authoritative refresh. Duplicate signals are safe. */
    notify(reason: TaricSubscriptionRefreshReason = "signal"): Promise<TaricSubscriptionRefreshResponse<TRecord>> {
        if (this.stateValue === "closed") return Promise.reject(new Error("Taric subscription recovery is closed"))
        if (this.refreshPromise) {
            this.refreshAgain = true
            this.nextReason = reason
            return this.refreshPromise
        }
        this.nextReason = reason
        this.refreshPromise = this.drain(reason)
        return this.refreshPromise
    }

    async close(): Promise<void> {
        this.stateValue = "closed"
        this.refreshAgain = false
        await this.refreshPromise?.catch(() => {})
    }

    private async drain(reason: TaricSubscriptionRefreshReason): Promise<TaricSubscriptionRefreshResponse<TRecord>> {
        this.stateValue = "refreshing"
        let latest: TaricSubscriptionRefreshResponse<TRecord> | undefined
        try {
            do {
                this.refreshAgain = false
                const request: TaricSubscriptionRefresh<TRecord> = {
                    projectId: this.options.projectId,
                    afterReadSeq: this.confirmedReadSeqValue,
                    reason: this.nextReason,
                }
                const response = await this.options.query(request)
                if ((this.stateValue as TaricSubscriptionRecoveryState) === "closed") {
                    latest = response
                    break
                }
                validateReadSeq(response.readSeq)
                if (!Array.isArray(response.records)) throw new Error("Taric subscription query must return records")
                if (response.readSeq < this.confirmedReadSeqValue) throw new Error("Taric subscription read_seq moved backwards")
                await this.options.apply?.(response)
                this.confirmedReadSeqValue = response.readSeq
                this.lastRefreshAtValue = new Date().toISOString()
                this.lastErrorValue = undefined
                this.stateValue = "healthy"
                latest = response
                reason = this.nextReason
            } while (this.refreshAgain)
            if (!latest) throw new Error("Taric subscription recovery closed before a refresh completed")
            return latest
        } catch (error) {
            this.stateValue = "degraded"
            this.lastErrorValue = error instanceof Error ? error.message : String(error)
            throw error
        } finally {
            this.refreshPromise = undefined
        }
    }
}

export const TaricOutbox = EncryptedTaricOutbox

function requiredText(value: string, field: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${field} is required`)
    return text
}

function validateReadSeq(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("readSeq must be a non-negative safe integer")
}

function isOutboxConflict(error: unknown, predicate?: (error: unknown) => boolean): boolean {
    if (predicate) return predicate(error)
    if (error instanceof TaricOutboxError && error.code === "TARIC_OUTBOX_CONFLICT") return true
    if (!error || typeof error !== "object") return false
    const code = (error as { code?: unknown }).code
    return code === "conflict" || code === "idempotency_conflict" || code === "stale_version"
}

function errorCode(error: unknown): string {
    if (!error || typeof error !== "object") return "transport_error"
    const code = (error as { code?: unknown }).code
    return typeof code === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(code) ? code : "transport_error"
}

function isPreDispatch(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && (error as { dispatchState?: unknown }).dispatchState === "pre_dispatch")
}

function isTransient(code: string, declared: readonly string[] = []): boolean {
    return declared.includes(code) || code === "TARIC_UNAVAILABLE"
}

function safeDiagnostic(value: string, secrets: readonly string[]): string {
    let result = value
    for (const secret of secrets) result = result.split(secret).join("<redacted>")
    return result.replace(/Bearer\s+[^\s,;]+/gi, "Bearer <redacted>")
        .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi, "<redacted private key>")
        .replace(/((?:api[_-]?key|token|password|secret|credential|authorization|cookie|connection[_-]?string|database[_-]?url|registry[_-]?key|outbox[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1<redacted>@")
        .replace(/flag\{[^}]*\}/gi, "<redacted>").slice(0, 512)
}

function assertOrdinaryPayload(value: unknown, secrets: readonly string[]): void {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return
    if (secrets.some((secret) => serialized.includes(secret))) throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Configuration secrets cannot enter the ordinary outbox")
    function inspect(item: unknown): void {
        if (typeof item === "string" && /(?:flag\{[^}]*\}|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:password|secret|token|cookie|authorization|credential|api[_-]?key|private[_-]?key|registry[_-]?key|outbox[_-]?key|database[_-]?url|connection[_-]?string)\s*[=:]\s*[^\s,;]+|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s]+@|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/i.test(item)) throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Sensitive values cannot enter the ordinary outbox")
        if (!item || typeof item !== "object") return
        for (const [key, child] of Object.entries(item)) {
            if (/^(?:password|secret|token|authorization|cookie|credential|credential_bytes|api[_-]?key|private[_-]?key|registry[_-]?key|outbox[_-]?key|database[_-]?url|connection[_-]?string|artifact_payload|full_response|full_prompt)$/i.test(key)) throw new TaricOutboxError("TARIC_OUTBOX_VALIDATION", "Sensitive fields cannot enter the ordinary outbox")
            inspect(child)
        }
    }
    inspect(value)
}
