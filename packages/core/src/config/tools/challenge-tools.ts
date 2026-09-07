import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

const EmptyParams = Type.Object({})
const SubmitReportParams = Type.Object({
    asset_hash: Type.String({
        description: "Exact MD5 asset identifier shown beside the assigned target in the solver entrypoint list.",
    }),
    report: Type.String({ description: "Detailed penetration test report for this asset, MUST USE CHINESE" }),
})
const ChallengeHintParams = Type.Object({})

type SubmitReportInput = Static<typeof SubmitReportParams>

export const challengeSubmitReportTool = defineTool({
    name: "challenge_submit_report",
    label: "Challenge Submit Report",
    description: "Submit a detailed penetration test report for one asset in the current challenge.",
    promptSnippet: "challenge_submit_report: submit a detailed report using one exact asset_hash",
    parameters: SubmitReportParams,
    async execute(_toolCallId, params: SubmitReportInput) {
        const details = await requestHostBridge<{
            challenge?: unknown
            assets_total: number
            assets_scanned: number
            assets_pending: number
            assets_completed: boolean
        }>("challenge_submit_report", { asset_hash: params.asset_hash, report: params.report })
        const completion = details.assets_completed ? "all assets scanned" : `${details.assets_pending} assets pending`
        return {
            content: [{ type: "text", text: `submitted report for asset hash: ${params.asset_hash}, ${completion}` }],
            details,
        }
    },
})

export const challengeGetHintTool = defineTool({
    name: "challenge_get_hint",
    label: "Challenge Get Hint",
    description: "Fetch or read persisted hint for current challenge .",
    promptSnippet: "challenge_get_hint: fetch hint for current challenge",
    parameters: ChallengeHintParams,
    async execute() {
        const details = await requestHostBridge<{
            code: string
            hint_content: string | null
        }>("challenge_get_hint", {})
        const hint = details.hint_content?.trim()
        return {
            content: [{ type: "text", text: hint ? `challenge hint:\n${hint}` : "challenge hint is empty" }],
            details,
        }
    },
})

export const challengeTools = [
    challengeGetHintTool,
    challengeSubmitReportTool,
]

export const challengeToolNames = new Set(challengeTools.map((tool) => tool.name))
