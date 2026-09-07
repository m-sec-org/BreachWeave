import { ConfigManager } from "@tch/core"
import {
    bashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    initTheme,
    type AgentSessionEvent,
    Theme,
    type ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import { Box, Container, matchesKey, ProcessTerminal, Text, TUI, type Component } from "@mariozechner/pi-tui"

type SolverEventListener = (event: AgentSessionEvent) => void

interface SolverState {
    phase: "idle" | "thinking" | "streaming" | "tool" | "done" | "error"
    turnCount: number
    inputTokens: number
    outputTokens: number
    cost: number
    model?: string
    errorMessage?: string
}

interface ToolResultContentBlock {
    type: string
    text?: string
    data?: string
    mimeType?: string
}

interface ToolResultLike {
    content: ToolResultContentBlock[]
    details?: unknown
}

const BUILTIN_TOOL_DEFINITIONS = new Map<string, ToolDefinition<any, any>>([
    ["read", createReadToolDefinition(process.cwd())],
    ["bash", bashToolDefinition],
    ["edit", createEditToolDefinition(process.cwd())],
    ["write", createWriteToolDefinition(process.cwd())],
    ["grep", createGrepToolDefinition(process.cwd())],
    ["find", createFindToolDefinition(process.cwd())],
    ["ls", createLsToolDefinition(process.cwd())],
])

const toolTheme = await createTheme("dark")
const appTheme = await createThemeFromColors({
    accent: "#00d4ff",
    border: "#3a3f47",
    borderAccent: "#00d4ff",
    borderMuted: "#3a3f47",
    success: "#00c896",
    error: "#ff4757",
    warning: "#e8a317",
    muted: "#7b68ee",
    dim: "#8e8e93",
    text: "#ffffff",
    thinkingText: "#8e8e93",
    userMessageText: "#ffffff",
    customMessageText: "#ffffff",
    customMessageLabel: "#7b68ee",
    toolTitle: "#5dade2",
    toolOutput: "#ffffff",
    mdHeading: "#ffffff",
    mdLink: "#00d4ff",
    mdLinkUrl: "#8e8e93",
    mdCode: "#ffffff",
    mdCodeBlock: "#ffffff",
    mdCodeBlockBorder: "#3a3f47",
    mdQuote: "#8e8e93",
    mdQuoteBorder: "#3a3f47",
    mdHr: "#3a3f47",
    mdListBullet: "#00d4ff",
    toolDiffAdded: "#00c896",
    toolDiffRemoved: "#ff4757",
    toolDiffContext: "#8e8e93",
    syntaxComment: "#8e8e93",
    syntaxKeyword: "#00d4ff",
    syntaxFunction: "#ffffff",
    syntaxVariable: "#ffffff",
    syntaxString: "#ffffff",
    syntaxNumber: "#ffffff",
    syntaxType: "#ffffff",
    syntaxOperator: "#ffffff",
    syntaxPunctuation: "#ffffff",
    thinkingOff: "#3a3f47",
    thinkingMinimal: "#8e8e93",
    thinkingLow: "#8e8e93",
    thinkingMedium: "#8e8e93",
    thinkingHigh: "#8e8e93",
    thinkingXhigh: "#8e8e93",
    bashMode: "#00c896",
}, {
    selectedBg: "#3a3a4a",
    userMessageBg: "#343541",
    customMessageBg: "#2d2838",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
})

async function createTheme(name: "dark" | "light"): Promise<Theme> {
    const raw = (await Bun.file(`node_modules/.bun/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/${name}.json`).json()) as {
        name: string
        vars?: Record<string, string | number>
        colors: Record<string, string | number>
    }
    const vars = raw.vars ?? {}
    const resolveColor = (value: string | number): string | number => {
        if (typeof value === "number") return value
        if (value === "") return "#ffffff"
        return vars[value] ?? value
    }
    const fgColors = {
        accent: resolveColor(raw.colors.accent),
        border: resolveColor(raw.colors.border),
        borderAccent: resolveColor(raw.colors.borderAccent),
        borderMuted: resolveColor(raw.colors.borderMuted),
        success: resolveColor(raw.colors.success),
        error: resolveColor(raw.colors.error),
        warning: resolveColor(raw.colors.warning),
        muted: resolveColor(raw.colors.muted),
        dim: resolveColor(raw.colors.dim),
        text: resolveColor(raw.colors.text),
        thinkingText: resolveColor(raw.colors.thinkingText),
        userMessageText: resolveColor(raw.colors.userMessageText),
        customMessageText: resolveColor(raw.colors.customMessageText),
        customMessageLabel: resolveColor(raw.colors.customMessageLabel),
        toolTitle: resolveColor(raw.colors.toolTitle),
        toolOutput: resolveColor(raw.colors.toolOutput),
        mdHeading: resolveColor(raw.colors.mdHeading),
        mdLink: resolveColor(raw.colors.mdLink),
        mdLinkUrl: resolveColor(raw.colors.mdLinkUrl),
        mdCode: resolveColor(raw.colors.mdCode),
        mdCodeBlock: resolveColor(raw.colors.mdCodeBlock),
        mdCodeBlockBorder: resolveColor(raw.colors.mdCodeBlockBorder),
        mdQuote: resolveColor(raw.colors.mdQuote),
        mdQuoteBorder: resolveColor(raw.colors.mdQuoteBorder),
        mdHr: resolveColor(raw.colors.mdHr),
        mdListBullet: resolveColor(raw.colors.mdListBullet),
        toolDiffAdded: resolveColor(raw.colors.toolDiffAdded),
        toolDiffRemoved: resolveColor(raw.colors.toolDiffRemoved),
        toolDiffContext: resolveColor(raw.colors.toolDiffContext),
        syntaxComment: resolveColor(raw.colors.syntaxComment),
        syntaxKeyword: resolveColor(raw.colors.syntaxKeyword),
        syntaxFunction: resolveColor(raw.colors.syntaxFunction),
        syntaxVariable: resolveColor(raw.colors.syntaxVariable),
        syntaxString: resolveColor(raw.colors.syntaxString),
        syntaxNumber: resolveColor(raw.colors.syntaxNumber),
        syntaxType: resolveColor(raw.colors.syntaxType),
        syntaxOperator: resolveColor(raw.colors.syntaxOperator),
        syntaxPunctuation: resolveColor(raw.colors.syntaxPunctuation),
        thinkingOff: resolveColor(raw.colors.thinkingOff),
        thinkingMinimal: resolveColor(raw.colors.thinkingMinimal),
        thinkingLow: resolveColor(raw.colors.thinkingLow),
        thinkingMedium: resolveColor(raw.colors.thinkingMedium),
        thinkingHigh: resolveColor(raw.colors.thinkingHigh),
        thinkingXhigh: resolveColor(raw.colors.thinkingXhigh),
        bashMode: resolveColor(raw.colors.bashMode),
    }
    const bgColors = {
        selectedBg: resolveColor(raw.colors.selectedBg),
        userMessageBg: resolveColor(raw.colors.userMessageBg),
        customMessageBg: resolveColor(raw.colors.customMessageBg),
        toolPendingBg: resolveColor(raw.colors.toolPendingBg),
        toolSuccessBg: resolveColor(raw.colors.toolSuccessBg),
        toolErrorBg: resolveColor(raw.colors.toolErrorBg),
    }
    return new Theme(fgColors, bgColors, "truecolor", { name: raw.name })
}

async function createThemeFromColors(
    fgColors: ConstructorParameters<typeof Theme>[0],
    bgColors: ConstructorParameters<typeof Theme>[1],
): Promise<Theme> {
    return new Theme(fgColors, bgColors, "truecolor", { name: "tch-solver" })
}

class SolverToolExecutionComponent extends Container {
    private readonly contentBox = new Box(1, 1)
    private readonly rendererState: Record<string, unknown> = {}
    private readonly builtInToolDefinition?: ToolDefinition<any, any>
    private readonly customToolDefinition?: ToolDefinition<any, any>
    private callRendererComponent?: Component
    private resultRendererComponent?: Component
    private args: unknown
    private result?: ToolResultLike & { isError: boolean }
    private executionStarted = false
    private isPartial = true
    private expanded = false

    constructor(
        private readonly ui: TUI,
        private readonly toolName: string,
        private readonly toolCallId: string,
        args: unknown,
        customToolDefinition: ToolDefinition<any, any> | undefined,
        private readonly cwd: string,
    ) {
        super()
        this.args = args
        this.customToolDefinition = customToolDefinition
        this.builtInToolDefinition = BUILTIN_TOOL_DEFINITIONS.get(toolName)
        this.addChild(this.contentBox)
        this.updateDisplay()
    }

    markExecutionStarted(): void {
        this.executionStarted = true
        this.updateDisplay()
        this.ui.requestRender()
    }

    updateArgs(args: unknown): void {
        this.args = args
        this.updateDisplay()
        this.ui.requestRender()
    }

    updateResult(result: ToolResultLike & { isError: boolean }, isPartial: boolean): void {
        this.result = result
        this.isPartial = isPartial
        this.updateDisplay()
        this.ui.requestRender()
    }

    private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
        if (!this.builtInToolDefinition) return this.customToolDefinition?.renderCall
        if (!this.customToolDefinition) return this.builtInToolDefinition.renderCall
        return this.customToolDefinition.renderCall ?? this.builtInToolDefinition.renderCall
    }

    private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
        if (!this.builtInToolDefinition) return this.customToolDefinition?.renderResult
        if (!this.customToolDefinition) return this.builtInToolDefinition.renderResult
        return this.customToolDefinition.renderResult ?? this.builtInToolDefinition.renderResult
    }

    private getRenderContext(lastComponent: Component | undefined) {
        return {
            args: this.args,
            toolCallId: this.toolCallId,
            invalidate: () => {
                this.invalidate()
                this.ui.requestRender()
            },
            lastComponent,
            state: this.rendererState,
            cwd: this.cwd,
            executionStarted: this.executionStarted,
            argsComplete: true,
            isPartial: this.isPartial,
            expanded: this.expanded,
            showImages: false,
            isError: this.result?.isError ?? false,
        }
    }

    private createCallFallback(): Component {
        return new Text(toolTheme.fg("toolTitle", toolTheme.bold(this.toolName)), 0, 0)
    }

    private createResultFallback(): Component | undefined {
        const output = getTextOutput(this.result)
        if (!output) return undefined
        return new Text(toolTheme.fg("toolOutput", output), 0, 0)
    }

    private updateDisplay(): void {
        const bgFn = this.isPartial
            ? (text: string) => toolTheme.bg("toolPendingBg", text)
            : this.result?.isError
              ? (text: string) => toolTheme.bg("toolErrorBg", text)
              : (text: string) => toolTheme.bg("toolSuccessBg", text)

        this.contentBox.setBgFn(bgFn)
        this.contentBox.clear()

        const callRenderer = this.getCallRenderer()
        if (!callRenderer) {
            this.contentBox.addChild(this.createCallFallback())
        } else {
            try {
                const component = callRenderer(this.args as never, toolTheme, this.getRenderContext(this.callRendererComponent))
                this.callRendererComponent = component
                this.contentBox.addChild(component)
            } catch {
                this.callRendererComponent = undefined
                this.contentBox.addChild(this.createCallFallback())
            }
        }

        if (!this.result) return

        const resultRenderer = this.getResultRenderer()
        if (!resultRenderer) {
            const component = this.createResultFallback()
            if (component) this.contentBox.addChild(component)
            return
        }

        try {
            const component = resultRenderer(
                { content: this.result.content as never, details: this.result.details },
                { expanded: this.expanded, isPartial: this.isPartial },
                toolTheme,
                this.getRenderContext(this.resultRendererComponent),
            )
            this.resultRendererComponent = component
            this.contentBox.addChild(component)
        } catch {
            this.resultRendererComponent = undefined
            const component = this.createResultFallback()
            if (component) this.contentBox.addChild(component)
        }
    }
}

