---
name: jwt-tool-skill
description: Help with authorized JWT assessment using ticarpi/jwt_tool. Use this skill whenever the user mentions `jwt_tool`, wants commands for JWT decoding, verification, secret cracking, claim tampering, playbook scans, `alg:none`, key confusion, JWKS spoofing or inline JWK injection, raw-request mode with `-r`, or needs to test bearer-token trust with a real HTTP request. Make sure to use it when the user asks how to audit or exploit JWT handling with `jwt_tool`, even if they only describe the token, headers, cookies, or a captured request and do not explicitly ask for a skill.
---

# jwt-tool-skill

Use this skill to turn a JWT testing goal into a practical `jwt_tool` workflow and concrete commands.

Keep the answer scoped to authorized testing, labs, demos, research, or CTFs. If the request is target-specific and authorization is unclear, ask one short clarification before giving target-specific commands.

## jwt_tool.py file path

jwt_tool.py in /opt/jwt_tool

## What This Skill Is For

Reach for this skill when the user wants to:

- inspect or decode a JWT with `jwt_tool`
- verify a signature with a public key or JWKS
- crack an HMAC secret with a wordlist
- test `alg:none`, key confusion, spoofed JWKS, or inline JWK attacks
- tamper with payload or header claims and resend the token
- run `jwt_tool` scans against a live endpoint
- use a captured HTTP request with `-r`
- understand which `jwt_tool` flags fit a JWT testing scenario

If the user mainly wants JWT vulnerability theory or a generic methodology without `jwt_tool`, another JWT or pentest skill may be a better fit.

## Response Style

Default to a short, runnable answer.

For most requests, use this structure:

### Recommended command

Give one primary command first. Add one alternative only when there is a real tradeoff, such as Docker versus local Python or `-r` versus manual `-rc`/`-rh`.

### Why this fits

Explain the chosen mode and the important flags in one or two short paragraphs or 3-5 bullets.

### What to check

Tell the user what output differences matter, such as:

- signature valid versus invalid
- response code or body length changes
- canary string matches
- claim acceptance despite tampering
- successful key recovery
- proof that a forged token was accepted

### Next escalation

Give the next likely `jwt_tool` step if the first command hits.

If one essential input is missing, ask one short question first. Good examples:

- do you have the raw JWT, or only an HTTP request containing it?
- is the token in a cookie, header, or POST body?
- do you already have a public key, JWKS, or a candidate secret?

Do not stop for unnecessary questions when the user already gave enough to build a command.

## Safety Boundary

- Help only with authorized systems, labs, demos, research, or CTFs.
- Prefer validation and low-noise checks before aggressive exploitation.
- Do not imply permission when the user did not say they have it.
- If the user asks for destructive or noisy testing, suggest a safer first pass when possible.

## Decision Flow

1. Identify the user's starting point.
- `token only`: decode, inspect, verify, crack, tamper, or sign offline first.
- `token + live target`: choose `-t` with `-rc` or `-rh`, or prefer `-r` if they have a saved request.
- `key material present`: route to `-V`, `-S`, `-X k`, or JWKS reconstruction paths.
- `JWT weakness hypothesis`: route to the smallest command that confirms or rejects it.

2. Prefer the least fragile request transport.
- If the user has a raw request file from Burp, prefer `-r` because it preserves headers, cookies, and body shape.
- Otherwise use `-t` plus `-rc`, `-rh`, and optional POST data.
- If a success marker exists, add `-cv` so `jwt_tool` can highlight accepted tokens faster.

3. Start with evidence gathering.
- Decode the token before mutation.
- Verify signatures when key material exists.
- Use scans before hand-building exploit chains when the goal is broad assessment.

4. Escalate only after you have a reason.
- `-M pb` for a broad first pass.
- `-M er` when the app may reveal behavior through forced errors.
- `-C` for HMAC secret testing.
- `-X a`, `-X k`, `-X s`, or `-X i` for specific exploit hypotheses.
- `-I` for claim/header injection or fuzzing.
- `-T` when the user explicitly wants manual, interactive tampering.

## Install Choices

If the user did not specify an environment, mention both options briefly and recommend one.

- Docker is the safer default when the user just wants the tool to work quickly.
- Local Python is fine when they already cloned the repo or need easy access to local files.

Docker base command:

```bash
docker run -it --network "host" --rm -v "${PWD}:/tmp" -v "${HOME}/.jwt_tool:/root/.jwt_tool" ticarpi/jwt_tool
```

Local install:

```bash
git clone https://github.com/ticarpi/jwt_tool
cd jwt_tool
python3 -m pip install -r requirements.txt
python3 jwt_tool.py -h
```

When giving Docker examples that reference local files, remember they appear under `/tmp/...` inside the container.

## High-Value Command Patterns

Read `jwt-tool-skill/references/command-recipes.md` when you need a compact mapping from testing goal to `jwt_tool` flags and examples.

Use these defaults:

- Decode only: `python3 jwt_tool.py <JWT>`
- Verify with PEM: `python3 jwt_tool.py <JWT> -V -pk public.pem`
- Verify with JWKS: `python3 jwt_tool.py <JWT> -V -jw jwks.json`
- Crack HMAC secret with wordlist: `python3 jwt_tool.py <JWT> -C -d wordlist.txt`
- Test `alg:none`: `python3 jwt_tool.py <JWT> -X a`
- Test key confusion: `python3 jwt_tool.py <JWT> -X k -pk public.pem`
- Inject inline JWK: `python3 jwt_tool.py <JWT> -X i`
- Spoof remote JWKS: `python3 jwt_tool.py <JWT> -X s -ju https://attacker.example/jwks.json`
- Inject or fuzz claims: `python3 jwt_tool.py <JWT> -I -pc role -pv admin`
- Run playbook scan: `python3 jwt_tool.py -t https://target.example -rc "jwt=<JWT>" -M pb`
- Prefer captured request mode: `python3 jwt_tool.py -r request.txt -M pb`

