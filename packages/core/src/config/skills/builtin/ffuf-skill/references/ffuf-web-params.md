# ffuf Web Parameter Fuzzing Reference

This reference supports `ffuf-skill`. Use it when you need quick command patterns or a reminder of which `ffuf` controls usually matter for Web parameter fuzzing.

## Core idea

Every `ffuf` run needs two things:
- an input source such as a wordlist
- a `FUZZ` marker somewhere in the request

Simple example:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test'
```

## High-value flags

| Flag | Meaning | Typical use |
| --- | --- | --- |
| `-w` | wordlist | choose candidate paths, parameter names, header names, or values |
| `-u` | target URL | simple path or query fuzzing |
| `-request` | raw request file | replay a captured HTTP request with one or more `FUZZ` markers |
| `-request-proto` | protocol for raw requests | use `http` when the raw request is not HTTPS |
| `-X` | HTTP method | `POST`, `PUT`, `PATCH`, and other non-default methods |
| `-H` | add header | custom auth, content type, or header fuzzing |
| `-d` | request body | form or JSON body fuzzing |
| `-x` | upstream proxy | route traffic through an HTTP or SOCKS proxy |
| `-replay-proxy` | replay matched hits | send interesting requests to Burp or ZAP |
| `-o` | output file | save results |
| `-of` | output format | `json`, `html`, `md`, `csv`, and related formats |
| `-json` | JSON lines stdout | automation-friendly real-time output |

## Web parameter fuzzing patterns

### Path

```bash
ffuf -w ffuf-skill/dicts/paths.txt -u 'https://target.example/FUZZ' -mc all -fs 1234
```

### Query parameter names

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/search?FUZZ=test' -mc all -fw 87
```

### Query parameter values

```bash
ffuf -w ffuf-skill/dicts/values.txt -u 'https://target.example/api/items?id=FUZZ' -mc all -fw 87
```

### Header values

```bash
ffuf -w ffuf-skill/dicts/header-values.txt -u 'https://target.example/profile' -H 'X-Forwarded-For: FUZZ' -mc all -fl 52
```

### Header names

```bash
ffuf -w ffuf-skill/dicts/header-names.txt -u 'https://target.example/profile' -H 'FUZZ: 127.0.0.1' -mc all -fl 52
```

### Form body fields

```bash
ffuf -w ffuf-skill/dicts/form-fields.txt -u 'https://target.example/login' -X POST -H 'Content-Type: application/x-www-form-urlencoded' -d 'FUZZ=test' -mc all -fs 3010
```

### JSON field names

```bash
ffuf -w ffuf-skill/dicts/json-fields.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"FUZZ":"test"}' -mc all -fw 91
```

### JSON field values

```bash
ffuf -w ffuf-skill/dicts/json-values.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"role":"FUZZ"}' -mc all -fw 91
```

### Raw request file

```bash
ffuf -w ffuf-skill/dicts/params.txt -request request.txt -mc all -fs 4242
```

## Matchers and filters cheat sheet

ffuf processes responses like this:
1. Send request
2. Check matchers
3. Check filters
4. Keep only responses that matched and were not filtered out

### Status code

- Match: `-mc`
- Filter: `-fc`

Examples:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -mc 200,204,301,302,403
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -mc all -fc 400
```

### Response size

- Match: `-ms`
- Filter: `-fs`

Good when all responses are the same status code but the baseline body size is stable.

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -mc all -fs 4242
```

### Word count

- Match: `-mw`
- Filter: `-fw`

Good when the server reflects user input and size changes slightly, but the overall template stays similar.

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -mc all -fw 87
```

### Line count

- Match: `-ml`
- Filter: `-fl`

Good when layout is stable and line count separates noise from signal.

```bash
ffuf -w ffuf-skill/dicts/header-values.txt -u 'https://target.example/profile' -H 'X-Forwarded-For: FUZZ' -mc all -fl 52
```

### Regex

- Match: `-mr`
- Filter: `-fr`

Use when you want to look for a specific string or header pattern.

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/redirect?FUZZ=https://example.org' -mr '(?i)location:'
```

### Timing

- Match: `-mt`
- Filter: `-ft`

Use for delay-based differences. Values are milliseconds.

```bash
ffuf -w ffuf-skill/dicts/json-values.txt -u 'https://target.example/api/item' -X POST -H 'Content-Type: application/json' -d '{"id":"FUZZ"}' -mt >5000
```

## Practical filtering habits

1. Observe one or two clearly invalid requests first.
2. Note the common status, size, word count, and line count.
3. Use the most stable of those values as your first filter.
4. Prefer one simple filter first, then add more only if needed.
5. Replay suspicious hits through Burp or ZAP when they need manual confirmation.

Quick rule of thumb:
- same status code everywhere: start with `-mc all`
- fixed-length baseline: prefer `-fs`
- reflected input or slight size drift: prefer `-fw`
- stable template structure: consider `-fl`
- one magic phrase or header matters: use `-mr`
- delay is the signal: use `-mt`

## Multi-wordlists

Use only when the task really needs multiple changing inputs.

### Clusterbomb

Tries all combinations.

```bash
ffuf -mode clusterbomb -w ffuf-skill/dicts/hosts.txt:HOST -w ffuf-skill/dicts/paths.txt:PATH -u 'https://HOST/PATH'
```

### Pitchfork

Walks lists in lockstep.

```bash
ffuf -mode pitchfork -w ffuf-skill/dicts/users.txt:USER -w ffuf-skill/dicts/ids.txt:ID -u 'https://target.example/u/ID/profile/USER'
```

## Replay and output

Replay only matched, non-filtered hits to a proxy:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -mc all -fs 4242 -replay-proxy 'http://127.0.0.1:8080'
```

Write JSON output:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -o results.json -of json
```

Use machine-readable stdout:

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/?FUZZ=test' -json
```

## Advanced notes

### Configuration

ffuf reads configuration from the XDG config location first, then older fallback locations. This matters mainly when the user asks about persistent configuration or scraper storage.

### Scraper

ffuf supports scraper rule groups stored as JSON files. This is useful for extracting titles, URLs, or known patterns from responses, but it is a secondary concern for parameter fuzzing and should not be the default recommendation.

## Local dictionary planning

If the user is building their own `dicts/` directory for this skill, these filenames are a practical starting point:

| File | Purpose |
| --- | --- |
| `params.txt` | common GET or POST parameter names |
| `json-fields.txt` | common JSON field names |
| `header-names.txt` | common standard and custom header names |
| `header-values.txt` | candidate header values or payloads |
| `paths.txt` | common endpoints, directories, and filenames |
| `values.txt` | generic fuzz values, flags, IDs, or roles |
