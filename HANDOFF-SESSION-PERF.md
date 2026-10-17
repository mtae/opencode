# HANDOFF: Session-history reload performance — benchmark, falsify, fix, verify

> **READ THIS FIRST.** This document is a complete handoff for a fresh session to execute.
> Target product: the **OpenCode CLI** (packages/core, packages/server, packages/tui, packages/cli).
> **The desktop app (packages/desktop) is a separate beta product — do not touch it, do not conflate it.**
> Method for the whole engagement: measure first, assume nothing, try to falsify every belief (Dan Luu style),
> and use subagents on free Go models for all substantive work.

---

## 0. Mission

`prepareContext` re-reads and re-decodes the **entire session history from SQLite on every LLM step and retry**
(O(total tokens) per step). It is believed to be the dominant per-step CPU cost for long sessions and the thing
that makes big-context sessions progressively slower. This engagement must:

1. **Benchmark** current behavior thoroughly and establish trustworthy baselines.
2. **Falsify or confirm every assumption** below with measurements — including the assumption that the reload is
   actually the bottleneck.
3. **Design and implement** a correct, invalidated cache (or whatever the measurements say is actually worth doing).
4. **Verify correctness** against the uncached path and the repo's session-core invariants.
5. **Benchmark after** and report honest, distribution-level results.

Success = a change that is provably context-identical to the uncached path and measurably cheaper on the hot path,
with baselines and after-numbers anyone can reproduce.

---

## 1. Environment and ground rules

