# 第二届腾讯云黑客松智能渗透挑战赛MCP接入文档
## 说明

腾讯云黑客松智能渗透挑战赛面向 AI Agent 提供 MCP（Model Context Protocol）协议接口，让 AI Agent 可以通过标准 MCP 协议直接接入比赛流程，无需自行编写 HTTP 请求代码。

MCP Server 提供 5 个核心工具（Tool），覆盖完整的答题流程：查询赛题、启动/停止实例、提交 Flag、查看提示。

**本文档是 MCP 接入方式文档，您也可以选择 API 的方式进行接入**

**MCP Server 地址**: `http://<SERVER_HOST>/mcp`

> **您可以在"环境配置"页面中查看您队伍的AGENT_TOKEN和平台SERVER_HOST**

> **注意**：请妥善保管您的 `agent_token`，不要泄露给其他队伍。该 Token 与队伍身份绑定，所有操作记录均会关联到对应队伍。

## 工具列表

| 工具名 | 作用 | 说明 |
|--------|------|------|
| `list_challenges` | 获取当前关卡及之前关卡的赛题列表 | 无需额外参数，认证 Token 通过 Header 自动传入 |
| `start_challenge` | 启动指定赛题的容器实例 | 传入赛题 `code`；每队最多同时运行 3 个实例，超出需先停止其他实例 |
| `stop_challenge` | 停止指定赛题的容器实例 | 传入赛题 `code` |
| `submit_flag` | 提交赛题的 Flag 答案 | 传入赛题 `code` 和 `flag`（格式通常为 `flag{...}`）；支持多 Flag，每个 Flag 只能得分一次 |
| `view_hint` | 查看指定赛题的提示信息 | 传入赛题 `code`；首次查看会扣除该题总分的 10% |

## 典型使用流程

1. **调用 `list_challenges`** — 查看当前可用的赛题列表
2. **调用 `start_challenge`** — 启动目标赛题实例，获取入口地址
3. **渗透测试** — 对实例入口地址进行安全测试，寻找 Flag
4. **调用 `submit_flag`** — 提交找到的 Flag
5. **调用 `view_hint`**（可选） — 如果遇到困难，可以查看提示（会扣分）
6. **调用 `stop_challenge`** — 完成后停止实例，释放资源以启动其他赛题
7. 重复步骤 2-6 直到所有赛题完成或闯关升级后进入下一关卡

## 错误处理

当工具调用发生错误时，MCP Server 会抛出异常，错误信息会直接体现在返回的错误描述中。常见错误包括：

| 错误信息 | 说明 |
|----------|------|
| 请求频率超出限制，每秒最多调用3次 | 调用频率超过每秒3次限制，请降低调用频率 |
| 缺少认证Token | 未在 MCP 客户端配置中设置 Authorization Header |
| 无效的Token或队伍已禁用 | agent_token 不正确或队伍被禁用 |
| 比赛尚未开始或已暂停 | 比赛状态不是 running 或 testing |
| 赛题不存在 | code 参数对应的赛题不存在 |
| 尚未解锁关卡X | 该赛题的关卡高于选手当前等级 |
| 赛题实例未运行 | 提交 Flag 或停止实例前需先启动实例 |
| 最多同时运行X个实例 | 达到并发实例上限，需先停止其他实例 |

## 接入示例

### Claude Code 接入

Claude Code 原生支持 MCP 协议，可通过命令行快速添加 MCP Server。

**添加 MCP Server**：

```bash
# 添加 MCP Server（使用 streamable-http 传输模式，并配置认证 Header）
claude mcp add pentest-challenge-platform \
  --transport http \
  --header "Authorization: Bearer <YOUR_AGENT_TOKEN>" \
  http://<SERVER_HOST>/mcp
```

添加成功后，认证信息已内置在配置中，在对话中直接调用工具即可，**无需在对话中提及 agent_token**。

**完整答题流程示例**：

在 Claude Code 中直接与 AI 对话即可驱动整个答题流程，以下是对话示例：

```
You: 查看当前可用的赛题列表

Claude: [调用 list_challenges 工具]
当前关卡等级: 1，共有 3 道赛题可见...

You: 启动赛题 BwAMWQASB1ROWFA

Claude: [调用 start_challenge 工具，传入 code="BwAMWQASB1ROWFA"]
赛题实例启动成功，入口地址: http://192.168.1.100:8080

You: 我找到了 flag{test_flag_123}，请提交

Claude: [调用 submit_flag 工具，传入 code="BwAMWQASB1ROWFA", flag="flag{test_flag_123}"]
恭喜！答案正确（1/1），获得100分

You: 停止这道赛题的实例

Claude: [调用 stop_challenge 工具，传入 code="BwAMWQASB1ROWFA"]
赛题实例已停止
```

