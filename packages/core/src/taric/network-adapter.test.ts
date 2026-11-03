import { createServer as createHttpsServer } from "node:https"
import { createServer as createTlsServer } from "node:tls"
import { test, expect, describe } from "bun:test"
import { createNetworkTaricServiceAdapter } from "./network-adapter"
import { TaricOperationError } from "./types"
import { TARIC_COMPATIBILITY_BASELINE } from "./compatibility"

const HOST_TOKEN = "host-token-012345678901234567890123456789"
const MODEL_TOKEN = "model-token-012345678901234567890123456789"
const BINDING = {
    projectId: "tenant/project",
    tenantId: "tenant",
    engagementId: "engagement-1",
    hostPrincipalId: "host-1",
    modelPrincipalId: "model-1",
}

async function tlsMaterial(): Promise<{ key: string; cert: string }> {
    const root = new URL("./fixtures/", import.meta.url)
    return {
        key: await Bun.file(new URL("gateway-test-key.pem", root)).text(),
        cert: await Bun.file(new URL("gateway-test-cert.pem", root)).text(),
    }
}

function listen(server: { listen(options: { host: string; port: number }, callback: () => void): void; address(): { port: number } | string | null }): Promise<number> {
    return new Promise((resolve, reject) => {
        server.listen({ host: "127.0.0.1", port: 0 }, () => resolve((server.address() as { port: number }).port))
    })
}

function response(id: unknown, data: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true, data } })
}

