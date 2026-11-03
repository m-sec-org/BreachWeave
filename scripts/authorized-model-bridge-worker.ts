import { stream } from "@earendil-works/pi-ai/api/openai-completions"
import type { Model } from "@earendil-works/pi-ai"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { createAuthorizedModelFetch } from "../packages/core/src/solver/authorized-model-fetch"
import { resolveHostBridgeResponse } from "../packages/core/src/challenge/host-bridge-client"

const origin = process.argv[2]!
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
    input += chunk
    let newline: number
    while ((newline = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        const response = JSON.parse(line) as { request_id: string; success: boolean; data?: unknown; error?: string }
        resolveHostBridgeResponse(response.request_id, response.success, response.data, response.error)
    }
})
globalThis.fetch = createAuthorizedModelFetch(origin)
const model: Model<"openai-completions"> = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", baseUrl: `${origin}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 100 }
const response = await stream(model, normalizeContext({ messages: [{ role: "user", content: "Run the local transport fixture.", timestamp: Date.now() }] }), { apiKey: "TCH_MODEL_BRIDGE_PLACEHOLDER", maxRetries: 0 }).result()
const passed = response.stopReason === "stop" && response.content.some((block) => block.type === "text" && block.text === "fixture model streaming")
process.stdout.write(`${JSON.stringify({ type: "model_smoke_result", passed })}\n`)
process.exit(passed ? 0 : 1)
