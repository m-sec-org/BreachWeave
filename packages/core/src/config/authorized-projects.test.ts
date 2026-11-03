import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthorizedProjectInventoryStore } from "./authorized-projects"
import type { AuthorizedProjectBinding } from "./authorized-projects"

function entry(challengeId: string): AuthorizedProjectBinding {
    return { challengeId, title: "Controlled project", scopeId: "019a0000-0000-7000-8000-000000000001", project: { mode: "authorized_pentest", tenant_id: "tenant-a", engagement_id: challengeId, scope_revision: 1, coverage_manifest_id: "manifest-a", memory_mode: "taric_required", taric_engagement_id: "engagement-a" } }
}

describe("authorized project discovery configuration", () => {
    test("fresh process discovery survives deletion of disposable challenge state and concurrent saves", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-project-inventory-"))
        try {
            const path = join(root, "config", "authorized-projects.json")
            const inventory = new AuthorizedProjectInventoryStore(path)
            await Bun.write(join(root, "challenge.json"), "{}")
            await Promise.all([inventory.save(entry("challenge-a")), inventory.save(entry("challenge-b"))])
            await rm(join(root, "challenge.json"))
            const fresh = new AuthorizedProjectInventoryStore(path)
            expect((await fresh.list()).map((binding) => binding.challengeId).sort()).toEqual(["challenge-a", "challenge-b"])
            await expect(fresh.save({ ...entry("challenge-a"), scopeId: "019a0000-0000-7000-8000-000000000099" })).rejects.toThrow("immutable")
            await fresh.remove("challenge-a")
            expect((await fresh.list()).map((binding) => binding.challengeId)).toEqual(["challenge-b"])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    test("corrupt inventory and copied governance state fail closed", async () => {
        const root = await mkdtemp(join(tmpdir(), "bw-project-inventory-"))
        try {
            const path = join(root, "authorized-projects.json")
            const inventory = new AuthorizedProjectInventoryStore(path)
            await Bun.write(path, "{bad json")
            await expect(inventory.list()).rejects.toThrow("unreadable")
            await rm(path)
            await expect(inventory.save({ ...entry("challenge-a"), manifest: [] } as AuthorizedProjectBinding)).rejects.toThrow("discovery configuration only")
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})
