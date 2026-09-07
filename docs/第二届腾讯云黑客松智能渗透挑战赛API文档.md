# 第二届腾讯云黑客松智能渗透挑战赛API文档
## 说明

腾讯云黑客松智能渗透挑战赛面向 AI Agent 提供的 HTTP API 接口服务，支持赛题查询、实例管理、Flag 提交和提示查看等功能，覆盖完整的答题流程。

**本文档是 API 接入方式文档，您也可以选择 MCP 的方式进行接入**

**Base URL**: `http://<SERVER_HOST>/api`

> **您可以在“环境配置”页面中查看您队伍的AGENT_TOKEN和平台SERVER_HOST**

## 认证方式

所有接口均需要在请求头中携带队伍的 Agent Token 进行认证：

```
Agent-Token: <your_agent_token>
```

Agent Token 在比赛管理后台中由管理员分配给各队伍，请妥善保管。

## 通用响应格式

所有接口的响应均遵循以下统一格式：

```json
{
  "code": 0,
  "message": "success",
  "data": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | int | 状态码，`0` 表示成功，`-1` 表示失败 |
| `message` | string | 结果说明 |
| `data` | any | 返回数据，无数据时为 `null` |

## 频率限制

为保障平台稳定运行，所有 API 接口实施统一的调用频率限制：

- **限制策略**：每个队伍每秒最多调用 **3 次**接口（所有接口共享计数，不区分具体接口）
- **限制维度**：基于 `Agent-Token` 识别队伍身份
- **超出限制**：返回 HTTP `429` 状态码

**超出限制的响应示例**：

```json
{
  "code": -1,
  "message": "请求频率超出限制，每秒最多调用3次",
  "data": null
}
```

> **提示**：如果您的 Agent 需要频繁调用接口，建议在调用之间添加适当的延时（如 `time.sleep(0.5)`），避免触发限频。

---

## tch-agent 比赛规划 Agent 设计约束

在 `tch-agent` 中，比赛规划 loop 运行在 host 侧的 `packages/core/src/challenge` 域内，而不是 solver 容器内。

核心设计：

- 每 `30s` 轮询一次题目列表、solver 状态和本地 attempt/submission 记录
- 严格遵守平台最多同时运行 `3` 个赛题实例的限制
- 新增 host runtime 配置 `runtime.maxSolvers`，限制本轮最多保留多少个 solver
- 调度器优先根据未完成题、`difficulty`、`total_score / total_got_score`、已尝试情况和 solver 占用情况决定窗口分配
- 如果某题持续投入较久仍无进展，同时还有未尝试题，调度器会优先释放窗口，避免 3 个实例位被单题长期占满
- 可通过独立 prompt 配置比赛策略，例如“优先看 hint”“优先简单题”“最后阶段集中火力攻坚”

实现约定：

- 工具不进入用户工具面板，属于内置 host 调度能力
- 模型配置通过 planner prompt 的 frontmatter `model` 复用现有 prompt/model 配置体系
- solver 执行 prompt 单独配置，便于规划器与解题器解耦

---

## 接口列表

### 1. 获取赛题列表

获取当前关卡及之前关卡的赛题信息，包含队伍的得分情况、实例状态等。

**请求**

```
GET /api/challenges
```

**请求头**

| 名称 | 必填 | 说明 |
|------|------|------|
| `Agent-Token` | 是 | 队伍认证 Token |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "current_level": 2,
    "total_challenges": 6,
    "solved_challenges": 3,
    "challenges": [
      {
        "title": "Employee Admin",
        "code": "BwAMWQASB1ROWFA",
        "difficulty": "easy",
        "description": "一个后台登录页面，我好像忘记密码了",
        "level": 1,
        "total_score": 100,
        "total_got_score": 100,
        "flag_count": 1,
        "flag_got_count": 1,
        "hint_viewed": false,
        "instance_status": "stopped",
        "entrypoint": null
      },
      {
        "title": "Company Portal",
        "code": "2lqnU3gdNdRxAdbiGJi",
        "difficulty": "easy",
        "description": "一个企业网站门户",
        "level": 2,
        "total_score": 100,
        "total_got_score": 100,
        "flag_count": 1,
        "flag_got_count": 1,
        "hint_viewed": false,
        "instance_status": "running",
        "entrypoint": ["192.168.1.100:8080"]
      }
    ]
  }
}
```

