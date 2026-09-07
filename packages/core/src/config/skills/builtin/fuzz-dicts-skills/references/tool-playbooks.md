# Tool Playbooks

These are short templates the skill can adapt.

Use them as examples, not as rigid output.

## ffuf

### Directory scan
```bash
ffuf -u https://target.example/FUZZ -w directoryDicts/top7000.txt -mc all -fc 404
```

### PHP directory scan with extensions
```bash
ffuf -u https://target.example/FUZZ -w directoryDicts/php/top3000.txt -e .php,.bak,.zip -mc all -fc 404
```

### Parameter fuzzing
```bash
ffuf -u 'https://target.example/index.php?FUZZ=test' -w paramDict/parameter.txt -mc all -fc 404
```

### API path fuzzing
```bash
ffuf -u https://target.example/api/FUZZ -w apiDict/api.txt -mc all -fc 404
```

## feroxbuster

### General content discovery
```bash
feroxbuster -u https://target.example -w directoryDicts/top7000.txt -x php,txt,bak
```

### Deep rescan
```bash
feroxbuster -u https://target.example -w directoryDicts/Filenames_or_Directories_All.txt
```

## gobuster

### Directory brute force
```bash
gobuster dir -u https://target.example -w directoryDicts/top7000.txt -x php,txt -k
```

### Subdomain enumeration
```bash
gobuster dns -d example.com -w subdomainDicts/main.txt
```

## wfuzz

### GET parameter fuzzing
```bash
wfuzz -c -z file,paramDict/parameter.txt 'https://target.example/search?FUZZ=test'
```

### POST parameter fuzzing
```bash
wfuzz -c -z file,paramDict/parameter.txt -d 'FUZZ=test' https://target.example/login
```

## Upload fuzzing hints

The exact upload command depends on the tool or proxy workflow, so the skill should usually provide a pattern instead of pretending there is one universal command.

Example guidance:

```text
Use uploadFileExtDicts/iis_upload_fuzz.txt as the filename or extension candidate list in your repeater, intruder, turbo intruder, or custom upload harness.
```

If the user wants automation, give a short pseudo-pattern such as:

```text
filename=avatar.aspx;.jpg
filename=shell.asp%20
filename=test.php5
```

## Response style reminder

- Keep commands editable.
- Do not overfit flags when the user did not specify their tooling.
- If the user names a tool, prefer that tool.
- If the user does not name a tool, default to `ffuf` for paths and parameters, `feroxbuster` for recursive content discovery, and `gobuster` for subdomains.
