import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { engagementId } from "../../engagement/env"
import { writeEngagementReport } from "../../engagement/report"

const GenerateEngagementReportParams = Type.Object({})
type GenerateEngagementReportInput = Static<typeof GenerateEngagementReportParams>

export const generateEngagementReportTool = defineTool({
    name: "generate_engagement_report",
    label: "Generate Engagement Report",
    description:
        "Render the engagement report from findings.ndjson into report.md (human-readable) and report.sarif.json (SARIF 2.1.0) in the current workspace. Idempotent (overwrites).",
    promptSnippet: "generate_engagement_report: render report.md + report.sarif.json from recorded findings",
    parameters: GenerateEngagementReportParams,
    async execute(_toolCallId, _params: GenerateEngagementReportInput, _signal, _onUpdate, ctx) {
        const result = await writeEngagementReport(ctx.cwd, {
            engagementId: engagementId() ?? "engagement",
            generatedAt: new Date().toISOString(),
        })

        return {
            content: [{ type: "text", text: `Wrote engagement report: report.md + report.sarif.json (${result.count} findings)` }],
            details: {
                markdown_path: result.markdownPath,
                sarif_path: result.sarifPath,
                count: result.count,
            },
        }
    },
})
