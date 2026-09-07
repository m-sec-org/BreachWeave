import { join } from "node:path"
import type { AddIdeaInput, AddIdeaResult, AddMemoryInput, IdeaRecord, MemoryEntry, MemoryKind, UpdateIdeaInput } from "../challenge/memory"
import {
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeIdea,
    updateChallengeMemory,
} from "../challenge/memory"

const SOLVER_BOARD_NAMESPACE = "board"

function requireSessionDir(sessionDir?: string): string {
    const value = sessionDir?.trim() || process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!value) {
        throw new Error("TCH_SOLVER_SESSION_DIR is required for solver board storage")
    }
    return value
}

export function solverBoardRootDir(sessionDir?: string): string {
    return join(requireSessionDir(sessionDir), ".observer")
}

export async function appendSolverBoardMemory(
    input: Omit<AddMemoryInput, "challengeId">,
    sessionDir?: string,
): Promise<MemoryEntry> {
    return appendChallengeMemory(solverBoardRootDir(sessionDir), {
        ...input,
        challengeId: SOLVER_BOARD_NAMESPACE,
    })
}

export async function listSolverBoardMemory(sessionDir?: string): Promise<MemoryEntry[]> {
    return listChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function updateSolverBoardMemory(
    entryIdOrPrefix: string,
    patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string },
    sessionDir?: string,
): Promise<MemoryEntry> {
    return updateChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, entryIdOrPrefix, patch)
}

export async function deleteSolverBoardMemory(entryIdOrPrefix: string, sessionDir?: string): Promise<MemoryEntry> {
    return deleteChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, entryIdOrPrefix)
}

export async function listSolverBoardIdeas(sessionDir?: string): Promise<IdeaRecord[]> {
    return listChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function searchSolverBoardIdeas(query: string, sessionDir?: string): Promise<IdeaRecord[]> {
    return searchChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, query)
}

export async function addSolverBoardIdea(input: AddIdeaInput, sessionDir?: string): Promise<AddIdeaResult> {
    return addChallengeIdea(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, input)
}

export async function updateSolverBoardIdea(ideaIdOrPrefix: string, patch: UpdateIdeaInput, sessionDir?: string): Promise<IdeaRecord> {
    return updateChallengeIdea(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, ideaIdOrPrefix, patch)
}

export async function readSolverBoardSnapshot(sessionDir?: string): Promise<{ memory: MemoryEntry[]; ideas: IdeaRecord[] }> {
    const [memory, ideas] = await Promise.all([listSolverBoardMemory(sessionDir), listSolverBoardIdeas(sessionDir)])
    return { memory, ideas }
}

export async function seedSolverBoardSnapshot(
    input: {
        memory: MemoryEntry[]
        ideas: IdeaRecord[]
    },
    sessionDir?: string,
): Promise<void> {
    const existing = await readSolverBoardSnapshot(sessionDir)
    if (existing.memory.length > 0 || existing.ideas.length > 0) return

    for (const entry of input.memory) {
        await appendSolverBoardMemory(
            {
                kind: entry.kind,
                content: entry.content,
                refs: entry.refs,
                source: entry.source,
            },
            sessionDir,
        )
    }

    for (const idea of input.ideas) {
        await addSolverBoardIdea(
            {
                content: idea.content,
                status: idea.status,
                result: idea.result,
            },
            sessionDir,
        )
    }
}