class SolverTui {
    private readonly ui = new TUI(new ProcessTerminal())
    private readonly header = new Text("", 0, 0)
    private readonly transcript = new Container()
    private readonly thinking = new Text("", 0, 0)
    private readonly streaming = new Text("", 0, 0)
    private readonly error = new Text("", 0, 0)
    private readonly status = new Text("", 0, 0)
    private readonly state: SolverState = {
        phase: "idle",
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
    }
    private readonly pendingTools = new Map<string, SolverToolExecutionComponent>()
    private streamingText = ""
    private thinkingText = ""
    private stopped = false
    private readonly removeInputListener: () => void

    constructor(
        private readonly task: string,
        private readonly toolDefinitions: Map<string, ToolDefinition<any, any>>,
    ) {
        initTheme(undefined, false)
        process.on("SIGINT", this.handleSigint)
        this.removeInputListener = this.ui.addInputListener((data) => {
            if (!matchesKey(data, "ctrl+c")) return
            this.stop(130)
            return { consume: true }
        })
        this.ui.addChild(this.header)
        this.ui.addChild(this.transcript)
        this.ui.addChild(this.thinking)
        this.ui.addChild(this.streaming)
        this.ui.addChild(this.error)
        this.ui.addChild(this.status)
        this.updateHeader()
        this.updateAux()
        this.ui.start()
    }

