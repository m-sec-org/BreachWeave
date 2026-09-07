# pi-tui & pi-web-ui — UI Adapter Patterns

## pi-tui (`packages/tui/`, `@mariozechner/pi-tui` v0.62.0)

Custom terminal UI framework with differential rendering — NOT built on Ink/React. Raw ANSI escape sequences + Node's `process.stdin/stdout`.

### Component Interface (Minimal)

```typescript
interface Component {
  render(width: number): string[]     // Returns array of lines (MUST NOT exceed width!)
  handleInput?(data: string): void    // Keyboard input when focused
  invalidate(): void                  // Clear cached render state
  wantsKeyRelease?: boolean           // Kitty protocol opt-in
}

interface Focusable {
  focused: boolean
}

// Cursor position marker (zero-width APC sequence)
const CURSOR_MARKER = "\x1b_pi:c\x07"
```

**Critical**: Each line from `render()` must NOT exceed `width`. Overflow crashes the TUI.

### Container (Basic Component Aggregator)

```typescript
class Container implements Component {
  children: Component[] = []
  render(width: number): string[] {
    const lines: string[] = []
    for (const child of this.children) {
      lines.push(...child.render(width))
    }
    return lines
  }
}
```

### TUI Class (Orchestrator)

```typescript
class TUI extends Container {
  constructor(terminal: Terminal, showHardwareCursor: boolean)

  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle
  // OverlayOptions: anchor (center/top-left/...), width ("50%"/number), margin, focus

  requestRender(): void     // Schedule re-render (coalesces via process.nextTick)
  shutdown(): void          // Clean up terminal state
}
```

### Differential Rendering Pipeline

```
1. requestRender() → schedules via process.nextTick() (coalesces multiple requests)
2. doRender() → calls render(width) on component tree
3. compositeOverlays() → layer overlays onto base content
4. extractCursorPosition() → find CURSOR_MARKER for IME placement
5. applyLineResets() → compare new vs previous frame lines
6. Write ONLY changed lines using cursor movement escape sequences
7. Wrap in CSI 2026 synchronized output for atomic updates (flicker-free)
```

Full re-render triggered on: width change, height change, first render, content shrink.

### Terminal & Input

```typescript
// Terminal interface + ProcessTerminal class
// - Raw stdin via process.stdin.setRawMode()
// - Kitty keyboard protocol detection
// - Bracketed paste mode
// - Cross-platform (Windows VT input via koffi)
// - StdinBuffer splits batched escape sequences
```

**Input flow:**
```
ProcessTerminal (raw stdin) → StdinBuffer (parse escape sequences)
  → TUI.handleInput() → inputListeners (middleware pattern)
    → focused component's handleInput(data)
      → keybinding system (matchesKey())
```

### Overlay System

```typescript
showOverlay(component, {
  anchor: "center",      // center, top-left, top-right, bottom-left, bottom-right
  width: "50%",          // percentage or fixed number
  margin: { top: 1, bottom: 1 },
  focus: true,           // capture focus
})
// Returns OverlayHandle for dismiss/visibility
```

Z-ordering by focus order. Focus capture/release. Visibility callbacks based on terminal dimensions.

### Built-in Components (12)

- `Box` — bordered container
- `Text` — styled text display
- `Input` — single-line editor with undo/redo, kill ring, bracketed paste
- `Editor` — multi-line editor
- `Markdown` — terminal markdown rendering (uses `marked`)
- `SelectList` — selection list
- `SettingsList` — settings toggle list
- `Image` — Kitty/Ghostty/iTerm2 image protocols
- `Loader` / `CancellableLoader` — spinner/progress
- `Spacer` — layout spacing
- `TruncatedText` — width-safe text display

---

## pi-web-ui (`packages/web-ui/`, `@mariozechner/pi-web-ui` v0.62.0)

Web component library: LitElement (from `lit`) + Tailwind CSS v4 + IndexedDB. Some sub-components use `@mariozechner/mini-lit`.

### Core Components

