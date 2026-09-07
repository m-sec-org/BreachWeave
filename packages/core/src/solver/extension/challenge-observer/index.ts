import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { PromptSessionExtensionLike } from "../../../config/index"
import { attachChallengeContinuation, buildChallengeExtensionAppendPrompt, isChallengeMode } from "./ralph-loop"
import { attachObserverLoop, buildObserverExtensionAppendPrompt } from "./observer-loop"
import { challengeObserverAgentTools } from "./tools"

export interface ChallengeObserverExtensionOptions {
    observerEnabled?: boolean
    observerModel?: string
}

export function challengeObserverExtension(options?: ChallengeObserverExtensionOptions): PromptSessionExtensionLike {
    const observerEnabled = options?.observerEnabled === true
    const observerModel = options?.observerModel
    const appendSystemPrompt = observerEnabled
        ? `${buildChallengeExtensionAppendPrompt()}\n\n${buildObserverExtensionAppendPrompt()}`
        : buildChallengeExtensionAppendPrompt()
    const factory: ExtensionFactory = (pi) => {
        if (!isChallengeMode()) return
        console.log("Challenge observer extension initialized")

        if (observerEnabled) {
            for (const tool of challengeObserverAgentTools) {
                pi.registerTool(tool)
            }
        }

        attachChallengeContinuation(pi)
        if (observerEnabled) {
            attachObserverLoop(pi, { observerModel })
        }
    }

    return {
        factory,
        appendSystemPrompt: () => appendSystemPrompt,
    }
}
