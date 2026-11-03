import { join } from "node:path"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface FixtureAuthority {
    dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>
}

function row(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scope fixture returned an invalid object")
    return value as Record<string, unknown>
}

function must(value: unknown): Record<string, unknown> {
    const response = row(value)
    if (response.ok !== true) throw new TaricOperationError(String(row(response.error).code), "Scope fixture operation rejected")
    return row(response.data)
}

/** Explicit local fixture operator; approval is issued through the real public contract. */
export async function approveFixtureScope(input: {
    authority: FixtureAuthority
    operator: unknown
    engagement: Record<string, unknown>
    contentRoot: string
    allowedTargets?: string[]
    ports?: number[]
}): Promise<{ scope: Record<string, unknown>; revision: Record<string, unknown> }> {
    const engagementId = String(input.engagement.id)
    const sessionId = `fixture-roe-${engagementId}`
    const dispatch = async (operation: string, request: Record<string, unknown>) => must(await input.authority.dispatch(operation, input.operator, { engagement_id: engagementId, ...request }))
    await dispatch("artifact.session.bind", { session_id: sessionId, root: join(input.contentRoot, sessionId), mode: "host-session" })
    const bytes = new TextEncoder().encode("Approved synthetic local fixture ROE. Loopback test services only; no external traffic authorization.")
    const hash = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
    const upload = await dispatch("artifact.store.begin", { session_id: sessionId, payload_kind: "text", media_type: "text/plain", expected_bytes: bytes.length, expected_hash: hash, category: "evidence", storage_mode: "taric_stored", idempotency_key: `${sessionId}:begin` })
    await dispatch("artifact.store.append", { session_id: sessionId, upload_id: upload.upload_id, ordinal: 0, data: Buffer.from(bytes).toString("base64"), encoding: "base64", chunk_hash: hash, idempotency_key: `${sessionId}:append` })
    const artifact = await dispatch("artifact.store.commit", { session_id: sessionId, upload_id: upload.upload_id, total_bytes: bytes.length, chunk_count: 1, content_hash: hash, idempotency_key: `${sessionId}:commit` })
    const result = await dispatch("scope.revise", {
        scope_id: input.engagement.scope_ref, expected_version: 1,
        policy: {
            allowed_targets: input.allowedTargets ?? ["127.0.0.1"], excluded_targets: [], protocols: ["http"],
            ports: (input.ports ?? [80]).map((port) => ({ from: port, to: port })), methods: ["GET", "HEAD", "POST"],
            dns: { require_pinned_addresses: true, reject_private_addresses: false, max_addresses: 8 },
            redirects: { max_hops: 2, same_scope_only: true },
            valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2030-01-01T00:00:00.000Z",
        },
        roe_artifact_ref: artifact.content_ref, roe_artifact_version: artifact.version, idempotency_key: `${sessionId}:approve`,
    })
    return { scope: row(result.scope), revision: row(result.revision) }
}
