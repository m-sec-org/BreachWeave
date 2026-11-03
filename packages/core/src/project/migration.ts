import { readdir } from "fs/promises"
import { join } from "path"
import { archiveChallengeRecord } from "../challenge/store"
import { deriveCompositeProjectKey, validateProject } from "./types"

export type LegacyMigrationClassification = "trusted" | "legacy_unclassified" | "host_audit_only" | "conflict"

export interface LegacyMigrationItem {
    challengeId: string
    classification: LegacyMigrationClassification
    /** A locally valid project identity never verifies canonical Taric provenance. */
    authorityProvenance: "unverified"
    canonicalAdmission: "not_requested"
    contentDigest: string
    sourceReference: string
    createdAt: string
    projectId?: string
    sensitiveWarnings: readonly string[]
    conflicts: readonly string[]
}

export interface LegacyMigrationReport {
    rootDir: string
    generatedAt: string
    readOnly: true
    counts: {
        total: number
        trusted: number
        legacyUnclassified: number
        hostAuditOnly: number
        conflicts: number
        sensitive: number
    }
    items: readonly LegacyMigrationItem[]
}

export interface LegacyArchiveResult {
    archived: readonly string[]
    missing: readonly string[]
}

const SENSITIVE_FIELD_PATTERN = /(flag|token|secret|password|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i
const SENSITIVE_VALUE_PATTERN = /flag\{[^}]*\}|bearer\s+[A-Za-z0-9._~+/=-]+|(?:sk|ak|pk)[_-][A-Za-z0-9._-]{12,}/gi

function warnings(value: unknown, path = "record", output: string[] = []): string[] {
    if (output.length >= 32 || path.length > 256) return output
    if (typeof value === "string") {
        if (SENSITIVE_VALUE_PATTERN.test(value)) output.push(`${path}: sensitive-looking value`)
        SENSITIVE_VALUE_PATTERN.lastIndex = 0
        return output
    }
    if (Array.isArray(value)) {
        for (const [index, item] of value.slice(0, 100).entries()) {
            if (output.length >= 32) break
            warnings(item, `${path}[${index}]`, output)
        }
        return output
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
            if (output.length >= 32) break
            const childPath = `${path}.${key.slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, "")}`
            if (SENSITIVE_FIELD_PATTERN.test(key)) output.push(`${childPath}: sensitive field`)
            warnings(item, childPath, output)
        }
    }
    return output
}

/** Read-only classification of legacy challenge records. No files are written. */
export async function dryRunLegacyMigration(rootDir: string): Promise<LegacyMigrationReport> {
    // Read raw files: the ordinary store list deliberately omits malformed
    // identities, which must remain visible in a migration diagnostic.
    let directories: string[]
    try {
        directories = (await readdir(rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch {
        directories = []
    }
    const items: LegacyMigrationItem[] = []
    for (const challengeId of directories) {
        const file = Bun.file(join(rootDir, challengeId, "challenge.json"))
        if (!(await file.exists())) continue
        const bytes = new Uint8Array(await file.arrayBuffer())
        const conflicts: string[] = []
        let record: Record<string, unknown> = {}
        try {
            const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
            if (!value || typeof value !== "object" || Array.isArray(value)) conflicts.push("challenge record must be an object")
            else record = value as Record<string, unknown>
        } catch {
            conflicts.push("challenge record is not valid JSON")
        }
        if (record.id !== undefined && record.id !== challengeId) conflicts.push("record identity does not match its source directory")
        let projectId: string | undefined
        let classification: LegacyMigrationClassification = "legacy_unclassified"
        if (record.project !== undefined) {
            try {
                const project = validateProject(record.project)
                projectId = deriveCompositeProjectKey(project)
                if (record.project_id !== undefined && record.project_id !== projectId) conflicts.push("record project_id does not match the host-derived identity")
                classification = project.mode === "authorized_pentest" ? "host_audit_only" : "trusted"
            } catch {
                conflicts.push("project identity cannot be validated")
            }
        } else if (record.project_id !== undefined) {
            conflicts.push("project_id has no validated project identity")
        }
        if (conflicts.length > 0) classification = "conflict"
        items.push({
            challengeId,
            classification,
            authorityProvenance: "unverified",
            canonicalAdmission: "not_requested",
            contentDigest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            sourceReference: `challenge/${encodeURIComponent(challengeId)}/challenge.json`,
            createdAt: typeof record.created_at === "string" ? record.created_at : "unknown",
            ...(projectId ? { projectId } : {}),
            sensitiveWarnings: warnings(record),
            conflicts,
        })
    }
    const projectOwners = new Map<string, LegacyMigrationItem[]>()
    for (const item of items) {
        if (item.projectId) projectOwners.set(item.projectId, [...(projectOwners.get(item.projectId) ?? []), item])
    }
    for (const owners of projectOwners.values()) {
        if (owners.length < 2) continue
        for (const item of owners) {
            item.classification = "conflict"
            item.conflicts = [...item.conflicts, "project identity is shared by multiple legacy records; explicit mapping review is required"]
        }
    }
    return {
        rootDir,
        generatedAt: new Date().toISOString(),
        readOnly: true,
        counts: {
            total: items.length,
            trusted: items.filter((item) => item.classification === "trusted").length,
            legacyUnclassified: items.filter((item) => item.classification === "legacy_unclassified").length,
            hostAuditOnly: items.filter((item) => item.classification === "host_audit_only").length,
            conflicts: items.filter((item) => item.classification === "conflict").length,
            sensitive: items.filter((item) => item.sensitiveWarnings.length > 0).length,
        },
        items,
    }
}

/** Archive only IDs explicitly selected by an operator after reviewing a dry run. */
export async function archiveLegacyUnclassified(
    report: LegacyMigrationReport,
    challengeIds: readonly string[],
    archiveRootDir?: string,
): Promise<LegacyArchiveResult> {
    const selected = new Set(challengeIds.map((id) => id.trim()).filter(Boolean))
    const allowed = new Set(report.items.filter((item) => item.classification !== "trusted").map((item) => item.challengeId))
    const archived: string[] = []
    const missing: string[] = []
    for (const id of selected) {
        if (!allowed.has(id)) throw new Error(`challenge "${id}" is not an unclassified or conflicting migration record`)
        const moved = await archiveChallengeRecord(report.rootDir, id, archiveRootDir)
        if (moved) archived.push(id)
        else missing.push(id)
    }
    return { archived, missing }
}

/** Return the archive manifest without loading or mutating the archived payload. */
export async function listLegacyArchiveEntries(archiveRootDir: string): Promise<string[]> {
    try {
        return (await readdir(archiveRootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(archiveRootDir, entry.name)).sort()
    } catch {
        return []
    }
}
