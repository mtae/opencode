# HANDOFF: Security hardening — informed by the Oct 2026 credential-theft incident

> **READ THIS FIRST.** Complete handoff for a fresh session. Method: measure/verify in source, assume nothing,
> fix defense-in-depth (not single routes), use subagents on free Go models at max effort.

---

## 0. Context: what happened

On 2026-10-17, users reported bulk theft of external provider API keys (OpenAI/Anthropic) used **only** in OpenCode
(see tweets from @colinparsonscom: $281 + $168 overnight; @prestonzeller: $1,700). Three GHSAs were published:

| Advisory | Summary |
|---|---|
| GHSA-c83v-7274-4vgp | Malicious website → XSS in OpenCode web UI → execute commands on local system |
| GHSA-vxw4-wv6m-9hhh | Unauthenticated HTTP server allows arbitrary command execution |
| GHSA-632h-h47v-g4x4 | Cross-site server upgrade request installs arbitrary packages |

**Root architectural flaw:** one trust boundary ("local user's browser") guards everything. The local server holds
shell execution, filesystem writes, and RAW credential values behind it; the web UI renders untrusted content
(model output, tool output, fetched web pages) with no CSP/sanitizer/Trusted Types. One XSS inherits everything.

**This engagement's mission:** the maintainers' remediation patches the exploited routes. Our job is the
**defense-in-depth class fixes** their patch likely does NOT include — so the next XSS/RCE chain dies at layer 2
instead of layer 0.

## 1. Environment and ground rules

- Local clone: `C:\Users\aahlad\Documents\claude\opencode`. **Check `git status` and `git branch --show-current`
  FIRST — the perf engagement owns branch `session-history-cache` with uncommitted-adjacent work. Do NOT commit,
  stash, or switch anything that belongs to it. Create your own branch from `origin/dev` (default branch is `dev`)
  and switch back cleanly, or (safer) work from a fresh `git worktree` off `origin/dev`.**
- Fork remote: `fork` → https://github.com/mtae/opencode. Push work there; PRs target upstream `dev`.
- Fork README carries a NOT-THE-REAL-REPO banner — leave it.
- Issue #1 on the fork = the (separate) perf engagement. Don't touch it.
- Subagent doctrine: all substantive work in subagents, `model: "opencode-go/beam-free"`, "very thorough".
  Verify first: `opencode run --model opencode-go/beam-free "Reply with exactly: OK"`.
  **Do NOT use `opencode/*` (Zen free) models — they 403 (`Generation.FreeTierError`) for this account.**
- Known machine quirks: PowerShell default shell, may lack coreutils (use .ps1 script files); Cloudflare WARP was
  installed 2026-10-17 for network A/B testing — ignore or uninstall at the end, owner's choice.
- Repo rules (AGENTS.md): no tests from root, conventional commits, Effect style, `bun run check` green before done.

## 2. Established findings (verified in source 2026-10-17 — re-verify against latest `origin/dev`, the maintainers
   have been remediating)

1. **Stored XSS in share pages**: `packages/web/src/components/share/content-markdown.tsx` — `marked` output into
   `innerHTML` unsanitized (lines 9–29, 40, 53); unsafe href/title interpolation; `/s/[id]` (`packages/web/src/pages/s/[id].astro`)
   has no CSP.
2. **Raw secrets over API**: `packages/server/src/handlers/credential.ts:57-65` — `credential.list` returns
   `value` for every stored credential.
3. **Token in query string**: `packages/server/src/middleware/authorization.ts:32-35` accepts `?auth_token=`;
   `packages/app/src/entry.tsx:44-50` uses it; no Referrer-Policy anywhere → token in history + Referer.
4. **Origin check bypassable**: `packages/server/src/cors.ts:22-34` — same-origin test passes when Origin host ==
   Host (DNS rebinding); no Sec-Fetch-Site/Host allowlist; consumers in `handlers/pty.ts:127,147`.
5. **Pairing cookie not hardened**: `handlers/server.ts:45-51`, `auth.ts:57-61` — no Secure/__Host- for non-loopback hosts.
6. **No Clear-Site-Data / local purge on logout or credential removal**; persisted server connections in
   `packages/app/src/runtime/persistence/storage.ts`.