    private readonly handleSigint = (): void => {
        this.stop(130)
    }

    private stop(exitCode?: number): void {
        if (this.stopped) return
        this.stopped = true
        this.removeInputListener()
        process.off("SIGINT", this.handleSigint)
        this.ui.stop()
        if (exitCode !== undefined) process.exit(exitCode)
    }

    handleEvent(event: AgentSessionEvent): void {
        switch (event.type) {
            case "agent_start":
                this.state.phase = "thinking"
                break
            case "agent_end":
                this.state.phase = "done"
                break
            case "turn_start":
                this.state.turnCount += 1
                this.streamingText = ""
                this.thinkingText = ""
                this.state.phase = "thinking"
                break
            case "turn_end":
                if (this.state.phase !== "done" && this.state.phase !== "error") this.state.phase = "idle"
                break
            case "message_start":
                this.streamingText = ""
                this.thinkingText = ""
                break
            case "message_update":
                if (event.assistantMessageEvent.type === "text_delta") {
                    this.streamingText += event.assistantMessageEvent.delta
                    this.state.phase = "streaming"
                } else if (event.assistantMessageEvent.type === "thinking_delta") {
                    this.thinkingText += event.assistantMessageEvent.delta
                    this.state.phase = "thinking"
                }
                break
            case "message_end":
                if (event.message.role === "assistant") {
                    const text = extractAssistantText(event.message.content)
                    if (text) {
                        this.transcript.addChild(new Text(`${appTheme.fg("accent", "Solver › ")}${appTheme.fg("text", text)}`, 0, 0))
                    }
                    this.state.model = event.message.model
                    this.state.inputTokens += event.message.usage.input
                    this.state.outputTokens += event.message.usage.output
                    this.state.cost += event.message.usage.cost.total
                    if (event.message.stopReason === "error") {
                        this.state.phase = "error"
                        this.state.errorMessage = event.message.errorMessage
                    } else if (this.state.phase !== "done") {
                        this.state.phase = "idle"
                    }
                    this.streamingText = ""
                }
                break
            case "tool_execution_start": {
                const toolDefinition = this.toolDefinitions.get(event.toolName)
                const tool = new SolverToolExecutionComponent(this.ui, event.toolName, event.toolCallId, event.args, toolDefinition, process.cwd())
                tool.markExecutionStarted()
                this.pendingTools.set(event.toolCallId, tool)
                this.transcript.addChild(tool)
                this.state.phase = "tool"
                break
            }
            case "tool_execution_update": {
                const tool = this.pendingTools.get(event.toolCallId)
                tool?.updateArgs(event.args)
                tool?.updateResult({ ...(event.partialResult as ToolResultLike), isError: false }, true)
                this.state.phase = "tool"
                break
            }
            case "tool_execution_end": {
                const tool = this.pendingTools.get(event.toolCallId)
                tool?.updateResult({ ...(event.result as ToolResultLike), isError: event.isError }, false)
                if (event.isError) this.state.phase = "error"
                break
            }
            case "compaction_start":
                break
            case "compaction_end":
                break
            case "auto_retry_start":
                break
            case "auto_retry_end":
                if (!event.success) {
                    this.state.phase = "error"
                    this.state.errorMessage = event.finalError
                }
                break
            default:
                break
        }

        this.updateHeader()
        this.updateAux()
        this.ui.requestRender()

        if (event.type === "agent_end") {
            process.nextTick(() => {
                this.stop()
            })
        }
    }

