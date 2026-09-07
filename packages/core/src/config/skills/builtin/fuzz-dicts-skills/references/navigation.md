# Dictionary Navigation

This file is the navigation source of truth for the `fuzz-dicts-navigator` skill.

Paths are relative to the repository root.

## Quick Routing Matrix

| Scenario | First Choice | Fallback | Why |
| --- | --- | --- | --- |
| General directory scan | `directoryDicts/top7000.txt` | `directoryDicts/Filenames_or_Directories_All.txt` | `top7000` is a balanced first pass. The larger file is broader but noisier. |
| PHP directory scan | `directoryDicts/php/top3000.txt` | `directoryDicts/php/phpFileName.txt` | Smaller PHP-first scan, then more filename coverage. |
| JSP directory scan | `directoryDicts/jsp/top100.txt` | `directoryDicts/vuls/tomcat.txt` | Very small JSP seed list plus Tomcat-specific paths. |
| ASP or ASP.NET directory scan | `directoryDicts/asp/top30000.txt` | `directoryDicts/vuls/iis.txt` | Broad ASP-oriented list plus IIS-specific known paths. |
| Known vulnerable paths | `directoryDicts/vulns.txt` | `directoryDicts/vuls/all.txt` | `vulns.txt` is small and fast. `vuls/all.txt` is broader. |
| Parameter fuzz | `paramDict/parameter.txt` | `paramDict/AllParam.txt` | Start curated, then widen. |
| PHP parameter fuzz | `paramDict/php.txt` | `paramDict/AllParam.txt` | PHP-heavy applications benefit from the PHP-specific list first. |
| JS or frontend parameter clues | `paramDict/js.txt` | `js/jsFileDict.txt` | Useful when the target exposes JS-driven keys or static asset names. |
| Directory-style route params | `paramDict/dir.txt` | `paramDict/burp.txt` | Good for route and path-like parameter names. |
| API discovery | `apiDict/api.txt` | `paramDict/AllParam.txt` | Start with path names, then fuzz parameters. |
| Spring Boot clues | `spring/spring-configuration-metadata.txt` | `apiDict/api.txt` | Metadata-style names often reveal actuator or config-shaped endpoints. |
| Upload bypass fuzz | `uploadFileExtDicts/all_upload_fuzz.txt` | stack-specific upload list | Broad upload extension coverage when stack is unclear. |
| PHP upload bypass | `uploadFileExtDicts/php_upload_fuzz.txt` | `uploadFileExtDicts/apache_upload_fuzz.txt` | PHP-specific tricks first, then Apache behavior. |
| JSP upload bypass | `uploadFileExtDicts/jsp_upload_fuzz.txt` | `uploadFileExtDicts/tomcat_upload_fuzz.txt` | Useful for Java upload filters and Tomcat parsing behavior. |
| ASP or IIS upload bypass | `uploadFileExtDicts/asp_upload_fuzz.txt` | `uploadFileExtDicts/iis_upload_fuzz.txt` | ASP-specific payloads plus IIS parsing variations. |
| Linux or Windows upload target | `uploadFileExtDicts/linux_upload_fuzz.txt` or `uploadFileExtDicts/win_upload_fuzz.txt` | `uploadFileExtDicts/all_upload_fuzz.txt` | Choose by server OS when known. |
| Username guessing | `userNameDict/top500.txt` | `userNameDict/常用用户名.txt` | Small login-first sets. |
| Chinese user naming patterns | `userNameDict/中文姓名(简写、全拼).txt` | `userNameDict/top300_lastname.txt` | Useful for internal enterprise naming conventions. |
| Password spraying | `passwordDict/top1000.txt` | `passwordDict/top19576.txt` | Start small for safety and signal, then expand. |
| Strong-weak password style | `passwordDict/RW_Password/` | `passwordDict/某集团下发的弱口令字典.txt` | Better for real enterprise habits than trivial defaults. |
| IoT or unknown device weak creds | `lotDict/password.txt` | `routerDicts/pass.txt` | Good for devices, routers, and odd panels. |
| Router defaults | `routerDicts/pass.txt` | `passwordDict/路由器默认密码.txt` | Router-focused default credentials. |
| Subdomain enumeration | `subdomainDicts/main.txt` | `subdomainDicts/dic1.txt` | `main.txt` is the broad working set. |
| XSS payloads | `easyXssPayload/easyXssPayload.txt` | `easyXssPayload/burpXssPayload.txt` | The main file is broader. Burp payloads are smaller and easier to start with. |
| SQL injection payloads | `sqlDict/sql.txt` | none | Compact SQLi fuzz payload list. |
| SSRF or LFI style probes | `ssrfDicts/ssrf.txt` | `ssrfDicts/lfi-scanner.txt` | SSRF payloads first, then LFI-focused probes. |
| Linux file path probes | `ssrfDicts/linux常见路径.txt` | `ssrfDicts/proc.txt` | Good for file read and path traversal checks. |
| XXE payloads | `XXEDicts/README.MD` | none | This repo stores XXE material as reference payload examples rather than a single wordlist file. |
| RCE payloads | `rcePayloads/Top-46-RCE-Parameters.txt` | `rcePayloads/Unix-Commond-Inject-Payload-List.txt`, `rcePayloads/Windows-Commond-Inject-Payload-List.txt` | Separate parameter discovery from platform-specific command payloads. |
| CTF path fuzzing | `ctfDict/ctf.txt` | `ctfDict/ctf-wscan/` | Use only when the context is clearly CTF-oriented. |