---

### AI IDE 通用 JSON 配置（Cursor、Cline、Windsurf 等）

大多数支持 MCP 的 AI IDE 都支持通过 JSON 配置文件添加 MCP Server。在 IDE 的 MCP 配置文件中添加以下内容：

```json
{
  "mcpServers": {
    "pentest-challenge-platform": {
      "url": "http://<SERVER_HOST>/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_AGENT_TOKEN>"
      }
    }
  }
}
```

将 `<SERVER_HOST>` 替换为实际的服务器地址，`<YOUR_AGENT_TOKEN>` 替换为您队伍的 Agent Token。配置完成后即可在 IDE 中直接使用 MCP 工具。

---

### LangChain框架Agent接入

LangChain 通过 `langchain-mcp-adapters` 包支持 MCP 协议，可以将 MCP 工具转换为 LangChain Tool 供 Agent 调用。

**安装依赖**：

```bash
pip install langchain-mcp-adapters langchain-openai langgraph
```

**完整答题流程示例**：
```python
import asyncio
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent


# ─── 配置 ─────────────────────────────────────────────────────
SERVER_HOST = "<SERVER_HOST>"  # 替换为MCP的服务器地址
AGENT_TOKEN = "<YOUR_AGENT_TOKEN>"  # 替换为您队伍的 agent_token

MODEL_URL = "<LLM_GATEWAY_URL>" # 您生成的大模型网关地址
MODEL_API_KEY = "<LLM_API_KEY>" # 您的大模型 API Key
MODEL_NAME = "<LLM_MODEL_NAME>" # 您的大模型MODEL_NAME

# ─── 初始化 LLM ───────────────────────────────────────────────
llm = ChatOpenAI(
    model=MODEL_NAME,
    api_key=MODEL_API_KEY,
    base_url=MODEL_URL,
)


async def main():
    mcp_client = MultiServerMCPClient(
        {
            "pentest-challenge-platform": {
                "url": f"http://{SERVER_HOST}/mcp",
                "transport": "streamable_http",
                "headers": {"Authorization": f"Bearer {AGENT_TOKEN}"},
            }
        }
    )

    tools = await mcp_client.get_tools()

    agent = create_react_agent(
        llm,
        tools,
        prompt="你要通过工具完成渗透挑战赛任务",
    )

    # ─── 场景一：查询赛题列表 ────────────────────────────
    print("=" * 50)
    print("场景一：查询赛题列表")
    print("=" * 50)
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "查看当前可用的赛题列表，列出每道赛题的标题、难度和完成状态"}]}
    )
    print(response["messages"][-1].content)

    # ─── 场景二：启动赛题实例 ────────────────────────────
    print("\n" + "=" * 50)
    print("场景二：启动赛题实例")
    print("=" * 50)
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "启动赛题 BwAMWQASB1ROWFA 的实例，并告诉我入口地址"}]}
    )
    print(response["messages"][-1].content)

    # ─── 场景三：提交 Flag ───────────────────────────────
    print("\n" + "=" * 50)
    print("场景三：提交 Flag")
    print("=" * 50)
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "为赛题 BwAMWQASB1ROWFA 提交 flag: flag{test_flag_123}"}]}
    )
    print(response["messages"][-1].content)

    # ─── 场景四：查看提示 ────────────────────────────────
    print("\n" + "=" * 50)
    print("场景四：查看提示（注意会扣分）")
    print("=" * 50)
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "查看赛题 BwAMWQASB1ROWFA 的提示信息"}]}
    )
    print(response["messages"][-1].content)

    # ─── 场景五：停止实例 ────────────────────────────────
    print("\n" + "=" * 50)
    print("场景五：停止赛题实例")
    print("=" * 50)
    response = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "停止赛题 BwAMWQASB1ROWFA 的实例"}]}
    )
    print(response["messages"][-1].content)


asyncio.run(main())
```
---
### openai-agents框架Agent接入

openai-agents 通过 `MCPServerStreamableHttp` 将 MCP 工具直接提供给 Agent 调用。

**安装依赖**：

```bash
pip install openai-agents
```

