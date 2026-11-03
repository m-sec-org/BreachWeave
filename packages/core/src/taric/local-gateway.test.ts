import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
    LocalTaricGatewayUnavailableError,
    TARIC_LOCAL_GATEWAY_DEFAULT_PORT,
    TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV,
    TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV,
    TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV,
    createLocalTaricEngagement,
    ensureLocalTaricGateway,
    ensureDefaultLocalTaricGateway,
    localGatewayStateDir,
    parseEngagementId,
    pickFreeLoopbackPort,
    resolveTaricCliPath,
} from "./local-gateway"

describe("parseEngagementId", () => {
    test("reads the engagement id from a json line", () => {
        const stdout = `{"ok":true,"data":{"id":"018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b","kind":"engagement"}}\n`
        expect(parseEngagementId(stdout)).toBe("018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b")
    })

    test("accepts engagement_id field and skips non-json lines", () => {
        const stdout = `provisioning\n{"ok":true,"data":{"engagement_id":"abcdef12-3456-7abc-def0-1234567890ab"}}\n`
        expect(parseEngagementId(stdout)).toBe("abcdef12-3456-7abc-def0-1234567890ab")
    })

    test("returns undefined for unknown shapes", () => {
        expect(parseEngagementId("no json here")).toBeUndefined()
        expect(parseEngagementId('{"ok":false}')).toBeUndefined()
    })
})

describe("pickFreeLoopbackPort", () => {
    test("skips busy ports", async () => {
        const busy = new Set([8849, 8850])
        const port = await pickFreeLoopbackPort(8849, (_host, candidate) => Promise.resolve(busy.has(candidate)), 5)
        expect(port).toBe(8851)
    })

    test("throws when the range is exhausted", async () => {
        await expect(pickFreeLoopbackPort(8849, () => Promise.resolve(true), 3)).rejects.toBeInstanceOf(LocalTaricGatewayUnavailableError)
    })
})

describe("resolveTaricCliPath", () => {
    test("honors an explicit path that exists", () => {
        expect(resolveTaricCliPath(resolve(import.meta.dir, "./local-gateway.ts"))).toBe(resolve(import.meta.dir, "./local-gateway.ts"))
    })

    test("returns undefined when nothing resolves", () => {
        const previous = process.env.TARIC_CLI
        delete process.env.TARIC_CLI
        expect(resolveTaricCliPath("/definitely/not/here/bin.js", () => false)).toBeUndefined()
        process.env.TARIC_CLI = previous
    })
})

describe("ensureDefaultLocalTaricGateway", () => {
    test("attempts local startup when the verification report is missing", async () => {
        const configDir = await mkdtemp(resolve(tmpdir(), "bw-taric-gate-"))
        const cliPath = resolve(configDir, "taric-cli.js")
        await Bun.write(cliPath, "process.exit(0)\n")
        let defaultsApplied = false
        const logs: string[] = []
        try {
            const runtime = await ensureDefaultLocalTaricGateway({
                dir: configDir,
                getHostSettings: async () => ({ taric: { enabled: true, profile: "authenticated_proxy", localCliPath: cliPath } }),
                applyLocalTaricDefaults: async () => {
                    defaultsApplied = true
                },
            }, (message) => logs.push(message))
            expect(runtime).toBeUndefined()
            expect(defaultsApplied).toBe(false)
            expect(logs.some((message) => message.includes("verification report unavailable"))).toBe(true)
        } finally {
            await rm(configDir, { recursive: true, force: true })
        }
    })
})

/** A spawned child that never exits, so the supervisor's startup wait runs its course. */
function neverExitingSpawn(): { exited: Promise<number> } {
    return { exited: new Promise<number>(() => {}) }
}

