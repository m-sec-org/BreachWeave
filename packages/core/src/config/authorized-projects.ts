import { randomUUID } from "node:crypto"
import { mkdir, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import type { AuthorizedPentestProject } from "../project/types"
import { deriveCompositeProjectKey, validateProject } from "../project/types"

/** Trusted discovery configuration only; governed state is queried from Taric. */
export interface AuthorizedProjectBinding {
    challengeId: string
    title: string
    project: AuthorizedPentestProject
    scopeId: string
}

interface AuthorizedProjectInventory {
    format: "breachweave-authorized-projects/1"
    bindings: AuthorizedProjectBinding[]
}

function parseBinding(value: unknown): AuthorizedProjectBinding {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authorized project binding must be an object")
    const input = value as Record<string, unknown>
    if (Object.keys(input).some((key) => !["challengeId", "title", "project", "scopeId"].includes(key))) throw new Error("authorized project inventory accepts discovery configuration only")
    const project = validateProject(input.project)
    if (project.mode !== "authorized_pentest") throw new Error("authorized project inventory rejects competition projects")
    if (typeof input.challengeId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.challengeId)) throw new Error("authorized project challengeId is invalid")
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 256 || /[\0\r\n]/.test(input.title)) throw new Error("authorized project title is invalid")
    if (typeof input.scopeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.scopeId)) throw new Error("authorized project scopeId must be a canonical Taric UUID")
    return { challengeId: input.challengeId, title: input.title.trim(), project, scopeId: input.scopeId }
}

/** This file survives cache deletion; loss/corruption is never replaced by local task state. */
export class AuthorizedProjectInventoryStore {
    private mutations: Promise<void> = Promise.resolve()

    constructor(private readonly path: string) {}

    async list(): Promise<AuthorizedProjectBinding[]> {
        let value: unknown
        try {
            if (!(await Bun.file(this.path).exists())) return []
            value = await Bun.file(this.path).json()
        } catch { throw new Error("authorized project inventory is unreadable; restore trusted configuration before governed startup") }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authorized project inventory is invalid")
        const inventory = value as Partial<AuthorizedProjectInventory>
        if (inventory.format !== "breachweave-authorized-projects/1" || !Array.isArray(inventory.bindings) || inventory.bindings.length > 1024) throw new Error("authorized project inventory is invalid")
        const bindings = inventory.bindings.map(parseBinding)
        if (new Set(bindings.map((entry) => entry.challengeId)).size !== bindings.length || new Set(bindings.map((entry) => deriveCompositeProjectKey(entry.project))).size !== bindings.length) throw new Error("authorized project inventory has conflicting bindings")
        return bindings
    }

    async save(input: AuthorizedProjectBinding): Promise<void> {
        const binding = parseBinding(input)
        return this.mutate(async () => {
            const bindings = await this.list()
            const existing = bindings.find((entry) => entry.challengeId === binding.challengeId || deriveCompositeProjectKey(entry.project) === deriveCompositeProjectKey(binding.project))
            if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) throw new Error("authorized project discovery binding is immutable; remove it explicitly before rebinding")
            if (!existing) bindings.push(binding)
            await this.write(bindings)
        })
    }

    async remove(challengeId: string): Promise<void> {
        return this.mutate(async () => this.write((await this.list()).filter((entry) => entry.challengeId !== challengeId)))
    }

    private mutate(action: () => Promise<void>): Promise<void> {
        const pending = this.mutations.then(action)
        this.mutations = pending.catch(() => {})
        return pending
    }

    private async write(bindings: AuthorizedProjectBinding[]): Promise<void> {
        if (bindings.length > 1024) throw new Error("authorized project inventory exceeds the project limit")
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
            await Bun.write(temporary, JSON.stringify({ format: "breachweave-authorized-projects/1", bindings } satisfies AuthorizedProjectInventory, null, 2))
            await rename(temporary, this.path)
        } finally { await rm(temporary, { force: true }) }
    }
}
