import { createHash } from "node:crypto"
import { TaricOperationError, TaricUnavailableError } from "./types"

export type GovernanceQueryKind = "context" | "work" | "resource" | "coverage" | "proposal" | "action"
export type GovernanceQueryStatus = "complete" | "unpinned" | "truncated" | "failed"
export type GovernanceQueryTruncationReason = "max_pages" | "max_records" | "max_bytes"

export interface GovernanceQueryLimits {
    maxPages: number
    maxRecords: number
    maxBytes: number
}

export interface GovernanceQueryBinding {
    principalId: string
    engagementId: string
    filters: Record<string, unknown>
    pageSize: number
    readSeq?: number
}

export interface GovernanceQueryDiagnostics {
    status: GovernanceQueryStatus
    kind: GovernanceQueryKind
    principalId: string
    engagementId: string
    filterDigest: string
    bindingDigest: string
    snapshotPinned: boolean
    pageSize: number
    pages: number
    records: number
    bytes: number
    duplicatesSuppressed: number
    hasMore: boolean
    continuationSafe: boolean
    readSeq?: number
    lastCursor?: string
    nextCursor?: string
    truncationReason?: GovernanceQueryTruncationReason
    errorCode?: string
    reconnectRequired: boolean
    /** A canonical recall view can omit valid domain records such as inconclusive Coverage. */
    visibility?: "recall_filtered" | "complete"
    /** True only when the projection can account for every requested domain record. */
    completeDomain?: boolean
}

export interface GovernanceQueryResult<T extends Record<string, unknown>> {
    records: T[]
    readSeq: number
    nextCursor?: string
    continuation?: GovernanceQueryContinuation
    diagnostics: GovernanceQueryDiagnostics
}

export interface GovernanceQueryContinuation {
    cursor: string
    readSeq: number
    bindingDigest: string
}

export interface GovernanceQueryPage<T extends Record<string, unknown>> {
    records: T[]
    readSeq: number
    nextCursor?: string
    hasMore?: boolean
}

export interface GovernanceQueryReaderOptions<T extends Record<string, unknown>> {
    kind: GovernanceQueryKind
    binding: GovernanceQueryBinding
    limits: GovernanceQueryLimits
    /** True only when the pinned Taric contract reads every page at the same authority snapshot. */
    snapshotPinned: boolean
    query: (input: Record<string, unknown>) => Promise<unknown>
    /** An opaque cursor supplied by a caller for the first page. */
    initialCursor?: string
    continuation?: GovernanceQueryContinuation
    /** The authority page key, e.g. records/items/cells/proposals. */
    pageKey: string
    /** Disable only when a higher-level projection applies a stricter filter. */
    enforceEngagement?: boolean
    /** Context uses `cursor`; other list operations use `next_cursor`. */
    cursorKey?: "cursor" | "next_cursor"
    /** Context has a character budget instead of page_size. */
    pageSizeInput?: string | false
    /** Context accepts an explicit read_seq; Resource accepts as_of. */
    readSeqInput?: "read_seq" | "as_of"
    parseRecord?: (value: unknown) => T
    compareRecords?: (left: T, right: T) => number
    onDiagnostics?: (diagnostics: GovernanceQueryDiagnostics) => void
}

const MAX_CURSOR_CHARS = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseData(value: unknown): unknown {
    if (!isRecord(value)) return value
    return value.data ?? value
}

function digest(value: unknown): string {
    const canonicalize = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(canonicalize)
        if (!isRecord(input)) return input
        return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]))
    }
    const json = JSON.stringify(canonicalize(value))
    return `sha256:${createHash("sha256").update(json).digest("hex")}`
}

function byteLength(value: unknown): number {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TaricOperationError("validation_error", "Taric query returned a non-serializable record")
    return new TextEncoder().encode(json).byteLength
}

