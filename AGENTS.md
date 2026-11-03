# tch-agent

CTF 智能 agent 平台：Manager/Observer/Solver 多角色架构，基于 pi-coding-agent SDK。

## 快速参考

- **运行时**: Bun（非 Node.js）
- **包管理器**: bun install / bun run
- **开发**: `bun run dev`（Web HMR）
- **测试**: `bun test`（packages/core）
- **类型检查**: `bun run typecheck`

## 仓库结构

```
packages/
  core/       → @tch/core        配置管理、provider/model/tool/skill/prompt 注册
  ui-web/     → @tch/ui-web      Web UI + REST API（Bun.serve）
  ui-tui/     → @tch/ui-tui      终端 UI（Ink）
apps/
  cli/        → @tch/cli         命令行入口（Commander → web/tui 模式）
```

## 关键文档

| 文档     | 位置                               | 内容                     |
| -------- | ---------------------------------- | ------------------------ |
| 架构概览 | [ARCHITECTURE.md](ARCHITECTURE.md) | 分层架构、数据流、包依赖 |
| 设计原稿 | [docs/design.md](docs/design.md)   | 初始架构设计（历史参考） |

## 架构分层

```
Types → Config → Service → Runtime → UI
```

依赖方向严格单向：UI 依赖 Runtime → Service → Config → Types。禁止反向依赖。

## 配置路径

用户配置存储在 `~/.tch-agent/config/`，包含：

- `api-keys.json` — API 密钥
- `provider-prefs.json` — Provider 偏好
- `model-prefs.json` — 模型偏好
- `models.json` — SDK 模型注册（同步自 model-prefs）
- `mcp.json` — MCP 服务配置
- `prompts/` — Prompt 文件（YAML frontmatter + Markdown）
- `skills/` — Skill 目录

## SDK 依赖

- `@earendil-works/pi-coding-agent` — Agent session、工具定义、资源加载
- `@earendil-works/pi-ai` — Model/Api 类型、Provider 注册表
- `pi-mcp-adapter` — MCP 配置加载

## Bun 偏好

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$\`ls\` instead of execa.

### Testing

Use `bun test` to run tests.

```ts
import { test, expect } from "bun:test"

test("hello world", () => {
    expect(1).toBe(1)
})
```

### Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Code Style

写代码必须遵循以下项目风格。不符合者必须修正。

### 文件命名

- 文件/目录：kebab-case（`api-keys.tsx`, `use-fetch.ts`, `sidebar-data.ts`）
- React 组件文件同样 kebab-case（不用 PascalCase 文件名）

### 导入规范

```ts
// 1. 类型导入用 `import type`，值导入用 `import`，不要混合
import type { ModelConfigEntry, ProviderPrefEntry } from "./providers"
import { ConfigManager } from "./config"

// 2. 模块内聚合用命名空间导入
import * as prompts from "./prompts"
import * as mcp from "./mcp"

// 3. SDK 类型 re-export 用 `export type`
export type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent"
```

### 函数风格

```ts
// React 组件：export function 声明（不用 arrow + export default）
export function ModelsPage() { ... }

// 组件内事件处理：async function 声明
async function handleSave() { ... }

// 工具方法/hooks：export function
export function useFetch<T>(fetcher: () => Promise<T>) { ... }

// 不要用 export default（组件、模块均用 named export）
```

### 状态管理

```ts
// 行级 useState，无状态管理库
const [name, setName] = useState("")
const [loading, setLoading] = useState(false)

// 数据获取统一用 useFetch hook
const { data: list, loading, reload } = useFetch(models.list)

// 派生状态用 const，不用额外 state
const filtered = list?.filter(...)
```

### 错误处理

- HTTP 层：`if (!res.ok) throw new Error(await res.text())`
- 文件操作：`try-catch` + null fallback
- 不要为不可能的场景加防御代码

### TypeScript

- `strict: true`，不要用 `any`（SDK 边界除外）
- 接口/类型：PascalCase（`ModelConfigEntry`）
- 常量：UPPER_SNAKE_CASE（`DEFAULT_CONFIG_DIR`）
- 变量/函数：camelCase

### UI 组件

- 基础组件在 `components/ui/` 下，CVA variants + Tailwind
- 业务组件在 `components/config/` 下，每个配置领域一个文件
- 样式：Tailwind utility classes，`cn()` 组合条件类名
- 不写内联 style，不用 CSS modules

### 配置文件格式

- JSON：`Bun.file().json()` 读，`Bun.write(path, JSON.stringify(data, null, 2))` 写
- YAML（Prompt frontmatter）：`yaml` 包解析
- 不要用 node:fs 的 readFile/writeFile，用 Bun.file


**No backward compatibility** - Break old formatsfreely
