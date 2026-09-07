import type { IdeaRecord, MemoryEntry } from "../../../challenge/memory"

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function escapeTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map((row) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`)
    return [header, separator, ...body].join("\n")
}

function formatRefs(refs: string[]): string {
    return refs.length > 0 ? refs.join(", ") : "-"
}

export function formatMemoryTable(items: MemoryEntry[], options?: { contentMaxChars?: number; updatedAtFallback?: boolean }): string {
    if (items.length === 0) return "No memory entries."
    const contentMaxChars = options?.contentMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.kind,
        clipText(item.content, contentMaxChars),
        formatRefs(item.refs),
        item.source,
        options?.updatedAtFallback === true ? item.updated_at || item.created_at : item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Kind", "Content", "Refs", "Source", "Updated"], rows)
}

export function formatIdeaTable(items: IdeaRecord[], options?: { contentMaxChars?: number; resultMaxChars?: number; updatedAtFallback?: boolean }): string {
    if (items.length === 0) return "No ideas."
    const contentMaxChars = options?.contentMaxChars ?? 100
    const resultMaxChars = options?.resultMaxChars ?? 120
    const rows = items.map((item) => [
        item.id,
        item.status,
        clipText(item.content, contentMaxChars),
        item.result ? clipText(item.result, resultMaxChars) : "-",
        options?.updatedAtFallback === true ? item.updated_at || item.created_at : item.updated_at,
    ])
    return formatMarkdownTable(["ID", "Status", "Idea", "Result", "Updated"], rows)
}