```typescript
// Top-level: <pi-chat-panel>
class ChatPanel extends LitElement {
  // Split-view: chat (left) + artifacts panel (right)
  // Responsive: mobile overlay at 800px breakpoint
  setAgent(agent: Agent, config?) // Wire agent to UI
}

// Main interaction: <agent-interface>
class AgentInterface extends LitElement {
  @property({ attribute: false }) session?: Agent
  // Connects to Agent directly (NOT AgentSession)
}
```

### Agent Connection (Different from TUI)

Web UI connects to the **Agent** class directly, not `AgentSession`:

```typescript
// Event subscription
this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
  switch (ev.type) {
    case "message_start":
    case "turn_start":
    case "turn_end":
    case "agent_start":
      this.requestUpdate()
      break
    case "message_update":
      this._streamingContainer.setMessage(ev.message, !isStreaming)
      break
    case "message_end":
    case "agent_end":
      this._streamingContainer.setMessage(null, true)
      break
  }
})

// State access
const state = this.session.state
// Exposes: messages, tools, pendingToolCalls, isStreaming, model, thinkingLevel

// User input
await this.session?.prompt(input)
```

### Component Hierarchy

**Messages**: `MessageList`, `Messages`, `StreamingMessageContainer`, `UserMessage`, `AssistantMessage`, `ThinkingBlock`
**Input**: `Input`, `MessageEditor` (attachment support)
**Execution**: `ConsoleBlock`, `SandboxedIframe`
**Dialogs**: `SettingsDialog`, `SessionListDialog`, `ApiKeyPromptDialog`, `ModelSelector`
**Extensibility**: `message-renderer-registry.ts` for custom message types

### Web-Specific Tools

- `javascript-repl.ts` — JS execution in sandboxed iframe
- `extract-document.ts` — PDF/DOCX/XLSX extraction
- `artifacts/` — HTML/SVG/image artifact rendering
- `renderer-registry.ts` — custom tool renderer registration

### Storage Layer

```
app-storage.ts → coordinator
  store.ts → generic store abstraction
    backends/ → IndexedDB
    stores/ → sessions, settings, provider-keys, custom-providers
```

---

## Shared Adapter Patterns

| Pattern | TUI | Web UI |
|---------|-----|--------|
| **Connection** | `AgentSession.subscribe()` | `Agent.subscribe()` |
| **Event type** | `AgentSessionEvent` (superset) | `AgentEvent` (core) |
| **Rendering** | `Component.render(width) → string[]` | LitElement `render() → html` |
| **Input routing** | Focus-based `handleInput(data)` | DOM events → `session.prompt()` |
| **State access** | `session.state` (getter) | `session.state` (getter) |
| **Overlay/Modal** | `TUI.showOverlay()` | Standard DOM dialogs |
| **Storage** | File-based (SessionManager) | IndexedDB |
| **Streaming** | Line-by-line differential render | `StreamingMessageContainer` |

**Key insight**: Both UIs follow the same adapter pattern — subscribe to agent events, maintain component tree reflecting state, funnel input back via `prompt()`. The core agent is completely UI-agnostic.

TUI is more tightly coupled (uses `AgentSession` with compaction, model cycling, session management). Web UI connects to lower-level `Agent` and implements session management in its own storage layer.

---

## RPC Mode (Headless Bridge)

`packages/coding-agent/src/modes/rpc/` — JSON Lines over stdin/stdout:

- Commands: prompt, steer, follow_up, abort, model management, session ops, bash
- Responses: success/error with optional ID tracking
- Enables external UIs (like web-ui) to control coding-agent remotely

## InteractiveMode (TUI-AgentSession Adapter)

```typescript
class InteractiveMode {
  constructor(session: AgentSession, options) {
    this.ui = new TUI(new ProcessTerminal(), showCursor)
    this.session.subscribe(async (event) => this.handleEvent(event))
  }

  handleEvent(event) {
    // message_start/update → AssistantMessageComponent
    // tool_execution_start/end → ToolExecutionComponent
    // agent_start/end → loader animations
  }
}
```

35 interactive components in `modes/interactive/components/` for specific UI concerns.
