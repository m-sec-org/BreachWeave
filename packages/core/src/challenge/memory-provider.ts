import type { CompositeProjectKey, MemoryMode, Project } from "../project/types"
import type { TaricCheckpointProposalInput, TaricHostObservationInput } from "../taric"
import type { TaricHealth } from "../taric"
import {
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeIdea,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeIdea,
    updateChallengeMemory,
} from "./memory"
import type {
    AddIdeaInput,
    AddIdeaResult,
    AddMemoryInput,
    IdeaRecord,
    MemoryEntry,
    UpdateIdeaInput,
} from "./memory"

export interface ChallengeMemoryScope {
    challengeId: string
    project?: Project
    projectKey?: CompositeProjectKey
}

export interface ChallengeMemoryProvider {
    readonly mode: MemoryMode
    assertAvailable?(scope: ChallengeMemoryScope): Promise<void>
    getHealth?(scope: ChallengeMemoryScope): Promise<TaricHealth | undefined> | TaricHealth | undefined
    getReadDiagnostics?(): unknown
    readBoard?(scope: ChallengeMemoryScope): Promise<{ memory: MemoryEntry[]; ideas: IdeaRecord[]; diagnostics?: unknown }>
    listMemory(scope: ChallengeMemoryScope): Promise<MemoryEntry[]>
    appendMemory(scope: ChallengeMemoryScope, input: Omit<AddMemoryInput, "challengeId">): Promise<MemoryEntry>
    updateMemory(
        scope: ChallengeMemoryScope,
        entryIdOrPrefix: string,
        patch: { kind?: AddMemoryInput["kind"]; content?: string; refs?: string[]; source?: string },
    ): Promise<MemoryEntry>
    deleteMemory(scope: ChallengeMemoryScope, entryIdOrPrefix: string): Promise<MemoryEntry>
    listIdeas(scope: ChallengeMemoryScope): Promise<IdeaRecord[]>
    searchIdeas(scope: ChallengeMemoryScope, query: string): Promise<IdeaRecord[]>
    addIdea(scope: ChallengeMemoryScope, input: AddIdeaInput): Promise<AddIdeaResult>
    updateIdea(scope: ChallengeMemoryScope, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord>
    deleteIdea(scope: ChallengeMemoryScope, ideaIdOrPrefix: string): Promise<IdeaRecord>
    captureObservation(scope: ChallengeMemoryScope, input: TaricHostObservationInput): Promise<unknown>
    proposeCheckpoint(scope: ChallengeMemoryScope, input: TaricCheckpointProposalInput): Promise<unknown>
    close?(): Promise<void>
}

export class FileChallengeMemoryProvider implements ChallengeMemoryProvider {
    readonly mode = "legacy_local" as const

    constructor(private readonly rootDir: () => Promise<string>) {}

    private namespace(scope: ChallengeMemoryScope): string {
        return scope.projectKey ?? scope.challengeId
    }

    async listMemory(scope: ChallengeMemoryScope): Promise<MemoryEntry[]> {
        const entries = await listChallengeMemory(await this.rootDir(), this.namespace(scope))
        return entries.map((entry) => ({ ...entry, challengeId: scope.challengeId }))
    }

    async readBoard(scope: ChallengeMemoryScope): Promise<{ memory: MemoryEntry[]; ideas: IdeaRecord[] }> {
        const [memory, ideas] = await Promise.all([this.listMemory(scope), this.listIdeas(scope)])
        return { memory, ideas }
    }

    async appendMemory(scope: ChallengeMemoryScope, input: Omit<AddMemoryInput, "challengeId">): Promise<MemoryEntry> {
        const entry = await appendChallengeMemory(await this.rootDir(), { ...input, challengeId: this.namespace(scope) })
        return { ...entry, challengeId: scope.challengeId }
    }

    async updateMemory(
        scope: ChallengeMemoryScope,
        entryIdOrPrefix: string,
        patch: { kind?: AddMemoryInput["kind"]; content?: string; refs?: string[]; source?: string },
    ): Promise<MemoryEntry> {
        const entry = await updateChallengeMemory(await this.rootDir(), this.namespace(scope), entryIdOrPrefix, patch)
        return { ...entry, challengeId: scope.challengeId }
    }

    async deleteMemory(scope: ChallengeMemoryScope, entryIdOrPrefix: string): Promise<MemoryEntry> {
        const entry = await deleteChallengeMemory(await this.rootDir(), this.namespace(scope), entryIdOrPrefix)
        return { ...entry, challengeId: scope.challengeId }
    }

    async listIdeas(scope: ChallengeMemoryScope): Promise<IdeaRecord[]> {
        return listChallengeIdeas(await this.rootDir(), this.namespace(scope))
    }

    async searchIdeas(scope: ChallengeMemoryScope, query: string): Promise<IdeaRecord[]> {
        return searchChallengeIdeas(await this.rootDir(), this.namespace(scope), query)
    }

    async addIdea(scope: ChallengeMemoryScope, input: AddIdeaInput): Promise<AddIdeaResult> {
        return addChallengeIdea(await this.rootDir(), this.namespace(scope), input)
    }

    async updateIdea(scope: ChallengeMemoryScope, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
        return updateChallengeIdea(await this.rootDir(), this.namespace(scope), ideaIdOrPrefix, patch)
    }

    async deleteIdea(scope: ChallengeMemoryScope, ideaIdOrPrefix: string): Promise<IdeaRecord> {
        return deleteChallengeIdea(await this.rootDir(), this.namespace(scope), ideaIdOrPrefix)
    }

    async captureObservation(): Promise<never> {
        throw new Error("host observations are unsupported by the legacy local provider")
    }

    async proposeCheckpoint(): Promise<never> {
        throw new Error("checkpoints are unsupported by the legacy local provider")
    }
}
