# Architecture

## 总览

tch-agent 是一个 Bun monorepo，采用分层架构：

```
┌─────────────────────────────────────────────┐
│  apps/cli        命令行入口 (Commander.js)     │
│  ↓ 路由到 web 或 tui 模式                     │
├─────────────────────────────────────────────┤
│  packages/ui-web    Web UI + REST API        │
│  packages/ui-tui    Terminal UI (Ink)         │
│  ↓ 调用 @tch/core                            │
├─────────────────────────────────────────────┤
│  packages/core      ConfigManager            │
│  ↓ 读写配置文件、调用 SDK                      │
├─────────────────────────────────────────────┤
│  pi-coding-agent SDK (第三方)                  │
│  pi-ai SDK (第三方)                            │
└─────────────────────────────────────────────┘
```

## 包依赖图

```
@tch/cli
  └── @tch/ui-web  ──→  @tch/core
  └── @tch/ui-tui  ──→  @tch/core
```

`@tch/core` 不依赖任何 UI 包。UI 包之间互不依赖。

## @tch/core 模块结构

```
config/
├── index.ts           ConfigManager 类（所有配置 CRUD 的入口）
├── providers/
│   ├── types.ts       ModelConfigEntry, ProviderPrefEntry 等类型
│   ├── custom.ts      自定义 provider 注册（zhipuai 等）
│   ├── discovery.ts   模型发现（OpenAI/Anthropic API 列表）
│   └── zhipuai.ts     智谱 AI provider 定义
├── prompts/
│   └── index.ts       Prompt CRUD、YAML 解析、toPromptTemplate
├── skills/
│   └── index.ts       Skill 发现、加载、安装
├── tools/
│   ├── index.ts       自定义工具注册
│   └── nmap.ts        nmap 工具定义
└── mcp/
    └── index.ts       MCP 服务配置、探测、工具缓存
```

### ConfigManager 关键方法

| 领域     | 方法                                         | 说明                                     |
| -------- | -------------------------------------------- | ---------------------------------------- |
| Auth     | setApiKey, removeApiKey, listApiKeys         | API 密钥管理                             |
| Provider | listProviderPrefs, addProviderPref           | Provider 偏好配置                        |
| Models   | listModelPrefs, addModelPref, testModel      | 模型偏好（用户选择的模型）               |
| Prompts  | listPrompts, savePrompt, removePrompt        | Prompt CRUD                              |
| Skills   | listSkills, removeSkill                      | Skill 管理                               |
| Tools    | resolveTools, allTools                       | 工具解析（registeredTools Map）          |
| MCP      | listMcpServers, addMcpServer, probeMcpServer | MCP 服务管理                             |
| Session  | resolvePromptSession                         | 从 Prompt 组装 CreateAgentSessionOptions |

## @tch/ui-web 结构

### Server（Bun.serve）

REST API 路由全部定义在 `server.ts` 的 `routes` 对象中：

```
/api/config/api-keys        GET/POST/DELETE
/api/config/providers        GET/POST/DELETE/PATCH
/api/config/models           GET
/api/config/model-prefs      GET/POST/DELETE
/api/config/provider-models  GET/POST/DELETE
/api/config/built-in/*       GET（内置 provider/model 列表）
/api/config/skills           GET/DELETE
/api/config/skills/:name/content  GET（读取 SKILL.md）
/api/config/prompts          GET/POST/DELETE
/api/config/mcp              GET/POST/DELETE/PATCH
/api/config/test-model       POST
```

### Frontend

- 入口：`index.html` → `main.tsx` → `app.tsx`
- 路由：Hash 路由（`#/config/models` 等）
- 组件目录：
    - `components/ui/` — 19 个基础组件（Button, Dialog, Table 等），CVA + Tailwind
    - `components/config/` — 配置页面组件（每个配置领域一个文件）
- API 客户端：`lib/api.ts`（typed fetch 封装 + 各领域 CRUD 方法）
- 数据获取：`hooks/use-fetch.ts`（useFetch 通用 hook）

## 数据流

```
用户操作 → React 组件 → api.ts (fetch) → Bun.serve 路由
  → ConfigManager 方法 → 文件系统 (~/.tch-agent/config/)
  → 返回 JSON → React 状态更新 → UI 渲染
```

## Prompt → Agent Session 流程

```
PromptFile (YAML+MD)
  → resolvePromptSession(promptId)
    → 解析 model-pref → ModelRegistry.find() → Model<Api>
    → 解析 tools → resolveTools() → ToolDefinition[]
    → 解析 skills → skillsOverride filter
    → DefaultResourceLoader(systemPrompt, promptsOverride, skillsOverride)
    → CreateAgentSessionOptions { model, thinkingLevel, customTools, resourceLoader, authStorage, modelRegistry }
```
