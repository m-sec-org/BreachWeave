# pentest 分支相对 main 的新增功能

> 对比基线：`main`（`ceac953`）
>
> 对比范围：当前 `pentest` 分支工作树，包括已提交修改和本地未提交修改。
>
> 本文只归纳新增或明显增强的能力，不逐项列出纯重构、测试调整和文件删除。

## 差异概览

- 已跟踪文件共修改 115 个，约新增 10,638 行、删除 8,436 行。
- 产品从单纯的 CTF Agent 工作台扩展为围绕项目、资产、Planner、Solver、Observer、知识共享和报告交付的一体化渗透测试协作平台。
- 产品名称及主要界面文案已统一更新为 `BreachWeave`。

## 1. 用户认证与访问控制

- Web 端新增注册、登录、登录态校验和退出登录流程。
- 新增基于 JWT 的 API 鉴权，普通 API 使用 Bearer Token，SSE 连接支持携带访问令牌。
- 用户密码使用 Bun 提供的 Argon2id 能力进行哈希存储，不保存明文密码。
- 用户名执行不区分大小写的重复校验。
- 登录令牌默认有效期为 7 天。
- 用户与认证配置保存在本地主机配置目录：
  - `~/.tch-agent/config/users.json`
  - Host 配置中的注册开关和 JWT Secret
- Host 配置新增是否允许开放注册的控制项。
- 新增管理员创建用户命令：

  ```bash
  bun run create-user <username> [password]
  ```

  同时支持：

  - `--config-dir <path>` 指定配置目录。
  - `TCH_USER_PASSWORD` 环境变量传入密码。

## 2. 本地项目与资产管理

- 项目管理统一为本地模式，不再依赖远程 Challenge API。
- Web 端可以直接创建项目，并配置：
  - 项目名称和描述。
  - URL 资产。
  - IP/主机资产。
  - 项目专属 Planner Prompt。
  - 是否启用自动 Planner。
- 每个资产拥有稳定的 MD5 `asset_hash` 和独立的 `scanned` 状态。
- 项目完成状态改为由全部资产是否扫描完成决定。
- 项目列表按创建时间倒序展示。
- 项目 ID 增加路径安全校验，防止非法路径访问。
- 删除项目时会：
  - 停止并移除关联 Solver。
  - 将项目目录归档至 `~/.tch-agent/archive_challenge`，而非直接永久删除。
- 项目详情新增资产扫描进度、待扫描/已扫描状态和整体完成率。
- 支持手动更新资产扫描状态。
- 支持将项目下的 Solver Session 打包导出为 ZIP。

## 3. 自动化 Planner 调度

- Planner 从一次性执行改为持续的待扫描资产调度循环。
- Planner 会定期读取项目状态，为尚未扫描的资产规划任务并启动 Solver。
- 支持一个规划轮次同时启动多个 Solver。
- 新增以下可配置参数：
  - 单项目最大 Solver 数，默认 7。
  - 全局同时活跃项目上限，默认 3。
  - Planner 调度间隔，默认 30 秒。
  - Solver 过期超时，默认 60 分钟。
  - Docker 网络模式。
  - Planner 模型与系统 Prompt。
- 每个项目可独立启用或停用 Planner，并可单独维护 Planner Prompt。
- Planner 状态细分为 `starting`、`running`、`stop` 和 `disabled`。
- Planner 会综合以下上下文进行下一轮规划：
  - 当前资产及扫描状态。
  - 可用 Solver Prompt。
  - 上一轮规划结果。
  - 项目共享 Memory、Idea 和 Report。
  - Solver 运行状态、耗时和 Token 数据。
- 启动 Planner 的 API 改为后台启动并立即返回，避免长时间阻塞请求。

## 4. 报告交付工作流

- 原有“提交 Flag”流程替换为“提交渗透测试报告”流程。
- Solver 提交报告时必须关联 `asset_hash`，确保结果归属到具体资产。
- 报告会记录 Solver、Prompt、模型和提交时间等元数据。
- 报告提交成功后会自动将对应资产标记为已扫描。
- 当所有资产均已扫描时，项目自动进入完成状态。
- 新增 `CHALLENGE_REPORT.md`，向 Solver 注入统一的报告要求和交付协议。
- 即使没有发现有效漏洞，Solver 也可以提交包含验证过程、失败边界和无发现结论的报告，避免资产长期停留在未完成状态。
- Web 端支持：
  - 报告列表查看。
  - Markdown 报告预览与展开阅读。
  - 单份报告下载。
- Hint 获取结果会缓存，并实时广播给项目中仍在运行的 Solver。

## 5. 项目级 Memory 与 Idea 协作

- 在原有 Solver 本地记录之外，新增项目级共享知识层：
  - Challenge Memory：共享事实、证据和关键结论。
  - Challenge Idea：共享假设、攻击方向和待验证思路。
- Solver 和 Observer 的工具会同时展示本地层与项目共享层。
- Solver 新增 `publish_to_challenge` 选项，可在记录本地 Memory/Idea 时同步发布到项目共享层。
- 项目共享 Memory/Idea 的新增或更新会实时通知其他活跃 Solver。
- 新启动的 Solver 会自动载入现有项目 Memory 和 Idea，减少重复侦察。
- Web 项目详情支持 Memory 和 Idea 的新增、编辑、删除与状态维护。
- Observer 在识别到 Solver 停滞但已有可交付证据时，可以提醒其及时提交报告。

