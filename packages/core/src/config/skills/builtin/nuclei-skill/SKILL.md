---
name: nuclei-skill
description: Help with safe, practical use of ProjectDiscovery Nuclei for authorized scanning. Use this skill whenever the user wants to run `nuclei`, choose templates, filter by tags or severity, scan one host or a target list, validate or run a custom template, tune output formats, use authenticated scans, or understand key CLI flags. Trigger on requests like "给我写 nuclei 命令", "怎么扫一批 URL", "怎么只跑高危模板", "帮我用 nuclei 跑自定义模板", "nuclei 结果怎么导出 JSONL", and similar Nuclei usage questions even if the user does not explicitly mention a skill.
---

# nuclei-skill

Use this skill to turn a Nuclei request into a runnable command, a tight workflow, or a short troubleshooting answer.

Keep the answer practical. The user usually wants to scan something, narrow scope, export results, or understand why a run behaved a certain way.

Nuclei is a high-performance scanner powered by YAML templates and supports multiple protocols including HTTP, DNS, SSL, TCP, headless, JavaScript, file, and workflows. The skill should help the user choose the smallest correct command for their job.

## Safety boundary

- Help only with authorized testing, labs, demos, CTFs, internal assets, or systems the user is permitted to scan.
- If the request is target-specific and authorization is unclear, ask one short clarification before giving scan commands.
- Do not help hide abusive scanning. Avoid advice whose main purpose is evasion, stealth, or bypassing defenses on third-party systems.
- Keep guidance aligned with the user's stated scope and rate limits.

## Default response style

Match the user's language.

For most requests, use this shape:

### Recommended command

Give one primary `nuclei` command first.

### Why this setup

Briefly explain the important flags and why they fit this case.

### Notes

Mention one or two practical cautions such as template selection, output format, auth, or rate limiting.

### Optional next step

Only add this when there is an obvious follow-up, such as validating a custom template, exporting JSONL, or updating templates.

Keep it concise. Prefer one strong command over many variants.

## When to ask a question first

Ask one short question only if one of these is missing and materially changes the command:

- whether the scan is authorized
- whether the input is a single target or a file/list
- whether the user wants built-in/community templates, a custom template, or a workflow
- whether authentication is required
- whether they need machine-readable output such as JSON, JSONL, Markdown, or SARIF

If the prompt is already clear enough, do not slow the user down with extra questions.

## Core workflow

Follow this sequence.

1. Identify the input shape
- Single target: use `-u` or `-target`.
- Target list: use `-l` or `-list`.
- Structured input such as Burp/OpenAPI/Swagger/list file: use `-im` with the correct mode when the user already has that format.

2. Decide template source
- Default/community templates: use `-t`, `-tags`, `-severity`, `-type`, or `-as`.
- New templates only: use `-nt` or `-ntv`.
- Custom template file or directory: use `-t <path>`.
- Workflow: use `-w <path>`.
- Remote template/workflow URL: use `-turl` or `-wurl` if the user explicitly wants remote resources.

3. Keep scope tight
- Prefer tags, severity, template ids, or protocol type filters over "scan everything".
- If the user is unsure, suggest a narrow default based on the asset type and what they actually want to find.

4. Add execution controls
- Use `-rl`, `-c`, `-bs`, `-timeout`, and `-retries` when rate, concurrency, or stability matters.
- For authenticated scans, add `-H` headers or `-sf` secret file as appropriate.
- For redirects, choose among `-fr`, `-fhr`, `-mr`, or `-dr`.

5. Choose outputs
- Human-readable terminal output is fine for quick checks.
- Use `-json-export`, `-jsonl-export`, `-markdown-export`, or `-sarif-export` when the user needs artifacts.
- Use `-o` for a plain output file.

6. Mention validation and updates when relevant
- For a custom template, suggest `-validate` before a full run.
- For missing or outdated templates, suggest `-ut`.

## Command patterns

### Single target web scan

Use for one URL or host.

```bash
nuclei -u https://target.example
```

If the user wants a narrower run, add template filters instead of scanning the full template set.

Example:

```bash
nuclei -u https://target.example -tags cve,exposure -severity medium,high,critical
```

### Scan a list of targets

Use when the user already has URLs or hosts in a file.

```bash
nuclei -l targets.txt -severity high,critical -jsonl-export findings.jsonl
```

This is a strong default for batch scans because the JSONL export is easy to consume later.

### Run specific template directories or files

Use when the user knows exactly which templates to run.

```bash
nuclei -u https://target.example -t http/cves/ -t ssl/
```

Or for a local custom template:

```bash
nuclei -u https://target.example -t /path/to/template.yaml
```

### Run a custom template safely

Encourage validation first.

```bash
nuclei -validate -t /path/to/template.yaml
```

Then run it:

```bash
nuclei -u https://target.example -t /path/to/template.yaml
```

If syntax issues appear and the user explicitly wants to test a draft, mention `-nss` only as a debugging aid, not as the default.

### Filter by tags, severity, protocol type, or template id

Use this when the user wants control without naming exact files.

```bash
nuclei -l targets.txt -tags exposure,tech -severity low,medium,high -pt http,ssl
```

Useful filters:
- `-tags`: choose topic or use case
- `-severity`: narrow by impact
- `-pt`: narrow by protocol type
- `-id`: run exact template ids or wildcard-matching ids
- `-etags`, `-exclude-severity`, `-exclude-id`, `-et`: remove noisy or unwanted templates

### Automatic scan mode

Use when the user wants a quick web scan and does not know which tags to choose.

```bash
nuclei -u https://target.example -as
```

