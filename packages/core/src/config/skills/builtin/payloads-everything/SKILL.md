---
name: payloads-all-the-things
description: Browse the bundled PayloadsAllTheThings corpus for CTF and web security payloads, bypasses, fuzz strings, exploit ideas, and methodology notes. Use when Agent needs to locate payloads by vulnerability category during CTFs, pentests, or challenge solving, then drill into the relevant README.md and markdown files under references/ instead of loading the whole corpus at once.
---

# PayloadsAllTheThings Local Navigator

把 `references/` 当作本地只读 payload 知识库。

按下面的顺序工作，不要一次性读取整个语料库：

1. 先看一级目录，按漏洞类型缩小范围。
2. 进入目标目录后先读该目录的 `README.md`，它通常会概述这个类目的 payload、利用技巧、绕过思路、工具和实验环境。
3. 再查看同级的具体 `*.md`、`Intruder/`、`Images/`、`Configuration*`、`CVE*` 或其他子目录。
4. 只在当前类目内使用 `rg -n` 搜关键词，避免全仓库大范围搜索。
5. 输出 payload 或技巧时，带上来源路径，便于继续深入。

优先使用这些命令：

```bash
find references -maxdepth 1 -mindepth 1 -type d -exec basename {} \; | sort
sed -n '1,200p' 'references/SQL Injection/README.md'
find 'references/SQL Injection' -maxdepth 1 \( -type f -o -type d \) | sort
rg -n 'union|time based|auth bypass' 'references/SQL Injection'
sed -n '1,200p' 'references/Server Side Request Forgery/README.md'
rg -n 'gopher|metadata|redirect|localhost' 'references/Server Side Request Forgery'
find 'references/Upload Insecure Files' -maxdepth 1 \( -type f -o -type d \) | sort
```

按目录导航时遵循这些约束：

- 先读 `README.md`，再决定是否继续读某个具体子文件。
- 目录名已经是最重要的索引，不要跳过目录发现直接盲搜全文。
- 不明确属于哪个漏洞类型时，先看 `references/Methodology and Resources`。
- 存在多个相近类目时，优先读取最接近的两个类目的 `README.md` 做比较，再决定深入哪个目录。

当前一级分类如下：

```text
API Key Leaks
Account Takeover
Brute Force Rate Limit
Business Logic Errors
CORS Misconfiguration
CRLF Injection
CSS Injection
CSV Injection
CVE Exploits
Clickjacking
Client Side Path Traversal
Command Injection
Cross-Site Request Forgery
DNS Rebinding
DOM Clobbering
Denial of Service
Dependency Confusion
Directory Traversal
Encoding Transformations
External Variable Modification
File Inclusion
Google Web Toolkit
GraphQL Injection
HTTP Parameter Pollution
Headless Browser
Hidden Parameters
Insecure Deserialization
Insecure Direct Object References
Insecure Management Interface
Insecure Randomness
Insecure Source Code Management
JSON Web Token
Java RMI
LDAP Injection
LaTeX Injection
Mass Assignment
Methodology and Resources
NoSQL Injection
OAuth Misconfiguration
ORM Leak
Open Redirect
Prompt Injection
Prototype Pollution
Race Condition
Regular Expression
Request Smuggling
Reverse Proxy Misconfigurations
SAML Injection
SQL Injection
Server Side Include Injection
Server Side Request Forgery
Server Side Template Injection
Tabnabbing
Type Juggling
Upload Insecure Files
Virtual Hosts
Web Cache Deception
Web Sockets
XPATH Injection
XS-Leak
XSLT Injection
XSS Injection
XXE Injection
Zip Slip
```
