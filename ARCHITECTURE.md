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

### Solver 分工审核与释放

Solver 的正式报告只声明分工结果，不授予结束权限。`challenge_submit_report` 的所有资产和测试项齐全后，Solver 暂停工具、清空协作消息队列并拒收普通同步；周期 Observer 开关不影响最终审核。

最终 Observer 读取宿主保存的原始任务、当前报告和完整工具历史，对每个资产/测试项提交 `verified`、`blocked`、`missing` 或 `unsupported`，并列明疑点和遗留待办。审查记录绑定确切的 submission IDs，保存到 challenge 的 `solver-reviews/`。普通自然语言总结不能代替结构化审核；失败或超时保持待审，每 10 秒重试。

Planner 优先处理这些审查，不受空闲槽位或资产认领状态限制。通过 `planner_decide_solver` 决定：

- `continue`：给原 Solver 发送专属 `resume_assignment` 整改指令，解锁原分工，修订报告后重新审核。
- `stop`：仅对证据充分的正常完成或真实阻塞分工停止容器。遗漏、无证据结论和未解决疑点不能直接通过。

资产关闭另行要求测试项具有 Observer 验证证据且相关分工已通过 Planner 停止决定。Runtime 对容器停止和进程 EOF 发出独立状态通知，Web 通过 SSE 更新列表和详情，及时显示 `stopped`。

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
    → CreateAgentSessionOptions { model, thinkingLevel, customTools, resourceLoader, modelRuntime }
```
