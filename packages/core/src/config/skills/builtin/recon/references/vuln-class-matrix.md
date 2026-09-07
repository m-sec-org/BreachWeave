# Recon Vulnerability Class Matrix

Use this reference when turning observed surface into hypotheses.
Each row answers three recon questions:
- What signals should be noticed now?
- What evidence should be saved now?
- How should `next_test` be framed for `targeted-pentest`?

This is a discovery matrix, not an exploit playbook.

## Access And State

| Class | Watch For | Save As Evidence | Good `next_test` |
| --- | --- | --- | --- |
| IDOR | User-controlled object IDs, leaked UUIDs, global IDs, export or history endpoints, method or version variants | Requests that carry object references, where IDs originate, role or account labels | Replay the same action against a sibling object ID or alternate method while keeping attacker auth unchanged. |
| Broken auth or access control | Admin or internal endpoints, client-side role gating, missing middleware siblings, legacy paths, debug routes | Route inventory, role hints from UI or JS, auth-required vs auth-missing response diffs | Test whether server-side auth and authorization are enforced for a lower-privilege account on the same endpoint family. |
| Business logic | Multi-step flows, hidden flags, mutable price or quantity fields, inconsistent workflow order, side effects split across endpoints | Workflow map, request sequence, mutable state fields, transitions between steps | Test whether a step can be skipped, repeated, or reordered at the identified workflow edge. |
| Race condition | Check-then-use flows, redeem or verify endpoints, missing idempotency keys, stock or credit counters, approval actions | Endpoint sequence, reusable tokens or codes, timing notes, duplicate side-effect opportunities | Send controlled parallel requests against the same state-changing endpoint and compare resulting state. |
| OAuth or OIDC | `authorize` and `callback` flows, `redirect_uri`, `state`, `code_challenge`, multiple redirectors, mobile or legacy clients | Full auth URL captures, redirect chain, parameter set, cookies around login | Test whether PKCE, `state`, and redirect target validation are enforced on the observed flow. |
| MFA or 2FA bypass | Pre-MFA sessions, OTP verify APIs, remember-device cookies, backup-code flows, split login states | Login flow map, cookies, headers, retry behavior, session state before and after MFA | Test whether pre-MFA state still grants access or whether OTP or device trust can be reused incorrectly. |
| ATO paths | Password reset, email change, invite acceptance, magic-link login, session fixation indicators, reset tokens in URLs | Reset flow captures, link hostnames, token locations, referrer or redirect behavior | Test whether the recovery or account-change flow can be rebound, replayed, or consumed by the wrong party. |
| SAML or SSO | ACS endpoints, `SAMLResponse`, NameID mapping, metadata URLs, custom login bridges, XML-based handlers | Endpoint list, auth flow captures, parameter names, metadata or config references | Test whether the assertion consumer validates signatures, issuer, and trusted identity attributes on the observed flow. |

## Input And Execution

| Class | Watch For | Save As Evidence | Good `next_test` |
| --- | --- | --- | --- |
| XSS | Reflection points, rich-text fields, DOM sinks, markdown rendering, template-like syntax, unsafe client-side parsing | Reflected parameters, sink snippets, page locations, encoding or sanitization behavior | Test whether attacker-controlled input reaches a server or DOM sink in executable context on the identified surface. |
| SSRF | URL fetchers, webhook targets, import-by-URL, avatar or image fetchers, PDF renderers, callback fields | Parameters that accept URLs, outbound-fetch features, redirect behavior, allowed scheme hints | Test whether the server fetches attacker-controlled URLs and whether internal or metadata destinations are reachable. |
| SQLi | Search, filter, sort, report, export, raw query builders, numeric ID filters with backend error variance | Query parameters, request bodies, content-length or error diffs, query-building code snippets if available | Test whether the identified backend parameter changes query semantics or error behavior when minimally perturbed. |
| File upload | Image or document upload, archive import, parser transforms, SVG handling, filename reuse, preview endpoints | Accepted file types, upload and storage path, preview or processing flow, parser stack hints | Test whether upload validation trusts metadata, parser choice, or filename handling at the observed upload path. |
| GraphQL | Introspection exposure, `node` or global IDs, batching, role-specific resolvers, hidden operations in JS | Schema snippets, operation names, ID format, resolver names, batch support evidence | Test whether resolver authorization fails for foreign object IDs, batched calls, or global ID access. |
| LLM or AI features | Chat inputs, file-grounded prompts, retrieval or memory, tool use, cross-user context, markdown rendering by AI output | Prompt entry points, available tools, model actions, file ingestion flow, visible scoping controls | Test whether attacker-controlled prompt or file content can change tool scope, leak other-user data, or trigger unsafe rendering. |
| API misconfiguration | Mass-assignment-shaped update bodies, permissive CORS, JWT or JWKS exposure, merge endpoints, hidden flags | Editable field lists, response schemas, CORS headers, token metadata, config snippets | Test whether extra fields, alternate origins, or token-algorithm assumptions affect authorization or object integrity. |
| SSTI | Templated documents, email or PDF generation, server-rendered previews, handlebars or Jinja-like syntax, reflected headers | Templating surface, render context, server-side engine hints, input reflection positions | Test whether user-controlled input is interpreted by the server template engine at the observed render path. |

## Edge, Infra, And Transport

| Class | Watch For | Save As Evidence | Good `next_test` |
| --- | --- | --- | --- |
| Cloud or infra misconfig | Public buckets, open Firebase-style stores, exposed admin panels, metadata reachability hints, internal service banners | Storage URLs, admin panel paths, response headers, cloud-provider hints | Test whether the exposed cloud or admin surface is readable, writable, or reachable from the application path. |
| HTTP request smuggling | Front proxy plus backend mismatch hints, HTTP/2 downgrade edges, unusual timeout behavior, conflicting hop headers | Raw request and response captures, proxy headers, protocol notes, timeout observations | Test whether front-end and back-end parsers disagree on request boundaries for the identified endpoint chain. |
| Cache poisoning or deception | Shared caches, `x-cache` headers, unkeyed inputs, static-looking private paths, inconsistent cache directives | Response headers, reflective unkeyed inputs, cache hits, variant URL forms | Test whether unkeyed input or path confusion can poison or expose cached private content on the observed route. |

## Coverage Notes

- Not every class applies to every target. Use feature-driven coverage, not a mechanical checklist.
- If a class has plausible signals but missing comparative evidence, add a focused `coverage_gap`.
- If a class depends on a surface you have not seen, do not invent a hypothesis. Record the missing surface instead.
