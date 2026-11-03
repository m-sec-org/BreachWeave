import { describe, expect, test } from "bun:test"
import type { TaricEgressDecision, TaricEgressExecutorOptions, TaricEgressResult, TaricEgressRunContext } from "./egress-executor"
import { TaricEgressExecutor } from "./egress-executor"
import { evaluateEgress } from "./governance"
import type { ScopePolicy } from "./governance"

const context: TaricEgressRunContext = { engagementId: "019a0000-0000-7000-8000-000000000001", actionId: "019a0000-0000-7000-8000-000000000002", workRunId: "019a0000-0000-7000-8000-000000000003", attemptId: "019a0000-0000-7000-8000-000000000004", generation: 2, ownerHost: "egress-fixture-host", scopeRevision: 1 }

function fixture(scope: ScopePolicy, overrides: Partial<TaricEgressExecutorOptions> = {}) {
    const decisions: TaricEgressDecision[] = []
    const results: TaricEgressResult[] = []
    const now = Date.now()
    let fences = 0
    const options: TaricEgressExecutorOptions = {
        evaluateEgress: (request) => evaluateEgress(scope, { startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 60_000).toISOString() }, request),
        assertFence: () => { fences += 1 },
        onDecision: async (decision) => { decisions.push(decision); return { decisionRef: `decision-${decisions.length}` } },
        recordResult: async (result) => { results.push(result) },
        ...overrides,
    }
    return { executor: new TaricEgressExecutor(options), decisions, results, getFences: () => fences }
}

