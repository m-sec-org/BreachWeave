import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { SubmitSubAgentOutputParams, createStructuredSubAgentOutput, type SubmittedSubAgentOutputPayload } from "./pentest-output"
import { ensurePentestWorkspace, pentestSubAgentPath } from "./pentest-workspace"

type SubmitSubAgentOutputInput = Static<typeof SubmitSubAgentOutputParams> & SubmittedSubAgentOutputPayload

const DEFAULT_EXPECTED_OUTPUT_SCHEMA =
    'Call submit_sub_agent_output exactly once with {"assets":[],"hypotheses":[],"candidate_findings":[],"evidence_refs":[],"coverage_gaps":[]}'

export const submitSubAgentOutputTool = defineTool({
    name: "submit_sub_agent_output",
    label: "Submit Sub-Agent Output",
    description: "Write canonical structured sub-agent output into sub-agents/<output_id>.json in the current workspace.",
    promptSnippet: "submit_sub_agent_output: submit assets/hypotheses/candidate_findings/evidence_refs/coverage_gaps",
    parameters: SubmitSubAgentOutputParams,
    async execute(_toolCallId, params: SubmitSubAgentOutputInput, _signal, _onUpdate, ctx) {
        await ensurePentestWorkspace(ctx.cwd)

        const output = createStructuredSubAgentOutput({
            outputId: params.output_id,
            role: params.role,
            stage: params.stage,
            objective: params.objective,
            context: params.context,
            policyRef: params.policy_ref ?? "run-policy.json",
            inputArtifacts: params.input_artifacts ?? [],
            expectedOutputSchema: params.expected_output_schema ?? DEFAULT_EXPECTED_OUTPUT_SCHEMA,
            markdownPath: params.markdown_path ?? `sub-agents/${params.output_id}.md`,
            payload: {
                assets: params.assets,
                hypotheses: params.hypotheses,
                candidate_findings: params.candidate_findings,
                evidence_refs: params.evidence_refs,
                coverage_gaps: params.coverage_gaps,
                goal: params.goal,
            },
        })

        const outputPath = pentestSubAgentPath(ctx.cwd, params.output_id, "json")
        if (await Bun.file(outputPath).exists()) {
            throw new Error(`submit_sub_agent_output can only be called once for output_id "${params.output_id}"`)
        }
        await Bun.write(outputPath, JSON.stringify(output, null, 2))

        return {
            content: [{ type: "text", text: `Wrote canonical sub-agent output to sub-agents/${params.output_id}.json` }],
            details: {
                output_id: params.output_id,
                output_path: `sub-agents/${params.output_id}.json`,
                role: params.role,
                stage: params.stage,
            },
        }
    },
})
