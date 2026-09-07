# pi-agent-core — Agent Loop & Tool Execution

Package: `@mariozechner/pi-agent-core` v0.62.0, located at `packages/agent/` (npm: `@mariozechner/pi-agent-core`). Only depends on `@mariozechner/pi-ai`.

5 source files: `types.ts`, `agent.ts`, `agent-loop.ts`, `proxy.ts`, `index.ts`.

## Agent Class (High-Level API)

```typescript
const agent = new Agent({
  initialState?: Partial<AgentState>,
  convertToLlm?: (msgs: AgentMessage[]) => Message[] | Promise<Message[]>,  // App→LLM conversion (async supported)
  transformContext?: (msgs: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,  // Pre-conversion (async)
  streamFn?: StreamFn,                    // Default: streamSimple from pi-ai
  toolExecution?: "sequential" | "parallel",  // Default: "parallel"
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>,
  afterToolCall?: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>,
  steeringMode?: "all" | "one-at-a-time",    // Default: "one-at-a-time"
  followUpMode?: "all" | "one-at-a-time",    // Default: "one-at-a-time"
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,  // Dynamic per-provider
  sessionId?: string,                         // For provider session caching
  onPayload?: (payload) => void,              // Inspect/replace provider payloads
  thinkingBudgets?: ThinkingBudgets,
  transport?: "sse" | "websocket" | "auto",   // Default: "sse"
  maxRetryDelayMs?: number,                   // Default: 60000
})

// Default model: gemini-2.5-flash-lite-preview-06-17 (Google)
```

### Lifecycle Methods

```typescript
agent.prompt(input, images?)  // Start turn: string (with optional images) | AgentMessage | AgentMessage[]
agent.continue()         // Resume from current context (retries, queued messages)
agent.abort()            // Cancel via AbortController
agent.reset()            // Clear messages, queues, streaming state, errors
agent.waitForIdle()      // Promise resolves when current run finishes

// Mid-execution injection
agent.steer(message)     // Inject after current tool calls, before next LLM call
agent.followUp(message)  // Queue for after agent finishes

// State mutation
agent.setSystemPrompt(prompt)
agent.setModel(model)
agent.setThinkingLevel(level)
agent.setTools(tools)
agent.replaceMessages(messages)
agent.appendMessage(message)
agent.clearMessages()

// Events
const unsub = agent.subscribe((event: AgentEvent) => { ... })
```

## AgentState

```typescript
interface AgentState {
  systemPrompt: string
  model: Model<any>
  thinkingLevel: ThinkingLevel  // "minimal"|"low"|"medium"|"high"|"xhigh" (no "off")
  tools: AgentTool<any>[]
  messages: AgentMessage[]
  isStreaming: boolean
  streamMessage: AgentMessage | null  // Current partial during streaming
  pendingToolCalls: Set<string>
  error?: string
}
```

State transitions happen via `_processLoopEvent`:
- `message_start` → sets `streamMessage`
- `message_update` → updates `streamMessage`
- `message_end` → clears `streamMessage`, appends to `messages`
- `tool_execution_start` → adds to `pendingToolCalls`
- `tool_execution_end` → removes from `pendingToolCalls`
- `agent_end` → sets `isStreaming = false`

## Core Agent Loop

Two levels of API:

```typescript
// High-level: EventStream-based
agentLoop(prompts, context, config, signal?) → EventStream<AgentEvent, AgentMessage[]>
agentLoopContinue(context, config, signal?) → EventStream<AgentEvent, AgentMessage[]>

// Low-level: Callback-based
runAgentLoop(prompts, context, config, emit, signal?, streamFn?) → Promise<AgentMessage[]>
runAgentLoopContinue(context, config, emit, signal?, streamFn?) → Promise<AgentMessage[]>
```

### Loop Structure (`runLoop`)

