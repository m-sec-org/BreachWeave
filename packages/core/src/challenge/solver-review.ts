import { mkdir, readdir, rename } from "node:fs/promises"
import { join } from "node:path"

export interface SolverReviewItem {
    asset_hash: string
    test_item: string
    verdict: "verified" | "blocked" | "missing" | "unsupported"
    evidence: string
}

export interface SolverAssignmentReview {
    summary: string
    checklist: SolverReviewItem[]
    concerns: string[]
    remaining_work: string[]
    suggested_decision: "continue" | "stop"
}

export interface SolverReviewRecord {
    id: string
    challenge_id: string
    solver_id: string
    assignment_id: string
    submission_ids: string[]
    review: SolverAssignmentReview
    created_at: string
    decision?: { action: "continue" | "stop"; rationale: string; instructions?: string; decided_at: string }
}

export function parseSolverAssignmentReview(value: unknown): SolverAssignmentReview {
    if (!value || typeof value !== "object") throw new Error("review is required")
    const input = value as Record<string, unknown>
    function text(value: unknown, field: string): string {
        if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
        return value.trim()
    }
    function texts(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
        return value.map((item) => text(item, field))
    }
    if (!Array.isArray(input.checklist) || input.checklist.length === 0) throw new Error("review checklist is required")
    const checklist = input.checklist.map((value): SolverReviewItem => {
        if (!value || typeof value !== "object") throw new Error("invalid review checklist item")
        const item = value as Record<string, unknown>
        const verdict = item.verdict
        if (verdict !== "verified" && verdict !== "blocked" && verdict !== "missing" && verdict !== "unsupported") throw new Error("invalid review verdict")
        return { asset_hash: text(item.asset_hash, "asset_hash"), test_item: text(item.test_item, "test_item"), verdict, evidence: text(item.evidence, "evidence") }
    })
    const suggestedDecision = input.suggested_decision
    if (suggestedDecision !== "continue" && suggestedDecision !== "stop") throw new Error("invalid suggested decision")
    return {
        summary: text(input.summary, "review.summary"),
        checklist,
        concerns: texts(input.concerns, "review.concerns"),
        remaining_work: texts(input.remaining_work, "review.remaining_work"),
        suggested_decision: suggestedDecision,
    }
}

function reviewsDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId), "solver-reviews")
}

export async function saveSolverReview(rootDir: string, record: SolverReviewRecord): Promise<void> {
    const dir = reviewsDir(rootDir, record.challenge_id)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${encodeURIComponent(record.id)}.json`)
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    await Bun.write(tmp, JSON.stringify(record, null, 2))
    await rename(tmp, path)
}

export async function listSolverReviews(rootDir: string, challengeId: string): Promise<SolverReviewRecord[]> {
    const dir = reviewsDir(rootDir, challengeId)
    let files: string[]
    try {
        files = (await readdir(dir)).filter((name) => name.endsWith(".json"))
    } catch {
        return []
    }
    const records = await Promise.all(files.map(async (name) => {
        try {
            return await Bun.file(join(dir, name)).json() as SolverReviewRecord
        } catch {
            return undefined
        }
    }))
    return records.filter((record): record is SolverReviewRecord => record !== undefined)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}
