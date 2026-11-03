import { describe, expect, test } from "bun:test"
import { evaluateEgress } from "./index"
import type { EgressRequest, ScopePolicy, TestWindow } from "./index"

const window: TestWindow = {
    startsAt: "2026-10-27T08:00:00.000Z",
    endsAt: "2026-10-27T10:00:00.000Z",
}

const practiceScope: ScopePolicy = {
    allowedTargets: [{ host: "dvwa.test" }, { cidr: "10.5.207.0/24" }],
    allowedProtocols: ["http"],
    allowedPorts: [4280],
}

function request(overrides: Partial<EgressRequest> = {}): EgressRequest {
    return {
        url: "http://dvwa.test:4280/",
        resolvedAddresses: ["10.5.207.26"],
        at: "2026-10-27T09:00:00.000Z",
        ...overrides,
    }
}

describe("authorized egress scope decisions", () => {
    test("rejects requests before and after the authorized test window", () => {
        const before = evaluateEgress(practiceScope, window, request({ at: "2026-10-27T07:59:59.999Z" }))
        const after = evaluateEgress(practiceScope, window, request({ at: "2026-10-27T10:00:00.001Z" }))

        expect(before).toMatchObject({ allowed: false, reason: "outside test window" })
        expect(after).toMatchObject({ allowed: false, reason: "outside test window" })
    })

    test("rejects protocols and ports outside the explicit policy", () => {
        const wrongProtocol = evaluateEgress(practiceScope, window, request({ url: "https://dvwa.test:4280/" }))
        const wrongPort = evaluateEgress(practiceScope, window, request({ url: "http://dvwa.test:8080/" }))

        expect(wrongProtocol).toMatchObject({ allowed: false, reason: "protocol is outside scope" })
        expect(wrongPort).toMatchObject({ allowed: false, reason: "port is outside scope" })
    })

    test("rejects a redirect whose destination leaves the allowed host scope", () => {
        const decision = evaluateEgress(practiceScope, window, request({
            redirectChain: ["http://outside.test:4280/admin"],
        }))

        expect(decision).toMatchObject({ allowed: false, reason: "target is outside scope" })
    })

    test("rejects an IPv6 DNS answer inside a denied range", () => {
        const scope: ScopePolicy = {
            allowedTargets: [{ host: "dvwa.test" }],
            deniedTargets: [{ cidr: "2001:db8:dead::/48" }],
            allowedProtocols: ["http"],
            allowedPorts: [4280],
        }
        const decision = evaluateEgress(scope, window, request({
            resolvedAddresses: ["2001:db8:dead::1"],
        }))

        expect(decision).toMatchObject({ allowed: false, reason: "target is denied by scope" })
    })

    test("rejects mixed in-scope and out-of-scope IPv6 DNS answers", () => {
        const scope: ScopePolicy = {
            allowedTargets: [{ cidr: "2001:db8::/32" }],
            allowedProtocols: ["https"],
            allowedPorts: [443],
        }
        const decision = evaluateEgress(scope, window, request({
            url: "https://[2001:db8::1]/",
            resolvedAddresses: ["2001:db8::1", "2001:db9::1"],
        }))

        expect(decision).toMatchObject({ allowed: false, reason: "target is outside scope" })
    })
})
