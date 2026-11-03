import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { TaricAuthorityProjectBootstrap } from "../packages/core/src/taric/authority-bootstrap"
import { TaricAuthorityCoverageService } from "../packages/core/src/taric/authority-coverage-service"
import { TaricAuthorityResourceService } from "../packages/core/src/taric/authority-resource-service"
import { TaricAuthorityScopeService } from "../packages/core/src/taric/authority-scope-service"
import type { AuthorityScopePolicy } from "../packages/core/src/taric/authority-scope-service"
import { TaricArtifactService } from "../packages/core/src/taric/artifact-service"
import { TARIC_BUN_DRIVER_INTEGRITY, TARIC_BUN_DRIVER_PACKAGE, TARIC_BUN_DRIVER_VERSION, TARIC_COMPATIBILITY_BASELINE, TARIC_DEFAULT_POLICY_DIGEST, TARIC_UPSTREAM_COMMIT } from "../packages/core/src/taric/compatibility"
import { createEmbeddedTaricServiceAdapter } from "../packages/core/src/taric/embedded-adapter"
import type { EmbeddedTaricRuntimeDependencies } from "../packages/core/src/taric/embedded-adapter"
import { createTaricHostModule } from "../packages/core/src/taric/host-module"
import { TARIC_OPERATION_REGISTRY_SOURCE_DIGEST } from "../packages/core/src/taric/operation-registry"
import { TaricOperationError } from "../packages/core/src/taric/types"

export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fixture response")
    return value as Record<string, unknown>
}

export function must(value: unknown): Record<string, unknown> {
    const envelope = record(value)
    if (envelope.ok !== true) {
        const error = record(envelope.error)
        throw new TaricOperationError(String(error.code), String(error.message).slice(0, 256), error.details)
    }
    return record(envelope.data)
}

