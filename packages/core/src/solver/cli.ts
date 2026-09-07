import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { createSolverSession, createSubagentSession } from "./session"
export { runSolverRpc } from "./rpc/rpc-server"

export type SolverEventListener = (event: AgentSessionEvent) => void

export interface RunSolverOptions {
    promptName: string
    task: string
    onEvent?: SolverEventListener
}

export async function runSolverCli(options: RunSolverOptions) {
    const solverId = crypto.randomUUID().slice(0, 8)
    const { session } = await createSolverSession({
        solverId,
        promptName: options.promptName,
        task: options.task,
    })

    options.onEvent && session.subscribe(options.onEvent)
    await session.prompt(options.task, {
        expandPromptTemplates: true,
        source: "interactive",
    })
}

export interface RunSubagentOptions {
    promptName: string
    task: string
}

export async function runSubagentCli(options: RunSubagentOptions) {
    const { session } = await createSubagentSession(options.promptName, options.task)

    session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_end") {
            process.stdout.write(`${JSON.stringify(event)}\n`)
            return
        }
        if (event.type === "agent_end") {
            process.stdout.write(`${JSON.stringify(event)}\n`)
        }
    })

    try {
        await session.prompt(options.task, {
            expandPromptTemplates: true,
            source: "interactive",
        })
    } finally {
        session.dispose()
    }
}