describe("authorized HTTP connection execution", () => {
    test("inline query credentials and configured secrets cannot reach traffic or durable decision metadata", async () => {
        let requests = 0
        const canary = "fixture-config-secret-canary"
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests += 1; return new Response("forbidden") } })
        try {
            const { executor, decisions, results } = fixture({ allowedTargets: [{ host: "127.0.0.1" }] }, { configurationSecrets: [canary] })
            for (const url of [`${server.url}?access_token=inline-query-canary`, `${server.url}?%61ccess_token=encoded-query-canary`, `${server.url}?ordinary=${canary}`, `${server.url}${canary}`, `${server.url}#inline-fragment-canary`]) {
                expect(await executor.execute({ url }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            }
            expect(await executor.execute({ url: server.url.toString(), headers: { "x-fixture": canary } }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            expect(decisions).toHaveLength(0)
            expect(requests).toBe(0)
            expect(JSON.stringify([decisions, results])).not.toMatch(/inline-query-canary|encoded-query-canary|fixture-config-secret-canary|inline-fragment-canary/)
        } finally { await server.stop(true) }
    })
    test("persists the host decision before actual traffic and exposes only bounded metadata", async () => {
        const order: string[] = []
        let consumed: Uint8Array | undefined
        let captured = ""
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { order.push("network"); return new Response("private-response-canary", { headers: { "set-cookie": "private-cookie-canary" } }) } })
        try {
            const { executor, results, getFences } = fixture({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [server.port!], allowedProtocols: ["http"] }, {
                onDecision: async () => { order.push("persisted-decision"); return { decisionRef: "decision-1" } },
                consumeResponse: async (response) => { consumed = response.bytes; captured = new TextDecoder().decode(response.bytes) },
            })
            const result = await executor.execute({ url: `${server.url}fixture` }, context)
            expect(result).toMatchObject({ outcome: "executed", statusCode: 200, byteLength: 23, hopCount: 1, decisionRefs: ["decision-1"] })
            expect(result.networkProvenance).toMatchObject({ approved_addresses: ["127.0.0.1"], connected_address: "127.0.0.1", ip_family: "ipv4", port: server.port, protocol: "http", redirect_chain: [] })
            expect(order).toEqual(["persisted-decision", "network"])
            expect(getFences()).toBe(3)
            expect(captured).toBe("private-response-canary")
            expect(consumed?.every((byte) => byte === 0)).toBe(true)
            expect(JSON.stringify([result, results])).not.toMatch(/private-response-canary|private-cookie-canary|set-cookie|body/)
        } finally { await server.stop(true) }
    })

    test("frames actual TCP responses and rejects ambiguous, truncated or oversized responses", async () => {
        const cases = [
            { wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nAudit: trailer\r\n\r\n", outcome: "executed", byteLength: 2 },
            { wire: "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nok", outcome: "executed", byteLength: 2 },
            { wire: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok", outcome: "unknown", failureCode: "invalid_response" },
            { wire: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", outcome: "unknown", failureCode: "invalid_response" },
            { wire: "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nok", outcome: "unknown", failureCode: "response_aborted" },
            { wire: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n100\r\n", outcome: "unknown", failureCode: "response_body_limit" },
            { wire: `HTTP/1.1 200 OK\r\nX-Oversized: ${"x".repeat(65536)}`, outcome: "unknown", failureCode: "response_header_limit" },
        ]
        for (const item of cases) {
            const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.end(item.wire) } } })
            try {
                const { executor } = fixture({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [server.port], allowedProtocols: ["http"] }, { maxResponseBytes: 64 })
                const result = await executor.execute({ url: `http://127.0.0.1:${server.port}/` }, context)
                expect(result).toMatchObject({ outcome: item.outcome, ...(item.byteLength === undefined ? {} : { byteLength: item.byteLength }), ...(item.failureCode ? { failureCode: item.failureCode } : {}) })
                expect(result.networkProvenance?.connected_address).toBe("127.0.0.1")
            } finally { server.stop(true) }
        }
    })

    test("pins approved DNS answers into the socket lookup and never resolves again", async () => {
        let requests = 0
        let resolutions = 0
        let hostHeader = ""
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { requests += 1; hostHeader = request.headers.get("host") ?? ""; return new Response("pinned") } })
        try {
            const { executor, decisions } = fixture({ allowedTargets: [{ host: "fixture.invalid" }, { cidr: "127.0.0.0/8" }], allowedPorts: [server.port!], allowedProtocols: ["http"] }, { resolveAddresses: async () => { resolutions += 1; return resolutions === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "203.0.113.1", family: 4 }] } })
            const result = await executor.execute({ url: `http://fixture.invalid:${server.port}/` }, context)
            expect(result.outcome).toBe("executed")
            expect(resolutions).toBe(1)
            expect(requests).toBe(1)
            expect(hostHeader).toBe(`fixture.invalid:${server.port}`)
            expect(decisions[0]?.resolvedAddresses).toEqual(["127.0.0.1"])
            expect(decisions[0]?.pinnedAddress).toBe("127.0.0.1")
        } finally { await server.stop(true) }
    })

    test("denies mixed DNS answers, disallowed ports/protocols and expired windows before any receiver traffic", async () => {
        let requests = 0
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests += 1; return new Response("should never execute") } })
        try {
            const scope: ScopePolicy = { allowedTargets: [{ host: "fixture.invalid" }, { host: "127.0.0.1" }], allowedPorts: [server.port!], allowedProtocols: ["http"] }
            const mixed = fixture(scope, { resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }, { address: "2001:db8::1", family: 6 }] })
            expect(await mixed.executor.execute({ url: `http://fixture.invalid:${server.port}/` }, context)).toMatchObject({ outcome: "denied", failureCode: "scope_denied", hopCount: 0 })
            expect(mixed.decisions[0]?.resolvedAddresses).toEqual(["127.0.0.1", "2001:db8::1"])
            expect(await fixture({ ...scope, allowedPorts: [server.port! + 1] }).executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            expect(await fixture({ ...scope, allowedProtocols: ["https"] }).executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            expect(await fixture(scope, { now: () => Date.now() + 120_000 }).executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            expect(requests).toBe(0)
        } finally { await server.stop(true) }
    })

    test("reapproves every redirect and keeps an out-of-scope receiver at zero requests", async () => {
        let receiverRequests = 0
        const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { receiverRequests += 1; return new Response("forbidden") } })
        const sender = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 302, headers: { location: receiver.url.toString() } }) } })
        try {
            const { executor, decisions } = fixture({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [sender.port!], allowedProtocols: ["http"] })
            expect(await executor.execute({ url: sender.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 1, failureCode: "scope_denied" })
            expect(decisions.map((decision) => decision.allowed)).toEqual([true, false])
            expect(receiverRequests).toBe(0)
        } finally { await sender.stop(true); await receiver.stop(true) }
    })

    test("injects target authentication only inside the private callback and blocks cross-origin credential redirects", async () => {
        const credential = "Bearer fixture-target-private-canary"
        const received: string[] = []
        let consumed: Uint8Array | undefined
        let receiverRequests = 0
        const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { receiverRequests += 1; return new Response("forbidden") } })
        const sender = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
            received.push(request.headers.get("authorization") ?? "")
            if (new URL(request.url).pathname === "/cross") return new Response(null, { status: 302, headers: { location: receiver.url.toString() } })
            if (new URL(request.url).pathname === "/same") return new Response(null, { status: 302, headers: { location: "/final" } })
            return new Response(credential)
        } })
        try {
            const { executor, results } = fixture({ allowedTargets: [{ host: "127.0.0.1" }], allowedPorts: [sender.port!, receiver.port!], allowedProtocols: ["http"] }, { artifactService: { async consumeTargetAuth(_input, consume) { const bytes = new TextEncoder().encode(credential); consumed = bytes; try { await consume(bytes) } finally { bytes.fill(0) } } } })
            const targetAuth = { sessionId: "fixture-target-session", contentRef: "fixture-target-ref" }
            const ordinary = await executor.execute({ url: `${sender.url}same`, targetAuth }, context)
            expect(ordinary).toMatchObject({ outcome: "executed", statusCode: 200, hopCount: 2 })
            expect(received).toEqual([credential, credential])
            expect(consumed?.every((byte) => byte === 0)).toBe(true)
            const redirected = await executor.execute({ url: `${sender.url}cross`, targetAuth }, context)
            expect(redirected).toMatchObject({ outcome: "denied", failureCode: "credential_redirect_denied", hopCount: 1 })
            expect(receiverRequests).toBe(0)
            expect(JSON.stringify(results)).not.toContain(credential)
            expect(await executor.execute({ url: sender.url.toString(), headers: { Authorization: credential } }, context)).toMatchObject({ outcome: "denied", failureCode: "invalid_header", hopCount: 0 })
        } finally { await sender.stop(true); await receiver.stop(true) }
    })

    test("rechecks scope/window and run ownership after persistence, before opening the socket", async () => {
        let requests = 0
        let fenceChecks = 0
        let now = Date.now()
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests += 1; return new Response("forbidden") } })
        try {
            const scope: ScopePolicy = { allowedTargets: [{ host: "127.0.0.1" }] }
            const fenced = fixture(scope, { assertFence: () => { fenceChecks += 1; if (fenceChecks === 2) throw new Error("stale generation") } })
            expect(await fenced.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            const expired = fixture(scope, { now: () => now, onDecision: async () => { now += 120_000; return { decisionRef: "window-decision" } } })
            expect(await expired.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", failureCode: "scope_changed_before_send", hopCount: 0 })
            const unpersisted = fixture(scope, { onDecision: async () => { throw new Error("decision persistence unavailable") } })
            expect(await unpersisted.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 0 })
            expect(requests).toBe(0)
        } finally { await server.stop(true) }
    })

    test("refreshes ownership and policy after the socket connects before writing HTTP bytes", async () => {
        let requests = 0
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests += 1; return new Response("forbidden") } })
        try {
            let fences = 0
            const fenced = fixture({ allowedTargets: [{ host: "127.0.0.1" }] }, { assertFence: () => { fences += 1; if (fences === 3) throw new Error("lease lost during connect") } })
            expect(await fenced.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 1 })
            expect(fences).toBe(3)
            let evaluations = 0
            const expired = fixture({ allowedTargets: [{ host: "127.0.0.1" }] }, { evaluateEgress: () => ({ allowed: ++evaluations < 3, reason: "window ended during connect", normalizedUrls: [] }) })
            expect(await expired.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "denied", hopCount: 1, failureCode: "scope_changed_before_send" })
            expect(evaluations).toBe(3)
            expect(requests).toBe(0)
        } finally { await server.stop(true) }
    })

    test("redirect metadata cannot disclose reflected target authentication or encoded bearer tokens", async () => {
        const token = "fixture-redirect-private-token"
        const credential = `Bearer ${token}`
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
            const path = new URL(request.url).pathname
            const location = path === "/full" ? `/?ordinary=${encodeURIComponent(credential)}` : `/prefix/${token.split("").map((letter) => `%${letter.charCodeAt(0).toString(16)}`).join("")}`
            return new Response(null, { status: 302, headers: { location } })
        } })
        try {
            const { executor, results } = fixture({ allowedTargets: [{ host: "127.0.0.1" }] }, { artifactService: { async consumeTargetAuth(_input, consume) { const bytes = new TextEncoder().encode(credential); try { await consume(bytes) } finally { bytes.fill(0) } } } })
            for (const path of ["full", "encoded"]) {
                const result = await executor.execute({ url: `${server.url}${path}`, targetAuth: { sessionId: "private-session", contentRef: "private-reference" } }, context)
                expect(result).toMatchObject({ outcome: "unknown", hopCount: 1, failureCode: "target_auth_metadata_denied", networkProvenance: { redirect_chain: [] } })
            }
            expect(JSON.stringify(results)).not.toContain(token)
            expect(JSON.stringify(results)).not.toContain(encodeURIComponent(credential))
        } finally { await server.stop(true) }
    })

    test("an unsolicited server greeting cannot complete an unsent HTTP action", async () => {
        let requests = 0
        const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
            open(socket) { socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok") },
            data() { requests += 1 },
        } })
        try {
            let fences = 0
            const { executor } = fixture({ allowedTargets: [{ host: "127.0.0.1" }] }, { assertFence: async () => { fences += 1; if (fences === 3) await Bun.sleep(50) } })
            expect(await executor.execute({ url: `http://127.0.0.1:${server.port}/` }, context)).toMatchObject({ outcome: "denied", failureCode: "response_before_request" })
            expect(requests).toBe(0)
        } finally { server.stop(true) }
    })

    test("bounds request/response bodies and records unknown transport outcomes exactly once without replay", async () => {
        let requests = 0
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { requests += 1; if (new URL(request.url).pathname === "/slow") await Bun.sleep(100); return new Response("response beyond the configured byte bound") } })
        try {
            const scope: ScopePolicy = { allowedTargets: [{ host: "127.0.0.1" }] }
            const limited = fixture(scope, { maxRequestBytes: 4, maxResponseBytes: 4 })
            expect(await limited.executor.execute({ url: server.url.toString(), method: "POST", body: "12345" }, context)).toMatchObject({ outcome: "denied", hopCount: 0, failureCode: "request_body_limit" })
            expect(requests).toBe(0)
            expect(await limited.executor.execute({ url: server.url.toString() }, context)).toMatchObject({ outcome: "unknown", hopCount: 1, failureCode: "response_body_limit" })
            const timed = fixture(scope, { timeoutMs: 25 })
            expect(await timed.executor.execute({ url: `${server.url}slow`, method: "POST", body: "one attempt" }, context)).toMatchObject({ outcome: "unknown", hopCount: 1 })
            await Bun.sleep(130)
            expect(timed.results).toHaveLength(1)
            expect(requests).toBe(2)
            expect(JSON.stringify(timed.results)).not.toContain("one attempt")
        } finally { await server.stop(true) }
    })

    test("executes approved IPv6 loopback addresses using the actual connection path", async () => {
        let requests = 0
        const server = Bun.serve({ hostname: "::1", port: 0, fetch() { requests += 1; return new Response("ipv6") } })
        try {
            const { executor, decisions } = fixture({ allowedTargets: [{ cidr: "::1/128" }], allowedPorts: [server.port!], allowedProtocols: ["http"] })
            expect(await executor.execute({ url: `http://[::1]:${server.port}/` }, context)).toMatchObject({ outcome: "executed", statusCode: 200 })
            expect(requests).toBe(1)
            expect(decisions[0]?.resolvedAddresses).toEqual(["::1"])
        } finally { await server.stop(true) }
    })
})
