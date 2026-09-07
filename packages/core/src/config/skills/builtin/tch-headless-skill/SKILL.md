---
name: tch-headless-skill
description: Use this skill whenever the user wants to crawl a website with the `tch-headless` or `TCH-EZ-Headless` browser crawler for a quick headless pass, especially for dynamic pages, Chrome-based automation, request capture, sitemap-style output inspection, or parsing `.tch-networks-output` / `.raw` crawl artifacts. Also use it when the user mentions headless browser crawling, automated website exploration with Chrome, or asks how to run and analyze `tch-headless`, even if they do not explicitly ask for a skill.
compatibility:
  tools: Bash, Glob, Grep, Read
---

# TCH Headless Skill

Use `tch-headless` as the default tool for browser-driven crawling when the user wants to explore a live site with Chrome automation and inspect the captured HTTP responses afterward.

## What this skill does

- Run `tch-headless` against a target URL.
- Prefer JSON stdio logs during runs so the crawl is easier to inspect while it is happening.
- Read `.tch-networks-output` results and explain what the crawler actually found.
- Summarize the crawl as discovered URLs, response headers, and response bodies from `.raw` files.

## Command reference

Core usage:

```bash
./scripts/tch-headless -t "<target-url>" -jsd
```

Useful options:

- `-t`, `--target`: crawl target, must start with `http://` or `https://`
- `-c`, `--config`: custom config path, usually `TCH-X_config.yaml`
- `--text-output`: write full request dump to a text file
- `--json-output`: write full request dump to a JSON file
- `--push-proxy`: push requests to a proxy endpoint
- `--disable-logger`, `--dl`: reduce logger output
- `--no-banner`: disable banner output

Prefer `-jsd` by default unless the user specifically wants plain terminal output.
Do not use `--wait-login` or `--disable-headless` in this skill. This skill is for unattended headless crawling only.

## Expected workspace artifacts

After the crawl, inspect `.tch-networks-output/` first.

Directory layout:

- `.tch-networks-output/`
- Second-level directory: target URL converted to `<host>_<port>` such as `example.com_443`
- Inside that directory: sitemap-like crawl artifacts stored as method-prefixed `*.raw` files

Path mapping rules:

- `http://110.41.78.165:8088/` requested with `GET` -> `.tch-networks-output/110.41.78.165_8088/GET_index.raw`
- `http://110.41.78.165:8088/vul/xss/xss.php` requested with `GET` -> `.tch-networks-output/110.41.78.165_8088/vul/xss/GET_xss.php.raw`
- If the same path is reached with another method such as `POST`, the filename changes accordingly, for example `POST_login.raw`

Each `.raw` file is structured like this:

```text
:AssetURL:
<discovered url>

:Method:
<HTTP method>

:Request Headers:
<header-name>: <value>

:Request Body:
<request body if present>

:Response Headers:
<header-name>: <value>

:Response Body:
<response body>
```

`Request Body` is optional and only appears when the crawler has request-body data to write.

Treat `.raw` as the authoritative post-crawl artifact for explaining what the crawler observed on both the request side and the response side.

## Workflow

1. Confirm the target URL.
2. Locate the crawler binary before running it. Prefer the bundled binary at `./scripts/tch-headless`. If that path does not exist, fall back to a repo-local `./tch-headless` and tell the user which one you used.
3. Check whether a config file is needed. If the user mentions a custom Chrome path, proxy, scope, depth, or timeout, use `-c` with the relevant `TCH-X_config.yaml`.
4. Run the crawl with `-jsd` by default.
5. Do a single rough crawl pass. Do not pause for human interaction and do not switch to visible browser mode.
6. After the crawl finishes, inspect `.tch-networks-output/<host>_<port>/` and read representative `.raw` files.
7. Summarize what was found instead of only dumping paths. Highlight important pages, APIs, forms, redirects, scripts, interesting request headers, and noteworthy request bodies.

## Command boundaries

Do not use these options in this skill:

- `--wait-login`
- `--disable-headless`

If the target requires login, SSO, MFA, CAPTCHA, or another interactive step, state that this rough headless pass may only capture pre-login or anonymously reachable content.

Use `--json-output` or `--text-output` when:

- the user asks for a standalone export file
- the user wants to archive the full request dump outside `.tch-networks-output`

## Result interpretation guidance

When reading crawl results:

- Start from the generated target directory and list the main sections of the site.
- Read a few high-value `.raw` files rather than every file blindly.
- Use the `:AssetURL:` block to identify the page.
- Use the `:Method:` block to distinguish `GET` pages from `POST` or other method-specific requests.
- Use the filename itself as a quick hint: `GET_index.raw`, `POST_login.raw`, `GET_api.php.raw`.
- Use `:Request Headers:` to understand how the browser reached the endpoint.
- If `:Request Body:` exists, inspect it for submitted form fields, JSON payloads, search parameters, or API inputs.
- Use `:Response Headers:` to spot content type, caching, redirects, cookies, or server information.
- Use `:Response Body:` to identify HTML entry points, forms, API responses, JS-driven routes, and linked assets.
- If the user asks for a sitemap or attack surface view, group results by path area such as `/admin`, `/api`, `/login`, `/static`, `/docs`.
- If multiple `.raw` files share the same path but different methods, explain them separately because they may represent different application behavior.

## Response format

When you finish a run, report in this shape:

```markdown
Command used: `<exact command>`
Output root: `.tch-networks-output/<host>_<port>/`

Findings:
- <important discovered URL or section>
- <important request method / request payload clue>
- <interesting header / behavior>
- <important response body clue>

Artifacts inspected:
- `<path/to/file1.raw>`
- `<path/to/file2.raw>`

Next step:
- <optional follow-up such as deeper crawl, config tuning, or focused analysis>
```

Keep the summary concrete and file-backed. Cite the `.raw` paths you inspected, and mention the request method when it matters.

## Guardrails

- Only crawl targets the user is authorized to inspect.
- Do not invent credentials or attempt bypass behavior.
- Do not switch to visible-browser or manual-login flows. If the site is interactive-only, explain that the results are limited by a headless one-pass crawl.
- If the binary or target is missing, say exactly what is missing and what path or URL is needed.

## Examples

**Example 1**

Input: `用 tch-headless 爬一下 https://example.com，帮我看看站点地图和返回包。`

Behavior: Run `./scripts/tch-headless -t "https://example.com" -jsd`, then inspect `.tch-networks-output/example.com_443/` and summarize key method-prefixed `.raw` files such as `GET_index.raw`.

**Example 2**

Input: `粗略爬一下这个站，不需要交互，也不要打开可见浏览器，帮我看能匿名拿到哪些页面和响应。`

Behavior: Run a single headless pass with `./scripts/tch-headless -t "<target>" -jsd`, then analyze the generated method-prefixed `.raw` artifacts, including request and response sections, and clearly note that authenticated pages may be missing.