describe("ensureLocalTaricGateway", () => {
    // stateDir sits next to configDir (dirname/config -> dirname/taric-gateway),
    // so each case nests configDir inside its own temp base directory.
    let baseDir: string
    let configDir: string
    let stateDir: string
    let cliPath: string

    beforeEach(async () => {
        baseDir = await mkdtemp(resolve(tmpdir(), "tch-taric-gw-"))
        configDir = resolve(baseDir, "config")
        await Bun.write(resolve(baseDir, ".keep"), "")
        stateDir = localGatewayStateDir(configDir)
        cliPath = resolve(baseDir, "bin.js")
        await Bun.write(cliPath, "// taric cli stub\n")
    })

    afterEach(async () => {
        delete process.env[TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV]
        delete process.env[TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV]
        delete process.env[TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV]
        delete process.env.TARIC_OUTBOX_KEY
        await rm(baseDir, { recursive: true, force: true })
    })

    test("spawns the gateway, writes material, and injects token env", async () => {
        // Pre-existing cert short-circuits openssl so the test stays hermetic.
        await Bun.write(resolve(stateDir, "server.crt"), "cert")

        let probes = 0
        let spawnedCommand: string[] = []
        const runtime = await ensureLocalTaricGateway({
            configDir,
            taricSettings: { localCliPath: cliPath },
            probePort: async () => {
                probes += 1
                return probes > 2
            },
            spawnProcess: (command) => {
                spawnedCommand = command
                return neverExitingSpawn()
            },
            runCommand: async () => ({
                exitCode: 0,
                stdout: `{"ok":true,"data":{"id":"018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b"}}\n`,
                stderr: "",
            }),
            probeGatewayStatus: async ({ expectedDigest }) => ({ ok: true, data: { readiness: true, runtime_configuration: { source: "explicit", digest: expectedDigest } } }),
        })

        const config = await Bun.file(resolve(stateDir, "gateway.json")).json()
        const runtimeConfig = await Bun.file(resolve(stateDir, "runtime.json")).json()
        expect(config.tls_tcp).toEqual({ host: "127.0.0.1", port: TARIC_LOCAL_GATEWAY_DEFAULT_PORT })
        expect(config.tokens).toHaveLength(3)
        expect(runtimeConfig.authority.sqlite.path).toBe(resolve(stateDir, "authority.sqlite"))
        expect(runtimeConfig.principal_role).toBe("operator")
        const roles = config.tokens.map((entry: { role: string }) => entry.role).sort()
        expect(roles).toEqual(["host", "model", "operator"])
        expect(runtime.engagementId).toBe("018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b")
        for (const entry of config.tokens.filter((item: { role: string }) => item.role !== "operator")) {
            expect(entry.engagement_id).toBe("018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b")
        }
        expect(runtime.port).toBe(TARIC_LOCAL_GATEWAY_DEFAULT_PORT)
        expect(spawnedCommand).toContain("--runtime-config")
        expect(spawnedCommand).toContain(resolve(stateDir, "runtime.json"))
        expect(runtime.adopted).toBe(false)
        const hostToken = config.tokens.find((entry: { role: string }) => entry.role === "host")?.token
        const modelToken = config.tokens.find((entry: { role: string }) => entry.role === "model")?.token
        const operatorToken = config.tokens.find((entry: { role: string }) => entry.role === "operator")?.token
        expect(process.env[TARIC_LOCAL_GATEWAY_HOST_TOKEN_ENV]).toBe(hostToken)
        expect(process.env[TARIC_LOCAL_GATEWAY_MODEL_TOKEN_ENV]).toBe(modelToken)
        expect(process.env[TARIC_LOCAL_GATEWAY_OPERATOR_TOKEN_ENV]).toBe(operatorToken)
        expect(process.env.TARIC_OUTBOX_KEY).toMatch(/^[0-9a-f]{64}$/)
    })

    test("adopts an already listening gateway", async () => {
        await Bun.write(
            resolve(stateDir, "gateway.json"),
            JSON.stringify({
                tls_tcp: { host: "127.0.0.1", port: 9911 },
                tls: { key_file: "server.key", cert_file: "server.crt" },
                tokens: [
                    { token: "a".repeat(40), role: "host", principal_id: "host-1" },
                    { token: "b".repeat(40), role: "model", principal_id: "model-1" },
                ],
            }),
        )
        await Bun.write(
            resolve(stateDir, "state.json"),
            JSON.stringify({ version: 1, host: "127.0.0.1", port: 9911, hostPrincipalId: "host-1", modelPrincipalId: "model-1", operatorPrincipalId: "op", engagementId: "018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b" }),
        )
        await Bun.write(resolve(stateDir, "server.crt"), "cert")

        const runtime = await ensureLocalTaricGateway({
            configDir,
            taricSettings: { localCliPath: cliPath },
            probePort: async () => true,
            probeGatewayStatus: async ({ expectedDigest }) => ({ ok: true, data: { readiness: true, runtime_configuration: { source: "explicit", digest: expectedDigest } } }),
        })
        expect(runtime.adopted).toBe(true)
        expect(runtime.port).toBe(9911)
        expect(runtime.hostPrincipalId).toBe("host-1")
        expect(runtime.engagementId).toBe("018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b")
    })

    test("refuses to adopt a foreign listener without gateway material", async () => {
        await expect(
            ensureLocalTaricGateway({
                configDir,
                taricSettings: { localCliPath: cliPath },
                probePort: async () => true,
            }),
        ).rejects.toBeInstanceOf(LocalTaricGatewayUnavailableError)
    })

    test("refuses a listening gateway that does not report the selected explicit runtime", async () => {
        await Bun.write(resolve(stateDir, "gateway.json"), JSON.stringify({
            tls_tcp: { host: "127.0.0.1", port: 9912 },
            tls: { key_file: "server.key", cert_file: "server.crt" },
            tokens: [{ token: "a".repeat(40), role: "host", principal_id: "host-1", engagement_id: "018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b" }],
        }))
        await Bun.write(resolve(stateDir, "state.json"), JSON.stringify({ version: 1, host: "127.0.0.1", port: 9912, hostPrincipalId: "host-1", modelPrincipalId: "model-1", operatorPrincipalId: "op", engagementId: "018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b" }))
        await Bun.write(resolve(stateDir, "server.crt"), "cert")
        await expect(ensureLocalTaricGateway({
            configDir,
            taricSettings: { localCliPath: cliPath },
            probePort: async () => true,
            probeGatewayStatus: async () => ({ ok: true, data: { readiness: true, runtime_configuration: { source: "environment", digest: "sha256:wrong" } } }),
        })).rejects.toBeInstanceOf(LocalTaricGatewayUnavailableError)
    })
})

describe("createLocalTaricEngagement", () => {
    test("returns the provisioned engagement id", async () => {
        const configDir = await mkdtemp(resolve(tmpdir(), "tch-taric-eng-"))
        try {
            const result = await createLocalTaricEngagement({
                stateDir: resolve(configDir, "taric-gateway"),
                name: "challenge-1",
                allowedTargets: ["10.5.207.26"],
                runCommand: async () => ({
                    exitCode: 0,
                    stdout: `{"ok":true,"data":{"id":"018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b"}}\n`,
                    stderr: "",
                }),
            })
            expect(result.engagementId).toBe("018f1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b")
        } finally {
            await rm(configDir, { recursive: true, force: true })
        }
    })

    test("surfaces cli failures", async () => {
        const configDir = await mkdtemp(resolve(tmpdir(), "tch-taric-eng-"))
        try {
            await expect(
                createLocalTaricEngagement({
                    stateDir: resolve(configDir, "taric-gateway"),
                    name: "challenge-1",
                    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
                }),
            ).rejects.toBeInstanceOf(LocalTaricGatewayUnavailableError)
        } finally {
            await rm(configDir, { recursive: true, force: true })
        }
    })
})
