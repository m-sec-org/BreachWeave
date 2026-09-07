# Web UI, RPC Protocol & SDK

## Artifacts System

### Artifact Types (10)
Extension → renderer mapping by file extension:
HtmlArtifact, SvgArtifact, MarkdownArtifact, ImageArtifact, PdfArtifact, ExcelArtifact, DocxArtifact, TextArtifact (code with syntax highlighting), GenericArtifact (fallback).

### Tool Schema
6 commands: `create`, `update`, `rewrite`, `get`, `delete`, `logs`. Parameters: `filename`, `content`, `old_str`/`new_str`. Exposed as `AgentTool` with TypeBox validation.

### Session Reconstruction
`reconstructFromMessages()` replays all artifact operations from history to reconstruct final state. Handles both `artifact` role and `toolResult` messages.

## Sandbox Security Model

### Iframe Sandboxing
- `sandbox="allow-scripts allow-modals"` — NO `allow-same-origin`, NO `allow-forms`, NO `allow-popups`
- Web mode: `srcdoc` attribute (no URL, completely isolated)
- Extension mode: `chrome.runtime.getURL("sandbox.html")` then `postMessage`

### Navigation Interception
All clicks/forms/`window.location` intercepted. External URLs forwarded via `postMessage({ type: "open-external-url" })`.

### Runtime Providers (4 built-in)

1. **ConsoleRuntimeProvider** (REQUIRED, always first)
   - Wraps console.log/error/warn/info
   - Provides `window.complete(error?, returnValue?)` for lifecycle
   - Handles global error + unhandledrejection

2. **ArtifactsRuntimeProvider**
   - `listArtifacts()`, `getArtifact(filename)`, `createOrUpdateArtifact(filename, content)`, `deleteArtifact(filename)`
   - Two modes: read-only (HTML viewing others) and read-write (REPL)
   - Offline (snapshot) vs Online (messaging)

3. **AttachmentsRuntimeProvider**
   - `listAttachments()`, `readTextAttachment(id)`, `readBinaryAttachment(id)`
   - Snapshot-based, no messaging

4. **FileDownloadRuntimeProvider**
   - `returnDownloadableFile(fileName, content, mimeType?)`
   - Handles Blob, Uint8Array, string, object content

### RuntimeMessageBridge
- sandbox-iframe: `window.parent.postMessage` with correlation IDs, 30s timeout
- user-script: `chrome.runtime.sendMessage` (browser extension)
- Both provide `window.sendRuntimeMessage()` and `window.onCompleted()`

### RuntimeMessageRouter (Singleton)
Single `window.addEventListener("message")` routes to all sandboxes. Messages → providers first (bidirectional), then consumers (one-way). Auto-cleanup on last unregister.

## Renderer Registries

### Message Renderer Registry
Maps `MessageRole` → `MessageRenderer`. API: `registerMessageRenderer(role, renderer)`, `getMessageRenderer(role)`.

### Tool Renderer Registry
Maps tool name → `ToolRenderer`. Built-in: BashRenderer, CalculateRenderer, DefaultRenderer, GetCurrentTimeRenderer, ArtifactsToolRenderer.
```typescript
interface ToolRenderer<TParams, TDetails> {
  render(params, result, isStreaming?): { content: TemplateResult, isCustom: boolean }
}
```

## RPC Protocol (28 Commands)

Transport: JSONL over stdin/stdout, LF framing, `StringDecoder` for UTF-8.

### Full Command List

**Prompting (5)**: prompt, steer, follow_up, abort, new_session
**State (1)**: get_state
**Model (3)**: set_model, cycle_model, get_available_models
**Thinking (2)**: set_thinking_level, cycle_thinking_level
**Queue (2)**: set_steering_mode, set_follow_up_mode
**Compaction (2)**: compact, set_auto_compaction
**Retry (2)**: set_auto_retry, abort_retry
**Bash (2)**: bash, abort_bash
**Session (7)**: get_session_stats, export_html, switch_session, fork, get_fork_messages, get_last_assistant_text, set_session_name
**Messages (1)**: get_messages
**Commands (1)**: get_commands

### Extension UI Protocol
- Requests (stdout): `extension_ui_request` with methods: select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text
- Responses (stdin): `extension_ui_response` with value/confirmed/cancelled
- Signal/timeout for dialog methods