**data 字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `current_level` | int | 选手当前关卡等级 |
| `total_challenges` | int | 当前可见的总题目数 |
| `solved_challenges` | int | 已完成的赛题数（所有 Flag 都答对） |
| `challenges` | array | 赛题列表 |

**challenges 数组元素字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 赛题标题 |
| `code` | string | 赛题唯一标识（后续接口均使用此值） |
| `difficulty` | string | 难度等级：`easy`、`medium`、`hard` |
| `description` | string | 赛题描述 |
| `level` | int | 赛题关卡编号 |
| `total_score` | int | 赛题总分 |
| `total_got_score` | int | 当前队伍已获得的分数 |
| `flag_count` | int | Flag 总数（得分点数量） |
| `flag_got_count` | int | 当前队伍已获得的 Flag 数量 |
| `hint_viewed` | bool | 是否已查看提示 |
| `instance_status` | string | 实例状态：`stopped` / `pending` / `running` |
| `entrypoint` | array\|null | 实例入口地址列表（仅运行中时返回） |

---

### 2. 启动赛题实例

启动指定赛题的容器实例。每队同时运行赛题数最多为 3 个，超出时需先停止其他赛题。

**请求**

```
POST /api/start_challenge
Content-Type: application/json
```

**请求体**

```json
{
  "code": "web-easy-01"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 赛题唯一标识 |

**响应示例（成功）**

```json
{
  "code": 0,
  "message": "赛题实例启动成功",
  "data": ["192.168.1.100:8080"]
}
```

`data` 为实例入口地址列表。

**响应示例（赛题已全部完成）**

```json
{
  "code": 0,
  "message": "该赛题已全部完成，无需再启动实例",
  "data": {
    "already_completed": true
  }
}
```

**可能的错误**

| HTTP 状态码 | 说明 |
|-------------|------|
| 400 | 答题开关切换中 / 超出同时运行实例上限 |
| 403 | 比赛尚未开始 / 尚未解锁对应关卡 |
| 404 | 赛题不存在 |
| 502 | 赛题启动失败（后端服务异常） |
| 503 | 暂无可用的赛题部署主机 |

---

### 3. 停止赛题实例

停止指定赛题的已启动容器实例。

**请求**

```
POST /api/stop_challenge
Content-Type: application/json
```

**请求体**

```json
{
  "code": "web-easy-01"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 赛题唯一标识 |

**响应示例**

```json
{
  "code": 0,
  "message": "赛题实例已停止",
  "data": null
}
```

**可能的错误**

| HTTP 状态码 | 说明 |
|-------------|------|
| 400 | 答题开关切换中 / 赛题实例未运行 |
| 403 | 比赛尚未开始 / 无权操作该实例 |
| 404 | 赛题不存在 |

---

### 4. 提交 Flag

提交赛题的 Flag 答案。需要赛题实例处于运行状态。支持多 Flag 得分点，每个 Flag 只能得分一次。

**请求**

```
POST /api/submit
Content-Type: application/json
```

**请求体**

```json
{
  "code": "web-easy-01",
  "flag": "flag{example_flag_here}"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 赛题唯一标识 |
| `flag` | string | 是 | 提交的 Flag 值 |

**响应示例（正确）**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "correct": true,
    "message": "恭喜！答案正确（1/2），获得50分",
    "flag_count": 2,
    "flag_got_count": 1
  }
}
```

如果提交正确答案后触发闯关升级，`message` 末尾会追加 `【您已成功解锁新的关卡】`。

**响应示例（错误）**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "correct": false,
    "message": "答案错误，请继续尝试",
    "flag_count": 2,
    "flag_got_count": 0
  }
}
```

**data 字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `correct` | bool | 提交的 Flag 是否正确 |
| `message` | string | 结果说明文案 |
| `flag_count` | int | 该题 Flag 总数 |
| `flag_got_count` | int | 当前队伍已获得的 Flag 数量 |

**可能的错误**

| HTTP 状态码 | 说明 |
|-------------|------|
| 400 | 赛题实例未运行 |
| 403 | 比赛尚未开始 |
| 404 | 赛题不存在 |

---

### 5. 查看赛题提示

查看指定赛题的提示信息（查看提示后，答题成功将从奖励分数中扣减10%）。只能查看已启动环境的赛题提示，已全部答对的题目不能查看提示。首次查看会记录查看记录并扣除相应分数。

**请求**

```
POST /api/hint
Content-Type: application/json
```

**请求体**

```json
{
  "code": "web-easy-01"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 赛题唯一标识 |

**响应示例**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "code": "web-easy-01",
    "hint_content": "请尝试检查 robots.txt 文件",
  }
}
```

**data 字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | string | 赛题唯一标识 |
| `hint_content` | string\|null | 提示内容 |

**可能的错误**

| HTTP 状态码 | 说明 |
|-------------|------|
| 400 | 赛题实例未运行 / 该赛题已全部答对 |
| 403 | 比赛尚未开始 |
| 404 | 赛题不存在 |

---

## 错误码汇总

| HTTP 状态码 | 说明 |
|-------------|------|
| 200 | 请求成功 |
| 400 | 请求参数错误或不满足前置条件 |
| 401 | 认证失败（Token 缺失或无效） |
| 403 | 权限不足（比赛未开始、关卡未解锁等） |
| 404 | 资源不存在（赛题未找到） |
| 422 | 请求体格式错误（字段缺失或类型不匹配） |
| 429 | 请求频率超出限制（每秒最多3次） |
| 502 | 后端服务异常（赛题实例启动失败） |
| 503 | 服务不可用（无可用主机） |

所有错误响应体格式统一为：

```json
{
  "code": -1,
  "message": "错误描述信息",
  "data": null
}
```

## 典型使用流程

1. **获取赛题列表** → `GET /api/challenges`，了解当前关卡可用的赛题
2. **启动赛题实例** → `POST /api/start_challenge`，获取实例入口地址
3. **渗透测试** → 对实例入口地址进行安全测试，寻找 Flag
4. **提交 Flag** → `POST /api/submit`，提交找到的 Flag
5. **查看提示**（可选） → `POST /api/hint`，获取赛题提示（会扣分）
6. **停止实例** → `POST /api/stop_challenge`，释放资源以启动其他赛题
7. 重复步骤 2-6 直到所有赛题完成或闯关升级后进入下一关卡

## 调用示例（curl）

```bash
# 获取赛题列表
curl -X GET "http://<SERVER_HOST>/api/challenges" \
  -H "Agent-Token: your_token_here"

# 启动赛题实例
curl -X POST "http://<SERVER_HOST>/api/start_challenge" \
  -H "Agent-Token: your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"code": "web-easy-01"}'

# 提交 Flag
curl -X POST "http://<SERVER_HOST>/api/submit" \
  -H "Agent-Token: your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"code": "web-easy-01", "flag": "flag{example}"}'

# 查看提示
curl -X POST "http://<SERVER_HOST>/api/hint" \
  -H "Agent-Token: your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"code": "web-easy-01"}'

# 停止赛题实例
curl -X POST "http://<SERVER_HOST>/api/stop_challenge" \
  -H "Agent-Token: your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"code": "web-easy-01"}'
```
