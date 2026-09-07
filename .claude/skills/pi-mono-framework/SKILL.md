---
name: pi-mono-framework
description: "pi-mono agent framework reference (github.com/badlogic/pi-mono). TRIGGER when: writing agent code using pi-ai/pi-agent-core/pi-coding-agent packages, defining tools with TypeBox schemas, implementing TUI or Web UI over an agent core, building extensions that hook into agent lifecycle, working with session/compaction/retry logic, implementing LLM provider abstractions, or any code that imports from @mariozechner/* packages."
---

# pi-mono Agent Framework

## Architecture

```
pi-ai           → LLM abstraction (13 providers, 10 protocols)
pi-agent-core   → Agent loop + tool execution + events (5 files, zero UI knowledge)
pi-coding-agent → Reference app: tools, extensions, skills, prompts, sessions, compaction
pi-tui          → Terminal UI (custom differential rendering, NOT Ink/React)
pi-web-ui       → Web components (LitElement + Tailwind + IndexedDB)
```

Strict layer isolation: each layer has ZERO knowledge of layers above. pi-agent-core does NOT contain MCP, skills, or sessions — pi-mono uses a custom Extension system instead of MCP.

## Gotchas

**These are the most common pitfalls. Read before writing any pi-mono code.**

- **TypeBox is mandatory for tool schemas** — `@sinclair/typebox` for JSON Schema + TypeScript inference. No raw JSON Schema anywhere.
- **ToolCall.arguments is `Record<string, any>`**, not string — arguments are parsed objects, not raw JSON strings.
- **ThinkingContent field is `thinking`**, not `text` — and `redacted` is optional (`redacted?: boolean`).
- **ThinkingLevel has no "off" value** — only `"minimal" | "low" | "medium" | "high" | "xhigh"`.
- **convertToLlm and transformContext are async** — `convertToLlm` returns `Message[] | Promise<Message[]>`, `transformContext` takes `(messages, signal?) => Promise<AgentMessage[]>`.
- **beforeToolCall/afterToolCall are async with signal** — signature is `(ctx, signal?) => Promise<Result | undefined>`. Can return undefined.
- **Tool preparation is always sequential** even in parallel mode — beforeToolCall hooks run one at a time. Only execution is concurrent.
- **TUI render(width) lines MUST NOT exceed width** — overflow crashes the TUI.
- **Web UI connects to Agent directly**, not AgentSession — it uses IndexedDB for its own storage. TUI uses the higher-level AgentSession.
- **Default model is Gemini Flash Lite**, not an Anthropic model.
- **No persistence in agent-core** — session management is entirely in pi-coding-agent.
- **Cross-provider normalization is critical** — tool call IDs, thinking blocks, and orphaned tool calls must be handled when switching providers. Use `transform-messages.ts`.
- **OAuth tokens trigger Claude Code impersonation** — `sk-ant-oat` prefix activates special headers, system prompt prefix, and tool name translation.
- **Compaction uses `characters / 4` heuristic** — not actual tokenizer. Cut point is always at user/assistant boundaries, never mid-turn.
- **Extension emit methods have DIFFERENT chaining semantics** — `emitToolResult` chains results, `emitContext` deep-clones via structuredClone, `emitToolCall` short-circuits on block. Don't assume one generic dispatch.
- **Extensions can't call action methods during loading** — runtime stubs throw. Provider registrations are queued and flushed after binding.
- **Register tool with same name to override built-in** — no special API, just `pi.registerTool({ name: "read", ... })`.

## References

### Core APIs (read first when implementing)
- **[references/pi-ai.md](references/pi-ai.md)** — Provider registry, streaming API, message types, model config, cross-provider compatibility
- **[references/pi-agent-core.md](references/pi-agent-core.md)** — Agent class, loop structure, AgentTool, tool execution, events, hook context types
- **[references/pi-coding-agent.md](references/pi-coding-agent.md)** — createAgentSession(), 7 built-in tools, ToolDefinition, extension API (30 events), skills, prompts
- **[references/pi-ui.md](references/pi-ui.md)** — TUI Component interface, rendering pipeline, Web UI components, adapter patterns

### Deep Internals (read when debugging or extending)
- **[references/pi-ai-internals.md](references/pi-ai-internals.md)** — Provider impl patterns, OAuth flows, Claude Code mode, adaptive thinking, cache retention, cost calculation, browser compat
- **[references/pi-session-compaction.md](references/pi-session-compaction.md)** — JSONL session tree, compaction algorithm, AgentSession vs Agent, retry system, branch summarization
- **[references/pi-extensions-deep.md](references/pi-extensions-deep.md)** — jiti loading, event dispatch chaining, EventBus, 15+ real extension patterns (SSH, subagent, permission gate, git checkpoint, custom compaction, overlay UI)
- **[references/pi-web-rpc-sdk.md](references/pi-web-rpc-sdk.md)** — Artifacts sandbox security, RPC 28 commands, SDK 12 examples, model discovery, ResourceLoader 12 override hooks
- **[references/pi-tui-internals.md](references/pi-tui-internals.md)** — Theming (50+ tokens, hot-reload), Input (Emacs kill ring), Editor (paste markers, jump mode), Markdown rendering, Image protocols, keybinding system
