import { join, resolve } from "node:path"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { TaricOperationError } from "../packages/core/src/taric/types"

interface FixtureAuthority {
    dispatch(operation: string, principal: unknown, input: Record<string, unknown>): Promise<unknown>
    close(): Promise<void>
}

interface FixtureCoreModule {
    AuthorityStore: new (driver: unknown) => unknown
    API_CONTRACT_VERSION: string
    AUTHORITY_STORAGE_CONTRACT_VERSION: string
    createCoreService(store: unknown, contentRoot: string): Promise<FixtureAuthority>
    createPrincipal(role: "host" | "operator", id: string, engagementId?: string, grants?: readonly string[]): unknown
}

interface FixtureDriverModule {
    BunSqliteAuthorityDriver: new (path: string) => unknown
}

function requiredRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fixture authority returned an invalid envelope")
    return value as Record<string, unknown>
}

function must(value: unknown): Record<string, unknown> {
    const response = requiredRecord(value)
    if (response.ok !== true) {
        const error = requiredRecord(response.error)
        throw new TaricOperationError(String(error.code).slice(0, 64), "Fixture authority operation was rejected")
    }
    return requiredRecord(response.data)
}

function argument(name: string): string {
    const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)
    if (!value) throw new Error(`--${name} is required`)
    return value
}

async function main(): Promise<void> {
    const source = resolve(argument("source"))
    const root = resolve(argument("root"))
    const phase = argument("phase")
    if (phase !== "write" && phase !== "read") throw new Error("phase is invalid")

    const [core, driver] = await Promise.all([
        import(join(source, "packages/core/dist/index.js")) as Promise<FixtureCoreModule>,
        import(join(source, "packages/driver-bun-sqlite/dist/index.js")) as Promise<FixtureDriverModule>,
    ])
    const authority = await core.createCoreService(new core.AuthorityStore(new driver.BunSqliteAuthorityDriver(join(root, "authority.sqlite"))), join(root, "content"))
    try {
        if (phase === "write") {
            const operator = core.createPrincipal("operator", "artifact-crash-fixture-operator")
            const engagement = must(await authority.dispatch("engagement.init", operator, {
                name: "BreachWeave Artifact process-crash fixture",
                scope: { allowed_targets: ["http://127.0.0.1"], excluded_targets: [], rules_of_engagement_ref: "fixture-only" },
            }))
            const engagementId = String(engagement.id)
            const principal = core.createPrincipal("host", "artifact-crash-fixture-host", engagementId, ["content_read"])
            const host = {
                getBinding() { return { projectId: "artifact-crash-project", tenantId: "artifact-crash-tenant", engagementId, hostPrincipalId: "artifact-crash-fixture-host", modelPrincipalId: "artifact-crash-model" } },
                async invokeHost(operation: string, input: Record<string, unknown>): Promise<unknown> {
                    return must(await authority.dispatch(operation, principal, { ...input, engagement_id: engagementId }))
                },
            }
            const service = new TaricArtifactService({ host, chunkBytes: 4, egressGrant: { principalId: "artifact-crash-fixture-host", engagementId, capability: "content_read" } })
            const sessionId = "artifact-crash-session"
            await service.bindSession({ sessionId, root: join(root, "content", sessionId), mode: "host-session" })
            const artifact = await service.storeTargetAuth({ sessionId, requestId: "artifact-crash-target-auth", payloadKind: "text", mediaType: "text/plain", payload: "synthetic-process-crash-credential" })
            console.log(JSON.stringify({ ready: true, engagementId, contentRef: artifact.contentRef, contentHash: artifact.contentHash, byteLength: artifact.byteLength }))
            await new Promise<void>(() => {})
            return
        }

        const input = requiredRecord(await Bun.file(resolve(argument("metadata"))).json())
        const engagementId = String(input.engagementId)
        const hostPrincipalId = "artifact-crash-fixture-host"
        const principal = core.createPrincipal("host", hostPrincipalId, engagementId, ["content_read"])
        const host = {
            getBinding() { return { projectId: "artifact-crash-project", tenantId: "artifact-crash-tenant", engagementId, hostPrincipalId, modelPrincipalId: "artifact-crash-model" } },
            async invokeHost(operation: string, operationInput: Record<string, unknown>): Promise<unknown> {
                return must(await authority.dispatch(operation, principal, { ...operationInput, engagement_id: engagementId }))
            },
        }
        const service = new TaricArtifactService({ host, chunkBytes: 4, egressGrant: { principalId: hostPrincipalId, engagementId, capability: "content_read" } })
        const contentRef = String(input.contentRef)
        const metadata = await service.metadata("artifact-crash-session", contentRef)
        let recovered = false
        await service.consumeTargetAuth({ sessionId: "artifact-crash-session", contentRef }, async (bytes) => {
            recovered = new TextDecoder().decode(bytes) === "synthetic-process-crash-credential"
        })
        if (!recovered || metadata.contentHash !== input.contentHash || metadata.byteLength !== input.byteLength) throw new Error("Process-crash Artifact recovery did not match committed metadata")
        console.log(JSON.stringify({ recovered: true, contentRef, contentHash: metadata.contentHash, byteLength: metadata.byteLength }))
    } finally {
        await authority.close()
    }
}

await main()
