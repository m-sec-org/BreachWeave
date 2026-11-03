import { BlockList, isIP } from "node:net"
import { TaricAuthorityResourceService } from "./authority-resource-service"
import type { AuthorityResourceRevisionInput } from "./authority-resource-service"
import { TaricAuthorityWorkService } from "./authority-work-service"
import { deriveStableHostRequestIdentity, requireOpaqueHostId, requireTaricUuid } from "./host-identity"
import { TaricAuthorityScopeService } from "./authority-scope-service"
import type { CanonicalScopeLocator } from "./authority-scope-service"
import { TaricAuthorityCoverageService } from "./authority-coverage-service"
import type { AuthorityCoverageDimension } from "./authority-coverage-service"
export type { CanonicalScopeLocator } from "./authority-scope-service"
import type { TaricHostModule } from "./host-module"
import { assertTaricControlPlaneContract } from "./control-plane-contract"
import { TaricOperationError } from "./types"

const HASH = /^sha256:[a-f0-9]{64}$/i
export interface AuthorizedBootstrapManifestItem {
    challengeId: string
    assetId: string
    origin: string
    path: string
    revision?: number
    method?: string
    contentHash?: string
    sourceObservationRefs?: readonly string[]
    testCategories: readonly string[]
    title?: string
    acceptanceCriteria?: readonly string[]
}

export interface AuthorizedProjectBootstrapInput {
    scopeId: string
    scopeVersion: number
    manifest: readonly AuthorizedBootstrapManifestItem[]
}

export interface BootstrappedManifestItem {
    challengeId: string
    assetId: string
    resource: Record<string, unknown>
    revision: Record<string, unknown>
    coverage: readonly Record<string, unknown>[]
    workItems: readonly Record<string, unknown>[]
}

export interface AuthorizedProjectBootstrapResult {
    scope: CanonicalScopeLocator
    manifestDigest: string
    coverageManifest: Record<string, unknown>
    manifest: readonly BootstrappedManifestItem[]
    launchAuthorized: false
    closable: false
    status: "coverage_incomplete"
}

export interface AuthorityProjectBootstrapOptions {
    host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "invokeOperator" | "submitProposal">
    policyDigest: string
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaricOperationError("validation_error", `${field} must be a record`)
    return value as Record<string, unknown>
}

function text(value: unknown, field: string, max = 2048): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new TaricOperationError("validation_error", `${field} must be bounded text`)
    return value.trim()
}

function positiveInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TaricOperationError("validation_error", `${field} must be a positive integer`)
    return Number(value)
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
    if (!value || typeof value !== "object") return JSON.stringify(value)
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

function digest(value: unknown): string {
    return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")}`
}