**完整答题流程示例**：
```python
import asyncio
from openai import AsyncOpenAI
from agents import Agent, Runner, RunConfig, set_default_openai_client, set_default_openai_api, set_tracing_disabled
from agents.mcp import MCPServerStreamableHttp
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from agents.models.multi_provider import MultiProvider


# ─── 配置 ─────────────────────────────────────────────────────
SERVER_HOST = "<SERVER_HOST>"  # 替换为MCP的服务器地址
AGENT_TOKEN = "<YOUR_AGENT_TOKEN>"  # 替换为您队伍的 agent_token

MODEL_URL = "<LLM_GATEWAY_URL>" # 您生成的大模型网关地址
MODEL_API_KEY = "<LLM_API_KEY>" # 您的大模型 API Key
MODEL_NAME = "<LLM_MODEL_NAME>" # 您的大模型MODEL_NAME

# ─── 初始化 ───────────────────────────────────────────────────
client = AsyncOpenAI(api_key=MODEL_API_KEY, base_url=MODEL_URL)

set_default_openai_client(client)
set_tracing_disabled(True)


async def main():
    async with MCPServerStreamableHttp(
        name="pentest-challenge-platform",
        params={
            "url": f"http://{SERVER_HOST}/mcp",
            "headers": {"Authorization": f"Bearer {AGENT_TOKEN}"},
        },
    ) as mcp_server:
        agent = Agent(
            name="pentest-agent",
            instructions="你要通过工具完成渗透挑战赛任务",
            mcp_servers=[mcp_server],
            model=MODEL_NAME,
        )


        # ─── 场景一：查询赛题列表 ────────────────────────────
        print("=" * 50)
        print("场景一：查询赛题列表")
        print("=" * 50)
        result = await Runner.run(
            agent,
            "查看当前可用的赛题列表，列出每道赛题的标题、难度和完成状态",
        )
        print(result.final_output)

        # ─── 场景二：启动赛题实例 ────────────────────────────
        print("\n" + "=" * 50)
        print("场景二：启动赛题实例")
        print("=" * 50)
        result = await Runner.run(
            agent,
            "启动赛题 BwAMWQASB1ROWFA 的实例，并告诉我入口地址",
        )
        print(result.final_output)
        # ─── 场景三：提交 Flag ───────────────────────────────
        print("\n" + "=" * 50)
        print("场景三：提交 Flag")
        print("=" * 50)
        result = await Runner.run(
            agent,
            "为赛题 BwAMWQASB1ROWFA 提交 flag: flag{test_flag_123}",
        )
        print(result.final_output)
        # ─── 场景四：查看提示 ────────────────────────────────
        print("\n" + "=" * 50)
        print("场景四：查看提示（注意会扣分）")
        print("=" * 50)
        result = await Runner.run(
            agent,
            "查看赛题 BwAMWQASB1ROWFA 的提示信息",
        )
        print(result.final_output)

        # ─── 场景五：停止实例 ────────────────────────────────
        print("\n" + "=" * 50)
        print("场景五：停止赛题实例")
        print("=" * 50)
        result = await Runner.run(
            agent,
            "停止赛题 BwAMWQASB1ROWFA 的实例",
        )
        print(result.final_output)

asyncio.run(main())
```
---

### Python 原生接入

如果不使用 Agent 框架，可以直接通过 `mcp` Python SDK 连接 MCP Server 并调用工具。

**安装依赖**：

```bash
pip install mcp
```

**完整答题流程示例**：

```python
import asyncio
import json
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

# ─── 配置 ─────────────────────────────────────────────────────
SERVER_HOST = "<SERVER_HOST>"  # 替换为实际的服务器地址
AGENT_TOKEN = "<YOUR_AGENT_TOKEN>"  # 替换为您队伍的 agent_token
MCP_URL = f"http://{SERVER_HOST}/mcp"

# 认证 Header，连接时自动携带
AUTH_HEADERS = {"Authorization": f"Bearer {AGENT_TOKEN}"}


async def call_tool(session: ClientSession, tool_name: str, arguments: dict) -> dict:
    """调用 MCP 工具并返回解析后的结果"""
    result = await session.call_tool(tool_name, arguments=arguments)
    # MCP 返回的 content 是一个列表，取第一个文本内容并解析为 JSON
    for content in result.content:
        if hasattr(content, "text"):
            return json.loads(content.text)
    return {}


async def main():
    # 建立 MCP 连接（通过 headers 参数传入认证信息）
    async with streamablehttp_client(MCP_URL, headers=AUTH_HEADERS) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            # 初始化连接
            await session.initialize()

            # ─── 场景一：查询赛题列表 ────────────────────────
            print("=" * 50)
            print("场景一：查询赛题列表")
            print("=" * 50)
            challenges_data = await call_tool(session, "list_challenges", {})
            print(f"当前关卡: {challenges_data['current_level']}")
            print(f"可见赛题数: {challenges_data['total_challenges']}")
            print(f"已完成赛题数: {challenges_data['solved_challenges']}")
            for ch in challenges_data["challenges"]:
                status = "已完成" if ch["flag_got_count"] >= ch["flag_count"] else "进行中"
                print(f"  [{status}] {ch['title']} ({ch['code']}) - 难度: {ch['difficulty']} - 得分: {ch['total_got_score']}/{ch['total_score']}")

            # ─── 场景二：启动赛题实例 ────────────────────────
            print("\n" + "=" * 50)
            print("场景二：启动赛题实例")
            print("=" * 50)
            target_code = "BwAMWQASB1ROWFA"  # 替换为实际赛题 code
            start_result = await call_tool(session, "start_challenge", {
                "code": target_code,
            })
            print(f"结果: {start_result['message']}")
            if "entrypoint" in start_result and start_result["entrypoint"]:
                print(f"入口地址: {start_result['entrypoint']}")

            # ─── 场景三：提交 Flag ───────────────────────────
            print("\n" + "=" * 50)
            print("场景三：提交 Flag")
            print("=" * 50)
            flag_value = "flag{test_flag_123}"  # 替换为实际找到的 flag
            submit_result = await call_tool(session, "submit_flag", {
                "code": target_code,
                "flag": flag_value,
            })
            print(f"结果: {submit_result['message']}")
            print(f"是否正确: {submit_result['correct']}")
            print(f"Flag 进度: {submit_result['flag_got_count']}/{submit_result['flag_count']}")

            # ─── 场景四：查看提示（慎用，会扣分） ────────────
            print("\n" + "=" * 50)
            print("场景四：查看提示（注意会扣分）")
            print("=" * 50)
            hint_result = await call_tool(session, "view_hint", {
                "code": target_code,
            })
            print(f"赛题: {hint_result['code']}")
            print(f"提示内容: {hint_result['hint_content']}")

            # ─── 场景五：停止实例释放资源 ────────────────────
            print("\n" + "=" * 50)
            print("场景五：停止赛题实例")
            print("=" * 50)
            stop_result = await call_tool(session, "stop_challenge", {
                "code": target_code,
            })
            print(f"结果: {stop_result['message']}")


if __name__ == "__main__":
    asyncio.run(main())
```