## 6. Attack Flow 多视图可视化

- Attack Flow 页面扩展为四种互补视图：
  1. 攻击活动（Attack Path）：攻击事件与阶段进展。
  2. Memory Path：Memory/Idea 的形成、更新与关联过程。
  3. Solver-Agent Collaboration：Solver、Observer、共享知识板和报告之间的协作关系。
  4. Aggregate View：将多个视图组合在同一工作台内。
- 时间线统一聚合以下事件：
  - Solver 启动与结束。
  - Agent 消息。
  - Tool Call 与 Tool Result。
  - Memory/Idea 新增和更新。
  - 报告提交。
  - Observer 提醒。
- 支持实时 SSE 更新，无需刷新页面即可观察 Solver 活动。
- 新增时间线回放能力：
  - 播放、暂停。
  - 上一步、下一步。
  - 播放速度调整。
  - 循环播放。
- 支持键盘快捷键切换视图及控制回放。
- 支持全屏演示模式。
- 支持通过 BroadcastChannel 在多个浏览器窗口间同步视图状态。
- 面板支持拖拽、缩放和布局调整，Aggregate View 提供可调整的聚合布局。
- 点击 Solver 可打开独立的运行时间线详情。
- 新增事件详情和知识节点详情弹窗。
- 当项目目标达成时显示完成态视觉反馈。

## 7. Solver 协作图与知识演进图

- 协作图以项目为中心展示 Solver、Observer、共享知识板与报告提交之间的关系。
- Solver 节点展示当前关注目标、最新事件、活动强度和近期动作摘要。
- 知识图按时间重建 Memory 和 Idea 的产生、修改、关闭及删除历史。
- 回放到历史时刻时，可以看到当时有效的知识状态，而不仅是当前最终状态。
- 已删除或已关闭的历史节点会保留为弱化显示，便于复盘决策过程。

## 8. 项目统计与执行概览

- 项目统计扩展为：
  - Solver 数量。
  - Attempt 和 Report 数量。
  - 首次尝试时间与首次报告时间。
  - 报告产出耗时。
  - Solver 活跃时长。
  - 输入、输出、缓存、推理及总 Token 用量。
  - 资产总数、已扫描数、待扫描数和完成率。
  - 按模型和 Prompt 聚合的效果数据。
- Web 端新增统计弹窗与图表，用于比较不同模型和 Prompt 的效率及产出。
- 新增执行总览时间线，以 Agent 泳道展示普通执行、派生 Solver、Memory、Idea 和 Report 等片段。
- Solver 卡片新增近期事件、活动区间和事件类型计数。

## 9. Web 体验与界面能力

- 新增浅色、深色和跟随系统三种主题模式。
- 主题选择保存在浏览器本地，并响应系统主题变化。
- Attack Flow 使用独立主题 Token，增强大屏展示的一致性。
- 引入 i18n 基础设施与中英文文本资源；当前界面默认使用中文。
- 新增 Toast 通知和 Checkbox 基础组件。
- 新增全局 UI Error Boundary，避免单个组件异常导致整个应用白屏。
- 优化 ResizeObserver 异常处理，降低图表和可视化布局变化引发的前端错误。
- 从项目页进入 Solver 后，支持返回原项目上下文。
- Runtime 列表不再提供脱离项目的临时 Solver 启动入口，Solver 生命周期统一由项目和 Planner 管理。

## 10. 构建、安装与本地开发

- 构建脚本新增本地 Workspace 包解析，优先使用当前仓库中的：
  - `@tch/core`
  - `@tch/ui-web`
  - `@tch/ui-tui`
  - `pi-mcp-adapter`

  避免构建时错误加载 `node_modules` 中的旧版本包。
- 保留内置资源生成文件机制，使 Skill、Prompt 等资源可以在构建前动态配置并重新生成。
- Linux Solver 二进制改为构建时生成并通过虚拟模块嵌入，不再要求源码树中长期存在平台二进制占位文件。
- 安装脚本支持透传 CLI 参数，并增加相应测试。
- Bun Workspace 改用 hoisted linker，补充各核心包的 exports 配置。
- README 增加带子模块克隆、安装、启动和创建用户说明。
- 内置渗透测试 Skill、Planner Prompt 和 Solver 报告 Prompt 得到更新。

## 主要使用入口

| 能力 | 入口 |
| --- | --- |
| 启动 Web | `bun run web` |
| 创建用户 | `bun run create-user <username> [password]` |
| 创建项目 | Web → 项目列表 → 新建项目 |
| 配置 Planner | Web → 项目详情 / Host Planner 配置 |
| 查看实时攻击过程 | Web → 项目详情 → Attack Flow |
| 查看报告 | Web → 项目详情 → Reports |
| 导出 Solver Session | Web → 项目详情 → 导出 ZIP |
| 运行测试 | `bun test` |
| 类型检查 | `bun run typecheck` |