7. **No security headers on any host** (verified live 2026-10-17): no HSTS, CSP, nosniff, Referrer-Policy,
   Permissions-Policy, COOP, Reporting-Endpoints; `http://opencode.ai` serves 200 without HTTPS redirect.
   Owner: `packages/app/public/_headers` (app host), `packages/web/src/middleware.ts` (docs host), `infra/webapp.ts`.

**Re-verify each against current `origin/dev` first** — record what the maintainers' remediation already fixed;
those become regression tests, not work items.

## 3. The fix list (defense-in-depth, each independently shippable)

| # | Fix | Files | Effort | Kills which class |
|---|-----|-------|--------|-------------------|
| F1 | Sanitize markdown render (DOMPurify / no raw HTML) + escape link attrs, on share pages AND app timeline | `packages/web/src/components/share/*`, `packages/session-ui` timeline renderers | M | Every current + future XSS in rendered content |
| F2 | Security headers everywhere (CSP with nonce, HSTS, nosniff, Referrer-Policy: no-referrer, Permissions-Policy, COOP/CORP; frame-ancestors) + HTTPS redirect on :80 | `packages/app/public/_headers`, `packages/web/src/middleware.ts`, `infra/webapp.ts` | M | XSS impact, SSL-strip, clickjacking, referrer leaks |
| F3 | Trusted Types CSP directives for injection sinks | app/web CSP + review `innerHTML` sites | M | DOM XSS |
| F4 | Redact `credential.list` values; fetch single secret on demand | `handlers/credential.ts`, `packages/protocol/src/groups/credential.ts` | S | Bulk exfil in one request |
| F5 | Remove `?auth_token=` support; token via fragment→memory or POST body; add Sec-Fetch-Site + Host allowlist middleware | `middleware/authorization.ts`, `cors.ts`, `entry.tsx` | M | CSRF, rebinding, referrer theft |
| F6 | Harden pairing cookie (Secure on non-loopback, `__Host-` prefix, single-use already?) | `handlers/server.ts`, `auth.ts` | S | Cookie capture on tunnels |
| F7 | `Clear-Site-Data` on logout + purge persisted server passwords locally | app logout/credential-removal flows | S | Post-logout recovery on shared devices |
| F8 | `/.well-known/security.txt` on opencode.ai + Link headers | `packages/web/public`, host config | S | Responsible disclosure path |
| F9 | Per-route CSP report + Reporting-Endpoints (observe, then enforce) | app/web infra | M | Future-proofing |

Order: F4, F6, F8 (S, immediate) → F2 (M, biggest) → F1, F5 (M) → F3, F7, F9.

## 4. Falsification plan (before AND after each fix)

- For F1: differential test — render adversarial payloads (raw HTML, javascript: hrefs, event handlers, nested
  markdown, data: URIs) through old vs new renderer; new must produce inert DOM. Include prompt-injection-shaped
  content (model echoing fetched web pages).
- For F2/F3: header verification probes per host (script files + curl equivalent); CSP report-only phase first —
  collect violations for real usage before enforcing; verify no functional break in share pages, docs, app.
- For F4: property test — list response contains zero secret material for any credential set; UI flows that need
  the value still work (fetch-on-demand).
- For F5: rebinding simulation (Host: evil.com against 127.0.0.1), cross-site POST with/without Sec-Fetch headers,
  localhost-only tests still pass; confirm desktop/web app auth flow after removing query-param support.
- For F6/F7: cookie attribute assertions; logout leaves no recoverable token in storage.
- Verify the maintainers' remediation: for each GHSA, write the exploit-shaped test first; confirm it fails on
  patched dev (if it passes, their fix is incomplete — that's a finding).

## 5. Deliverables

1. Re-verified findings table (fixed-by-upstream vs still-open) on this issue
2. One commit-series per fix (F4 → F6 → F8 → F2 → F1 → F5 → F3 → F7 → F9), each with its falsification tests
3. Before/after header + exploit-probe table for every host (opencode.ai, app.opencode.ai, docs, local server)
4. Suggested upstream PR split + a short advisory-language summary the maintainers can reuse
