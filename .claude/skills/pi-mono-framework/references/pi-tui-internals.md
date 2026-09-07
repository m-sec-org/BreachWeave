# TUI Deep Internals

## Theming System

### Theme JSON Schema (50+ color tokens)
```json
{
  "$schema": "...",
  "name": "dark",
  "vars": { "accent": "#7c3aed" },
  "colors": { "accent": "accent", "border": "#333", ... },
  "export": { "pageBg": "#000", "cardBg": "#111" }
}
```

Color values: hex (`"#ff0000"`), 256-color integers (`0-255`), variable references (`"accent"`), empty string = terminal default. Circular reference detection for variable chains.

### Color Token Categories (50+)
- **Core UI (11)**: accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text, thinkingText
- **Backgrounds (6)**: selectedBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg
- **Content (5)**: userMessageText, customMessageText, customMessageLabel, toolTitle, toolOutput
- **Markdown (10)**: mdHeading, mdLink, mdLinkUrl, mdCode, mdCodeBlock, mdCodeBlockBorder, mdQuote, mdQuoteBorder, mdHr, mdListBullet
- **Diffs (3)**: toolDiffAdded, toolDiffRemoved, toolDiffContext
- **Syntax (9)**: syntaxComment, syntaxKeyword, syntaxFunction, syntaxVariable, syntaxString, syntaxNumber, syntaxType, syntaxOperator, syntaxPunctuation
- **Thinking borders (6)**: thinkingOff/Minimal/Low/Medium/High/Xhigh
- **Bash (1)**: bashMode

### Theme Class
Colors resolved to ANSI sequences at construction. Methods: `fg(color, text)`, `bg(color, text)`, `bold()`, `italic()`, `underline()`, `inverse()`, `strikethrough()`.

### Color Mode Detection
`detectColorMode()`: checks `COLORTERM`, `WT_SESSION`, `TERM_PROGRAM`. Apple_Terminal/screen/tmux → 256-color. Hex downsampled via 6x6x6 color cube with weighted Euclidean distance.

### Discovery & Live Reload
- Built-in: `dark.json`, `light.json`
- Custom: `~/.pi/themes/*.json`
- Programmatic: `setRegisteredThemes(Theme[])` from extensions
- Auto-detect: `COLORFGBG` env (bg < 8 → dark, else light)
- Global via `Symbol.for("@mariozechner/pi-coding-agent:theme")` on `globalThis`
- Hot-reload: `fs.watch()` on custom themes dir, 100ms debounce

---

## Input Component

### Kill Ring (Full Emacs-Style)
```
ctrl+y       → yank (paste from ring top)
alt+y        → yank-pop (rotate ring, replace — only after yank)
ctrl+u       → kill to line start (prepend accumulation)
ctrl+k       → kill to line end (append accumulation)
ctrl+w       → kill word backward (prepend)
alt+d        → kill word forward (append)
```

Consecutive kills accumulate into one ring entry. `lastAction` tracking enables accumulation.

### Undo System
`UndoStack<InputState>` with `structuredClone()` deep copies. State: `{ value, cursor }`. Coalescing: consecutive word characters share one undo unit. `ctrl+-` to undo.

### Word Movement
`Intl.Segmenter` with grapheme granularity. Three-class boundaries: whitespace, punctuation (`isPunctuationChar()`), word characters. Skip trailing whitespace, then skip run of same class.

### Full Keybindings
- **Move**: left/ctrl+b, right/ctrl+f, home/ctrl+a, end/ctrl+e, alt+left/ctrl+left/alt+b (word left), alt+right/ctrl+right/alt+f (word right)
- **Delete**: backspace, delete/ctrl+d, ctrl+w/alt+backspace, alt+d/alt+delete, ctrl+u, ctrl+k
- **Actions**: enter (submit), escape/ctrl+c (cancel), ctrl+y, alt+y, ctrl+- (undo)
- **Paste**: bracketed paste (`\x1b[200~`...`\x1b[201~`), strips newlines/CR, tabs → 4 spaces

### Cursor
Inverse video (`\x1b[7m`) for visual cursor. `CURSOR_MARKER` APC sequence for hardware cursor (IME support).

---

## Editor Component

### Scrolling
- `scrollOffset` tracks first visible line
- Max visible: `max(5, floor(terminalRows * 0.3))` — 30% of terminal
- Scroll indicators: `"--- ^ N more ---"` / `"--- v N more ---"`
- Page up/down by viewport size

### Word Wrap
`wordWrapLine()`: word-boundary-aware, falls back to char-level for long words. Returns `TextChunk[]` with `{ text, startIndex, endIndex }` for cursor mapping.

### Paste Markers
Large pastes → `[paste #1 +123 lines]`. `pastes` Map stores originals. `segmentWithMarkers()` merges graphemes in markers into atomic segments. `getExpandedText()` restores originals.

### Sticky Column
`preferredVisualCol` maintained during vertical movement. Prevents cursor drift across lines of different lengths.

### History
Up to 100 entries (deduped consecutive). Up arrow on first line/empty editor → older. Down arrow on last line while browsing → newer.

### Character Jump Mode
`ctrl+]` → forward jump, next printable char jumps cursor there. `ctrl+alt+]` → backward. Press hotkey again or control char to cancel.