### Where things are
- Local clone: `C:\Users\aahlad\Documents\claude\opencode` (branch: `session-history-cache`, fork remote: `fork` → https://github.com/mtae/opencode, upstream: `origin` → anomalyco/opencode). Base all work on `origin/dev` — the default branch is `dev`.
- Installed client used for live measurement: opencode v2.0.32, Windows 11, service on 127.0.0.1.
- Measurement harness you can extend: `packages/app/e2e/performance/**` (~30 benchmark specs).

### Repo rules that are non-negotiable (from AGENTS.md)
- Branch names: ≤3 words, hyphenated, no type prefixes. Commits/PRs: `type(scope): summary` (`fix(core): ...`).
- **Never run tests from repo root** (guard `do-not-run-tests-from-root`); run from package dirs (e.g. `cd packages/core`).
- `bun run check` from root = full lint/typecheck; `bun typecheck` from the affected package during iteration.
- No `any`, no `try/catch` unless necessary, prefer `const`, no star imports, Effect style per `AGENTS.md`.
- Durable-event discipline: record irreducible facts only; keep prompt admission separate from model execution; one step = one `llm.stream` call continuing from reloaded history (this invariant is the reason the current design exists — respect it or explicitly change it upstream with evidence).
- Do not edit generated client files; after changing HttpApi, run `bun run generate` from `packages/client`.
- English strings and i18n rules only matter if you touch UI copy (avoid touching UI copy).

### Subagent usage (per engagement owner)
- Use the `subagent` tool liberally; **all subagents run with `model: "opencode-go/beam-free"` and maximum effort ("very thorough")**.
- Verified working as of 2026-10-17: `opencode run --model opencode-go/beam-free "Reply with exactly: OK"` → `OK` in ~900 ms.
- **Do NOT use `opencode/*` (Zen free) models** — they currently 403 (`Generation.FreeTierError`) for this account.
  If a subagent fails with that error, re-check with the `opencode run` command above; if it fails too, free models
  are down again — fall back to waiting/retrying, and do NOT silently switch to paid models without saying so.
- Second free Go model if needed: `opencode-go/longcat-2.5-preview-free`.
- Known local quirks: the shell may lack coreutils (use PowerShell script files for system tasks); a stale hung
  `msiexec` and a half-installed Cloudflare WARP exist on this machine — ignore unless they block you.

---

## 2. What we already know (evidence so far — re-verify, don't trust)

### The suspect path
- `packages/core/src/session/runner/llm.ts` `runStep` (~lines 209–330): every step and retry calls
  `prepareContext` → `context.load` (`packages/core/src/session/context.ts:163`) →
  `SessionHistory.entriesForRunner` (`packages/core/src/session/history.ts:118`) which does
  `latestCompaction` + `select().all()` + **decode of all rows** + `toLLMMessages`, inside a transaction.
- `store.context` (`store.ts:179`) additionally does a full `SessionHistory.load(..., "latest")` used by
  `settleStaleToolCalls` (`llm.ts:365`).
- Design rationale (why it exists): history can be mutated between steps by compaction, revert stage/commit,
  forks, inbox steering, other tabs/processes, crash recovery. Reload-per-step makes every step trivially correct.
  Their session-core doc states: "Each step is one explicit llm.stream call that continues from reloaded history."

### Live numbers captured 2026-10-17 (this machine, re-measure anyway)
- `opencode --version`: ~180–200 ms. `opencode service status`: ~285 ms (dominated by process spawn).
- End-to-end `opencode run` on a free Go model: ~900 ms total.
- Binary: 204 MB single-file Bun. CLI start is lazy-loaded per subcommand.
- Event stream: server SSE, per-subscriber queue capacity 4,096, slow consumers disconnected
  (`packages/server/src/event-feed.ts`); client batches at 16 ms (`packages/client/src/solid/connection.ts:65`,
  `flushInterval: 16` in app `client.tsx:94`).
- Timeline: virtualized (`@tanstack/solid-virtual`), projection with row-identity reuse
  (`packages/session-ui/src/timeline/projection.ts`), messages paginate at 20
  (`packages/client/src/solid/data.ts:84`).
- Benchmarks assert scenario completion and metric **collection**, NOT wall-clock budgets
  (`packages/app/e2e/performance/AGENTS.md`). There are no hard latency budgets today.

---

## 3. Assumptions to FALSIFY (each one: measure, then believe or kill)

| # | Assumption | How to try to kill it |
|---|---|---|
| A1 | Per-step full history reload is the dominant per-step CPU cost for long sessions | Instrument: separate ms for SQLite read vs row-decode vs `toLLMMessages` vs everything else in `runStep`. If reload <20% of step time, this whole engagement re-targets the real top cost |
| A2 | The SQLite read is cheap; decode is the cost | Measure separately: raw `select().all()` time vs decode time vs `toLLMMessages` at 100 / 1,000 / 5,000 / 20,000 messages |
| A3 | Decode cost is linear and unavoidable | Profile decode: is it schema/JSON parse bound? Is there a cheaper encoding (columns already extracted by SQL)? |
| A4 | Rows only ever append between steps (suffix-cache validity) | Try to falsify: compaction mid-session, revert stage/commit mid-session, fork then continue, message edits from a second client, crash recovery replay. Any of these rewriting old rows kills naive suffix caching |
| A5 | A cached projection can be invalidated reliably | Property test: random adversarial mutation sequences (steer, compact, revert, fork, external DB write) — cached context MUST be byte-identical to fresh uncached context |
| A6 | `settleStaleToolCalls` / `store.context` full loads matter too | Measure them separately; they may dominate or be irrelevant |
| A7 | Measurement itself is trustworthy | Verify instrumentation overhead (~0); check clock granularity; warm vs cold runs differ (Bun JIT, SQLite page cache, OS file cache); take N≥15 runs, report median + MAD, not single numbers |
| A8 | Compaction checkpoints make suffix loads valid | Verify checkpoint semantics in `history.ts` / compaction code; a checkpoint that rewrites message visibility invalidates suffix logic |
| A9 | The event-feed `JSON.stringify` per subscriber is also significant | Measure with large tool outputs; if yes, note as follow-up (do not scope-creep) |
| A10 | Fixing this changes end-to-end step latency visibly | Decide with data: report per-step ms AND end-to-end `opencode run` ms; if end-to-end is dominated by model latency, say so honestly in the final report |

Rule: any assumption that survives an honest falsification attempt gets to inform the design. Any that dies gets a
written obituary in the final report (what we believed, what we measured, what's true).

---

## 4. Phase 1 — Baseline benchmarking (no code changes yet)

Instrument, don't guess:

1. Add cheap, removable timing instrumentation around: `entriesForRunner` (total), the raw SQL read, row decode,
   `toLLMMessages`, `store.context` full load, and `prepareContext` overall. Log per step: ms per phase + message
   count + decoded token estimate + sessionID. (Keep it behind a single local commit you can drop later.)
2. Build synthetic session fixtures at 4 scales (100 / 1,000 / 5,000 / 20,000 messages; mix of tool calls, large
   tool outputs, compaction checkpoints). Store generators under `packages/core/test/` fixtures — follow existing
   fixture patterns.
3. Measure on real sessions too: the local DB at `C:\Users\aahlad\.local\share\opencode\opencode.db` has real
   long sessions (book-building project with heavy subagent use). Copy the DB, never benchmark against the live one.
4. Protocol: N≥15 warm runs per point, report median/MAD/p95; interleave scales to decorrelate drift; record
   Bun version, DB size, page-cache state. Run from `packages/core`.
5. Deliverable: `BASELINE.md` committed on this branch with tables per scale and the A1/A2/A6 verdicts.

## 5. Phase 2 — Design (only after baselines)

Chosen direction (verify against measurements before building):
- Cache the decoded LLM-message projection keyed on `(sessionID, historyRevision)`; revision = cheap durable
  sequence (max message rowid + durable-event counter). Step path: revision match → reuse; else suffix-load past
  cached tail; compaction/revert/fork/delete → revision bump → full rebuild.
- Inventory EVERY invalidation trigger before writing code (grep the mutation sites: compaction commit, revert
  stage/commit/clear, fork, session.remove, inbox update, `settleStaleToolCalls`, external writes). Missing one is
  the only way this change can be dangerous — treat the inventory as a checklist that the property tests (Phase 3)
  enumerate exhaustively.
- Keep the cache inside `packages/core/src/session/` (process-local to the runner). Do NOT cache across processes;
  do NOT put it in the UI layer. The TUI/app already paginate independently.

## 6. Phase 3 — Correctness & falsification tests (write BEFORE the optimization)

In `packages/core` (bun test; never from root):

1. **Equivalence property test** (the core falsifier): model a session as an op-sequence; ops = append user/assistant
   message, tool call/result, compact, revert stage/commit/clear, fork, steer, interrupt-resume, external row edit.
   For thousands of random op-sequences: assert cached-path context ≡ uncached-path context (exact structure equality).
   This test must FAIL on a naive suffix cache with a rewrite op (proves it can fail).
2. **Invalidation matrix**: one test per trigger from the Phase 2 inventory.
3. **Crash/restart test**: kill mid-sequence, recover, continue — context must match a never-cached run.
4. **Concurrency test**: two runners on the same sessionID (their `SessionRunCoordinator` should prevent this —
   verify, and test it anyway).
5. Keep their testing rules: no mocks of things the real thing does better, tests must be able to fail, one contract
   per test, control time with `setSystemTime` from `bun:test`.

## 7. Phase 4 — Implementation

- Style: Effect patterns per root AGENTS.md, no `any`, no nested service yields, inlinable helpers inline, comments
  only for non-obvious constraints (the invalidation invariant DESERVES a comment).
- Keep the instrumentation from Phase 1 behind a debug flag until the end; remove before final commit.
- Commit in small conventional commits: `feat(core): versioned session history context cache`, etc.

## 8. Phase 5 — After-benchmark & report

- Re-run Phase 1 protocol identically (same fixtures, same N, interleaved, warm).
- Report: per-scale medians before/after with MAD, per-step and end-to-end, plus the A1–A10 verdict table
  (assumption → measurement → verdict). Include negative results without spinning them.
- `bun run check` green; full correctness suite green; PR targets `dev` on upstream or the fork, owner's choice.

---

## 9. Subagent orchestration plan (free Go models, max effort)

- **Explore (very thorough)**: inventory all history-mutation sites for the invalidation matrix; map
  `entriesForRunner` call graph; verify compaction checkpoint semantics; audit `store.context` usage.
- **General (very thorough)**: build the fixture generators + equivalence property test harness; write the
  instrumentation; run benchmark batches and tabulate.
- Batch subagents so several run concurrently; give each one self-contained context (they cannot see this session).
- Every subagent prompt must include: repo path, "very thorough", the exact files to touch, the output format, and
  "no claims without a file path".

## 10. Current-state checklist for the new session

- [ ] Verify free Go models work: `opencode run --model opencode-go/beam-free "Reply with exactly: OK"`
- [ ] `git -C C:\Users\aahlad\Documents\claude\opencode status` — clean, on `session-history-cache`
- [ ] `git fetch origin` and confirm based on latest `origin/dev`
- [ ] Read `packages/core/src/session/runner/llm.ts`, `session/history.ts`, `session/context.ts` before believing
      anything in §2
- [ ] Do NOT touch packages/desktop
- [ ] File the plan-vs-reality deltas as commits to this handoff doc as you learn
