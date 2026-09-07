# pi-ai Deep Internals

## Provider Implementation Pattern

All providers follow identical architecture:

1. Create `AssistantMessageEventStream`
2. Wrap logic in async IIFE
3. Initialize `AssistantMessage` with zeroed usage
4. Create provider SDK client with merged headers
5. Call `options?.onPayload?.(params, model)` hook (inspect/mutate raw API payload)
6. Iterate provider's native stream → map to unified `AssistantMessageEvent`
7. Track content blocks by index, push start/delta/end events
8. On error: `stopReason = "error"/"aborted"`, push error event
9. On success: push "done" event

### Provider-Specific Behaviors

- **Anthropic**: `client.messages.stream()`. Handles `text`, `thinking`, `redacted_thinking`, `tool_use`, `signature_delta` blocks.
- **OpenAI Responses**: `client.responses.create()`. Processing factored into `openai-responses-shared.ts` `processResponsesStream()`.
- **Google**: `client.models.generateContentStream()`. No incremental tool call args — arrive complete in `part.functionCall.args`.
- **Bedrock**: `ConverseStreamCommand` via AWS SDK. Supports proxy/HTTP1 config via env vars (`HTTP_PROXY`, `AWS_BEDROCK_FORCE_HTTP1`, `AWS_BEDROCK_SKIP_AUTH`).

## Incremental JSON Parsing

```typescript
// src/utils/json-parse.ts — uses `partial-json` npm package
function parseStreamingJson<T>(partialJson: string | undefined): T {
  if (!partialJson?.trim()) return {} as T
  try { return JSON.parse(partialJson) as T }         // Fast path: complete JSON
  catch { return (partialParse(partialJson) ?? {}) as T }  // Fallback: partial parse
}
```

**Why**: Tool call arguments arrive as fragments during streaming. `partial-json` can parse `{"file": "test.ts", "conte` → `{"file": "test.ts"}`. All providers except Google use this (Google sends complete args).

## OAuth Flows (5 providers)

### Anthropic OAuth (Authorization Code + PKCE)
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Callback: `127.0.0.1:53692/callback`
- Token URL: `https://platform.claude.com/v1/oauth/token`
- Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- PKCE S256 via Web Crypto API
- Token expiry buffer: 5 minutes early
- Refresh via `grant_type: "refresh_token"`
- CLI-only (uses `node:http.createServer`)

### GitHub Copilot OAuth (Device Code Flow)
- Client ID: `Iv1.b507a08c87ecfe98`
- Mimics VS Code Copilot (`GitHubCopilotChat/0.35.0`, `vscode/1.107.0`)
- Enterprise support: prompts for domain
- Two-step: GitHub access token → Copilot-specific token via `/copilot_internal/v2/token`
- Base URL extracted from token's `proxy-ep` field
- Polling: 1.2x interval, 1.4x on `slow_down`
- Post-login: enables ALL registered models via `POST /models/{id}/policy`
- `modifyModels()`: only OAuth provider that dynamically updates model baseUrl

### Shared OAuth Infrastructure
- Registry: `Map<string, OAuthProviderInterface>`
- `getOAuthApiKey()`: auto-refreshes expired tokens
- Custom providers can be registered/unregistered

## Claude Code Impersonation ("Stealth Mode")

When using Anthropic OAuth tokens (`sk-ant-oat` prefix):
- **Headers**: `user-agent: claude-cli/2.1.75`, `x-app: cli`, beta header `claude-code-20250219`
- **System prompt**: Prepends "You are Claude Code, Anthropic's official CLI for Claude."
- **Tool name translation**: Maintains lookup table of Claude Code canonical names (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`). `toClaudeCodeName()` converts outgoing, `fromClaudeCodeName()` converts incoming.

This enables Claude Pro/Max subscription usage via OAuth.

## Adaptive vs Budget-Based Thinking

Two distinct thinking modes:

1. **Adaptive** (Opus 4.6, Sonnet 4.6): `thinking: { type: "adaptive" }` + `output_config: { effort: "low"|"medium"|"high"|"max" }`. Model decides when/how much to think. `"max"` is Opus 4.6-only.
2. **Budget-based** (older models): `thinking: { type: "enabled", budget_tokens: N }`. Fixed budgets: minimal=1024, low=2048, medium=8192, high=16384.

Detection: `supportsAdaptiveThinking()` checks for `opus-4-6/4.6` or `sonnet-4-6/4.6` in model ID.

Google: Gemini 3.x uses `thinkingLevel` enum, Gemini 2.5.x uses `thinkingBudget` token count. Thinking can't be fully disabled on Gemini 3 (minimum LOW for Pro, MINIMAL for Flash).

## OpenAICompletionsCompat (Full Interface)

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean
  supportsDeveloperRole?: boolean          // "developer" vs "system" role
  supportsReasoningEffort?: boolean
  reasoningEffortMap?: Partial<Record<ThinkingLevel, string>>
  supportsUsageInStreaming?: boolean
  maxTokensField?: "max_completion_tokens" | "max_tokens"
  requiresToolResultName?: boolean
  requiresAssistantAfterToolResult?: boolean
  requiresThinkingAsText?: boolean
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template"
  openRouterRouting?: OpenRouterRouting
  vercelGatewayRouting?: VercelGatewayRouting
  supportsStrictMode?: boolean
}
```

Auto-detection via `detectCompat()` by provider name and base URL. Thinking format varies: zai/qwen use `enable_thinking`, OpenRouter uses `reasoning: { effort }`, qwen-chat-template uses `chat_template_kwargs`.

## Cache Retention Per Provider

Type: `"none" | "short" | "long"`. Resolution: explicit option → `PI_CACHE_RETENTION` env → default `"short"`.

- **Anthropic**: `cache_control: { type: "ephemeral" }` on system prompt + last user message. `"long"` adds `ttl: "1h"` only on `api.anthropic.com`.
- **OpenAI Responses**: `prompt_cache_key` (= sessionId) + `prompt_cache_retention` ("24h" for "long" on `api.openai.com`).
- **Bedrock**: `CachePointType.DEFAULT` blocks. Supports Claude 3.5 Haiku, 3.7 Sonnet, 4.x. Force with `AWS_BEDROCK_FORCE_CACHE=1`.
- **OpenAI Completions / Google**: No cache control.

## Cost Calculation Per Provider

Model costs in dollars per million tokens. `calculateCost()` multiplies by actual usage.

Provider-specific timing:
- **Anthropic**: Called twice (message_start for input, message_delta for final)
- **OpenAI Responses**: Once at response.completed. Subtracts `cached_tokens` from input.
- **OpenAI Completions**: Per chunk. Adds `reasoning_tokens` to output.
- **Google**: Per chunk. Sums `candidatesTokenCount + thoughtsTokenCount`.
- **Bedrock**: Once at metadata event.

OpenAI service tier pricing: `flex` = 0.5x, `priority` = 2x.

## Browser Compatibility

All providers lazy-loaded via dynamic `import()`. Main bundle never imports heavy SDKs.

- Providers set `dangerouslyAllowBrowser: true` (Anthropic, OpenAI)
- Bedrock: detects non-Node environment, falls back to minimal config
- OAuth Anthropic: throws in browser (`node:http` unavailable)
- `setBedrockProviderModule()`: allows replacing Bedrock module for browser

## Streaming Internals

EventStream is a simple unbounded push-queue. No backpressure (by design — AI responses are small).

`Transport` type (`"sse" | "websocket" | "auto"`) exists in `StreamOptions` but is NOT used by any current provider. All streaming delegated to provider SDKs.