Explain that `-as` uses technology detection to map to relevant tags. It is convenient, but not a substitute for carefully chosen templates in a focused assessment.

### Authenticated scan

Use when the target requires cookies, bearer tokens, or custom headers.

Header-based example:

```bash
nuclei -u https://target.example -H 'Authorization: Bearer <token>' -H 'Cookie: session=<value>' -tags exposure
```

Secret-file example:

```bash
nuclei -u https://target.example -sf secrets.yaml -ps
```

Prefer a secret file when the user is running repeated authenticated scans or wants cleaner command history.

### Redirect behavior

Use when behavior depends on redirects.

```bash
nuclei -u https://target.example -fr -mr 5
```

Or if redirects are getting in the way:

```bash
nuclei -u https://target.example -dr
```

### Machine-readable exports

Use when the user wants integration with scripts, CI, dashboards, or review workflows.

```bash
nuclei -l targets.txt -severity medium,high,critical -jsonl-export nuclei-findings.jsonl
```

Other common exports:
- `-json-export results.json`
- `-markdown-export report-dir/`
- `-sarif-export results.sarif`

If the user wants only findings in terminal output, mention `-silent`.

### Debugging a confusing scan

Use only when the user is actively troubleshooting.

```bash
nuclei -u https://target.example -t /path/to/template.yaml -debug -vv -validate
```

Useful debug flags:
- `-debug`, `-dreq`, `-dresp`
- `-vv` to show loaded templates
- `-ms` to display matcher status
- `-svd` to inspect variable dumps when template logic is involved
- `-hc` for health checks

Do not lead with debug flags in normal usage.

### Updating engine or templates

Use when findings seem stale or the user asks how to update.

```bash
nuclei -ut
```

Engine update:

```bash
nuclei -up
```

If the user manages templates in a custom directory, add `-ud <dir>`.

## Rate and scale guidance

Nuclei is fast. That is useful, but it also means the wrong defaults can hit too hard.

- For sensitive internal environments, suggest lowering `-rl`, `-c`, or `-bs`.
- For unstable targets, mention `-timeout`, `-retries`, and `-mhe`.
- For very large input sets, prefer a file input, structured outputs, and explicit template filters.
- If the user asks how to avoid duplicate work, mention `-project` and optionally `-project-path`.

Example conservative batch command:

```bash
nuclei -l targets.txt -tags cve -severity high,critical -rl 20 -c 10 -bs 10 -jsonl-export findings.jsonl
```

## Output interpretation

When the user asks how to read results, explain briefly:

- Template ID and matched result indicate what triggered.
- Severity helps prioritize, but template context still matters.
- Request/response storage is optional with `-sresp` or `-srd` and can aid triage.
- JSONL is usually the best export for later parsing.

If the user asks about including raw request/response pairs in output, mention that JSON/JSONL/Markdown output behavior is controlled by the raw-output flags, and that omitting raw data can be preferable for portability or privacy.

## Working with custom templates

If the user asks for help writing a Nuclei template:

- First identify whether they need HTTP, DNS, TCP, SSL, file, headless, JavaScript, or workflow logic.
- Produce a small starter template, not a giant generic scaffold.
- Prefer a single matcher/extractor path that clearly proves the detection logic.
- Tell them to validate with `nuclei -validate -t <template>` before scanning.
- If they only need to run an existing template, do not drift into full DSL teaching.

If the request turns into deep template authoring, syntax reference, or workflow design, keep the answer practical and centered on the smallest working example.

## Troubleshooting heuristics

When `nuclei` behaves unexpectedly, check these in order:

1. Input shape is wrong
- wrong target format
- forgot `-l` for file input
- should have used `-im burp`, `-im openapi`, or similar

2. Template selection is wrong
- wrong tag or severity filter
- forgot `-headless`, `-code`, `-file`, or another capability gate
- template path is wrong

3. Auth or request context is missing
- required header/cookie absent
- secret file not loaded
- redirects need `-fr` or should be disabled

4. Output expectation is wrong
- user wants JSONL but only terminal output is enabled
- user needs stored responses and did not use `-sresp`

5. Runtime pressure is too high
- rate/concurrency too aggressive
- timeout too low

When helpful, recommend a minimal diagnostic command instead of a long theory explanation.

## Do and do not

Do:
- give one strong command first
- scope templates tightly
- mention validation for custom templates
- mention structured export when the user will likely parse results later
- mention authorization and rate awareness when appropriate

Do not:
- invent flags or template behavior
- recommend scanning the whole internet or public third-party assets without clear authorization
- dump the full `nuclei -h` output unless the user explicitly asks for all flags
- overcomplicate a simple "scan this host" request

## Short examples

**Example 1**
Input: 帮我写一个 nuclei 命令，扫 `targets.txt` 里所有站点，只看高危和严重，输出成 jsonl

Output:

```bash
nuclei -l targets.txt -severity high,critical -jsonl-export findings.jsonl
```

Reasoning to include briefly: batch input with `-l`, severity filter, JSONL export for later processing.

**Example 2**
Input: 我有一个本地模板 `./templates/test.yaml`，想先检查模板语法再跑 `https://demo.test`

Output:

```bash
nuclei -validate -t ./templates/test.yaml
nuclei -u https://demo.test -t ./templates/test.yaml
```

Reasoning to include briefly: validate first, then run on the single target.

**Example 3**
Input: `nuclei` 怎么只跑跟 exposure 相关的模板，并带上登录 Cookie？

Output:

```bash
nuclei -u https://target.example -tags exposure -H 'Cookie: session=<value>'
```

Reasoning to include briefly: tag-based narrowing plus auth header/cookie.
