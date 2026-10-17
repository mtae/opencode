# Session-history reload: alternative approaches (brainstorm)

Companion to `HANDOFF-SESSION-PERF.md`. The suspect path is
`SessionRunner.prepareContext` → `SessionContext.load` →
`SessionHistory.entriesForRunner` (`packages/core/src/session/history.ts:118`), which runs
`latestCompaction` + `select().all()` + decodes every row + filters, inside a transaction,
on every LLM step and retry. This document compares alternatives to (or in addition to) the
planned versioned `(sessionID, historyRevision)` cache. Estimates are unmeasured hypotheses
until Phase 1 baselines land; treat orders of magnitude as planning inputs, not facts.

## Ground truth from the code (so estimates have a denominator)

- Hot read: `packages/core/src/session/history.ts:78-108` `messageEntries`: `latestCompaction`
  (SQL with `json_extract` on compaction rows) + `select().all()` ordered by `seq` +
  `Effect.forEach(rows, decodeMessageRow)` (Effect `Schema.decodeUnknownEffect(SessionMessage.Info)`)
  + `findLast` native checkpoint + filter.
- Caller 1: `packages/core/src/session/context.ts:163-179` `SessionContext.load` → `entriesForRunner`
  (also calls `InstructionState.initial` in same transaction).
- Caller 2: `packages/core/src/session/store.ts:179` `SessionStore.context` → `SessionHistory.load(..., "latest")`
  used by `settleStaleToolCalls` (`packages/core/src/session/runner/llm.ts:362-385`).
- Conversion: `packages/core/src/session/runner/llm.ts:227-233` `SessionModelRequest.baseTranscript`
  calls `toLLMMessages` (`packages/core/src/session/runner/to-llm-message.ts:330`) per step.
- Mutations are not append-only: `packages/core/src/session/message-updater.ts` mutates assistant rows
  in place (tool streaming, step started/ended, text/reasoning ended, shell.ended) and updates
  compaction rows; projector (`packages/core/src/session/projector.ts`) appends on inbox delivery,
  instructions, synthetic, skill, shell.started, step, text, etc., and deletes on revert commit.
- DB: `packages/core/src/database/database.ts:39-44` sets WAL, synchronous=NORMAL, busy_timeout=5000,
  cache_size=-64000 (64 MiB), passive checkpoint. Indexes in `packages/core/src/session/sql.ts:92-97`
  include `(session_id, seq)` unique and `(session_id, type, seq)`.

## Evaluation axes

