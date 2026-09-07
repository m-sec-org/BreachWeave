# pi-coding-agent — Reference Application

Package: `@mariozechner/pi-coding-agent` v0.62.0, located at `packages/coding-agent/`. Ships as both CLI (`pi`) and SDK library.

## Composition Root: createAgentSession()

Central entry point in `src/core/sdk.ts`:

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent"

// Minimal usage
const { session } = await createAgentSession()
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta)
  }
})
await session.prompt("What files are in the current directory?")

// Full control
const { session } = await createAgentSession({
  cwd,
  agentDir: "/tmp/my-agent",
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  resourceLoader,                              // Custom ResourceLoader
  tools: [createReadTool(cwd), createBashTool(cwd)],
  sessionManager: SessionManager.inMemory(),
  settingsManager,
})
```

### Initialization Flow

1. Parse CLI args (`src/cli/args.ts`)
2. Resolve config paths (`getAgentDir()`, `getSettingsPath()`)
3. Create `AuthStorage` + `ModelRegistry`
4. Create `SettingsManager`
5. Create `DefaultResourceLoader` (discovers extensions, skills, prompts, themes)
6. Call `resourceLoader.reload()`
7. Call `createAgentSession({ ... })` → sets up tools, creates/restores session, resolves model

### Layered Architecture

```
CLI Entry (src/cli.ts)
  └── Modes (interactive TUI / print / RPC)
       └── AgentSession (src/core/agent-session.ts)
            ├── pi-agent-core Agent (core loop, tool calling)
            ├── pi-ai (LLM providers, streaming)
            ├── Tools (read, bash, edit, write, grep, find, ls)
            ├── Extensions (event hooks, custom tools, commands)
            ├── SessionManager (JSONL tree persistence)
            ├── SettingsManager (config persistence)
            ├── ModelRegistry + AuthStorage
            ├── ResourceLoader (skills, prompts, themes)
            └── Compaction (context window management)
```

## Built-in Tools (7)

| Tool | File | Purpose | Key Feature |
|------|------|---------|-------------|
| read | `tools/read.ts` | Read files (text + images) | Auto-resize images, offset/limit |
| bash | `tools/bash.ts` | Execute shell commands | Streaming output, spawn hooks |
| edit | `tools/edit.ts` | Find-and-replace | Fuzzy matching, diff generation |
| write | `tools/write.ts` | Create/overwrite files | File mutation queue |
| grep | `tools/grep.ts` | Search file contents | Ripgrep-based |
| find | `tools/find.ts` | Find files by pattern | Glob-based |
| ls | `tools/ls.ts` | List directory contents | Formatted output |

**Pre-configured sets:**
- `createCodingToolDefinitions(cwd)` → [read, bash, edit, write] (default)
- `createReadOnlyToolDefinitions(cwd)` → [read, grep, find, ls]
- `createAllToolDefinitions(cwd)` → all 7

**MUST use factory functions** when cwd differs from process.cwd().

## ToolDefinition (Layer 3)

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
  name: string
  label: string
  description: string
  promptSnippet?: string          // One-liner for "Available tools" section
  promptGuidelines?: string[]     // Bullets for Guidelines section
  parameters: TParams             // TypeBox schema

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,        // Extension context with UI, cwd, sessionManager
  ): Promise<AgentToolResult<TDetails>>

  renderCall?: (args, theme, context: ToolRenderContext) => Component
  renderResult?: (result, options, theme, context: ToolRenderContext) => Component
}
```

### Concrete Example: Read Tool

```typescript
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
})

export function createReadToolDefinition(cwd, options?): ToolDefinition<typeof readSchema, ReadToolDetails> {
  return {
    name: "read",
    label: "read",
    description: "Read the contents of a file...",
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate, _ctx) {
      // file reading, truncation, image handling
      return { content: [{ type: "text", text: outputText }], details }
    },
    renderCall(args, theme, ctx) { /* TUI component */ },
    renderResult(result, opts, theme, ctx) { /* TUI component */ },
  }
}
```

### Bridge: ToolDefinition → AgentTool

```typescript
function wrapToolDefinition(definition, ctxFactory?): AgentTool {
  return {
    name: definition.name, label: definition.label,
    description: definition.description, parameters: definition.parameters,
    execute: (id, params, signal, onUpdate) =>
      definition.execute(id, params, signal, onUpdate, ctxFactory?.()),
  }
}
```

### Tool Patterns

- **Pluggable Operations**: Tools accept operation interfaces (e.g., `BashOperations.exec`) for local/remote execution (SSH)
- **File mutation queue**: `withFileMutationQueue()` serializes concurrent file modifications
- **Output truncation**: `truncateHead()` (50KB / 2000 lines default)
- **AbortSignal support** throughout

## Extension System (NOT MCP)

Extensions are TypeScript modules loaded via `jiti`. Discovery from `.pi/extensions/`, `~/.pi/agent/extensions/`, or explicit paths.