## Command-Building Rules

### Offline token inspection

Use when the user only has a token and wants to understand it.

Start with:

```bash
python3 jwt_tool.py '<JWT>'
```

Call out:

- `alg`, `kid`, `jku`, `jwk`, `x5u`
- `iss`, `aud`, `sub`, `role`, `scope`, `tenant`, `exp`, `nbf`, `iat`
- whether the algorithm implies HMAC or asymmetric verification paths

### Signature verification

Use `-V` when the user already has a public key, private key-derived public key, or JWKS.

Examples:

```bash
python3 jwt_tool.py '<JWT>' -V -pk public.pem
python3 jwt_tool.py '<JWT>' -V -jw jwks.json
```

If the user has only a JWKS URL, tell them `jwt_tool` works with local files more directly, so fetching it first is often simpler unless they are testing `jku` trust itself.

### Secret cracking

Use `-C` only for HMAC algorithms such as `HS256`, `HS384`, or `HS512`.

Examples:

```bash
python3 jwt_tool.py '<JWT>' -C -d jwt-common.txt
python3 jwt_tool.py '<JWT>' -C -d /path/to/wordlist.txt
```

If the token uses RSA, EC, or PSS algorithms, do not suggest `-C` as if it will work.

### Live application testing

Prefer `-r request.txt` when the user already has a raw request file.

Examples:

```bash
python3 jwt_tool.py -r request.txt -M pb
python3 jwt_tool.py -r request.txt -M er -cv 'Welcome'
```

If there is no request file, build the request with `-t`, `-rc`, and `-rh`.

Examples:

```bash
python3 jwt_tool.py -t 'https://target.example/profile' -rh 'Authorization: Bearer <JWT>' -cv 'Welcome' -M pb
python3 jwt_tool.py -t 'https://target.example/' -rc 'jwt=<JWT>; session=abc' -M er
```

At least one header, cookie, or POST field must actually contain the JWT.

### Claim injection and fuzzing

Use `-I` when the user wants controlled edits without the interactive flow.

Examples:

```bash
python3 jwt_tool.py '<JWT>' -I -pc role -pv admin -X a
python3 jwt_tool.py '<JWT>' -I -pc tenant_id -pv 1 -S hs256 -p 'secret'
python3 jwt_tool.py '<JWT>' -I -hc kid -hv fuzz.txt -X a
```

If a value argument points to a file, explain that one header or payload value can be fuzzed from that file in a run.

### Exploit selection

Use these exploit codes carefully and explain the precondition:

- `-X a`: `alg:none` only matters if the backend accepts unsigned tokens.
- `-X k`: key confusion needs a known public key and a vulnerable implementation.
- `-X s`: spoofed JWKS needs the server to trust attacker-controlled `jku` or related key lookup behavior.
- `-X i`: inline JWK injection needs the backend to trust attacker-supplied `jwk` values.

Do not frame these as guaranteed wins. Frame them as hypothesis tests.

### Interactive tampering

Use `-T` only when the user explicitly wants the guided interactive editor or is exploring a token manually.

```bash
python3 jwt_tool.py '<JWT>' -T
```

If the user wants a repeatable or scriptable command, prefer `-I` over `-T`.

### Log review

If the user shows a `jwttool_<id>` tracking identifier and wants to inspect a prior run, route to:

```bash
python3 jwt_tool.py -Q jwttool_deadbeef1234567890
```

## Common Advice Patterns

- If the user is unsure where the JWT lives in the request, suggest extracting a real request from Burp and using `-r`.
- If the target returns the same status code for everything, recommend `-cv` with a success marker and compare response size and body text.
- If `jwt_tool` auto-generated keys or JWKS are part of the plan, mention the first run creates local key material and config under the user's jwt_tool directory.
- If the user is testing spoofed JWKS or collaborator-style checks, remind them to configure `jwtconf.ini` values such as `jwksloc` and `httplistener`.
- If the user only wants to inspect the token, do not jump straight to attack commands.

## Failure-Avoidance Rules

- Do not suggest `-C` for non-HMAC tokens.
- Do not omit the token location when giving live-target commands.
- Do not recommend `-T` when the user asked for a non-interactive one-liner.
- Do not assume `-t` is better than `-r` when the user already has a captured request.
- Do not suggest exploit flags without stating the trust assumption they test.

## Example Response Fragments

**Example 1: verify with a PEM key**

Recommended command:

```bash
python3 jwt_tool.py '<JWT>' -V -pk public.pem
```

Why this fits: `-V` checks whether the current signature matches the supplied public key. This is the quickest way to confirm whether the token was really signed by the key you recovered.

What to check: a clear valid versus invalid verification result.

Next escalation: if valid and the app uses an asymmetric alg, test whether `kid`, `jku`, or key-confusion paths are trusted too loosely.

**Example 2: scan a captured request**

Recommended command:

```bash
python3 jwt_tool.py -r request.txt -M pb -cv 'Welcome'
```

Why this fits: `-r` keeps the original request shape intact, and `-M pb` is the best first-pass automated audit for common JWT trust problems.

What to check: any request IDs, changed status codes, body lengths, or a success marker appearing with forged tokens.

Next escalation: rerun the specific promising attack with `-X ...` or `-I ...` so you can validate and exploit it deliberately.
