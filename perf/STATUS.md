# OpenCode perf work: status

Updated: 2026-10-19. The owner session is the Claude Code desktop session in `C:\Users\aahlad\Documents\claude`. Read this file, then TODO.md, after any compaction.

## Where things are
- **Worktree:** `C:\Users\aahlad\Documents\claude\opencode-perf`, branch `perf-harness` (origin/dev f36cda5bc8 plus timing hooks and harness), pushed to `mtae/opencode` (fork). Measurement only; never upstream.
- **Harness:** `packages/core/script/perf-bench/` (README there).
  - Run output must live outside the repo; `PERF_OUT` defaults to `$TMPDIR/opencode-perf-bench`. Run data inside the worktree made `opencode run` hang.
- **DB snapshot:** `%TEMP%\claude\C--Users-aahlad-Documents-claude\31cf3071-6fa5-499a-88d2-56fae3447484\scratchpad\perf\snap.db`. It's 212 MB, a VACUUM INTO copy of the live DB. Never write to the live DB at `~/.local/share/opencode/opencode.db`.
- **Bench sessions:**

  | Size | Session ID | Contents |
  |---|---|---|
  | small | ses_eb477754bffeGFnSXtQoHGXyGY | 39 msgs |
  | 3MB | ses_eb4a4ff6effe8626DC07AD7C4C | |
  | 5MB | ses_ebd46dc12ffeAFFE3457913E4A | |
  | 9MB | ses_eb90c95feffe65819DFE049147 | 27 JPEG screenshots |
  | 20MB | ses_eba6ab260ffe7Jsyw3DtRD9q5b | one 15 MB PDF inline in a read tool result |

## Live install: don't clash
- v2.0.32 is at `~/.opencode/bin/opencode`. Its service listens on 127.0.0.1:45278, and the desktop app OpenCode.exe is running.
- A from-source build is channel "local", so its service port is 45279. It discovers the service through `$XDG_STATE_HOME/opencode/service.json`.
- Always isolate XDG_DATA/CONFIG/STATE/CACHE_HOME plus OPENCODE_DB. Pass `--server` explicitly, and use ports 47900+.
- Kill processes by the PID on the port, never by name.

## Running side work (background agents launched 2026-10-19)
- **Full-text session search:** worktree `C:\Users\aahlad\Documents\claude\opencode-fts`, branch `session-fts`. Writes `FTS-NOTES.md` (uncommitted). No push or PR without the user.
- **Request-encoding research:** writes `scratchpad\stringify\REPORT.md`.

## Measured so far (origin/dev f36cda5bc8, Windows, from source, fake provider)
Gap between steps (provider response end → next request), CPU-bound the whole time:

| Session | Gap per step |
|---|---|
| small | ~95 ms |
| 5 MB | ~145 ms |
| 9 MB | ~400 ms |

Profiled per step, small session (120 ms with profiler overhead):

| Cost | ms |
|---|---|
| Effect runtime / GC (unattributed) | 37 |
| `Provider.snapshot` (8×/step, mostly `Integration.list`) | 26 |
| DB | 16 |
| Request build/encode | 15 |
| Projectors | 13 |
| Tool JSON schema (28 calls) | 5 |
| History decode | 5 |

Profiled per step, 9 MB session (623 ms):

| Cost | ms |
|---|---|
| History load+decode | 315 |
| Request build/encode | 104 |
| Runtime | 92 |
| DB (mostly the history select, whose stack is lost through async) | 62 |
| `Provider.snapshot` | 23 |
| Projectors | 14 |

Other findings:
- **Base64 regex cliff** (`packages/schema/src/prompt.ts:22`): an image over ~424K chars costs 35–322 ms. It's 158 ms of the 224 ms history decode at 9 MB. The linear replacement is proven equivalent and verified on 980,800 strings. Upstream: #45558 and fix PR #51272, which is unreviewed and needs a rebase.
- **History cache on branch `session-history-cache`:** an exact-sequence hit only, so it never hits in a tool loop. The right design is a delta/prefix cache keyed by row `time_updated`. Upstream issue #51497 (gaojunran, 2026-09-26) has no live PR.
- **Per-step provider request encode:** 6.9 MB, ~50 ms of `JSON.stringify` plus the schema encode. It's re-done in full every step.
- **Startup, binary v2.0.32:** 0.7–1.3 s with an empty DB, 2.2 s with the real DB (+1–1.5 s, unexplained). From source it takes ~17 s, mostly transpiling; ignore that number.
- **Upload:** 7 MB per step is ~0.2 s at 300 Mbps, so it's secondary on fiber. The request-size cap (Anthropic 32 MB, unverified today) matters for heavy image sessions.

## Upstream activity (as of 2026-10-19)
- **kitlangton** opened ~40 PRs today. Measure these areas but don't work on them:
  - media: #56989, #56990, #56991, #56993
  - memory: #57005, #57025
  - render: #57016, #57004, #56992, #56995
  - server: #57019, #57011, #57223 (catalog refresh coalescing; check overlap with `Provider.snapshot`), #56994 (snapshot reuse)
  - compaction: #57220
- **Hona** is mostly on app/desktop UX and Windows install. Perf involvement is unverified.

## Decisions
- No ultracode or workflows. The ceiling is Opus 5.5 extra-high.
- Any upstream issue, PR or comment needs the user's go-ahead. PR bodies are verbatim with no Claude footer.
- Commits on perf-harness: author mtae, plus the Co-Authored-By line.
