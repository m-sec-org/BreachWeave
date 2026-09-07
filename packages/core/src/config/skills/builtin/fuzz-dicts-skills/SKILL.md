---
name: fuzz-dicts-navigator
description: Navigate the fuzzDicts repository and choose the right dictionary or payload list for authorized Web directory scanning, parameter fuzzing, upload bypass testing, subdomain enumeration, API discovery, credential spraying, and vuln-specific fuzzing. Use this skill whenever the user asks which wordlist to use, wants to browse or classify fuzz dictionaries, needs ffuf/wfuzz/feroxbuster/dirsearch/gobuster-ready file paths, or mentions this repository even if they do not explicitly ask for a skill.
---

# Fuzz Dicts Navigator

Use this skill to turn the `fuzzDicts` repository into a practical navigation layer.

The repository already contains many useful dictionaries, but the folder names alone do not help much during a live test. Your job is to quickly map the user's task to the smallest useful set of files, explain why those files fit, and give tool-ready examples.

This skill is for authorized security testing, internal validation, lab work, and CTF-style practice. If the user's context is unclear, keep guidance focused on defensive or authorized use.

## What to do

1. Identify the user's scenario.
2. Map it to one of the dictionary families in `references/navigation.md`.
3. Recommend one primary file and up to two fallbacks.
4. Prefer narrower dictionaries before huge catch-all lists when the stack is known.
5. Give command examples that the user can paste into common fuzzing tools.

## Scenario routing

Route the request into one of these buckets before recommending anything:

- Directory or content discovery
- Parameter discovery
- File upload bypass or extension fuzzing
- Username or password guessing for authorized testing
- Subdomain enumeration
- API path discovery
- JavaScript file discovery
- Vulnerability-specific payload selection: XSS, SQLi, SSRF, LFI, XXE, RCE
- CTF-only path fuzzing

If the user mixes goals, split the answer into phases. Example: first directory scan, then parameter fuzz, then upload bypass.

## Selection rules

- When the tech stack is known, choose the matching stack-specific dictionary first.
- When the stack is unknown, start with a balanced general dictionary rather than the biggest file.
- Only escalate to very large lists when the first pass is exhausted or the user explicitly wants breadth.
- If the user asks for speed, bias toward smaller curated lists.
- If the user asks for coverage, include one broad fallback.
- If a directory contains payloads rather than plain wordlists, say so clearly.

## Output format

Use this structure unless the user asks for something else:

### Scenario
One sentence describing what the user is trying to do.

### Recommended Dictionaries
- `relative/path/to/file.txt`: why it is the first choice
- `relative/path/to/file.txt`: when to switch to it
- `relative/path/to/file.txt`: optional broad fallback

### Tool Examples
Provide one or two commands using the files you recommended. Prefer `ffuf`, `feroxbuster`, `gobuster`, or `wfuzz` depending on the request.

### Notes
- Mention stack assumptions.
- Mention whether the file is compact, broad, or payload-oriented.
- Mention any sequencing advice.

## Command behavior

- Use repository-relative paths in examples unless the user gives an absolute path.
- Keep command templates short and editable.
- For directory brute force, include extensions only when they fit the stack.
- For parameter fuzzing, show where `FUZZ` should go.
- For upload fuzzing, clarify whether the file targets filename tricks, extension tricks, or middleware behavior.

## Reference files

- Read `references/navigation.md` for the category map and recommended file entry points.
- Read `references/tool-playbooks.md` when you need ready-made command patterns for common fuzzing tools.

## Response quality bar

- Do not dump the whole repository tree unless the user explicitly asks.
- Do not recommend more than three files in the first pass.
- Explain tradeoffs in plain language: smaller and faster, broader and noisier, stack-specific, payload-heavy.
- If the user only says "give me the best dirscan dictionary", still ask yourself whether they seem to want speed, depth, or stack specificity, and answer accordingly.

## Examples

**Example 1**
Input: "目标像是 PHP 站点，我想先跑目录扫描，再看看有没有常见后台文件。"

Output shape:
- Recommend `directoryDicts/php/top3000.txt` first
- Add `directoryDicts/php/phpFileName.txt` as a PHP-focused fallback
- Add `directoryDicts/vulns.txt` or `directoryDicts/vuls/all.txt` for known vulnerable paths
- Give a short `ffuf` or `feroxbuster` command

**Example 2**
Input: "给我一个适合 Spring Boot 的接口和参数 fuzz 组合。"

Output shape:
- Recommend `apiDict/api.txt`
- Add `paramDict/AllParam.txt` or `paramDict/parameter.txt`
- Mention `spring/spring-configuration-metadata.txt` for Spring-specific clues
- Give one API path command and one parameter fuzz command

**Example 3**
Input: "这是 IIS 上传点，想测扩展名绕过。"

Output shape:
- Recommend `uploadFileExtDicts/iis_upload_fuzz.txt`
- Add `uploadFileExtDicts/all_upload_fuzz.txt` as a broad fallback
- Mention `uploadFileExtDicts/fileExt` as a simple extension seed file
- Give one upload fuzzing pattern the user can adapt