## Directory Scan Details

- `directoryDicts/top7000.txt` has about 6983 lines and is a strong default first pass.
- `directoryDicts/Filenames_or_Directories_All.txt` has about 45522 lines and is better for coverage-heavy rescans.
- `directoryDicts/vulns.txt` has about 186 lines and is excellent for fast checks of common vulnerable paths.
- `directoryDicts/vuls/all.txt` has about 5668 lines and aggregates server or middleware-specific paths.
- `directoryDicts/vuls/` contains targeted files such as `iis.txt`, `tomcat.txt`, `weblogic.txt`, `websphere.txt`, `Traversal.txt`, and `XXEExploit.txt`.

## Parameter Fuzz Details

- `paramDict/parameter.txt` has about 5845 lines and is the curated default.
- `paramDict/AllParam.txt` has about 74331 lines and is for exhaustive passes.
- `paramDict/php.txt` has about 23269 lines and is useful when the app is PHP-heavy.
- `paramDict/js.txt` has about 5078 lines and is useful when keys come from frontend JavaScript.
- `paramDict/burp.txt` has about 2262 lines and works as a lighter alternative.
- `paramDict/Arjun/db/params.txt` is useful if the user also wants to pair this repository with Arjun.

## Upload Fuzz Details

- `uploadFileExtDicts/all_upload_fuzz.txt` has about 32991 lines and is the broad fallback.
- `uploadFileExtDicts/php_upload_fuzz.txt`, `jsp_upload_fuzz.txt`, and `asp_upload_fuzz.txt` each provide stack-aware extension variations.
- `uploadFileExtDicts/iis_upload_fuzz.txt`, `apache_upload_fuzz.txt`, and `tomcat_upload_fuzz.txt` target server parsing behavior.
- `uploadFileExtDicts/fileExt` is a tiny extension seed file with `php`, `jsp`, `asp`, and `aspx` examples.

## Credential Dictionaries

- `userNameDict/` is for login names and naming conventions.
- `passwordDict/top1000.txt` is safer as a first pass than the very large password lists.
- `passwordDict/top19576.txt` is the large generic fallback.
- `passwordDict/RW_Password/` is better when the user wants realistic strong-looking weak passwords.
- `lotDict/password.txt` and `routerDicts/pass.txt` are niche but useful for device and router contexts.

## Recon-Oriented Add-ons

- `apiDict/api.txt` has about 212 API-related entries.
- `js/jsFileDict.txt` helps discover predictable JavaScript file names.
- `subdomainDicts/main.txt` has about 167378 lines and is the main subdomain corpus.
- `spring/spring-configuration-metadata.txt` helps when the target smells like Spring Boot or Actuator.

## Payload-Oriented Sets

- `easyXssPayload/easyXssPayload.txt` has about 1850 XSS payloads.
- `easyXssPayload/burpXssPayload.txt` has about 209 payloads and is a compact starter set.
- `sqlDict/sql.txt` has about 191 SQL payloads.
- `ssrfDicts/ssrf.txt` has about 801 SSRF probes.
- `ssrfDicts/lfi-scanner.txt`, `proc.txt`, `config.txt`, `centsOS_etc.txt`, and `aix_etc.txt` are useful when probing file read and SSRF-to-local-file scenarios.
- `XXEDicts/README.MD` contains example payloads and references rather than a single `.txt` dictionary.
- `rcePayloads/` contains command injection payload files and parameter-name seeds.

## Recommendation Heuristics

- Unknown stack: start with a balanced general list.
- Known stack: go stack-specific first.
- Fast triage: prefer `vulns.txt`, `parameter.txt`, `top1000.txt`, `burpXssPayload.txt`.
- Deep coverage: escalate to `Filenames_or_Directories_All.txt`, `AllParam.txt`, `all_upload_fuzz.txt`, `subdomainDicts/main.txt`.
- Real devices or panels: check `lotDict/`, `routerDicts/`, and service or middleware password folders.
