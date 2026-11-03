import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { deriveCompositeProjectKey } from "../project/types"
import {
    EncryptedTaricOutbox,
    TARIC_BUN_DRIVER_INTEGRITY,
    TARIC_BUN_DRIVER_PACKAGE,
    TARIC_BUN_DRIVER_VERSION,
    TARIC_COMPATIBILITY_BASELINE,
    createTaricHostModule,
} from "../taric"
import type { TaricCompatibility, TaricHostBinding } from "../taric"
import { FileChallengeMemoryProvider } from "./memory-provider"
import { TaricMemoryProvider } from "./taric-memory-provider"

const projectA = {
    mode: "competition" as const,
    provider: "local_practice" as const,
    tenant_id: "tenant-a",
    platform_id: "platform-a",
    competition_id: "competition-a",
    team_id: "team-a",
    challenge_code: "same-code",
    memory_mode: "legacy_local" as const,
}

const projectB = { ...projectA, team_id: "team-b" }

describe("challenge memory providers", () => {
    test("file provider uses the composite identity when trusted projects share a challenge code", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-memory-provider-"))
        try {
            const provider = new FileChallengeMemoryProvider(async () => dir)
            const scopeA = { challengeId: "same-code", project: projectA, projectKey: deriveCompositeProjectKey(projectA) }
            const scopeB = { challengeId: "same-code", project: projectB, projectKey: deriveCompositeProjectKey(projectB) }
            await provider.appendMemory(scopeA, { kind: "fact", content: "team A", source: "host" })
            await provider.appendMemory(scopeB, { kind: "fact", content: "team B", source: "host" })
            expect((await provider.listMemory(scopeA)).map((item) => item.content)).toEqual(["team A"])
            expect((await provider.listMemory(scopeB)).map((item) => item.content)).toEqual(["team B"])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test("best-effort writes queue encrypted candidates without falling back to local storage", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bw-memory-provider-"))
        try {
            const project = { ...projectA, memory_mode: "taric_best_effort" as const, taric_engagement_id: "engagement-a" }
            const projectKey = deriveCompositeProjectKey(project)
            const binding: TaricHostBinding = {
                projectId: projectKey,
                tenantId: project.tenant_id,
                engagementId: "engagement-a",
                hostPrincipalId: "host-a",
                modelPrincipalId: "model-a",
            }
            const compatibility: TaricCompatibility = {
                ...TARIC_COMPATIBILITY_BASELINE,
                policyDigest: "sha256:policy",
                bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY },
            }
            const outbox = new EncryptedTaricOutbox({ path: join(dir, "outbox.jsonl"), key: new Uint8Array(32).fill(4) })
            const host = createTaricHostModule({ binding, expectedCompatibility: compatibility, mode: project.memory_mode })
            await host.initialize()
            const provider = new TaricMemoryProvider({ host, mode: project.memory_mode, outbox })
            const scope = { challengeId: "same-code", project, projectKey }
            const proposal = await provider.appendMemory(scope, { kind: "fact", content: "candidate only", source: "model" })
            expect(proposal.trustState).toBe("candidate")
            expect((await outbox.pending(projectKey))).toHaveLength(1)
            await expect(provider.listMemory(scope)).rejects.toThrow("No verified Taric adapter")
            await host.close()
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