export function digest(value: string): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`
}

/** Real Bun driver + embedded host/operator routes; no AuthorityStore domain-record seeding. */
export async function createTaricControlPlaneFixture(sourceArgument: string) {
    const source = resolve(sourceArgument)
    const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: source, stdout: "pipe", stderr: "pipe" })
    const sourceCommit = (await new Response(revisionProcess.stdout).text()).trim()
    if (await revisionProcess.exited !== 0 || sourceCommit !== TARIC_UPSTREAM_COMMIT) throw new Error("fixture requires the pinned Taric source")
    if (digest(await Bun.file(join(source, "packages/schemas/src/registry.ts")).text()) !== TARIC_OPERATION_REGISTRY_SOURCE_DIGEST) throw new Error("registry source digest mismatch")
    const [core, schemas, driver] = await Promise.all([import(join(source, "packages/core/dist/index.js")), import(join(source, "packages/schemas/dist/src/index.js")), import(join(source, "packages/driver-bun-sqlite/dist/index.js"))])
    const dependencies = { core, schemas, driver } as unknown as EmbeddedTaricRuntimeDependencies
    const root = await mkdtemp(join(tmpdir(), "bw-control-plane-"))
    const authorityPath = join(root, "authority.sqlite")
    const contentRoot = join(root, "content")
    await mkdir(contentRoot, { recursive: true })
    const store = new dependencies.core.AuthorityStore(new dependencies.driver.BunSqliteAuthorityDriver(authorityPath))
    const initialAuthority = await dependencies.core.createCoreService(store, contentRoot)
    const engagement = must(await initialAuthority.dispatch("engagement.init", dependencies.core.createPrincipal("operator", "control-plane-init"), { name: "BreachWeave canonical local acceptance", scope: { allowed_targets: ["127.0.0.1"], excluded_targets: [], rules_of_engagement_ref: "setup-only-not-authorized" } }))
    await initialAuthority.close()
    const sessionId = "control-plane-fixture-session"
    const binding = { projectId: "control-plane-fixture-project", tenantId: "control-plane-fixture-tenant", engagementId: String(engagement.id), hostPrincipalId: "control-plane-fixture-host", modelPrincipalId: "control-plane-fixture-model" }
    async function openHost(hostSessionId = sessionId) {
        const adapter = await createEmbeddedTaricServiceAdapter({ authorityPath, contentRoot, binding, hostCapabilities: ["admit", "content_read"], hostSessionId, operatorPrincipalId: "control-plane-fixture-operator", dependencies })
        const host = createTaricHostModule({ binding, mode: "taric_required", expectedCompatibility: { ...TARIC_COMPATIBILITY_BASELINE, policyDigest: TARIC_DEFAULT_POLICY_DIGEST, bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY } }, adapter })
        const health = await host.initialize()
        if (health.status !== "healthy") throw new Error(`fixture host unavailable: ${JSON.stringify(health)}`)
        return host
    }
    const host = await openHost()
    const artifacts = new TaricArtifactService({ host, egressGrant: { capability: "content_read", principalId: binding.hostPrincipalId, engagementId: binding.engagementId } })
    await artifacts.bindSession({ sessionId, root: join(contentRoot, sessionId), mode: "host-session" })
    const roe = await artifacts.storeArtifact({ sessionId, requestId: "fixture-approved-roe", category: "report", payloadKind: "text", mediaType: "text/plain", payload: "Explicit local operator approval for the isolated loopback fixture; no external targets." })
    const policy: AuthorityScopePolicy = { allowed_targets: ["127.0.0.1"], excluded_targets: [], protocols: ["http"], ports: [{ from: 1, to: 65535 }], methods: ["GET", "POST"], dns: { require_pinned_addresses: true, reject_private_addresses: false, max_addresses: 4 }, redirects: { max_hops: 2, same_scope_only: true }, valid_from: new Date(Date.now() - 60_000).toISOString(), valid_until: new Date(Date.now() + 3_600_000).toISOString() }
    const scopes = new TaricAuthorityScopeService({ host })
    const scope = await scopes.revise({ scopeId: String(engagement.scope_ref), expectedVersion: 1, policy, roeArtifactRef: roe.contentRef, roeArtifactVersion: roe.version, idempotencyKey: "fixture-approved-scope" })
    const resources = new TaricAuthorityResourceService({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
    const asset = { challengeId: "fixture-challenge", assetId: "fixture-asset", origin: "http://127.0.0.1", path: "/" }
    const resource = await resources.provision(asset)
    const observationCandidate = record(await host.captureObservation({ eventId: "fixture-source-observation", sourceKind: "host_event", observation: { resource_ref: String(resource.id), observed_at: new Date().toISOString(), statement: "Locally controlled loopback fixture resource descriptor", artifact_refs: [], limitations: ["Fixture resource declaration; no external target observation."] } }))
    const observationAdmission = record(await host.invokeHost("admission.commit", { proposal_id: observationCandidate.id, expected_version: 0, policy_digest: TARIC_DEFAULT_POLICY_DIGEST, idempotency_key: "fixture-source-observation-admit" }))
    const observation = record(observationAdmission.record)
    const bootstrapInput = { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion, manifest: [{ ...asset, method: "GET", contentHash: digest("fixture-resource-descriptor"), sourceObservationRefs: [String(observation.id)], testCategories: ["authorization", "authentication"] }] }
    const bootstrap = new TaricAuthorityProjectBootstrap({ host, policyDigest: TARIC_DEFAULT_POLICY_DIGEST })
    const project = await bootstrap.bootstrap(bootstrapInput)
    return { root, source, sourceCommit, dependencies, authorityPath, contentRoot, engagement, sessionId, binding, host, openHost, artifacts, roe, policy, scopes, scope, resources, asset, observation, project, bootstrapInput, coverage: new TaricAuthorityCoverageService({ host }), async cleanup() { await host.close(); await rm(root, { recursive: true, force: true }) } }
}
