# Session Management & Compaction

## Session JSONL Tree Format

**Storage**: Append-only JSONL files. Each line is a `SessionEntry`.

### SessionHeader (first line)
```typescript
{ version, id, timestamp, workingDirectory, parentSession? }
```

### SessionEntry Node Types
- **Messages**: user, assistant, toolResult — standard conversation turns
- **ThinkingLevelChange**: records when thinking level switches
- **ModelSwitch**: records when model changes
- **CompactionEntry**: summary replacing older messages
- **BranchSummaryEntry**: summary of branch being navigated away from
- **CustomEntry**: extension-injected data (not sent to LLM)
- **LabelEntry**: user-defined bookmarks
- **SessionInfo**: metadata

### Tree Structure
Each entry has a parent ID → forms a tree. `SessionManager` tracks a "leaf" pointer (current position). New entries always append as children of current leaf.

### Branching vs Forking
- **Branch**: `branch()` moves leaf pointer back. New messages create a new branch in same JSONL file (non-destructive).
- **Fork**: `createBranchedSession()` extracts a single path into a NEW session file.
- **Branch with summary**: `branchWithSummary()` generates structured summary of branch being left behind.

### Context Reconstruction (`buildSessionContext()`)
1. Traverse root → current leaf
2. CompactionEntry encountered → replace all prior messages with summary
3. BranchSummaryEntry → inject as context
4. Assemble `SessionContext`: message list, current thinking level, current model

### Static Constructors
```typescript
SessionManager.create(cwd)          // New session
SessionManager.open(path)           // Open existing
SessionManager.continueRecent(cwd)  // Resume most recent (or create new)
SessionManager.forkFrom(...)        // Branch from entry in another session
SessionManager.inMemory()           // No persistence (testing)
SessionManager.list(cwd)            // Enumerate sessions
```

### Migration
v1 → v2 (tree structure), v2 → v3 (role renaming). Backward compatible.

---

## Compaction Algorithm

### Trigger Conditions
- **Auto**: context tokens approach `contextWindow - reserveTokens` (monitored after each LLM response)
- **Manual**: user command or extension `ctx.compact()`
- **Overflow recovery**: LLM returns context overflow error → compact then retry
- **Extension hook**: `session_before_compact` can cancel or provide custom result

### Settings
```typescript
compaction: {
  enabled: true,
  reserveTokens: 16384,     // Buffer kept free in context window
  keepRecentTokens: 20000,  // Recent conversation preserved verbatim
}
```

### Token Estimation
`characters / 4` heuristic for messages. Actual counts from LLM usage metadata.

### Cut Point Algorithm (`findCutPoint()`)
1. Walk **backwards** from current leaf
2. Accumulate estimated token sizes
3. Stop at `keepRecentTokens` threshold
4. Only cut at **user/assistant message boundaries** (never mid-turn, never at tool results)
5. If cut falls mid-turn → `splitTurn` flag with boundary info

### Summarization (Two-Pass)
1. **Main summary**: All pre-cut messages serialized via `serializeConversation()` → LLM prompt requesting: goals, progress, decisions, next steps
2. **Split-turn prefix**: If mid-turn cut, early part gets separate summary merged with main
3. **Iterative**: If previous compaction summary exists, included in prompt for refinement

### File Operation Tracking
During compaction, `extractFileOpsFromMessage()` scans for read/write/edit tool calls. `computeFileLists()` separates read-only vs modified files. Appended to summary as `<read-files>` and `<modified-files>` XML.

### Serialization Format
```
[User]: {text}
[Assistant thinking]: {thinking}
[Assistant]: {text}
[Assistant tool calls]: {tool calls}
[Tool result]: {truncated at 2000 chars}
```
Images filtered out. Format prevents summarization model from continuing conversation.

### Session Integration
CompactionEntry appended to tree. `buildSessionContext()` replaces pre-compaction messages with single user message: "conversation history before this point was compacted".

---

## AgentSession vs Agent

### Agent (Low-Level)
- System prompt, model, thinking level, tools, messages
- Three queues: prompt, steer, followUp
- abort, waitForIdle, subscribe
- Emits AgentEvent
- **No persistence, no retry, no compaction**

### AgentSession (High-Level) — Adds:
1. **Session persistence** — all messages written to JSONL tree
2. **Auto-compaction** — monitors usage, triggers on limits or overflow
3. **Auto-retry** — exponential backoff on retryable errors
4. **Model cycling** — cycle through available models
5. **Skill/template expansion** — expands slash commands before agent
6. **Extension integration** — fires all extension events at lifecycle points
7. **Bash command execution** — tracks history for context
8. **Session navigation** — switching, forking, tree navigation with branch summaries
9. **Model/API key validation** — validates before prompting
10. **Custom message types** — converts via `convertToLlm()`

### Key Wiring
AgentSession provides `convertToLlm` and `transformContext` callbacks to Agent's `AgentLoopConfig`. The Agent loop calls these before each LLM request → AgentSession implements with session-aware logic.

### Custom Message Types
```typescript
// Declared via module augmentation:
bashExecution     — shell command results
custom            — extension-injected messages
branchSummary     — branch navigation summaries
compactionSummary — compaction results
```

`convertToLlm()` transforms these to standard LLM messages. Messages marked `excludeFromContext` are filtered out.

---

## Retry System

### Settings
```typescript
retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000 }
```

### Exponential Backoff
`delay = min(baseDelayMs * 2^attempt, maxDelayMs)` → 2s, 4s, 8s (capped at 60s)

### Triggers Retry
- Overload (529), rate limit (429), server errors (5xx)
- Context overflow → compact first, then retry with smaller context

### Does NOT Retry
- Auth errors (401/403), invalid request (400), abort/cancellation, tool execution errors

### Mechanism
Uses `agentLoopContinue()` to resume from current context without adding a new message. StreamFn contract: never throw — encode failures as protocol events with `stopReason: "error"/"aborted"` and `errorMessage`.

---

## Branch Summarization

**When**: user navigates to different point in session tree.

**Algorithm**:
1. Trace from current position back to common ancestor
2. Convert entries to messages (backwards, respecting token budget)
3. Send to LLM with structured format: goals, constraints, progress, decisions, next steps
4. Store as `BranchSummaryEntry`

Settings: `reserveTokens: 16384`, `skipPrompt: false`.