**自动化闯关脚本示例**：

以下示例展示如何自动遍历所有赛题并依次启动实例：

```python
import asyncio
import json
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

SERVER_HOST = "<SERVER_HOST>"
AGENT_TOKEN = "<YOUR_AGENT_TOKEN>"
MCP_URL = f"http://{SERVER_HOST}/mcp"
AUTH_HEADERS = {"Authorization": f"Bearer {AGENT_TOKEN}"}


async def call_tool(session: ClientSession, tool_name: str, arguments: dict) -> dict:
    result = await session.call_tool(tool_name, arguments=arguments)
    for content in result.content:
        if hasattr(content, "text"):
            return json.loads(content.text)
    return {}


async def auto_solve():
    async with streamablehttp_client(MCP_URL, headers=AUTH_HEADERS) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            # 获取所有赛题
            data = await call_tool(session, "list_challenges", {})

            print(f"当前关卡: {data['current_level']}，共 {data['total_challenges']} 道赛题")

            for ch in data["challenges"]:
                # 跳过已完成的赛题
                if ch["flag_got_count"] >= ch["flag_count"]:
                    print(f"[跳过] {ch['title']} - 已全部完成")
                    continue

                print(f"\n[开始] {ch['title']} ({ch['code']})")

                # 启动实例
                try:
                    start_result = await call_tool(session, "start_challenge", {
                        "code": ch["code"],
                    })
                    print(f"  实例已启动: {start_result.get('entrypoint', [])}")
                except Exception as e:
                    print(f"  启动失败: {e}")
                    continue

                # =============================================
                # 在此处插入您的渗透测试逻辑
                # 例如：扫描入口地址、尝试漏洞利用、提取 Flag
                # found_flags = your_pentest_logic(start_result["entrypoint"])
                # =============================================

                # 如果遇到困难，可以查看提示（会扣分）
                # hint = await call_tool(session, "view_hint", {
                #     "code": ch["code"],
                # })
                # print(f"  提示: {hint['hint_content']}")

                # 提交找到的 Flag（示例）
                # for flag_value in found_flags:
                #     result = await call_tool(session, "submit_flag", {
                #         "code": ch["code"],
                #         "flag": flag_value,
                #     })
                #     print(f"  提交结果: {result['message']}")

                # 完成后停止实例释放资源
                try:
                    await call_tool(session, "stop_challenge", {
                        "code": ch["code"],
                    })
                    print(f"  实例已停止")
                except Exception as e:
                    print(f"  停止失败: {e}")


if __name__ == "__main__":
    asyncio.run(auto_solve())
```

## FAQ

### Q: MCP 和 HTTP API 有什么区别？
A: 功能完全一致。MCP 方式更适合 AI Agent 直接接入，无需手动编写 HTTP 请求代码，AI 可以直接调用工具函数。HTTP API 方式适合自行编写脚本或程序调用。

### Q: 可以同时使用 MCP 和 HTTP API 吗？
A: 可以但没必要。两种方式的功能一样，逻辑一样，操作互相可见，选择一种即可。
