// Externalized termination for engagement mode (de-CTF ralph loop).
// On agent_end, if the injected completion oracle says the engagement is not done,
// re-inject a neutral continuation prompt. Termination is decided by coverage/budget,
// not by the model's self-report.

import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { CompletionOracle } from "../../../engagement/oracle"

const MAX_RETRY_ATTEMPTS = 10
const CONTINUATION_MESSAGE =
    "继续当前 engagement。不要重复已经完成的步骤，基于现有上下文继续推进；直到测试策略覆盖度达标、或授权范围内的 attack surface 已按既定深度走完（由系统完成判定决定），不要提前结束。"
const CONTINUATION_CUSTOM_TYPE = "engagement-continuation"
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 10000

function getAgentEndError(messages: AgentMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message.role !== "assistant") continue
        if (message.stopReason !== "error") return
        return message.errorMessage ?? "Agent ended with an unknown error"
    }
    return
}

function getDelayMs(attempt: number): number {
    return Math.min(BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_MS)
}

export function attachEngagementContinuation(pi: ExtensionAPI, oracle: CompletionOracle): void {
    let consecutiveErrors = 0

    pi.on("agent_end", async (event) => {
        if (await oracle.isComplete()) {
            return
        }

        const errorMessage = getAgentEndError(event.messages)
        if (errorMessage) {
            consecutiveErrors += 1
            if (consecutiveErrors > MAX_RETRY_ATTEMPTS) return
            await Bun.sleep(getDelayMs(consecutiveErrors))
        } else {
            consecutiveErrors = 0
        }

        setImmediate(() => {
            pi.sendMessage(
                {
                    customType: CONTINUATION_CUSTOM_TYPE,
                    content: [{ type: "text", text: CONTINUATION_MESSAGE }],
                    display: false,
                    details: undefined,
                },
                { triggerTurn: true },
            )
        })
    })
}
