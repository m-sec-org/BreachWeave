# Extension System Deep Dive

## Extension Loading (jiti)

Uses `@mariozechner/jiti` (fork with `virtualModules` support) for runtime TypeScript loading:

### Two Loading Modes
- **Bun binary**: `virtualModules` for bundled packages + `tryNative: false` (forces jiti to handle ALL imports)
- **Node/dev**: `alias` mappings to `node_modules`

### Virtual Modules (available in extensions)
`@sinclair/typebox`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@mariozechner/pi-ai/oauth`, `@mariozechner/pi-coding-agent`

### Module Format
Default export function: `(pi: ExtensionAPI) => void | Promise<void>`. Both sync and async supported.

### Error Handling
Errors during loading collected in `errors` array but don't prevent other extensions. `LoadExtensionsResult` contains both `extensions` and `errors`.

### Discovery (3 locations)
1. `cwd/.pi/extensions/` — `.ts`/`.js` files or subdirs with `index.ts`
2. `agentDir/extensions/` — same rules
3. Configured paths explicitly provided

Subdirs with `package.json` → `pi.extensions` array declares entry points (multi-file extensions).

### Runtime Stub Pattern
All action methods start as throwing stubs:
```typescript
const notInitialized = () => {
  throw new Error("Action methods cannot be called during extension loading.")
}
```
`bindCore()` later replaces stubs with real implementations. Exception: `registerProvider` queues during load, flushed on bind.

### No Hot-Reload
But `/reload` via `ctx.reload()` rediscovers all resources. `moduleCache: false` ensures fresh loads.

---

## Extension Runner — Event Dispatch

### Specialized Emit Methods (NOT one generic emit)

| Method | Chaining |
|--------|----------|
| `emit()` | Sequential; session_before_* can cancel |
| `emitToolCall()` | `block: true` short-circuits |
| `emitToolResult()` | **Result chain** — each handler modifies content/details/isError |
| `emitUserBash()` | First handler returning result wins |
| `emitContext()` | **Message chain** — `structuredClone` + sequential transforms |
| `emitBeforeProviderRequest()` | **Payload chain** — sequential transforms |
| `emitBeforeAgentStart()` | Collects messages from ALL handlers + chains system prompt |
| `emitResourcesDiscover()` | Collects paths from all handlers |
| `emitInput()` | Chain transforms; `"handled"` short-circuits, `"transform"` modifies |

### Result Chaining
Tool results: each handler sees previous handler's modifications:
```typescript
if (handlerResult?.content !== undefined) {
  currentEvent.content = handlerResult.content  // Next handler sees this
}
```

Context messages: deep-cloned via `structuredClone` for safety before transforms.

### Execution Order
Registration order (discovery: project-local → global → configured). Within each extension, handlers in registration order.

### Communication Between Extensions
1. **EventBus** — pub/sub (see below)
2. **Shared runtime** — all extensions share same `ExtensionRuntime`
3. **Session entries** — `pi.appendEntry()` + `ctx.sessionManager.getEntries()`

---

## EventBus

Wraps Node.js `EventEmitter`:

```typescript
interface EventBus {
  emit(channel: string, data: unknown): void
  on(channel: string, handler: (data: unknown) => void): () => void  // returns unsubscribe
}
```

- Error isolation: each handler wrapped in try/catch
- Async-safe handlers
- Shared instance via `pi.events`
- Convention: `"namespace:event"` channel naming

```typescript
// Extension A: listen
pi.events.on("my:notification", (data) => { ... })
// Extension B: emit
pi.events.emit("my:notification", { message: "hello", from: "ext-b" })
```

---

## Extension Patterns from Examples

### Tool Override
Register tool with **same name as built-in** to replace it:
```typescript
pi.registerTool({ name: "read", label: "read (audited)", execute: ... })
```
Override inherits built-in renderers if no custom renderCall/renderResult provided.

### SSH Remote Execution (Operations Interfaces)
Most architecturally significant pattern. Creates `*Operations` interfaces and passes to tool factories:
```typescript
import { createBashTool, createReadTool, type BashOperations, type ReadOperations }
  from "@mariozechner/pi-coding-agent"
```
- `registerFlag("ssh", { type: "string" })` for `--ssh user@host:/path`
- Lazy resolution in `session_start` (CLI flags unavailable during factory)
- Dynamic delegation: each tool checks `getSsh()` at call time
- `user_bash` event returns `{ operations: createRemoteBashOps(...) }`
- `before_agent_start` modifies system prompt to replace cwd with remote path

### Permission Gate
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (isDangerous(event.input.command)) {
    const choice = await ctx.ui.select("Allow?", ["Yes", "No"])
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" }
  }
})
```

### Git Checkpoint
```typescript
pi.on("turn_start", async () => {
  const { stdout } = await pi.exec("git", ["stash", "create"])  // pi.exec() = direct shell
  if (ref) checkpoints.set(currentEntryId, ref)
})
pi.on("session_before_fork", async (event, ctx) => {
  const ref = checkpoints.get(event.entryId)
  if (ref) await pi.exec("git", ["stash", "apply", ref])
})
```

### Subagent Orchestration
Tool with 3 modes: single, parallel, chain:
- `child_process.spawn()` for each subagent
- Security gate: confirms before running project-local agents
- JSON streaming from subagent stdout
- Concurrency limit: max 8 tasks, 4 concurrent
- Chain mode: `{previous}` placeholder substitution

### Custom UI Components (Games)
```typescript
pi.registerCommand("snake", {
  handler: async (_args, ctx) => {
    const entries = ctx.sessionManager.getEntries()  // Load saved state
    await ctx.ui.custom((tui, _theme, _kb, done) => {
      return new SnakeComponent(tui, () => done(undefined), (state) => {
        pi.appendEntry(SNAKE_SAVE_TYPE, state)  // Persist state
      }, savedState)
    })
  },
})
```

### Overlay Mode
```typescript
await ctx.ui.custom(
  (tui, _theme, _kb, done) => new DoomComponent(tui, ...),
  { overlay: true, overlayOptions: { width: "75%", maxHeight: "95%", anchor: "center" } },
)
```

### Custom Editor
```typescript
class ModalEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert"
  handleInput(data: string) { /* vim-like modal editing */ }
}
pi.on("session_start", (_event, ctx) => {
  ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb))
})
```

### Dynamic Tool Registration
Tools registered at ANY time (not just during factory):
```typescript
pi.registerCommand("add-tool", {
  handler: async (args) => {
    pi.registerTool({ name: args, ... })  // Calls runtime.refreshTools() internally
  },
})
```

### Custom Compaction
```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const model = ctx.modelRegistry.find("google", "gemini-2.5-flash")  // Different model
  const summary = await complete(model, ...) // Use pi-ai directly
  return { compaction: { summary, firstKeptEntryId, tokensBefore } }
})
```

### Input Transform
Three response types:
- `{ action: "continue" }` — pass through
- `{ action: "transform", text: "modified" }` — rewrite input
- `{ action: "handled" }` — consume entirely, no LLM call

Source-aware: `event.source` can be `"interactive"`, `"rpc"`, or `"extension"`.

### Session Handoff
```typescript
// /handoff command: summarize → edit → new session
ctx.newSession({ parentSession, setup })
```
