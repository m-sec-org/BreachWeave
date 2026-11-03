import { describe, expect, test } from "bun:test"
import type { TaricArtifactEgressGrant } from "./artifact-service"
import { TaricArtifactService } from "./artifact-service"
import { TaricOperationError } from "./types"

const ENGAGEMENT_ID = "019a0000-0000-7000-8000-000000000001"
const ARTIFACT_ID = "019a0000-0000-7000-8000-000000000002"
const UPLOAD_ID = "019a0000-0000-7000-8000-000000000003"
const WORK_RUN_ID = "019a0000-0000-7000-8000-000000000004"
const ATTEMPT_ID = "019a0000-0000-7000-8000-000000000005"
const CONTENT_REF = `${ARTIFACT_ID}@v1`
const CONFIGURATION_SECRETS = [
    "gateway-fixture-token",
    "postgres://fixture:database-fixture-password@db.invalid/app",
    "-----BEGIN PRIVATE KEY-----\nfixture-tls-key\n-----END PRIVATE KEY-----",
    "registry-signing-key-fixture",
    "outbox-encryption-key-fixture",
    "session-cookie-fixture",
]

function digest(bytes: Uint8Array): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
}

/** Contract fixture, not an assertion of live Taric restart durability. */
function fixture() {
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = []
    const chunks: Buffer[] = []
    let beginInput: Record<string, unknown> | undefined
    let metadata: Record<string, unknown> | undefined
    let failCommitAcknowledgement = false
    const host = {
        getBinding() { return { engagementId: ENGAGEMENT_ID, hostPrincipalId: "host-1", modelPrincipalId: "model-1", projectId: "project-1", tenantId: "tenant-1" } },
        async invokeHost(operation: string, input: Record<string, unknown>): Promise<unknown> {
            calls.push({ operation, input })
            if (operation === "artifact.session.bind") {
                if (input.mode === "run-bound" && input.generation !== 2) throw new TaricOperationError("stale_version", "stale fence")
                return input
            }
            if (operation === "artifact.store.begin") {
                if (beginInput && JSON.stringify(beginInput) !== JSON.stringify(input)) throw new TaricOperationError("idempotency_conflict", "upload identity changed")
                beginInput = input
                return { upload_id: UPLOAD_ID, artifact_id: ARTIFACT_ID, version: 1, max_chunk_bytes: 16_384 }
            }
            if (operation === "artifact.store.append") {
                if (metadata) throw new TaricOperationError("unavailable_host", "upload is no longer active")
                const bytes = Buffer.from(String(input.data), "base64")
                expect(digest(bytes)).toBe(String(input.chunk_hash))
                chunks[Number(input.ordinal)] = bytes
                return { next_ordinal: chunks.length }
            }
            if (operation === "artifact.store.commit") {
                if (metadata) return metadata
                const bytes = Buffer.concat(chunks)
                if (bytes.byteLength !== input.total_bytes || chunks.length !== input.chunk_count) throw new TaricOperationError("conflict", "upload byte or chunk count mismatch")
                metadata = {
                    engagement_id: ENGAGEMENT_ID, session_id: input.session_id, artifact_id: ARTIFACT_ID, version: 1, content_ref: CONTENT_REF,
                    category: beginInput?.category, storage_mode: "taric_stored", content_status: "available", integrity_status: "verified",
                    payload_kind: beginInput?.payload_kind, media_type: beginInput?.media_type,
                    byte_length: bytes.byteLength, content_hash: digest(bytes), manifest_hash: digest(new TextEncoder().encode("fixture manifest")),
                    data: "forbidden-response-payload", root: "/private/spool", summary: "forbidden-summary",
                    ...(beginInput?.work_run_id === undefined ? {} : { work_run_id: beginInput.work_run_id, attempt_id: beginInput.attempt_id, generation: beginInput.generation, owner_host: "host-1" }),
                }
                if (failCommitAcknowledgement) {
                    failCommitAcknowledgement = false
                    throw new Error("lost commit acknowledgement")
                }
                return metadata
            }
            if (operation === "artifact.metadata") {
                if (!metadata) throw new TaricOperationError("unavailable_host", "content is unavailable")
                return metadata
            }
            if (operation === "artifact.content.read") {
                if (!metadata) throw new TaricOperationError("unavailable_host", "content is unavailable")
                const bytes = Buffer.concat(chunks)
                const offset = Number(input.offset)
                const chunk = bytes.subarray(offset, offset + Number(input.length ?? bytes.byteLength))
                return { content_ref: CONTENT_REF, content_hash: metadata.content_hash, byte_offset: offset, byte_length: chunk.byteLength, encoding: "base64", data: chunk.toString("base64"), chunk_verified: true, integrity_status: "verified" }
            }
            throw new Error("Unexpected fixture operation")
        },
    }
    const grant: TaricArtifactEgressGrant = { principalId: "host-1", engagementId: ENGAGEMENT_ID, capability: "content_read" }
    return {
        host, calls, grant,
        service: new TaricArtifactService({ host, egressGrant: grant, chunkBytes: 4, configurationSecrets: CONFIGURATION_SECRETS }),
        setMetadata(patch: Record<string, unknown>) { if (metadata) Object.assign(metadata, patch) },
        loseCommitAcknowledgement() { failCommitAcknowledgement = true },
    }
}

