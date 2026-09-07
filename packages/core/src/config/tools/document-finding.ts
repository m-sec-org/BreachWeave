import { join, relative, resolve } from "path"
import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { ensurePentestWorkspace, pentestSubAgentPath, readHypothesisBacklog, readRunState } from "./pentest-workspace"

const DocumentFindingParams = Type.Object({
    target: Type.String({ description: "Target URL, host, or IP" }),
    kind: Type.String({ description: "Vulnerability type, e.g. xss, sqli, idor" }),
    entry_point: Type.String({ description: "Entry point, path, parameter, or trigger" }),
    hypothesis: Type.String({ description: "Hypothesis description" }),
    hypothesis_id: Type.String({ description: "Hypothesis ID for traceability" }),
    status: Type.Union([Type.Literal("candidate"), Type.Literal("verified"), Type.Literal("rejected")]),
    evidence: Type.String({ description: "Evidence summary" }),
    evidence_refs: Type.Array(Type.String(), { description: "Evidence paths or references" }),
    source_agent: Type.String({ description: "Source agent identifier" }),
    source_artifact: Type.String({ description: "Source artifact path, e.g. sub-agents/recon-001.json" }),
    notes: Type.String({ description: "Additional notes" }),
})
type DocumentFindingInput = Static<typeof DocumentFindingParams>

interface FindingRecord {
    target: string
    kind: string
    entry_point: string
    hypothesis: string
    hypothesis_id: string
    status: "candidate" | "verified" | "rejected"
    evidence: string
    evidence_refs: string[]
    source_agent: string
    source_artifact: string
    notes: string
    timestamp: string
}

function dedupKey(record: Pick<FindingRecord, "target" | "kind" | "entry_point">): string {
    return `${record.target}\n${record.kind}\n${record.entry_point}`
}

function renderFinding(record: FindingRecord): string {
    const evidenceRefs = record.evidence_refs.length > 0 ? record.evidence_refs.map((ref) => `- ${ref}`).join("\n") : "- none"
    return `## Finding: ${record.kind} — ${record.entry_point}

target: ${record.target}
kind: ${record.kind}
entry_point: ${record.entry_point}
hypothesis: ${record.hypothesis}
hypothesis_id: ${record.hypothesis_id}
status: ${record.status}
evidence: ${record.evidence}
source_agent: ${record.source_agent}
source_artifact: ${record.source_artifact}
evidence_refs:
${evidenceRefs}
notes: ${record.notes}
timestamp: ${record.timestamp}`
}

function renderFindingsMarkdown(records: FindingRecord[]): string {
    if (records.length === 0) {
        return "# Findings\n\n<!-- Structured findings will be appended by document_finding tool -->\n"
    }
    return `# Findings

<!-- Structured findings will be appended by document_finding tool -->

${records.map((record) => renderFinding(record)).join("\n\n")}
`
}

function parseNdjson(content: string): FindingRecord[] {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            try {
                return JSON.parse(line) as FindingRecord
            } catch {
                return
            }
        })
        .filter((record): record is FindingRecord => Boolean(record))
}

function normalizeSourceArtifact(cwd: string, sourceArtifact: string): string {
    const normalized = sourceArtifact.trim()
    if (!normalized) {
        throw new Error("source_artifact must be a non-empty string")
    }

    const absolutePath = resolve(cwd, normalized)
    const expectedPath = pentestSubAgentPath(cwd, normalized.replace(/^sub-agents\//, "").replace(/\.json$/, ""), "json")
    if (normalized.startsWith("sub-agents/")) {
        return normalized
    }
    if (absolutePath === expectedPath || absolutePath.startsWith(resolve(cwd, "sub-agents"))) {
        return relative(cwd, absolutePath).replace(/\\/g, "/")
    }
    throw new Error('source_artifact must resolve under "sub-agents/"')
}

export const documentFindingTool = defineTool({
    name: "document_finding",
    label: "Document Finding",
    description: "Record a structured finding into findings.ndjson and rebuild findings.md in the current workspace.",
    promptSnippet: "document_finding: record a structured finding with source and evidence references",
    parameters: DocumentFindingParams,
    async execute(_toolCallId, params: DocumentFindingInput, _signal, _onUpdate, ctx) {
        await ensurePentestWorkspace(ctx.cwd)

        const sourceArtifact = normalizeSourceArtifact(ctx.cwd, params.source_artifact)
        const sourceFile = Bun.file(join(ctx.cwd, sourceArtifact))
        if (!(await sourceFile.exists())) {
            throw new Error(`source_artifact does not exist: ${sourceArtifact}`)
        }

        const runState = await readRunState(ctx.cwd)
        if (runState.active_hypothesis_id === params.hypothesis_id) {
            throw new Error(`hypothesis_id "${params.hypothesis_id}" is still active; ingest output before documenting finding`)
        }

        const backlog = await readHypothesisBacklog(ctx.cwd)
        const backlogHypothesis = backlog.hypotheses.find((hypothesis) => hypothesis.id === params.hypothesis_id)
        if (backlogHypothesis && backlogHypothesis.status === "candidate") {
            throw new Error(`hypothesis_id "${params.hypothesis_id}" is still candidate; ingest targeted output before documenting finding`)
        }

        const findingsNdjsonFile = Bun.file(join(ctx.cwd, "findings.ndjson"))
        const existingContent = await findingsNdjsonFile.text().catch(() => "")
        const records = parseNdjson(existingContent)
        const index = new Map<string, FindingRecord>(records.map((record) => [dedupKey(record), record]))

        const record: FindingRecord = {
            ...params,
            source_artifact: sourceArtifact,
            evidence_refs: [...new Set(params.evidence_refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0))],
            timestamp: new Date().toISOString(),
        }

        index.set(dedupKey(record), record)
        await Bun.write(findingsNdjsonFile, `${existingContent}${JSON.stringify(record)}\n`)
        await Bun.write(join(ctx.cwd, "findings.md"), renderFindingsMarkdown([...index.values()]))

        return {
            content: [{ type: "text", text: `Recorded finding: ${params.kind} at ${params.entry_point} (${params.status})` }],
            details: {
                source_artifact: sourceArtifact,
                findings_path: "findings.md",
                findings_ndjson_path: "findings.ndjson",
            },
        }
    },
})
