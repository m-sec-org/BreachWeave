---
name: ffuf-skill
description: Help with ffuf-based Web parameter fuzzing. Use this skill whenever the user wants to fuzz Web request paths, query parameters, headers, POST bodies, JSON fields, or raw HTTP requests with ffuf, or when they ask for an ffuf command, wordlist choice, false-positive filtering, matcher/filter tuning, or replaying hits into Burp/ZAP. 
---

# ffuf-skill

Use this skill to turn a Web fuzzing goal into a practical `ffuf` command, not into a long theory dump.

Focus on these request locations:
- URL path segments
- Query parameter names
- Query parameter values
- Header names or values
- Form body fields
- JSON body fields
- Raw HTTP request files with one or more `FUZZ` markers

Do not drift into unrelated offensive guidance. Keep the help scoped to authorized testing and the user's stated target.

## Safety boundary

- Help only with authorized testing, labs, demos, or user-owned systems.
- If authorization is unclear, ask one short clarification before giving target-specific commands.
- Do not pretend a target is authorized when the user has not said so.

## Default response style

Match the user's language.

For most requests, structure the answer as:

### Recommended command

Provide one primary `ffuf` command first. If there is a meaningful variant, provide one alternative command after it.

### Why this setup

Explain the key flags briefly:
- fuzz location
- chosen wordlist
- request method/body/headers
- why the selected matcher/filter is a reasonable starting point

### Noise-control tips

Explain how to reduce false positives for this case.

### What to look for

Tell the user what result differences usually matter, such as:
- changed status code
- different response size
- different word or line count
- regex hit in body or headers
- unusual timing

Keep the explanation concise. The user asked for something runnable.

If the prompt is missing one essential detail, ask one short question first. Good examples:
- which request location should be fuzzed
- whether the user already has a raw request file
- which baseline response should be filtered out

If the request is already clear enough, do not pause to ask extra questions.

## Local dictionaries

`dicts/` is the local dictionary directory for this skill.

How to use it:
- Prefer dictionaries from `ffuf-skill/dicts/` when generating commands.
- Do not assume `SecLists` or other external wordlists are installed.
- If the user does not specify a dictionary, recommend a likely file from `dicts/` based on the fuzz target.
- If `dicts/` does not yet contain a suitable file, say what category is needed, such as parameter names, headers, JSON keys, paths, or payload values.

Dictionary inventory placeholder:

| File | Purpose | Typical use | Notes |
| --- | --- | --- | --- |

Suggested dictionary categories for this directory:
- `params.txt`: common query or form parameter names
- `json-fields.txt`: common JSON field names
- `header-names.txt`: common header names
- `header-values.txt`: header payloads or candidate values
- `paths.txt`: common directories, endpoints, or filenames
- `values.txt`: common IDs, roles, flags, or payload values

## Core workflow

Follow this sequence.

1. Identify the fuzz point
- Decide whether the user wants to fuzz a path, query key, query value, header, form field, JSON field, or a raw request.
- If the prompt already includes a request sample, reuse its method, headers, and body shape.

2. Pick the request format
- Prefer `-u` for simple path or query fuzzing.
- Prefer `-request <file>` when the user already has a raw HTTP request from Burp or another proxy.
- Use `-X`, `-H`, and `-d` when reconstructing a request inline is still simple.
- When the user already has a real authenticated request, prefer `-request` so cookies, tokens, and odd headers stay intact.

3. Pick the dictionary
- Parameter name fuzzing: choose a parameter-name or API-field dictionary.
- Header fuzzing: choose a header-name dictionary or a value payload dictionary.
- JSON or form value fuzzing: choose payloads or candidate values.
- Path fuzzing: choose path, file, or endpoint dictionaries.

4. Add a starting matcher or filter
- Start simple.
- If the application returns varied status codes, begin with `-mc`.
- If the application returns the same status code for everything, begin with `-mc all` plus `-fs`, `-fw`, or `-fl`.
- Use regex or timing only when there is a clear reason.

5. Tell the user how to validate hits
- Suggest replaying likely hits to Burp/ZAP with `-replay-proxy` when manual inspection matters.
- Point out which differences are likely signal versus background noise.

6. Prefer one best command over many mediocre ones
- Give one default command first.
- Add one alternative only if there is a real tradeoff, such as `-request` versus inline reconstruction, or `-fs` versus `-fw`.
- Do not dump five variants unless the user asked for comparison.

## Command patterns

### Path fuzzing

Use when the unknown part is a directory, endpoint, or filename in the URL path.

Example:

```bash
ffuf -w ffuf-skill/dicts/paths.txt -u 'https://target.example/FUZZ' -mc all -fs 1234
```

### Query parameter name fuzzing

Use when the application may accept undocumented GET parameter names.

This is one of the highest-value defaults when the user says "fuzz this request parameter" but only shows a URL.