describe("Taric authenticated network adapter", () => {
    test("uses Bearer token identity and bounded HTTPS dispatch", async () => {
        const { key, cert } = await tlsMaterial()
        const seen: Array<{ token?: string; operation?: string; method?: string }> = []
        const server = createHttpsServer({ key, cert }, (request, reply) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            request.on("end", () => {
                const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: { operation?: string } }
                seen.push({ token: request.headers.authorization?.slice("Bearer ".length), operation: input.params.operation, method: input.method })
                const data = input.method === "taric.gateway.status"
                    ? { readiness: true, liveness: true }
                    : input.params.operation === "engagement.status"
                      ? { schema_version: TARIC_COMPATIBILITY_BASELINE.schemaVersion, api_contract_version: TARIC_COMPATIBILITY_BASELINE.apiContractVersion }
                      : { accepted: true }
                const payload = response(input.id, data)
                reply.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
                reply.end(payload)
            })
        })
        const port = await listen(server)
        try {
            const adapter = createNetworkTaricServiceAdapter({ binding: BINDING, transport: { kind: "https", url: `https://localhost:${port}/rpc`, hostToken: HOST_TOKEN, modelToken: MODEL_TOKEN, ca: cert } })
            await adapter.checkHealth?.()
            const result = await adapter.invoke("context.query", { engagement_id: BINDING.engagementId })
            const hostWorkQuery = await adapter.invoke("work.query", { engagement_id: BINDING.engagementId, include_active_runs: true }, "host")
            const status = await adapter.gatewayStatus?.()
            expect(result).toEqual({ ok: true, data: { accepted: true } })
            expect(hostWorkQuery).toEqual({ ok: true, data: { accepted: true } })
            expect(status).toMatchObject({ ok: true, data: { readiness: true } })
            expect(seen).toEqual([
                { token: HOST_TOKEN, operation: undefined, method: "taric.gateway.status" },
                { token: HOST_TOKEN, operation: "engagement.status", method: "taric.dispatch" },
                { token: MODEL_TOKEN, operation: "context.query", method: "taric.dispatch" },
                { token: HOST_TOKEN, operation: "work.query", method: "taric.dispatch" },
                { token: HOST_TOKEN, operation: undefined, method: "taric.gateway.status" },
            ])
            await adapter.close()
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
    })

    test("uses an operator token and identity for gateway reload", async () => {
        const { key, cert } = await tlsMaterial()
        const seen: Array<{ token: string; role: string; principalId: string; method?: string }> = []
        const server = createTlsServer({ key, cert }, (socket) => {
            socket.setEncoding("utf8")
            let buffer = ""
            socket.on("data", (chunk) => {
                buffer += chunk
                let newline = buffer.indexOf("\n")
                while (newline >= 0) {
                    const input = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }
                    buffer = buffer.slice(newline + 1)
                    newline = buffer.indexOf("\n")
                    if (input.method === "taric.identify") {
                        const declare = input.params.declare as { role: string; principal_id: string }
                        seen.push({ token: String(input.params.token), role: declare.role, principalId: declare.principal_id })
                        socket.write(`${response(input.id, { identified: true })}\n`)
                    } else {
                        seen[seen.length - 1].method = input.method
                        socket.write(`${response(input.id, { accepted: true, reconnect_required: true })}\n`)
                    }
                }
            })
        })
        const port = await listen(server)
        try {
            const adapter = createNetworkTaricServiceAdapter({
                binding: BINDING,
                transport: { kind: "tls_tcp", host: "localhost", port, hostToken: HOST_TOKEN, modelToken: MODEL_TOKEN, operatorToken: "operator-token-012345678901234567890123456789", operatorPrincipalId: "operator-1", ca: cert },
            })
            await expect(adapter.gatewayReload?.()).resolves.toMatchObject({ ok: true, data: { reconnect_required: true } })
            expect(seen).toEqual([{ token: "operator-token-012345678901234567890123456789", role: "operator", principalId: "operator-1", method: "taric.gateway.reload" }])
            await adapter.close()
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
    })

    test("preserves only bounded structured diagnostics from RPC envelopes", async () => {
        const { key, cert } = await tlsMaterial()
        const server = createHttpsServer({ key, cert }, (request, reply) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            request.on("end", () => {
                const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string }
                const payload = JSON.stringify({
                    jsonrpc: "2.0",
                    id: input.id,
                    result: { ok: false, error: { code: "validation_error", message: "invalid token=do-not-leak", details: { kind: "contract", contract_name: "test", violations: Array.from({ length: 20 }, () => ({ instance_path: "/password", keyword: "required", params: { missingProperty: "password", raw: "ignore" }, message: "password=do-not-leak" })) } } },
                })
                reply.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
                reply.end(payload)
            })
        })
        const port = await listen(server)
        try {
            const adapter = createNetworkTaricServiceAdapter({ binding: BINDING, transport: { kind: "https", url: `https://localhost:${port}/rpc`, hostToken: HOST_TOKEN, modelToken: MODEL_TOKEN, ca: cert } })
            try {
                await adapter.checkHealth?.()
            } catch (error) {
                expect(error).toBeInstanceOf(TaricOperationError)
                const details = (error as TaricOperationError).details as { kind: string; violations: Array<{ instance_path: string; message: string }> }
                expect(details.kind).toBe("contract")
                expect(Array.isArray(details.violations)).toBe(true)
                expect(details.violations.length).toBe(16)
                expect(details.violations[0]).toMatchObject({ instance_path: "/<redacted>" })
                expect(details.violations[0]?.message).not.toContain("do-not-leak")
            }
            await adapter.close()
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
    })

    test("uses connection identity and TLS for TCP dispatch", async () => {
        const { key, cert } = await tlsMaterial()
        const seen: Array<{ token: string; role: string; principal_id: string; operation?: string }> = []
        const server = createTlsServer({ key, cert }, (socket) => {
            socket.setEncoding("utf8")
            let buffer = ""
            socket.on("data", (chunk) => {
                buffer += chunk
                let newline = buffer.indexOf("\n")
                while (newline >= 0) {
                    const input = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }
                    buffer = buffer.slice(newline + 1)
                    newline = buffer.indexOf("\n")
                    if (input.method === "taric.identify") {
                        const declare = input.params.declare as { role: string; principal_id: string }
                        seen.push({ token: String(input.params.token), role: declare.role, principal_id: declare.principal_id })
                        socket.write(`${response(input.id, { identified: true })}\n`)
                    } else {
                        seen[seen.length - 1].operation = String(input.params.operation)
                        socket.write(`${response(input.id, { accepted: true })}\n`)
                    }
                }
            })
        })
        const port = await listen(server)
        try {
            const adapter = createNetworkTaricServiceAdapter({ binding: BINDING, transport: { kind: "tls_tcp", host: "localhost", port, hostToken: HOST_TOKEN, modelToken: MODEL_TOKEN, ca: cert } })
            const result = await adapter.invoke("capture.observation", { engagement_id: BINDING.engagementId, observation: { kind: "observation" } })
            expect(result).toEqual({ ok: true, data: { accepted: true } })
            await adapter.invoke("proposal.list", { engagement_id: BINDING.engagementId, page_size: 10 })
            expect(seen).toEqual([
                { token: HOST_TOKEN, role: "host", principal_id: BINDING.hostPrincipalId, operation: "capture.observation" },
                { token: HOST_TOKEN, role: "host", principal_id: BINDING.hostPrincipalId, operation: "proposal.list" },
            ])
            await adapter.close()
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        }
    })
})