- **Speedup**: order of magnitude on the hot step path for long sessions.
- **Correctness risk**: likelihood of context divergence from the uncached path.
- **Impl cost**: S (days) / M (week) / L (weeks) / XL (month+).
- **Durable-event discipline**: compatible / partial / conflicts with AGENTS.md ("each step is one
  explicit `llm.stream` continuing from reloaded history"; no in-memory tool loop; durable events minimal).
- **Cache interaction**: mutually exclusive with the planned versioned cache, complementary, or subsumed.

## Summary table

| # | Approach | Speedup | Risk | Cost | Discipline | vs cache |
|---|---|---|---|---|---|---|
| 1 | Suffix/incremental decode | 2-10x avg | High | M-L | Compatible | Subsumed |
| 2 | Streaming/lazy decode | 2-10x avg | High | M | Compatible | Subsumed |
| 3 | Materialized projection table | 10-50x read | Medium-High | XL | Compatible* | Redundant |
| 4 | In-memory transcript, no reload | 10-100x | Very high | M | Conflicts | Makes cache optional |
| 5 | Compact more / trim outputs | 2-5x | Medium (quality) | S-M | Compatible | Complementary |
| 6 | Cheaper encoding / SQL pushdown | 1.5-3x | Low-Medium | M | Compatible | Complementary |
| 7 | DB tuning / indexes / prepared stmts | 1.2-3x | Low | S | Compatible | Complementary |
| 8 | Batch/parallel decode | 1-2x | Low | S | Compatible | Complementary |
| 9 | Worker thread decode | 1-2x* | Medium | L | Compatible | Orthogonal |
| 10 | Multi-step in-memory loop | 5-50x | Very high | XL | Conflicts (explicit) | Supersedes |
| 11 | Cache at model-request boundary | 2-5x retries | Low | S-M | Compatible | Fold into cache |
| 12 | Compress tool outputs in storage | 1-3x | Low-Medium | M | Compatible | Complementary |

\* worker gains are responsiveness, not total CPU.

## Alternatives in detail

### 1. Suffix/incremental decode (append-only fast path) with invalidation

- **Mechanism**: keep the decoded entry array; on reload, if the session revision indicates only new rows
  were appended past the cached tail, decode only the suffix and concatenate. On any rewrite (compaction,
  revert, in-place assistant update, fork, external write), invalidate and full-rebuild.
- **Touches**: `packages/core/src/session/history.ts` (messageEntries, decodeMessageRow), a new revision
  helper, `packages/core/src/session/context.ts` (load), `packages/core/src/session/projector.ts` and
  `packages/core/src/session/message-updater.ts` (invalidation hooks).
- **Speedup**: 2-10x average on long sessions in steady state; up to ~N/k when appends dominate. But the
  codebase mutates assistant rows in place during a step (`message-updater.ts` updateAssistant for tool
  streaming and terminal states), so "append-only" is false in practice; the fast path would miss many
  steps and fall back to full rebuild.
- **Correctness risk**: high. The invalidation matrix is large (see §Invalidation inventory). A missed
  trigger yields a stale transcript — the exact failure mode the reload-per-step design exists to prevent.
  This is the naive suffix cache the handoff says must be proven to fail in property tests.
- **Impl cost**: M-L.
- **Discipline**: compatible — reload still happens each step; this is a read optimization behind the same
  call. No invariant change.
- **vs cache**: subsumed. The planned versioned cache already does revision-gated reuse; adding a
  suffix fast-path inside it is an optional micro-optimization. Do not build standalone.
- **Verdict**: defer (fold into cache as a fast path only after the cache is correct and measured).

### 2. Streaming/lazy decode (only decode newly appended rows)

- **Mechanism**: variant of #1 where decode is deferred until `toLLMMessages`/consumer touches a row;
  rows carry a lazy thunk. Effectively lazy materialization of the projection.
- **Touches**: `packages/core/src/session/history.ts`, `packages/core/src/session/runner/to-llm-message.ts`,
  `packages/core/src/session/context.ts`.
- **Speedup**: same order as #1 in the best case; worse in practice because lazy thunks still run on the
  hot path (toLLMMessages walks all messages), so the decode cost is merely moved, not removed, unless
  paired with a cache.
- **Correctness risk**: high (same invalidation surface as #1, plus lifetime/GC of thunks).
- **Impl cost**: M.
- **Discipline**: compatible.
- **vs cache**: subsumed; adds complexity for no gain over a cached decoded array.
- **Verdict**: reject as standalone.

### 3. Persist a pre-decoded projection (materialized view) updated by projector

- **Mechanism**: new table (e.g. `session_context_projection`) storing the decoded/LLM projection,
  maintained by the projector in the same transaction as message writes; read becomes a single-row fetch
  with no decode.
- **Touches**: new migration + `packages/core/src/session/sql.ts`, `packages/core/src/session/projector.ts`
  (every append/update/delete path), `packages/core/src/session/history.ts` (read path), `packages/core/src/session/transfer.ts`
  and `packages/core/src/session/projector.ts:115-235` (fork copy), recovery/startup.
- **Speedup**: 10-50x on the read side for long sessions (one row vs N rows + decode). Write side gains
  nothing; every step still writes assistant rows, and projection updates add write amplification.
  Forks must rebuild/copy the projection.
- **Correctness risk**: medium-high. The projector is the single writer in-process, but forks batch-insert
  rows directly, external processes bypass the projector, and any new mutation site must update the
  projection or it drifts. Two sources of truth for the same data.
- **Impl cost**: XL.
- **Discipline**: compatible in principle — a read model is allowed ("enrich projections and read models");
  durable events stay minimal. But it centralizes mutation coupling in the projector, which is already
  the bottleneck for invalidation.
- **vs cache**: redundant. A process-local cache already removes DB reads on hits; the materialized view
  only helps cold starts and cross-process. Not worth it before measuring cold-start cost.
- **Verdict**: defer (revisit if cross-process sharing or cold-start decode dominates measurements).

### 4. Avoid reload entirely by holding an in-memory transcript in the runner (scoped)

- **Mechanism**: keep the last `Loaded` transcript in the runner; reuse unless a mutation signal fires.
- **Touches**: `packages/core/src/session/runner/llm.ts` (runStep, prepareContext), `packages/core/src/session/context.ts`.
- **Speedup**: 10-100x on the happy path (no DB read, no decode, no toLLMMessages).
- **Correctness risk**: very high. Without a revision check this silently misses external mutations,
  compaction-by-other-process, crash recovery, and forks. "Scoped" invalidation by signals is exactly
  the invalidation matrix problem, unsolved.
- **Impl cost**: M.
- **Discipline**: conflicts with "each step is one explicit `llm.stream` call that continues from reloaded
  history" unless reinterpreted as "reload gated by a cheap revision check" — which is just the planned
  cache. As written, it breaks the durable invariant.
- **vs cache**: makes the cache optional but only by dropping the revision check, which is the dangerous
  part. The cache keeps the check.
- **Verdict**: reject as stated; implement the revision-gated cache instead (#planned). Do not skip the check.

### 5. Reduce row count: compact more aggressively, trim tool outputs

- **Mechanism**: lower compaction `keep` / thresholds, cap tool output size at storage time, drop
  reasoning or large media earlier. `TOOL_OUTPUT_MAX_CHARS` already truncates compaction recent text
  (`packages/core/src/session/compaction.ts:100, 813-826`); extend to primary storage and projection.
- **Touches**: `packages/core/src/session/compaction.ts` (settings, splitConversation), `packages/core/src/session/tool-output.ts`,
  `packages/core/src/session/message-updater.ts` / projector (output caps), config.
- **Speedup**: 2-5x for tool-output-heavy and very long sessions; reduces both N and bytes per row.
- **Correctness risk**: medium but quality-oriented, not structural: trimming outputs can remove
  information the model needs; more aggressive compaction can lose detail. Needs quality evals, not just
  perf tests.
- **Impl cost**: S-M.
- **Discipline**: compatible. Compaction is already durable; trimming at the projection is a read-model
  concern. Durable events stay minimal.
- **vs cache**: complementary — smaller rows make cache hits cheaper and cold reads faster.
- **Verdict**: pursue (separate PR, with quality evals). Not a substitute for the cache.

### 6. Cheaper encoding: SQL-extracted columns, avoid JSON parse

- **Mechanism**: push filters (`type`, compaction `status`) into SQL via `json_extract` (already done for
  compaction boundary); store hot fields as columns; use `Bun` native JSON; skip `Schema.decode` for
  rows excluded by the replayable filter (currently decode happens before filter).
- **Touches**: `packages/core/src/session/history.ts:78-108`, `packages/core/src/session/sql.ts`,
  migrations, `packages/core/src/session/message.ts` (decode).
- **Speedup**: 1.5-3x. The decode is `Schema.decodeUnknownEffect(SessionMessage.Info)` per row; avoiding
  it for filtered rows and reducing JSON parse helps, but the dominant cost is still O(N) row reads.
- **Correctness risk**: low-medium. Skipping schema validation risks admitting corrupt rows; keep decode
  for admitted rows. Changing the stored shape needs a migration and careful rollback.
- **Impl cost**: M.
- **Discipline**: compatible.
- **vs cache**: complementary; mostly helps the cache-miss/cold path.
- **Verdict**: defer (do after cache; only if miss-path cost matters).

### 7. DB-level: indexes, prepared statements, mmap, page cache tuning

- **Mechanism**: verify `select().all()` uses the `(session_id, seq)` index; add `PRAGMA mmap_size`,
  `temp_store=MEMORY`, larger cache; reuse prepared statements; possibly `PRAGMA optimize`.
- **Touches**: `packages/core/src/database/database.ts:39-44`, `packages/core/src/session/sql.ts` (indexes),
  drizzle query sites in `packages/core/src/session/history.ts`.
- **Speedup**: 1.2-3x read; page cache helps repeated reads but is already 64 MiB. Cheap.
- **Correctness risk**: low (configuration). mmap on Windows/file locking needs care but is standard.
- **Impl cost**: S.
- **Discipline**: compatible.
- **vs cache**: complementary and independent.
- **Verdict**: pursue now (low cost, low risk, easy to measure). Note the existing indexes already cover
  the hot query; gains may be small — measure first.

### 8. Batch/parallel decode

- **Mechanism**: `Effect.forEach(rows, decodeMessageRow, { concurrency: N })` instead of sequential.
- **Touches**: `packages/core/src/session/history.ts:96-98`.
- **Speedup**: 1-2x. Bun is single-threaded; Effect concurrency interleaves, it does not add cores.
  May even regress due to scheduling overhead on large arrays.
- **Correctness risk**: low.
- **Impl cost**: S.
- **Discipline**: compatible.
- **vs cache**: complementary; trivial experiment.
- **Verdict**: defer (run as a measured micro-experiment; keep if it wins).

### 9. Move decode to a worker thread

- **Mechanism**: offload `decodeMessageRow` + filtering to a worker, returning decoded entries.
- **Touches**: new worker module, `packages/core/src/session/history.ts`, Effect interop.
- **Speedup**: 1-2x wall-clock responsiveness at best; total CPU unchanged. Serialization of large
  decoded message arrays across the worker boundary (structured clone) can cost as much as the decode.
- **Correctness risk**: medium (message objects with non-cloneable parts, schema types, Effect errors).
- **Impl cost**: L.
- **Discipline**: compatible.
- **vs cache**: orthogonal; does not reduce work.
- **Verdict**: reject for now (complexity and serialization cost likely erase gains).

### 10. Change invariant upstream: multi-step in-memory tool loop

- **Mechanism**: allow the runner to call `llm.stream` multiple times per logical turn without
  reloading/re-projecting between tool results, persisting at turn end.
- **Touches**: `packages/core/src/session/runner/llm.ts` (drain/runStep), `packages/core/src/session/runner/step.ts`,
  `packages/core/src/session/execution.ts`, recovery in `packages/core/src/session/execution/restart.ts`,
  compaction, inbox steering, revert.
- **Speedup**: 5-50x for tool-heavy turns (N steps → 1 reload).
- **Correctness risk**: very high — crash mid-turn loses in-flight steps; cross-client visibility
  delayed; steering/compaction mid-turn semantics change; recovery must be redesigned. This is an
  architecture change, not a perf tweak.
- **Impl cost**: XL.
- **Discipline**: directly conflicts with AGENTS.md: "Each step is one explicit `llm.stream` call that
  continues from reloaded history. Do not add an in-memory tool loop." Only pursuable as an explicit
  upstream change with evidence and a recovery design.
- **vs cache**: if adopted, the cache becomes optional but not harmful; the two are alternative
  architectures, not layers.
- **Verdict**: reject unless the engagement re-targets with a product decision. Keep documented.

### 11. Cache at the model-request boundary (`toLLMMessages`)

- **Mechanism**: memoize `toLLMMessages(messages, model, key)` so retries within a step (which call
  `context.load` → `baseTranscript` again) skip re-conversion.
- **Touches**: `packages/core/src/session/runner/to-llm-message.ts`, `packages/core/src/session/model-request.ts`
  (baseTranscript), `packages/core/src/session/runner/llm.ts` (retry path).
- **Speedup**: 2-5x on retry-heavy steps; negligible on the first attempt because messages change each step.
- **Correctness risk**: low if the key includes model ref, provider metadata key, and message identity/length.
- **Impl cost**: S-M.
- **Discipline**: compatible.
- **vs cache**: complementary; should be folded into the cached `Loaded` (store both decoded messages and
  the converted `Message[]`), not built as a separate cache.
- **Verdict**: pursue as part of the cache (not standalone).

### 12. Compression of large tool outputs before storage

- **Mechanism**: compress tool output strings in the projection (or at write) and decompress on read.
- **Touches**: `packages/core/src/session/message-updater.ts`, `packages/core/src/session/projector.ts`,
  `packages/core/src/session/history.ts` (decode), schema/migration.
- **Speedup**: 1-3x for output-heavy sessions; uncertain net because decompression CPU replaces parse CPU.
- **Correctness risk**: low-medium (must be lossless and preserve exact bytes the model saw).
- **Impl cost**: M.
- **Discipline**: compatible (encoding concern in the read model).
- **vs cache**: complementary (smaller cached payloads) but adds CPU to every cache miss.
- **Verdict**: defer (trim outputs first via #5; revisit with measurements).

## Invalidation inventory (what any cache must handle)

Mutation sites that change the history a runner reads. Missing any of these is the only way a cache
becomes dangerous.

- `packages/core/src/session/projector.ts:618-648` `InboxDelivered` → `insertMessage` (append user/synthetic).
- `packages/core/src/session/projector.ts:683-688` `InstructionsUpdated` → `run` + `InstructionState.apply` (append system message; updates instruction state).
- `packages/core/src/session/projector.ts:689-735` `Synthetic`, `Skill.Activated`, `Shell.Started/Ended`, `Step.*`, `Text.*`, `Tool.*`, `Reasoning.*`, `RetryScheduled`, `Compaction.*` → `run` (append or in-place update via `message-updater`).
- `packages/core/src/session/projector.ts:737-758` `RevertEvent.Staged/Cleared/Committed` → session revert state; commit deletes rows `>= boundary.seq` and resets instruction state (`InstructionState.reset`).
- `packages/core/src/session/projector.ts:115-235` `Forked` → copies a prefix of parent rows into a new session with new IDs and seeds instruction state.
- `packages/core/src/session/projector.ts:552-554` `Deleted` → cascades session + messages.
- `packages/core/src/session/message-updater.ts:215-479` in-place assistant updates (step started/streamed/ended/failed, text, tool, reasoning, retry) and compaction running→completed/failed; `session.message.content.updated` replaces content.
- `packages/core/src/session/compaction.ts` `Compaction.Ended` → `InstructionState.advanceEpoch` (epoch boundary changes what `initial` renders).
- Cross-process/external writes: other processes, migrations, crash recovery replay. Detect via a cheap revision query (`max(seq)`, `max(time_updated)`, `count(*)` per session), not process signals.

Also relevant: `packages/core/src/session/runner/llm.ts:72` `settleStaleToolCalls` does a full
`SessionStore.context` load (A6 in the handoff) — a second hot read worth measuring separately.

## Mutually exclusive / interaction notes

- #1/#2 (suffix/lazy decode) are variants of the planned cache's read path; building them standalone
  duplicates the invalidation work. Fold in only after the cache is correct and measured.
- #3 (materialized view) vs the process cache: redundant sources of truth. Pick one; the process cache
  is far cheaper and sufficient unless cross-process/cold-start decode proves dominant.
- #4 (no reload) and #10 (in-memory tool loop) are architecture breaks; if adopted they supersede the
  cache, but both conflict with AGENTS.md and require explicit upstream decisions.
- #5, #6, #7, #8, #11, #12 are complementary to the cache and can land independently.
- #9 (worker thread) is orthogonal and likely net-negative.

## Recommended portfolio

1. **Pursue now**: versioned revision-gated cache (the planned approach) + DB hygiene (#7) + output/compaction
   tuning (#5, separate PR with quality evals) + fold toLLMMessages memoization into the cached `Loaded` (#11).
2. **Defer**: SQL pushdown (#6), batch/parallel decode (#8, as a measured experiment), materialized view (#3),
   compression (#12), suffix fast-path inside the cache (#1).
3. **Reject now**: worker thread (#9), reload-avoidance without a revision check (#4), in-memory tool loop (#10)
   unless an explicit upstream change is approved.

## Open questions for measurement (Phase 1)

- Is reload actually the dominant per-step cost (A1)? If <20%, re-target.
- Decode vs SQL read vs toLLMMessages split (A2, A3).
- How often does the fast path invalidate in real sessions (compaction frequency, tool-update density)?
- Does `settleStaleToolCalls`/`store.context` dominate (A6)?
- End-to-end vs per-step latency (A10) — model latency may dwarf everything.