Example:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/search?FUZZ=test' -mc all -fs 4242
```

### Query parameter value fuzzing

Use when the parameter name is known and the interesting part is its value.

Example:

```bash
ffuf -w ffuf-skill/dicts/values.txt -u 'https://target.example/api/items?id=FUZZ' -mc all -fw 87
```

### Header fuzzing

Use when the header name or value may change application behavior.

Typical cases:
- IP-related headers such as `X-Forwarded-For`
- cache or routing headers
- feature or debug headers
- custom application headers

Example header value fuzzing:

```bash
ffuf -w ffuf-skill/dicts/header-values.txt -u 'https://target.example/profile' -H 'X-Forwarded-For: FUZZ' -mc all -fl 52
```

Example header name fuzzing:

```bash
ffuf -w ffuf-skill/dicts/header-names.txt -u 'https://target.example/profile' -H 'FUZZ: 127.0.0.1' -mc all -fl 52
```

### Form body fuzzing

Use when the request body is form-encoded.

Example:

```bash
ffuf -w ffuf-skill/dicts/form-fields.txt -u 'https://target.example/login' -X POST -H 'Content-Type: application/x-www-form-urlencoded' -d 'FUZZ=test' -mc all -fs 3010
```

### JSON body fuzzing

Use when the request body is JSON. Remember to keep `Content-Type: application/json`.

Example field value fuzzing:

```bash
ffuf -w ffuf-skill/dicts/json-values.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"role":"FUZZ"}' -mc all -fw 91
```

Example field name fuzzing:

```bash
ffuf -w ffuf-skill/dicts/json-fields.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"FUZZ":"test"}' -mc all -fw 91
```

### Raw request fuzzing

Use `-request` when the user already has a complete request captured in Burp or wants to fuzz multiple custom headers/body fields without rebuilding the request inline.

Example:

```bash
ffuf -w ffuf-skill/dicts/params.txt -request request.txt -mc all -fs 4242
```

If the request is plain HTTP rather than HTTPS, add `-request-proto http`.

## Matchers and filters

The most important part of this skill is choosing a sane starting point for signal versus noise.

### Good defaults

- Use `-mc` when meaningful responses already differ by status code.
- Use `-mc all` when the application hides behavior behind a uniform status code.
- Then filter the known baseline with one of:
  - `-fs` for response size
  - `-fw` for word count
  - `-fl` for line count

### When to prefer each control

- Prefer `-fs` when the application is stable and returns nearly identical bodies.
- Prefer `-fw` when content length changes slightly because user input is reflected.
- Prefer `-fl` when the page template is stable but words vary too much.
- Use `-mr` or `-fr` when the user cares about a specific string or header pattern.
- Use `-mt` or `-ft` for timing-based differences only when delay is the actual signal.

### Baseline-first habit

If the application behavior is unclear, tell the user to first send one or two known-bad requests and note the common response:
- status code
- size
- words
- lines

Then build the first filter around that baseline instead of guessing.

When helpful, tell the user this explicitly:
- if status code is uniform, start with `-mc all`
- if body length is stable, try `-fs`
- if input reflection changes length slightly, try `-fw`
- if only a specific marker matters, use `-mr`

## Multi-wordlist usage

Only introduce multiple wordlists when the user clearly needs it.

- `clusterbomb` tries every combination and grows very fast.
- `pitchfork` walks wordlists in lockstep and is useful for paired data.

For ordinary Web parameter fuzzing, one wordlist is usually the right default.

## Replay and output

- Use `-replay-proxy http://127.0.0.1:8080` when the user wants promising hits sent to Burp or ZAP for manual review.
- Use `-o <file> -of json` when the user wants structured output for later processing.
- Use `-json` when the user wants machine-readable stdout during automation.

## Anti-patterns

Avoid these common mistakes:
- forgetting `Content-Type: application/json` for JSON body fuzzing
- rebuilding a complex authenticated request inline when `-request` would preserve it safely
- stacking too many filters before establishing a baseline
- assuming every interesting hit will use a different status code
- recommending multi-wordlist modes for simple single-parameter fuzzing

## When to read references

Read `references/ffuf-web-params.md` when:
- you need a denser parameter cheat sheet
- you need more example templates
- you need a quick reminder of matcher/filter tradeoffs
- the user asks about ffuf configuration or scraper-related features

## Example prompts this skill should handle well

- `帮我写一个 ffuf 命令，fuzz 这个 GET 请求里可能存在的隐藏参数名。`
- `我有个 Burp 导出的 request.txt，想 fuzz JSON body 里的字段名。`
- `这个站所有响应都是 200，我该怎么用 ffuf 过滤误报？`
- `我想 fuzz X-Forwarded-For 头的值，并把命中的请求转发到 Burp。`
- `帮我根据这个 POST 请求写 ffuf，目标是 fuzz form body 里的字段名。`
- `这个 API 返回长度会变，状态码没区别，ffuf 应该先用 fs 还是 fw？`