function normalizeManifest(input: readonly AuthorizedBootstrapManifestItem[]): AuthorizedBootstrapManifestItem[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 1024) throw new TaricOperationError("empty_manifest", "authorized manifest must contain at least one item")
    const keys = new Set<string>()
    return input.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new TaricOperationError("invalid_manifest", `manifest item ${index} is invalid`)
        const challengeId = requireOpaqueHostId(item.challengeId, "manifest.challengeId")
        const assetId = requireOpaqueHostId(item.assetId, "manifest.assetId")
        const origin = text(item.origin, "manifest.origin", 512)
        let parsedOrigin: URL
        try { parsedOrigin = new URL(origin) } catch { throw new TaricOperationError("invalid_manifest", "manifest.origin must be a valid URL") }
        if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.pathname !== "/") throw new TaricOperationError("invalid_manifest", "manifest.origin must be an HTTP origin without credentials or query")
        const path = text(item.path, "manifest.path")
        if (!path.startsWith("/") || /[?#]/.test(path)) throw new TaricOperationError("invalid_manifest", "manifest.path must be an absolute path without query or fragment")
        if (!Array.isArray(item.testCategories) || item.testCategories.length === 0 || item.testCategories.length > 64) throw new TaricOperationError("invalid_manifest", "manifest testCategories must be non-empty and bounded")
        const testCategories = item.testCategories.map((category: string) => {
            const value = requireOpaqueHostId(category, "manifest.testCategory")
            if (value.length > 128) throw new TaricOperationError("invalid_manifest", "manifest.testCategory exceeds the Taric limit")
            return value
        }).sort()
        if (new Set(testCategories).size !== testCategories.length) throw new TaricOperationError("invalid_manifest", "manifest testCategories must be unique")
        const revision = item.revision === undefined ? undefined : positiveInteger(item.revision, "manifest.revision")
        const method = item.method === undefined ? "GET" : text(item.method, "manifest.method", 16).toUpperCase()
        if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method)) throw new TaricOperationError("invalid_manifest", "manifest.method is invalid")
        const contentHash = item.contentHash === undefined ? undefined : text(item.contentHash, "manifest.contentHash", 80)
        if (contentHash !== undefined && !HASH.test(contentHash)) throw new TaricOperationError("invalid_manifest", "manifest.contentHash must be SHA-256")
        const sourceObservationRefs = item.sourceObservationRefs === undefined ? undefined : [...item.sourceObservationRefs].map((id) => requireTaricUuid(id, "manifest.sourceObservationRef"))
        if (sourceObservationRefs !== undefined && (sourceObservationRefs.length === 0 || sourceObservationRefs.length > 32 || new Set(sourceObservationRefs).size !== sourceObservationRefs.length)) throw new TaricOperationError("invalid_manifest", "manifest source observations must be unique and bounded")
        const title = item.title === undefined ? `Authorized test ${challengeId}/${assetId}` : text(item.title, "manifest.title")
        const acceptanceCriteria = item.acceptanceCriteria === undefined ? ["Record the host result with source and limitations."] : item.acceptanceCriteria.map((criterion: string) => text(criterion, "manifest.acceptanceCriteria[]"))
        if (acceptanceCriteria.length === 0 || acceptanceCriteria.length > 64) throw new TaricOperationError("invalid_manifest", "manifest acceptanceCriteria must be non-empty and bounded")
        for (const category of testCategories) {
            const key = `${challengeId}\0${assetId}\0${revision ?? "current"}\0${category}`
            if (keys.has(key)) throw new TaricOperationError("invalid_manifest", "manifest contains duplicate dimensions")
            keys.add(key)
        }
        return { challengeId, assetId, origin: parsedOrigin.origin, path, ...(revision === undefined ? {} : { revision }), method, ...(contentHash === undefined ? {} : { contentHash }), ...(sourceObservationRefs === undefined ? {} : { sourceObservationRefs }), testCategories, title, acceptanceCriteria }
    })
}

/** Static manifest admission check; DNS and connected peer checks still happen at execution. */
function assertManifestInScope(manifest: readonly AuthorizedBootstrapManifestItem[], scope: CanonicalScopeLocator): void {
    function matches(hostname: string, target: string): boolean {
        if (!target.includes("/")) return hostname.toLowerCase().replace(/\.$/, "") === target.toLowerCase().replace(/\.$/, "")
        const family = isIP(hostname)
        if (!family) return false
        const [network, prefix] = target.split("/")
        if (isIP(network!) !== family) return false
        const block = new BlockList()
        block.addSubnet(network!, Number(prefix), family === 4 ? "ipv4" : "ipv6")
        return block.check(hostname, family === 4 ? "ipv4" : "ipv6")
    }
    for (const item of manifest) {
        const url = new URL(item.origin)
        const hostname = url.hostname.replace(/^\[|\]$/g, "")
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
        if (!scope.policy.allowed_targets.some((target) => matches(hostname, target)) || scope.policy.excluded_targets.some((target) => matches(hostname, target)) || !scope.policy.protocols.includes(url.protocol.slice(0, -1) as "http" | "https") || !scope.policy.ports.some((range) => port >= range.from && port <= range.to) || !scope.policy.methods.includes(item.method ?? "GET")) throw new TaricOperationError("authorization_error", "Manifest target, protocol, port or method is outside the approved ScopeRevision")
    }
}

