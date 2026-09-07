import { isToolCallEventType } from "@mariozechner/pi-coding-agent"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"

function resolveRtkAvailability(): { available: boolean; stdout: string; stderr: string; exitCode: number } {
    const proc = Bun.spawnSync(["rtk", "--version"], { stdout: "pipe", stderr: "pipe" })
    return {
        available: proc.exitCode === 0,
        stdout: proc.stdout.toString().trim(),
        stderr: proc.stderr.toString().trim(),
        exitCode: proc.exitCode,
    }
}

function rewriteCommand(command: string): { rewritten?: string; stdout: string; stderr: string; exitCode: number } {
    const proc = Bun.spawnSync(["rtk", "rewrite", command], { stdout: "pipe", stderr: "pipe" })
    const rewritten = proc.stdout.toString().trim()
    return {
        rewritten: rewritten && rewritten !== command ? rewritten : undefined,
        stdout: rewritten,
        stderr: proc.stderr.toString().trim(),
        exitCode: proc.exitCode,
    }
}

export function rtkRewriteExtension(): ExtensionFactory {
    return (pi) => {
        let availabilityChecked = false
        let rtkAvailable = false

        pi.on("tool_call", async (event) => {
            if (!isToolCallEventType("bash", event)) return
            if (typeof event.input.command !== "string") return

            if (!availabilityChecked) {
                availabilityChecked = true
                const availability = resolveRtkAvailability()
                rtkAvailable = availability.available
                if (!rtkAvailable) return
            }
            if (!rtkAvailable) return

            const original = event.input.command
            const result = rewriteCommand(original)
            if (!result.rewritten) return

            event.input.command = result.rewritten
        })
    }
}