### Autocomplete
Tab-triggered. Two modes: "regular" (auto on typing) and "force" (Tab forced). `CombinedAutocompleteProvider` with slash commands + file paths. Tab applies + chains, Enter applies + submits (slash commands) or just applies.

---

## Markdown Rendering

### Parser
`marked` lexer for tokenization → ANSI-styled terminal output.

### Supported Elements
- **Headings**: H1 = bold+underline, H2 = bold, H3+ = `### ` + bold
- **Code blocks**: fenced with ``` display, `cli-highlight` syntax highlighting (language validation, auto-detect disabled), configurable indent
- **Inline code**: styled text
- **Bold/Italic/Strikethrough/Underline**: ANSI sequences via chalk
- **Links**: underlined text + URL in parens (deduped if same)
- **Blockquotes**: italic with `│ ` border, recursive nesting
- **Lists**: ordered/unordered with 2-space nesting
- **Tables**: column alignment, header, separator
- **HR**: `─` × 80 chars

### Style Context
`InlineStyleContext { applyText, stylePrefix }` — after ANSI reset, parent style re-applied. Ensures nested formatting works (bold inside heading re-applies heading color).

### Caching & Background
Render cached per `{ text, width }`. Background color applied at full-line padding stage (extends to terminal width), not inline.

---

## Image Rendering

### Terminal Detection (Priority Order)
1. `KITTY_WINDOW_ID` / `TERM_PROGRAM=kitty` → Kitty protocol
2. `GHOSTTY_RESOURCES_DIR` / `TERM_PROGRAM=ghostty` → Kitty protocol
3. `WEZTERM_PANE` / `TERM_PROGRAM=wezterm` → Kitty protocol
4. `ITERM_SESSION_ID` / `TERM_PROGRAM=iterm.app` → iTerm2 protocol
5. `TERM_PROGRAM=vscode/alacritty` → no images (truecolor + hyperlinks)

### Cell Size Query
`CSI 16 t` → response `CSI 6 ; height ; width t`. Fallback: 9px × 18px.

### Dimension Parsers (Pure TypeScript, No Dependencies)
- **PNG**: IHDR at offset 16/20 (big-endian UInt32)
- **JPEG**: SOF markers (0xC0-0xC2)
- **GIF**: offset 6/8 (little-endian UInt16)
- **WebP**: VP8, VP8L, VP8X chunk formats

### Kitty Protocol
4096-byte base64 chunks. `a=T, f=100, q=2`. Multi-chunk: `m=1` (more) / `m=0` (final). Image ID for reuse/replacement.

### iTerm2 Protocol
OSC 1337: `\x1b]1337;File=inline=1;width=N;height=auto;...:BASE64\x07`

### Rendering Trick
Renders `rows-1` empty lines + final line with cursor-up + image sequence. Lets differential renderer track image height. Fallback: `[Image: filename.png [image/png] 800x600]`.

---

## Keybinding System

### Three Layers
1. **Key parsing** (`keys.ts`): raw bytes → key identifiers
2. **Definitions** (`keybindings.ts`): semantic action → default keys
3. **KeybindingsManager**: resolution with user overrides + conflict detection

### Triple Protocol Support
1. **Legacy sequences**: hardcoded maps for arrows, function keys
2. **Kitty protocol**: CSI-u format (`\x1b[codepoint;modifier:event`)
3. **xterm modifyOtherKeys**: `CSI 27 ; modifiers ; keycode ~`

### Non-Latin Keyboard Support
Kitty's `baseLayoutKey` (flag 4) as fallback for Cyrillic/etc. Safety: only when primary codepoint is NOT recognized Latin (prevents Dvorak/Colemak/xremap false matches).

### Key Release/Repeat
`:3` in Kitty = release, `:2` = repeat. Components opt in via `wantsKeyRelease`. Bracketed paste content never treated as release/repeat.

### User Overrides
User bindings REPLACE defaults (not additive). Conflict detection for duplicate keys across bindings.

### Extensibility
Declaration merging: packages extend `Keybindings` interface. coding-agent adds app-specific bindings on top of TUI defaults.

---

## Interactive Components (35 in coding-agent)

### 7 UI Patterns

1. **Container + SelectList overlay**: ThemeSelector, SettingsSelector, ThinkingSelector, etc. `tui.showOverlay()` with positioning.

2. **Container + Input + custom list**: ModelSelector (fuzzy search), SessionSelector (scope/sort/rename/delete modes).

3. **Themed text blocks**: AssistantMessage, UserMessage, CustomMessage. Compose `Markdown` with theme backgrounds.

4. **Tool execution display**: BashExecution, ToolExecution. Status-dependent backgrounds (pending/success/error). Collapsible output. DiffComponent for file changes (word-level intra-line diff with inverse highlighting).

5. **Footer/Header bars**: Single-line, context-dependent keybinding hints via `keyHint()`/`keyText()`.

6. **Loading states**: Animated spinners, CancellableLoader wraps content with cancel action.

7. **Extension integration**: ExtensionEditor/Input/Selector wrap standard components for extension use. `EditorComponent` interface for custom implementations (vim mode).