export class TaricAuthorityProjectBootstrap {
    private readonly resources: TaricAuthorityResourceService
    private readonly work: TaricAuthorityWorkService
    private readonly scopes: TaricAuthorityScopeService
    private readonly coverageService: TaricAuthorityCoverageService

    constructor(private readonly options: AuthorityProjectBootstrapOptions) {
        if (!HASH.test(options.policyDigest)) throw new TaricOperationError("validation_error", "policyDigest must be SHA-256")
        this.resources = new TaricAuthorityResourceService(options)
        this.work = new TaricAuthorityWorkService(options)
        this.scopes = new TaricAuthorityScopeService(options)
        this.coverageService = new TaricAuthorityCoverageService(options)
    }

    async resolveScope(input: Pick<AuthorizedProjectBootstrapInput, "scopeId" | "scopeVersion">): Promise<CanonicalScopeLocator> {
        return this.scopes.resolve(input)
    }

    async assertScopeCurrent(locator: CanonicalScopeLocator): Promise<CanonicalScopeLocator> {
        return this.scopes.assertCurrent(locator)
    }

    async bootstrap(input: AuthorizedProjectBootstrapInput): Promise<AuthorizedProjectBootstrapResult> {
        const manifest = normalizeManifest(input.manifest)
        assertTaricControlPlaneContract()
        const scope = await this.resolveScope(input)
        assertManifestInScope(manifest, scope)
        const canonical: BootstrappedManifestItem[] = []
        for (const item of manifest) {
            let resource: Record<string, unknown>
            try {
                resource = (await this.resources.resolve(item)).resource
            } catch (error) {
                if (!(error instanceof TaricOperationError) || error.code !== "resource_identity_unresolved") throw error
                resource = await this.resources.provision({ challengeId: item.challengeId, assetId: item.assetId, origin: item.origin, path: item.path })
            }
            this.assertCanonical(resource, "resource")
            const identity = record(resource.identity, "Resource identity")
            if (identity.origin !== item.origin || identity.path !== item.path) throw new TaricOperationError("authorization_error", "Manifest origin/path differs from its stable canonical Resource")
            const requestedRevision = item.revision ?? positiveInteger(resource.revision, "resource.revision")
            let resolvedRevision: { resource: Record<string, unknown>; revision: Record<string, unknown>; readSeq: number }
            try {
                resolvedRevision = await this.resources.resolveRevision(String(resource.id), requestedRevision)
            } catch (error) {
                if (!(error instanceof TaricOperationError) || error.code !== "resource_revision_unresolved") throw error
                if (!item.contentHash || !item.sourceObservationRefs?.length) throw new TaricOperationError("resource_revision_unresolved", "manifest must provide contentHash and sourceObservationRefs to provision a missing ResourceRevision")
                const revisionInput: AuthorityResourceRevisionInput = { challengeId: item.challengeId, assetId: item.assetId, resourceId: String(resource.id), expectedVersion: positiveInteger(resource.version, "resource.version"), method: item.method ?? "GET", path: item.path, contentHash: item.contentHash, sourceObservationRefs: item.sourceObservationRefs }
                resolvedRevision = await this.resources.provisionRevision(revisionInput)
            }
            this.assertCanonical(resolvedRevision.resource, "resource")
            this.assertCanonical(resolvedRevision.revision, "resource_revision")
            if (resolvedRevision.resource.id !== resource.id || resolvedRevision.revision.resource_ref !== resource.id || Number(resolvedRevision.revision.revision) !== requestedRevision) throw new TaricOperationError("authorization_error", "resolved ResourceRevision is outside the requested Resource")
            const variant = record(resolvedRevision.revision.variant, "ResourceRevision variant")
            if (variant.method !== item.method || variant.path_template !== item.path || (item.contentHash !== undefined && resolvedRevision.revision.content_hash !== item.contentHash)) throw new TaricOperationError("authorization_error", "Manifest method/path/content differs from its canonical ResourceRevision")
            resource = resolvedRevision.resource
            const coverage: Record<string, unknown>[] = []
            const workItems: Record<string, unknown>[] = []
            for (const category of item.testCategories) {
                const identity = deriveStableHostRequestIdentity(this.options.host.getBinding(), { kind: "coverage", challengeId: item.challengeId, assetId: item.assetId, dimensions: [String(resolvedRevision.revision.id), scope.scopeRevisionId, category] })
                const cell = await this.coverageService.record({ dimension: { resource_ref: String(resource.id), resource_revision_ref: String(resolvedRevision.revision.id), test_category: category, conditions: [] }, scopeRevisionId: scope.scopeRevisionId, policyDigest: scope.policyDigest, status: "not_tested", limitations: ["Generated from the approved host manifest."], expectedVersion: 0, idempotencyKey: identity.idempotencyKey })
                this.assertCanonical(cell, "coverage")
                if (cell.resource_ref !== resource.id || cell.resource_revision_ref !== resolvedRevision.revision.id || cell.test_category !== category) throw new TaricOperationError("authorization_error", "Coverage cell dimensions do not match the approved manifest")
                coverage.push(cell)
                const workKey = digest([resolvedRevision.revision.id, scope.scopeRevisionId, category]).slice(7)
                const workItem = await this.work.provisionWorkItem({ challengeId: item.challengeId, assetId: item.assetId, workKey, scopeId: scope.scopeId, targetVersion: requestedRevision, resourceIds: [String(resource.id), String(resolvedRevision.revision.id)], title: item.title!, acceptanceCriteria: item.acceptanceCriteria! })
                this.assertCanonical(workItem, "work_item")
                if (!Array.isArray(workItem.resource_refs) || !workItem.resource_refs.includes(resource.id) || !workItem.resource_refs.includes(resolvedRevision.revision.id) || workItem.scope_ref !== scope.scopeId || Number(workItem.target_version) !== requestedRevision) throw new TaricOperationError("authorization_error", "WorkItem dimensions do not match the approved manifest")
                const workRead = await this.work.queryWork([String(resource.id), String(resolvedRevision.revision.id)])
                if (workRead.diagnostics.hasMore || workRead.diagnostics.status !== "complete") throw new TaricOperationError("incomplete_authority_snapshot", "Admitted WorkItem could not be read from a complete authority snapshot")
                const admitted = workRead.records.find((candidate) => candidate.id === workItem.id)
                if (!admitted || admitted.version !== workItem.version || admitted.scope_ref !== scope.scopeId || Number(admitted.target_version) !== requestedRevision) throw new TaricOperationError("work_item_unresolved", "Admitted WorkItem is not visible in the authority read")
                workItems.push(admitted)
            }
            canonical.push({ challengeId: item.challengeId, assetId: item.assetId, resource, revision: resolvedRevision.revision, coverage, workItems })
        }
        const expectedCells: AuthorityCoverageDimension[] = canonical.flatMap((item) => item.coverage.map((cell) => ({ resource_ref: String(cell.resource_ref), resource_revision_ref: String(cell.resource_revision_ref), test_category: String(cell.test_category), conditions: [] })))
        const manifestIdentity = deriveStableHostRequestIdentity(this.options.host.getBinding(), { kind: "scope", dimensions: [scope.scopeRevisionId, digest(expectedCells)] })
        const coverageManifest = await this.coverageService.commitManifest({ scopeRevisionId: scope.scopeRevisionId, policyDigest: scope.policyDigest, expectedCells, idempotencyKey: manifestIdentity.idempotencyKey })
        await this.scopes.assertCurrent(scope)
        return { scope, manifestDigest: String(coverageManifest.manifest_digest), coverageManifest, manifest: canonical, launchAuthorized: false, closable: false, status: "coverage_incomplete" }
    }

    private assertCanonical(value: Record<string, unknown>, kind: string): void {
        const binding = this.options.host.getBinding()
        requireTaricUuid(value.id, `${kind}Id`)
        if (value.kind !== kind || value.engagement_id !== binding.engagementId || !["L1", "L2"].includes(String(value.trust_level)) || ["stale", "retracted", "superseded", "archived", "expired"].includes(String(value.status))) throw new TaricOperationError("authorization_error", `canonical ${kind} is outside the trusted Engagement`)
    }
}
