import { defineTool } from "@earendil-works/pi-coding-agent"
import type { Static } from "typebox"
import { Type } from "typebox"
import { markAuthorizedWorkFinished, requestHostBridge } from "../../challenge/host-bridge-client"

const EmptyParams = Type.Object({})
const SubmitReportParams = Type.Object({
    asset_hash: Type.String({
        description: "Exact MD5 asset identifier shown beside the assigned target in the solver entrypoint list.",
    }),
    report: Type.String({ description: "Detailed penetration test report for this asset, MUST USE CHINESE" }),
    test_results: Type.Optional(Type.Array(Type.Object({
        test_item: Type.String({ minLength: 1, description: "Exact test item from this solver's assigned checklist." }),
        status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
        evidence: Type.String({ minLength: 1, description: "Verified evidence for completion, or the reason this test item is blocked." }),
    }), { description: "Outcome of each assigned test item covered by this report." })),
    discoveries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        description: "Additional findings or test opportunities for the planner to evaluate and assign. Do not expand this solver's assignment to pursue them.",
    })),
})
const ChallengeHintParams = Type.Object({})
const AuthorizedHttpParams = Type.Object({
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"), Type.Literal("OPTIONS")])),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
    rationale: Type.String({ minLength: 1, maxLength: 1024 }),
})
const AuthorizedWorkCompleteParams = Type.Object({})

type SubmitReportInput = Static<typeof SubmitReportParams>

export const challengeSubmitReportTool = defineTool({
    name: "challenge_submit_report",
    label: "Challenge Submit Report",
    description: "Submit a detailed report and assigned test-item outcomes for one asset. Hand additional discoveries to the planner, then stop after completing this solver's assignment.",
    promptSnippet: "challenge_submit_report: report one exact asset_hash with test_results and discoveries for the planner",
    parameters: SubmitReportParams,
    async execute(_toolCallId, params: SubmitReportInput) {
        const details = await requestHostBridge<{
            challenge?: unknown
            assets_total: number
            assets_scanned: number
            assets_pending: number
            assets_completed: boolean
            solver_task_completed: boolean
        }>("challenge_submit_report", {
            asset_hash: params.asset_hash,
            report: params.report,
            ...(params.test_results !== undefined ? { test_results: params.test_results } : {}),
            ...(params.discoveries !== undefined ? { discoveries: params.discoveries } : {}),
        })
        const completion = details.assets_completed ? "all assets scanned" : `${details.assets_pending} assets pending`
        return {
            content: [{
                type: "text",
                text: details.solver_task_completed
                    ? `资产 ${params.asset_hash} 的报告已提交。本次分工报告齐全，请结束；剩余资产由 planner 安排。`
                    : `submitted report for asset hash: ${params.asset_hash}, ${completion}`,
            }],
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

export const challengeAuthorizedHttpTool = defineTool({
    name: "challenge_authorized_http",
    label: "Authorized HTTP Request",
    description: "Send one HTTP request through the host's Taric Scope and WorkRun authorization path.",
    promptSnippet: "challenge_authorized_http: make a scoped, audited HTTP request to the current authorized target",
    parameters: AuthorizedHttpParams,
    async execute(_toolCallId, params: Static<typeof AuthorizedHttpParams>) {
        const result = await requestHostBridge<{ statusCode: number; outcome: string; bodyBase64?: string; diagnostic?: string }>("challenge_authorized_http", params)
        const body = result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64").toString("utf8") : ""
        return {
            content: [{ type: "text", text: [`HTTP outcome: ${result.outcome}`, `status: ${result.statusCode}`, body.slice(0, 32_768)].filter(Boolean).join("\n") }],
            details: { statusCode: result.statusCode, outcome: result.outcome, diagnostic: result.diagnostic },
        }
    },
})

export const authorizedWorkCompleteTool = defineTool({
    name: "authorized_work_complete",
    label: "Complete Authorized Work",
    description: "Complete the current Taric WorkRun after recording the final outcome and remaining Coverage gaps.",
    promptSnippet: "authorized_work_complete: finish this WorkRun after summarizing its verified outcome",
    parameters: AuthorizedWorkCompleteParams,
    async execute() {
        await requestHostBridge("authorized_work_finish", {})
        markAuthorizedWorkFinished()
        return { content: [{ type: "text", text: "Taric WorkRun completed." }], details: {} }
    },
})

export const challengeTools = [
    challengeAuthorizedHttpTool,
    authorizedWorkCompleteTool,
    challengeGetHintTool,
    challengeSubmitReportTool,
]

export const challengeToolNames = new Set(challengeTools.map((tool) => tool.name))