### RPC Client
`RpcClient` spawns agent as child process with `--mode rpc`. Helpers: `waitForIdle(timeout)`, `collectEvents(timeout)`, `promptAndWait(message, images, timeout)`.

### Correlation
Commands have optional `id`. Responses include matching `id`. Events (streaming) are separate.

## SDK Examples (12)

| # | File | Pattern |
|---|------|---------|
| 01 | minimal | Zero config, subscribe + prompt |
| 02 | custom-model | `getModel()`, `modelRegistry.find()`, `getAvailable()` |
| 03 | custom-prompt | `systemPromptOverride`, `appendSystemPromptOverride` |
| 04 | skills | `skillsOverride`, `createSyntheticSourceInfo()` |
| 05 | tools | `codingTools`, `readOnlyTools`, factory functions with custom cwd |
| 06 | extensions | `additionalExtensionPaths`, `extensionFactories` inline |
| 07 | context-files | `agentsFilesOverride` for AGENTS.md discovery |
| 08 | prompt-templates | `promptsOverride()`, custom `PromptTemplate` objects |
| 09 | api-keys-oauth | `AuthStorage.create()`, `setRuntimeApiKey()` |
| 10 | settings | `SettingsManager.create/inMemory`, `applyOverrides()` |
| 11 | sessions | 4 modes: inMemory, create, continueRecent, open |
| 12 | full-control | Custom ResourceLoader impl, `createExtensionRuntime()` |

## Web UI Model Discovery

4 local server types with auto-discovery:
- **Ollama**: `ollama.list()` + `ollama.show()`, filters by tools capability
- **llama.cpp**: `/v1/models`, fallback 8192 context
- **vLLM**: `/v1/models`, `max_model_len` for context
- **LM Studio**: `@lmstudio/sdk` WebSocket, `listDownloadedModels()`, detects vision/tool-use

All use `openai-completions` API format. Custom providers: 7 types (4 auto-discovery + 3 manual).

## i18n

`@mariozechner/mini-lit` i18n. English + German (207+ strings). `i18n("Key string")` with template params. TypeScript declaration merging for type-safe keys.

## Proxy Systems

### CORS Proxy (Web UI)
- Always proxy: Z-AI, OpenAI Codex
- Conditional: Anthropic OAuth (`sk-ant-oat-*`) needs proxy
- Never: OpenAI, Google, Groq, OpenRouter, etc.
- `applyProxyIfNeeded()` rewrites baseUrl to `{proxyUrl}/?url={encodedBaseUrl}`

### Server Proxy (pi-agent-core)
- `streamProxy()` via SSE to `{proxyUrl}/api/stream`
- Bandwidth-optimized (server strips `partial` field)
- Client reconstructs AssistantMessage from deltas

## Resource Loader

### Context File Discovery (AGENTS.md / CLAUDE.md)
1. Load from `agentDir` (global)
2. Walk UP from `cwd` to filesystem root
3. Each dir: check AGENTS.md then CLAUDE.md (first found wins per dir)
4. Ancestor files ordered root-first
5. Dedup by absolute path

### System Prompt Files
`<cwd>/.pi/SYSTEM.md` → `~/.pi/agent/SYSTEM.md`. Same for `APPEND_SYSTEM.md`.

### Override System (12 hooks)
All accept `(base) => modified`:
`systemPromptOverride`, `appendSystemPromptOverride`, `extensionsOverride`, `skillsOverride`, `promptsOverride`, `themesOverride`, `agentsFilesOverride`

Disable flags: `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`

Additional paths: `additionalExtensionPaths/SkillPaths/PromptTemplatePaths/ThemePaths`

Inline: `extensionFactories: ExtensionFactory[]`

### ResourceLoader Interface
```typescript
interface ResourceLoader {
  getExtensions(): LoadExtensionsResult
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] }
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] }
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> }
  getSystemPrompt(): string | undefined
  getAppendSystemPrompt(): string[]
  extendResources(paths: ResourceExtensionPaths): void
  reload(): Promise<void>
}
```

`extendResources()` called by extensions at runtime for dynamic paths. Source tracking via `SourceInfo` with path, source, scope, origin.