const upload = { sessionId: "task-1", requestId: "credential-1", payloadKind: "text" as const, mediaType: "text/plain", payload: "fixture-target-password" }

describe("Taric Artifact service", () => {
    test("rejects configuration inventory values in every metadata and binding path before dispatch", async () => {
        const { service, calls } = fixture()
        const canary = CONFIGURATION_SECRETS[0]!
        for (const patch of [{ sessionId: canary }, { requestId: canary }, { mediaType: `text/${canary}` }]) {
            await expect(service.storeTargetAuth({ ...upload, ...patch })).rejects.toThrow("configuration secrets")
            await expect(service.storeArtifact({ ...upload, category: "evidence", ...patch })).rejects.toThrow("configuration secrets")
        }
        await expect(service.bindSession({ sessionId: canary, root: "/safe/root", mode: "host-session" })).rejects.toThrow("configuration secrets")
        await expect(service.bindSession({ sessionId: "safe-session", root: `/safe/${canary}`, mode: "host-session" })).rejects.toThrow("configuration secrets")
        await expect(service.metadata(canary, CONTENT_REF)).rejects.toThrow("configuration secrets")
        await expect(service.metadata(upload.sessionId, canary)).rejects.toThrow("configuration secrets")
        expect(calls).toHaveLength(0)
    })

    test("rejects inventory values in allowed returned metadata instead of projecting a secret", async () => {
        const { service, setMetadata } = fixture()
        await service.storeTargetAuth(upload)
        setMetadata({ category: CONFIGURATION_SECRETS[0] })
        await expect(service.metadata(upload.sessionId, CONTENT_REF)).rejects.toThrow("configuration secrets")
    })
    test("stores ordinary evidence and reports without admitting Evidence or crossing the credential channel", async () => {
        const { service, calls } = fixture()
        const stored = await service.storeArtifact({ ...upload, category: "evidence", payload: "ordinary evidence" })
        expect(stored).toMatchObject({ category: "evidence", payloadKind: "text", storageMode: "taric_stored" })
        let read = ""
        await service.consumeArtifact({ sessionId: upload.sessionId, contentRef: stored.contentRef }, async (bytes) => { read = new TextDecoder().decode(bytes) })
        expect(read).toBe("ordinary evidence")
        await expect(service.consumeTargetAuth({ sessionId: upload.sessionId, contentRef: stored.contentRef }, async () => {})).rejects.toThrow("execution channel")
        expect(calls.some((call) => /proposal|capture|admit|evidence/.test(call.operation))).toBe(false)
        const target = fixture()
        await target.service.storeTargetAuth(upload)
        await expect(target.service.consumeArtifact({ sessionId: upload.sessionId, contentRef: CONTENT_REF }, async () => {})).rejects.toThrow("execution channel")
        await expect(service.storeArtifact({ ...upload, category: "target-auth" } as never)).rejects.toThrow("category")
        await expect(service.storeArtifact({ ...upload, category: "report", storageMode: "external" } as never)).rejects.toThrow("Taric-managed")
    })

    test("checks host retention policy before reading bytes and records only verified commits", async () => {
        const { host, grant, calls } = fixture()
        let committed = false
        const service = new TaricArtifactService({ host, egressGrant: grant, onCommitted: () => { committed = true }, assertReadable: () => { throw new Error("retention expired") } })
        await service.storeArtifact({ ...upload, category: "report" })
        expect(committed).toBe(true)
        await expect(service.consumeArtifact({ sessionId: upload.sessionId, contentRef: CONTENT_REF }, async () => {})).rejects.toThrow("retention expired")
        expect(calls.some((call) => call.operation === "artifact.content.read")).toBe(false)
    })

    test("projects complete run provenance and rejects partial or mismatched upload metadata", async () => {
        const { service, setMetadata } = fixture()
        await service.storeArtifact({ ...upload, category: "report" })
        setMetadata({ work_run_id: WORK_RUN_ID, attempt_id: ATTEMPT_ID, generation: 2, owner_host: "host-1" })
        expect(await service.metadata(upload.sessionId, CONTENT_REF)).toMatchObject({ workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "host-1" })
        setMetadata({ attempt_id: null })
        await expect(service.metadata(upload.sessionId, CONTENT_REF)).rejects.toThrow("attempt_id")
        setMetadata({ work_run_id: null, generation: null, owner_host: null, media_type: "application/octet-stream" })
        await expect(service.storeArtifact({ ...upload, category: "report" })).rejects.toThrow("upload identity")
    })
    test("requires explicit session mode and delegates run fencing to Taric", async () => {
        const { service, calls } = fixture()
        await expect(service.bindSession({ sessionId: "task-1", root: "/content/task-1", mode: "host-session", workRunId: WORK_RUN_ID } as never)).rejects.toThrow("cannot include run")
        expect(calls).toHaveLength(0)
        await service.bindSession({ sessionId: "task-1", root: "/content/task-1", mode: "host-session" })
        await expect(service.bindSession({ sessionId: "task-2", root: "/content/task-2", mode: "run-bound", workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 1, ownerHost: "host-1" })).rejects.toMatchObject({ code: "stale_version" })
        await service.bindSession({ sessionId: "task-2", root: "/content/task-2", mode: "run-bound", workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "host-1" })
        await expect(service.bindSession({ sessionId: "task-2", root: "/content/task-2", mode: "run-bound", workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "other-host" })).rejects.toThrow("trusted host")
    })

    test("run-bound publication carries its fence and suppresses a superseded commit acknowledgement", async () => {
        const { host, calls, setMetadata } = fixture()
        let published = 0
        const service = new TaricArtifactService({ host, onCommitted: () => { published += 1 } })
        await service.bindSession({ sessionId: upload.sessionId, root: "/content/task-1", mode: "run-bound", workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "host-1" })
        await expect(service.storeArtifact({ ...upload, category: "evidence" })).resolves.toMatchObject({ workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "host-1" })
        expect(calls.find((call) => call.operation === "artifact.store.begin")?.input).toMatchObject({ work_run_id: WORK_RUN_ID, attempt_id: ATTEMPT_ID, generation: 2 })
        setMetadata({ generation: 3 })
        await expect(service.storeArtifact({ ...upload, category: "evidence" })).rejects.toThrow("active WorkRun fence")
        expect(published).toBe(1)
    })

    test("partial and substituted publication fences fail before uploading bytes", async () => {
        const { service, calls } = fixture()
        await expect(service.storeArtifact({ ...upload, category: "evidence", workRunId: WORK_RUN_ID })).rejects.toThrow("requires workRunId")
        await expect(service.storeArtifact({ ...upload, category: "evidence", workRunId: WORK_RUN_ID, attemptId: ATTEMPT_ID, generation: 2, ownerHost: "other-host" })).rejects.toThrow("trusted host")
        expect(calls).toHaveLength(0)
    })

    test("uses bounded opaque upload operations and projects only committed metadata", async () => {
        const { service, calls } = fixture()
        const metadata = await service.storeTargetAuth(upload)
        expect(metadata).toMatchObject({ contentRef: CONTENT_REF, category: "target-auth", storageMode: "taric_stored", byteLength: upload.payload.length })
        expect(JSON.stringify(metadata)).not.toMatch(/fixture-target-password|forbidden-response|private\/spool|forbidden-summary/)
        expect(calls.find((call) => call.operation === "artifact.store.begin")?.input).toMatchObject({ category: "target-auth", storage_mode: "taric_stored", expected_hash: digest(new TextEncoder().encode(upload.payload)), idempotency_key: "credential-1:begin" })
        expect(calls.filter((call) => call.operation === "artifact.store.append").every((call) => Buffer.from(String(call.input.data), "base64").byteLength <= 4)).toBe(true)
        expect(calls.filter((call) => call.operation !== "artifact.store.append").every((call) => !JSON.stringify(call.input).includes(upload.payload))).toBe(true)
    })

    test("resolves confirmed and lost-acknowledgement retries to the same durable upload identity", async () => {
        const { service, host, calls, loseCommitAcknowledgement } = fixture()
        loseCommitAcknowledgement()
        await expect(service.storeTargetAuth(upload)).rejects.toThrow("lost commit acknowledgement")
        const appendCount = calls.filter((call) => call.operation === "artifact.store.append").length
        const replacement = new TaricArtifactService({ host, chunkBytes: 4 })
        const metadata = await replacement.storeTargetAuth(upload)
        expect(metadata.contentRef).toBe(CONTENT_REF)
        expect(await replacement.storeTargetAuth(upload)).toEqual(metadata)
        expect(calls.filter((call) => call.operation === "artifact.store.append")).toHaveLength(appendCount)
        await expect(replacement.storeTargetAuth({ ...upload, payload: "different target password" })).rejects.toMatchObject({ code: "idempotency_conflict" })
    })

    test("rejects external references, configuration secrets, private keys and oversized payloads before dispatch", async () => {
        const { service, calls, host } = fixture()
        await expect(service.storeTargetAuth({ ...upload, storageMode: "external" } as never)).rejects.toThrow("Taric-managed")
        await expect(service.storeTargetAuth({ ...upload, hostRef: "/tmp/credential" } as never)).rejects.toThrow("unapproved")
        for (const secret of CONFIGURATION_SECRETS) {
            let rejection: unknown
            try {
                await service.storeTargetAuth({ ...upload, payload: secret })
            } catch (error) {
                rejection = error
            }
            expect(rejection).toBeInstanceOf(Error)
            expect(String(rejection)).toContain("configuration secrets")
            expect(String(rejection)).not.toContain(secret)
        }
        await expect(new TaricArtifactService({ host, maxPayloadBytes: 4 }).storeTargetAuth(upload)).rejects.toThrow("host limit")
        expect(calls).toHaveLength(0)
    })

    test("keeps host configuration credentials out of ordinary Artifact metadata", async () => {
        const { service, setMetadata } = fixture()
        const stored = await service.storeTargetAuth(upload)
        setMetadata({
            gateway_token: "fixture-gateway-token",
            database_url: CONFIGURATION_SECRETS[1],
            tls_private_key: CONFIGURATION_SECRETS[2],
            registry_key: CONFIGURATION_SECRETS[3],
            outbox_key: CONFIGURATION_SECRETS[4],
            cookie: CONFIGURATION_SECRETS[5],
        })
        const ordinaryMetadata = await service.metadata("task-1", stored.contentRef)
        const serialized = JSON.stringify(ordinaryMetadata)
        for (const secret of [...CONFIGURATION_SECRETS, "fixture-target-password"]) {
            expect(serialized).not.toContain(secret)
        }
    })

    test("requires an explicit same-Engagement host grant and denies an uncommitted read", async () => {
        const { host, grant, service, calls } = fixture()
        let called = false
        const consume = async () => { called = true }
        await expect(new TaricArtifactService({ host }).consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, consume)).rejects.toThrow("content_read")
        await expect(new TaricArtifactService({ host, egressGrant: { ...grant, engagementId: "other-engagement" } }).consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, consume)).rejects.toThrow("content_read")
        await expect(new TaricArtifactService({ host, egressGrant: { ...grant, principalId: "model-1" } }).consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, consume)).rejects.toThrow("content_read")
        await expect(service.consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, consume)).rejects.toMatchObject({ code: "unavailable_host" })
        expect(called).toBe(false)
        expect(calls.filter((call) => call.operation === "artifact.content.read")).toHaveLength(0)
    })

    test("reads verified bytes only inside the consumer and clears the buffer on success and error", async () => {
        const { service } = fixture()
        await service.storeTargetAuth(upload)
        let retained: Uint8Array | undefined
        expect(await service.consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, async (bytes) => {
            expect(new TextDecoder().decode(bytes)).toBe(upload.payload)
            retained = bytes
        })).toBeUndefined()
        expect(retained?.every((byte) => byte === 0)).toBe(true)
        await expect(service.consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, async (bytes) => {
            retained = bytes
            throw new Error("consumer failed")
        })).rejects.toThrow("consumer failed")
        expect(retained?.every((byte) => byte === 0)).toBe(true)
    })

    test("blocks cross-domain, uncommitted and hash-mismatched metadata before exposing bytes", async () => {
        const { service, setMetadata, calls } = fixture()
        await service.storeTargetAuth(upload)
        setMetadata({ engagement_id: "other-engagement" })
        await expect(service.metadata("task-1", CONTENT_REF)).rejects.toThrow("bound Engagement")
        setMetadata({ engagement_id: ENGAGEMENT_ID, content_status: "staged" })
        await expect(service.consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, async () => {})).rejects.toThrow("not committed")
        expect(calls.filter((call) => call.operation === "artifact.content.read")).toHaveLength(0)
        setMetadata({ content_status: "available", content_hash: `sha256:${"0".repeat(64)}` })
        let called = false
        await expect(service.consumeTargetAuth({ sessionId: "task-1", contentRef: CONTENT_REF }, async () => { called = true })).rejects.toThrow("hash mismatch")
        expect(called).toBe(false)
    })
})