    private updateHeader(): void {
        let text = `${appTheme.fg("accent", "▓▓ ")}${appTheme.fg("toolTitle", appTheme.bold("tch-solver"))}`
        if (this.state.model) text += appTheme.fg("muted", ` ⟨${this.state.model}⟩`)
        text += `\n${appTheme.fg("muted", "Task › ")}${appTheme.fg("text", this.task)}`
        this.header.setText(text)
    }

    private updateAux(): void {
        this.thinking.setText(this.thinkingText ? appTheme.fg("thinkingText", `▸ ${this.thinkingText}`) : "")
        this.streaming.setText(this.streamingText ? `${appTheme.fg("accent", "Solver › ")}${appTheme.fg("text", this.streamingText)}` : "")
        this.error.setText(this.state.errorMessage ? appTheme.fg("error", `Error: ${this.state.errorMessage}`) : "")
        this.status.setText(buildStatusLine(this.state))
    }
}

function buildStatusLine(state: SolverState): string {
    let text = appTheme.fg("dim", `T${state.turnCount}`)
    text += appTheme.fg("border", " │ ")
    text += appTheme.fg("dim", `↑${state.inputTokens} ↓${state.outputTokens}`)
    if (state.cost > 0) text += appTheme.fg("accent", ` $${state.cost.toFixed(4)}`)
    text += appTheme.fg("border", " │ ")
    switch (state.phase) {
        case "thinking":
            text += appTheme.fg("thinkingText", "thinking")
            break
        case "streaming":
            text += appTheme.fg("accent", "streaming")
            break
        case "tool":
            text += appTheme.fg("toolTitle", "executing")
            break
        case "done":
            text += appTheme.fg("success", "● done")
            break
        case "error":
            text += appTheme.fg("error", "● error")
            break
        default:
            text += appTheme.fg("dim", "○ idle")
            break
    }
    return text
}

function getTextOutput(result: ToolResultLike | undefined): string {
    if (!result) return ""
    return result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("\n")
        .trim()
}

function extractAssistantText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter((item: unknown): item is { type: string; text?: string } => !!item && typeof item === "object" && "type" in item)
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("")
}

async function loadToolDefinitions(promptName: string): Promise<Map<string, ToolDefinition<any, any>>> {
    const definitions = new Map(BUILTIN_TOOL_DEFINITIONS)
    const config = await ConfigManager.getInstance()
    const sessionOpts = await config.resolvePromptSession(promptName)
    for (const tool of sessionOpts?.customTools ?? []) {
        definitions.set(tool.name, tool as ToolDefinition<any, any>)
    }
    return definitions
}

export async function startSolverTui(task: string, promptName: string): Promise<SolverEventListener> {
    const toolDefinitions = await loadToolDefinitions(promptName)
    const app = new SolverTui(task, toolDefinitions)
    return (event: AgentSessionEvent) => {
        app.handleEvent(event)
    }
}
