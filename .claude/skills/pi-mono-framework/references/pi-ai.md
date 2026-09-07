# pi-ai — LLM Provider Abstraction

Package: `@mariozechner/pi-ai` v0.62.0, located at `packages/ai/`.

## Provider Registry

Registry pattern with lazy loading via dynamic `import()`:

```typescript
// src/api-registry.ts
registerApiProvider(provider: ApiProvider, sourceId?)  // ApiProvider = { api, stream, streamSimple }
getApiProvider(api)
getApiProviders()
unregisterApiProviders(source)  // remove by source
clearApiProviders()              // reset everything
```

`src/providers/register-builtins.ts` lazy-loads providers on first import. 24+ model providers (KnownProvider), 10 API protocols: openai-completions, openai-responses, openai-codex-responses, azure-openai-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-gemini-cli, google-vertex, mistral-conversations.

Each provider exports `stream<Provider>` and `streamSimple<Provider>` functions.

## Streaming API

4 public functions in `src/stream.ts`:

```typescript
stream(model, context, options?)         // Raw streaming, provider-specific options
complete(model, context, options?)       // Awaits full response via stream().result()
streamSimple(model, context, options?)   // Simplified with reasoning level control
completeSimple(model, context, options?) // Awaits full simplified response
```

## EventStream

Generic async-iterable stream (`src/utils/event-stream.ts`):

```typescript
class EventStream<T, R> {
  push(event: T): void           // Producer pushes events
  end(result?: R): void          // Signal completion
  [Symbol.asyncIterator]()       // Consumer: for await...of
  result(): Promise<R>           // Await final result
}

type AssistantMessageEventStream = EventStream<AssistantMessageEvent, AssistantMessage>
```

## Stream Event Protocol

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial }
  | { type: "text_start"; contentIndex; partial } | { type: "text_delta"; contentIndex; delta; partial } | { type: "text_end"; contentIndex; content: string; partial }
  | { type: "thinking_start"; contentIndex; partial } | { type: "thinking_delta"; contentIndex; delta; partial } | { type: "thinking_end"; contentIndex; content: string; partial }
  | { type: "toolcall_start"; contentIndex; partial } | { type: "toolcall_delta"; contentIndex; delta; partial } | { type: "toolcall_end"; contentIndex; toolCall: ToolCall; partial }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message }
  | { type: "error"; reason: "aborted" | "error"; error }
```

Each event carries `partial: AssistantMessage` with accumulated state. Tool call arguments parsed incrementally via `parseStreamingJson()`.

## Message Types

```typescript
type Message = UserMessage | AssistantMessage | ToolResultMessage

interface UserMessage {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: string; provider: string; model: string; responseId?: string
  usage: Usage
  stopReason: StopReason  // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string
  timestamp: number
}

interface ToolResultMessage<TDetails = any> {
  role: "toolResult"
  toolCallId: string; toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails; isError: boolean
  timestamp: number
}

// Content types
interface TextContent { type: "text"; text: string; textSignature?: string }
interface ThinkingContent { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
interface ImageContent { type: "image"; data: string; mimeType: string }
interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; thoughtSignature?: string }
```

## Context

```typescript
interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]
}
```

## Tool Schema (TypeBox)

```typescript
import { Type, type Static, type TSchema } from "@sinclair/typebox"

interface Tool<TParameters extends TSchema> {
  name: string
  description: string
  parameters: TParameters
}
```

## Model Configuration

`src/models.generated.ts` — auto-generated `MODELS` constant: `Record<Provider, Record<ModelId, Model<Api>>>`.

```typescript
interface Model<TApi> {
  id: string; name: string; api: TApi; provider: string
  baseUrl: string; reasoning: boolean
  input: string[]                    // modalities
  cost: { input, output, cacheRead, cacheWrite }  // per million tokens
  contextWindow: number; maxTokens: number
  compat?: OpenAICompletionsCompat; headers?: Record<string, string>
}

// Runtime model registry (src/models.ts)
getModel(provider, id)       // Type-safe lookup
getProviders()               // List all providers
getModels(provider)          // List models for a provider
calculateCost(model, usage)  // Compute costs from usage
```

## Token Counting & Context Management

```typescript
interface Usage {
  input: number; output: number
  cacheRead: number; cacheWrite: number
  totalTokens: number
  cost: { input, output, cacheRead, cacheWrite, total }
}

// Context overflow detection (src/utils/overflow.ts)
isContextOverflow(message, contextWindow?)  // Checks against 15+ provider-specific regex patterns

// Thinking budgets
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh"  // No "off" value
// ThinkingBudgets: optional per-level token budgets
```

## Cross-Provider Compatibility

`src/providers/transform-messages.ts` normalizes conversation history when switching providers:

- **Tool call ID normalization**: OpenAI uses 450+ char IDs, Anthropic requires `^[a-zA-Z0-9_-]+$` max 64 chars
- **Thinking block preservation**: redacted blocks for same-model, converted to text for cross-model
- **Orphaned tool call detection**: inserts synthetic error results for tool calls without matching results
- **Error message skipping**: filters out error/aborted messages

## Auth Management

`src/env-api-keys.ts` — `getEnvApiKey(provider)` resolves from environment:
- Direct: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, etc.
- OAuth: `ANTHROPIC_OAUTH_TOKEN` takes precedence over API key
- Complex: GitHub Copilot (`COPILOT_GITHUB_TOKEN`), AWS Bedrock (multiple credential sources)
- Browser-safe: dynamic imports for `node:fs`/`node:os`/`node:path`

OAuth flows in `src/utils/oauth/` for: Anthropic, GitHub Copilot, Google Antigravity, Google Gemini CLI, OpenAI Codex.