function parsePage<T extends Record<string, unknown>>(value: unknown, options: GovernanceQueryReaderOptions<T>): GovernanceQueryPage<T> {
    const data = responseData(value)
    if (!isRecord(data)) throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned an invalid page`)
    const rawRecords = data[options.pageKey]
    if (!Array.isArray(rawRecords)) throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned an invalid ${options.pageKey} page`)
    const records = rawRecords.map((record) => options.parseRecord ? options.parseRecord(record) : record as T)
    if (records.some((record) => !isRecord(record))) throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned a non-record item`)
    if (records.some((record) => typeof record.id !== "string" || !record.id.trim())) throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned a record without an id`)
    if (options.enforceEngagement !== false && records.some((record) => typeof record.engagement_id === "string" && record.engagement_id !== options.binding.engagementId)) {
        throw new TaricOperationError("authorization_error", `Taric ${options.kind} query returned a record outside the bound Engagement`)
    }
    const readSeq = data.read_seq
    if (!Number.isSafeInteger(readSeq) || Number(readSeq) < 0) throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned an invalid read_seq`)
    const key = options.cursorKey ?? "next_cursor"
    const nextCursor = data[key]
    if (nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > MAX_CURSOR_CHARS)) {
        throw new TaricOperationError("invalid_cursor", `Taric ${options.kind} query returned an invalid continuation cursor`)
    }
    const hasMore = data.has_more
    if (hasMore !== undefined && typeof hasMore !== "boolean") throw new TaricOperationError("validation_error", `Taric ${options.kind} query returned invalid has_more`)
    if (hasMore === true && nextCursor === undefined) throw new TaricOperationError("invalid_cursor", `Taric ${options.kind} query reported more records without a continuation cursor`)
    if (hasMore === false && nextCursor !== undefined) throw new TaricOperationError("invalid_cursor", `Taric ${options.kind} query returned a cursor after exhaustion`)
    return { records, readSeq: Number(readSeq), ...(nextCursor === undefined ? {} : { nextCursor }), ...(hasMore === undefined ? {} : { hasMore }) }
}

function errorCode(error: unknown): string {
    if (error instanceof TaricOperationError) return error.code
    if (error instanceof TaricUnavailableError) return error.code
    return "query_failed"
}

function reconnectRequired(code: string): boolean {
    return code === "invalid_cursor" || code === "stale_version" || code === "conflict" || code === "unavailable_host" || code === "TARIC_UNAVAILABLE"
}

function assertLimits(limits: GovernanceQueryLimits): void {
    if (!Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1) throw new Error("maxPages must be a positive integer")
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1) throw new Error("maxRecords must be a positive integer")
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error("maxBytes must be a positive integer")
}

/**
 * Consume a bounded authority query. The adapter owns cursor signing and its
 * principal/Engagement/filter binding; this reader verifies that each page
 * keeps the same watermark and never presents a budget-truncated set as complete.
 */
export async function readGovernancePages<T extends Record<string, unknown>>(options: GovernanceQueryReaderOptions<T>): Promise<GovernanceQueryResult<T>> {
    assertLimits(options.limits)
    if (!options.binding.principalId.trim() || !options.binding.engagementId.trim()) throw new Error("principalId and engagementId are required")
    if (!Number.isSafeInteger(options.binding.pageSize) || options.binding.pageSize < 1) throw new Error("pageSize must be a positive integer")
    const bindingDigest = digest({
        kind: options.kind,
        principalId: options.binding.principalId,
        engagementId: options.binding.engagementId,
        filters: options.binding.filters,
        pageSize: options.binding.pageSize,
        limits: options.limits,
        snapshotPinned: options.snapshotPinned,
    })
    const diagnostics: GovernanceQueryDiagnostics = {
        status: "complete",
        kind: options.kind,
        principalId: options.binding.principalId,
        engagementId: options.binding.engagementId,
        filterDigest: digest(options.binding.filters),
        snapshotPinned: options.snapshotPinned,
        bindingDigest,
        pageSize: options.binding.pageSize,
        pages: 0,
        records: 0,
        bytes: 0,
        duplicatesSuppressed: 0,
        hasMore: false,
        continuationSafe: false,
        reconnectRequired: false,
    }
    try {
        if (options.initialCursor !== undefined && (typeof options.initialCursor !== "string" || !options.initialCursor.trim() || options.initialCursor.length > MAX_CURSOR_CHARS)) {
            throw new TaricOperationError("invalid_cursor", "governance initial cursor is invalid")
        }
        if (options.continuation && options.continuation.bindingDigest !== bindingDigest) throw new TaricOperationError("invalid_cursor", "governance continuation binding changed")
        if (options.continuation && (typeof options.continuation.cursor !== "string" || !options.continuation.cursor.trim() || !Number.isSafeInteger(options.continuation.readSeq) || options.continuation.readSeq < 0)) {
            throw new TaricOperationError("invalid_cursor", "governance continuation is invalid")
        }
        if (options.binding.readSeq !== undefined && options.continuation && options.binding.readSeq !== options.continuation.readSeq) {
            throw new TaricOperationError("invalid_cursor", "governance continuation read_seq changed")
        }
        if (options.initialCursor !== undefined && options.continuation && options.initialCursor !== options.continuation.cursor) {
            throw new TaricOperationError("invalid_cursor", "governance initial cursor conflicts with continuation")
        }
    } catch (error) {
        diagnostics.status = "failed"
        diagnostics.errorCode = errorCode(error)
        diagnostics.reconnectRequired = reconnectRequired(diagnostics.errorCode)
        diagnostics.lastCursor = options.continuation?.cursor
        options.onDiagnostics?.({ ...diagnostics })
        throw error
    }
    const records: T[] = []
    const seenRecords = new Set<string>()
    const seenCursors = new Set<string>()
    const compare = options.compareRecords ?? (options.kind === "context" ? undefined : (left: T, right: T) => String(left.id ?? "").localeCompare(String(right.id ?? "")))
    let cursor = options.continuation?.cursor ?? options.initialCursor
    let readSeq: number | undefined = options.binding.readSeq ?? options.continuation?.readSeq
    let previous: T | undefined
    try {
        while (diagnostics.pages < options.limits.maxPages) {
            diagnostics.lastCursor = cursor
            const input: Record<string, unknown> = {
                ...options.binding.filters,
                ...(options.pageSizeInput === false ? {} : { [options.pageSizeInput ?? "page_size"]: options.binding.pageSize }),
                ...(cursor ? { cursor } : {}),
            }
            if (readSeq !== undefined && options.readSeqInput) input[options.readSeqInput] = readSeq
            diagnostics.pages += 1
            const page = parsePage(await options.query(input), options)
            diagnostics.readSeq ??= page.readSeq
            if (readSeq === undefined) readSeq = page.readSeq
            if (page.readSeq !== readSeq) throw new TaricOperationError("conflict", `Taric ${options.kind} pagination changed read_seq`)
            diagnostics.nextCursor = page.nextCursor
            for (const record of page.records) {
                const id = typeof record.id === "string" && record.id.trim() ? record.id : JSON.stringify(record)
                if (seenRecords.has(id)) {
                    diagnostics.duplicatesSuppressed += 1
                    continue
                }
                if (previous && compare && compare(previous, record) > 0) throw new TaricOperationError("conflict", `Taric ${options.kind} pagination changed ordering`)
                const bytes = byteLength(record)
                if (diagnostics.records >= options.limits.maxRecords) {
                    diagnostics.status = "truncated"
                    diagnostics.hasMore = true
                    diagnostics.truncationReason = "max_records"
                    diagnostics.continuationSafe = false
                    diagnostics.nextCursor = undefined
                    options.onDiagnostics?.({ ...diagnostics })
                    return { records, readSeq, diagnostics }
                }
                if (diagnostics.bytes + bytes > options.limits.maxBytes) {
                    diagnostics.status = "truncated"
                    diagnostics.hasMore = true
                    diagnostics.truncationReason = "max_bytes"
                    diagnostics.continuationSafe = false
                    diagnostics.nextCursor = undefined
                    options.onDiagnostics?.({ ...diagnostics })
                    return { records, readSeq, diagnostics }
                }
                seenRecords.add(id)
                records.push(record)
                diagnostics.records += 1
                diagnostics.bytes += bytes
                previous = record
                options.onDiagnostics?.({ ...diagnostics })
            }
            if (page.nextCursor && diagnostics.records >= options.limits.maxRecords) {
                diagnostics.status = "truncated"
                diagnostics.hasMore = true
                diagnostics.truncationReason = "max_records"
                diagnostics.continuationSafe = true
                options.onDiagnostics?.({ ...diagnostics })
                return { records, readSeq, nextCursor: page.nextCursor, continuation: { cursor: page.nextCursor, readSeq, bindingDigest }, diagnostics }
            }
            if (!page.nextCursor) {
                diagnostics.status = options.snapshotPinned ? "complete" : "unpinned"
                diagnostics.hasMore = false
                diagnostics.continuationSafe = true
                options.onDiagnostics?.({ ...diagnostics })
                return { records, readSeq, diagnostics }
            }
            if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) throw new TaricOperationError("invalid_cursor", `Taric ${options.kind} query repeated a continuation cursor`)
            seenCursors.add(page.nextCursor)
            cursor = page.nextCursor
            diagnostics.hasMore = true
            diagnostics.continuationSafe = true
            options.onDiagnostics?.({ ...diagnostics })
        }
        diagnostics.status = "truncated"
        diagnostics.hasMore = true
        diagnostics.continuationSafe = Boolean(cursor)
        diagnostics.truncationReason = "max_pages"
        options.onDiagnostics?.({ ...diagnostics })
        return {
            records,
            readSeq: readSeq as number,
            ...(cursor ? { nextCursor: cursor, continuation: { cursor, readSeq: readSeq as number, bindingDigest } } : {}),
            diagnostics,
        }
    } catch (error) {
        diagnostics.status = "failed"
        diagnostics.errorCode = errorCode(error)
        diagnostics.reconnectRequired = reconnectRequired(diagnostics.errorCode)
        diagnostics.continuationSafe = false
        options.onDiagnostics?.({ ...diagnostics })
        throw error
    }
}