```typescript
export default function myExtension(pi: ExtensionAPI) {
  // Register tools
  pi.registerTool({
    name: "echo_session", label: "Echo Session",
    description: "Echo a message with prefix",
    parameters: Type.Object({ message: Type.String({ description: "Message to echo" }) }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `[session] ${params.message}` }], details: {} }
    },
  })

  // Register commands (slash commands)
  pi.registerCommand("mycommand", { description: "...", handler: async (args) => { ... } })

  // Register keyboard shortcuts
  pi.registerShortcut("ctrl+k", { handler: async () => { ... } })

  // Register CLI flags
  pi.registerFlag("--my-flag", { type: "boolean" })

  // Subscribe to lifecycle events (30+)
  pi.on("tool_call", async (event, ctx) => {
    return { block: true, reason: "Permission denied" }
  })
  pi.on("context", async (event, ctx) => {
    return { messages: modifiedMessages }  // Modify before LLM call
  })
  pi.on("tool_result", async (event, ctx) => {
    return { content: modifiedContent }    // Modify tool output
  })

  // Register custom providers
  pi.registerProvider("my-proxy", { baseUrl, models })

  // Send messages
  pi.sendMessage({ customType: "...", content: [...] })
  pi.sendUserMessage("...")

  // Persist state
  pi.appendEntry("my-state", { ... })
}
```

### Key Extension Events

**Transform data (middleware-style):**
- `context` — modify messages before LLM call
- `before_provider_request` — modify raw API payload
- `before_agent_start` — inject messages, replace system prompt
- `input` — transform user input text
- `tool_result` — modify tool output content

**Block/gate:**
- `tool_call` — return `{ block: true, reason }` to prevent execution
- `session_before_switch/fork/compact/tree` — return `{ cancel: true }`

**Lifecycle hooks:**
- `session_start`, `session_shutdown`
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start/update/end`
- `model_select`, `user_bash`

**Dispatch**: Extensions called in registration order, results chained. First `cancel: true` short-circuits. All handlers wrapped in try-catch.

## Skills (Markdown SKILL.md)

```markdown
---
name: my-skill
description: When to use this skill (max 1024 chars)
disable-model-invocation: false
---

# Skill Instructions
Detailed workflow instructions loaded on-demand...
```

### Skill Type

```typescript
interface Skill {
  name: string                     // lowercase, alphanumeric, hyphens; max 64 chars
  description: string              // required; max 1024 chars
  filePath: string                 // absolute path to SKILL.md
  baseDir: string
  sourceInfo: SourceInfo
  disableModelInvocation: boolean
}
```

### Discovery

1. `~/.pi/agent/skills/` — global (from `getAgentDir()`)
2. `.pi/skills/` — project-local (using `CONFIG_DIR_NAME`)
3. Custom paths via settings or `--skill <path>`

Rules: directories containing `SKILL.md` → skill root. Respects `.gitignore`. Detects name collisions.

### System Prompt Integration

`formatSkillsForPrompt(skills)` formats as XML. Only name + description included (progressive disclosure). Full content loaded on `/skill:name` invocation. Skills only included when `read` tool is available.

### Programmatic Override

```typescript
const loader = new DefaultResourceLoader({
  skillsOverride: (skills, diagnostics) => {
    const filtered = skills.filter(s => s.name.includes("browser"))
    filtered.push({ name: "my-skill", description: "...", ... })
    return { skills: filtered, diagnostics }
  },
})
```

Extensions add skill paths via `resources_discover` event:
```typescript
pi.on("resources_discover", (event) => ({
  skillPaths: ["/path/to/my/skills/directory"],
}))
```

## Prompt Templates

Markdown files with optional frontmatter, invoked as `/name args`:

```typescript
interface PromptTemplate {
  name: string           // filename without .md
  description: string    // from frontmatter or first line
  content: string        // template body
  filePath: string
  sourceInfo: SourceInfo
}
```

**Argument substitution (bash-style):**
- `$1`, `$2` — positional
- `$@`, `$ARGUMENTS` — all args joined
- `${@:N}` — from Nth onwards
- `${@:N:L}` — L args from Nth

**Discovery:** `~/.pi/agent/prompts/` (global), `.pi/prompts/` (project-local)

## System Prompt Assembly

`buildSystemPrompt()` assembles in order:

1. Base instructions (or `customPrompt` override)
2. **Available tools** section — `name: promptSnippet` per tool
3. **Guidelines** section — tool-specific `promptGuidelines[]`
4. Documentation references
5. **Project Context** — context files (AGENTS.md, CLAUDE.md)
6. **Skills** section — XML via `formatSkillsForPrompt()`
7. Append section (APPEND_SYSTEM.md files)
8. Current date + working directory

Override patterns:
```typescript
new DefaultResourceLoader({
  systemPromptOverride: () => "Custom base prompt",
  appendSystemPromptOverride: (base) => [...base, "Additional guidelines"],
})
```

Prompt rebuilt dynamically when active tools change via `_rebuildSystemPrompt(toolNames)`.

## Session Management

- Append-only JSONL tree format (branch, fork, compaction nodes)
- `SessionManager.inMemory()` for testing
- File-based at `~/.pi/agent/sessions/`

## Settings

```typescript
interface Settings {
  defaultProvider, defaultModel, defaultThinkingLevel,
  compaction: { enabled, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: { enabled, maxRetries: 3, baseDelayMs: 2000 },
  extensions: string[], skills: string[], prompts: string[],
  theme: string,
  // ...
}
```

Cascade: in-memory defaults < file settings < CLI args < runtime overrides.

Config paths (default `~/.pi/agent/`):
- `settings.json`, `auth.json`, `models.json`
- `extensions/`, `skills/`, `prompts/`, `sessions/`

## Safety Patterns

- `tool_call` event → extensions can block with reason
- `bash` tool → spawn hooks (modify command, cwd, env)
- File mutation queue prevents corruption
- Output truncation prevents context overflow
- Extension examples: `confirm-destructive.ts`, `protected-paths.ts`, `permission-gate.ts`, `dirty-repo-guard.ts`