```
OUTER LOOP (follow-up messages):
  INNER LOOP (tool calls + steering):
    1. Emit turn_start
    2. Process pending messages (steering/follow-up) → emit as message events
    3. streamAssistantResponse:
       a. Apply transformContext (AgentMessage[] → AgentMessage[])
       b. Apply convertToLlm (AgentMessage[] → Message[])
       c. Build Context { systemPrompt, messages, tools }
       d. Resolve API key dynamically
       e. Call streamFn (default: streamSimple)
       f. Iterate events: emit message_start, message_update (each delta), message_end
    4. If error/aborted → emit turn_end, agent_end, return
    5. Extract tool calls → execute via executeToolCalls
    6. Emit turn_end
    7. Check steering messages → continue inner loop if any
  END INNER LOOP
  Check follow-up messages → continue outer loop if any
END OUTER LOOP
Emit agent_end
```

## AgentTool Interface

```typescript
interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
  label: string  // Human-readable for UI
  execute: (
    toolCallId: string,
    params: Static<TParameters>,          // Validated via TypeBox
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,  // Streaming progress updates
  ) => Promise<AgentToolResult<TDetails>>
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[]  // For LLM consumption
  details: T                                // Typed details for UI rendering
}

type AgentToolUpdateCallback<T> = (partialResult: AgentToolResult<T>) => void
```

## Tool Execution Flow

```
1. prepareToolCall
   - Find tool by name in context
   - Validate arguments via validateToolArguments (TypeBox)
   - Call beforeToolCall hook → can return { block: true, reason }
   - Returns PreparedToolCall or ImmediateToolCallOutcome (errors/blocks)

2. executePreparedToolCall
   - Call tool.execute(toolCallId, args, signal, onUpdate)
   - Collect streaming updates via onUpdate callback
   - On error, create error result

3. finalizeExecutedToolCall
   - Call afterToolCall hook → can override { content?, details?, isError? }
   - Emit tool_execution_end event
   - Create ToolResultMessage, emit message_start/message_end
```

### Tool Hook Context Types

```typescript
interface BeforeToolCallContext {
  assistantMessage: AgentMessage
  toolCall: AgentToolCall
  args: any
  context: AgentContext
}
// Returns: Promise<{ block?: boolean, reason?: string } | undefined>

interface AfterToolCallContext {
  assistantMessage: AgentMessage
  toolCall: AgentToolCall
  args: any
  result: AgentToolResult<any>
  isError: boolean
  context: AgentContext
}
// Returns: Promise<{ content?, details?, isError? } | undefined>
```

**Parallel mode**: Prepare sequentially (beforeToolCall ordering guarantee), execute concurrently.
**Sequential mode**: Prepare and execute one at a time.

## Event System

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
```

Subscription: `agent.subscribe(fn)` returns unsubscribe function. Events pushed synchronously to all listeners.

## Extensible Message Types

```typescript
// AgentMessage is extensible via declaration merging
interface CustomAgentMessages {
  // Empty by default
}
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]

// Apps extend:
declare module "@mariozechner/agent" {
  interface CustomAgentMessages {
    artifact: ArtifactMessage
  }
}
```

## AgentLoopConfig

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>                               // Required
  convertToLlm: (msgs: AgentMessage[]) => Message[] | Promise<Message[]>  // Required (async supported)
  transformContext?: (msgs: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  getSteeringMessages?: () => Promise<AgentMessage[]>   // Mid-run injection
  getFollowUpMessages?: () => Promise<AgentMessage[]>   // Post-completion injection
  toolExecution?: "sequential" | "parallel"
  beforeToolCall?: (ctx, signal?) => Promise<BeforeToolCallResult | undefined>
  afterToolCall?: (ctx, signal?) => Promise<AfterToolCallResult | undefined>
}
```

## Proxy System

```typescript
// Drop-in StreamFn replacement for server-mediated LLM calls
streamProxy(model, context, options: ProxyStreamOptions) → AssistantMessageEventStream

interface ProxyStreamOptions extends SimpleStreamOptions {
  authToken: string
  proxyUrl: string
}
```

Uses SSE over `fetch` to `{proxyUrl}/api/stream`. Server strips `partial` field for bandwidth. Client reconstructs partial message from deltas.

## What Is NOT in This Package

- MCP integration → in coding-agent
- Skills/prompts → in coding-agent
- Session persistence → in coding-agent
- Compaction → in coding-agent
- Extensions/plugins → in coding-agent
- UI of any kind → in pi-tui / pi-web-ui
