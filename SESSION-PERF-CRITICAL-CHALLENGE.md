# Critical Challenge: Is per-step session-history reload the right scope?

**Branch:** `session-history-cache` (base `origin/dev`)  
**Source of scope:** `HANDOFF-SESSION-PERF.md` §0–§3, assumptions A1–A10  
**Verdict up front:** The assumed problem is **unproven and currently unsupported by any measurement**.  
Do **not** implement the history cache yet. Run Phase 1 baselines first and apply the decision gate in §5.  
If the gate fails, kill or re-target the engagement.

This report challenges the handoff's core claim using only repository evidence plus the handoff's own live numbers.  
Speculation is explicitly labeled.

---

## 1. Is reload actually the dominant per-step CPU cost? (A1)

### What the code actually does

- `packages/core/src/session/runner/llm.ts:209-219` (`runStep`): on the first attempt `first` is used; on every retry/continuation it calls `prepareContext(sessionID)` then `context.load`, i.e. a fresh full reload (`llm.ts:218`).
- `packages/core/src/session/context.ts:163-178` (`SessionContext.load`): calls `SessionHistory.entriesForRunner(db, session.id, instructions, provenance)`.
- `packages/core/src/session/history.ts:118-135` (`entriesForRunner`): wraps `messageEntries` + `InstructionState.initial` in a transaction; `messageEntries` (`history.ts:78-108`) does `latestCompaction`, `select().all()`, `Effect.forEach(rows, decodeMessageRow)` (schema decode of every row), filtering, plus `InstructionState.initial`.
- `packages/core/src/session/store.ts:179`: `context` is `SessionHistory.load(db, sessionID, "latest")` — a second full reload used by `settleStaleToolCalls` (`llm.ts:362-385`) and other callers (`session.ts:420`, `instructions.ts:101`, `title.ts:106`, `execution/restart.ts:175`, `aisdk.ts:190`).

So the reload path is real and O(rows) in both SQL and decode. That is the *mechanism*. It is not yet evidence of *dominance*.

### What we can measure today (existing instrumentation)

- **Effect span names** already exist: `SessionHistory.entriesForRunner`, `SessionHistory.load`, `SessionContext.load`, `SessionContext.select`, `SessionRunner.prepareContext`, `SessionRunner.runStep`, `SessionRunner.drain`, `SessionModelRequest.prepare`, `SessionStep.*`. These are names only; they are not automatically timed unless a tracer/metrics layer is installed.
- Search of `packages/core/src` for telemetry shows essentially no runtime metrics in this path: only `Metric.counter("opencode_session_websocket_events_total")` in `model-transport.ts:28` and `withTracerEnabled(false)` in the SQLite driver (`database/drizzle/effect-sqlite/session.ts:123-129`). There is **no** histogram/counter for step time, reload time, decode time, or model latency in core.
- The app has performance benchmarks under `packages/app/e2e/performance/**` (handoff §1, `packages/app/e2e/performance/AGENTS.md`), but those assert scenario completion and metric *collection*, not wall-clock budgets, and they target the TUI/app, not `packages/core` CPU.

### What is missing (must be added before any claim)

1. **Phase boundaries inside `runStep`**: separate `prepareContext`, `context.select`, `context.load`/`entriesForRunner`, `compaction.compact`, `context.request.primary`, `steps.attempt` (model stream + tool execution), and retry waits. Today `runStep` (`llm.ts:209-329`) bundles all of these; no single timestamp exists.
2. **Sub-phases inside `entriesForRunner`**: raw `select().all()` time vs `Effect.forEach(decodeMessageRow)` vs `latestCompaction` vs `InstructionState.initial`, at minimum. `history.ts:83-98` mixes them in one generator.
3. **Model latency vs tool execution vs decode**: `steps.attempt` (`llm.ts:248`) owns streaming + tools; its duration must be split from decode. Tool execution can dominate for shell/subagent steps.
4. **Step count and token volume per point**: message count, decoded byte/token estimate, DB size, compaction checkpoint count. `runStep` has `loaded.messages` but no logging.
5. **Warm/cold and repetition discipline**: Bun JIT, SQLite page cache, OS file cache. Handoff A7 requires N≥15 warm runs, median+MAD, interleaved scales. Nothing in repo does this for core.
6. **Clock and overhead validation**: `performance.now` granularity/overhead on Windows/Bun must be checked; instrumentation must be removable (`HANDOFF` §4.1).

**Conclusion for A1:** The handoff's "<20% of step time ⇒ re-target" rule is the right test, but **no number exists yet**. Any statement that reload is dominant is currently belief, not evidence.

---

## 2. Could end-to-end `opencode run` be dominated by model latency? (A10)

### Evidence

- Handoff §2 live numbers: `opencode --version` ~180–200 ms; `opencode service status` ~285 ms; end-to-end `opencode run` on a free Go model ~900 ms total; binary 204 MB single-file Bun.
- The runner performs **one** `llm.stream` per step (`AGENTS.md` session core: "Each step is one explicit llm.stream call that continues from reloaded history"; `runStep` calls `steps.attempt` at `llm.ts:248`).
- The model path includes network RTT to the provider, provider queueing, and token generation, none of which local history decode affects.

### Honest assessment (partly evidence, partly inference)

- For the handoff's own 900 ms end-to-end figure, a single model round-trip plus process spawn plausibly accounts for most of it; local SQLite decode of a short history is unlikely to be a large fraction. **This is inference, not measurement** — the handoff does not break down the 900 ms.
- For long sessions, input upload size and provider-side processing of large context grow, and local decode of 5k–20k messages also grows. Which grows faster is unknown without data (A2/A3).
- Therefore: **it is plausible the optimization is invisible end-to-end for typical sessions**, and even for long sessions the bottleneck may be upload/provider latency rather than local decode. The final report must state per-step *and* end-to-end numbers; if end-to-end is model-dominated, say so (handoff A10).

### What would settle it

- Instrument `steps.attempt` duration and the model stream's time-to-first-token vs total, alongside reload time, for the same session/scale. Compare.

---

## 3. Are there cheaper wins that dominate user-perceived latency?

Candidates visible in repo/handoff, with evidence status:

| Candidate | Evidence in repo | Status |
|---|---|---|
| CLI startup / process spawn | Handoff §2: version ~180–200 ms, service status ~285 ms, 204 MB Bun binary, lazy-loaded subcommands | Real, measured by handoff; likely dominates *cold* invocations |
| Event-feed `JSON.stringify` per subscriber | `packages/server/src/event-feed.ts:30` `data: ${JSON.stringify(event)}`; per-subscriber queue 4,096 (`SubscriberCapacity`); publish loops subscribers (`event-feed.ts:64-68`) | Mechanism present; cost unmeasured (A9). Could matter with large tool outputs |
| Client batching 16 ms | `packages/client/src/solid/connection.ts:73` (default 10, app `client.tsx:94` sets 16) | Fixed floor on perceived reactivity; not obviously a "win" to remove |
| TUI virtualization / pagination | `packages/session-ui` timeline projection with row-identity reuse; messages paginate at 20 (`packages/client/src/solid/data.ts:84`) | Already optimized; not a quick win |
| DB/page cache / warm state | Handoff A7 mentions SQLite page cache and OS file cache | Unmeasured; could make microbenchmarks misleading |
| Tool execution (shell/subagent) | `runStep` tool loop via `steps.attempt`; `settleStaleToolCalls` full reload | Can dominate wall time on tool-heavy steps; unmeasured |

**Assessment:** Startup cost (~200 ms) is a concrete, measured, user-visible latency that is *independent* of session length and likely larger than any plausible per-step history-decode win for short/medium sessions. If the engagement's goal is user-perceived latency, startup and event-feed stringify are more defensible first targets. **Speculation:** whether they dominate *interactive* latency vs. model latency is unmeasured.

---

## 4. Is the durable-reload invariant necessary, or defensive? (A4/A8)

### Evidence that it is currently *load-bearing*, not merely defensive

- `AGENTS.md` (session core): "Each step is one explicit llm.stream call that continues from reloaded history." and "Keep durable events minimal: record irreducible new facts...".
- `HANDOFF` §2 design rationale: history can be mutated between steps by compaction, revert stage/commit, forks, inbox steering, other tabs/processes, crash recovery. Reload-per-step makes every step trivially correct.
- Mutation sites that can change visible history:
  - Compaction: `packages/core/src/session/compaction.ts:363` (`SessionHistory.load(..., "local")`), `llm.ts:121` (`SessionHistory.preview`), `llm.ts:220` (`compaction.compact`), and compaction status rows (`running`/`completed`) filtered in `history.ts:39-40`.
  - Revert: `session.ts:319-340` (`stage`/`clear`/`commit`), `session.ts:164-165` and `:251` commit staged revert during prompt; `message-updater.ts:480-482` handles `session.revert.staged/cleared/committed`.
  - Fork: `info.ts:22-26` fork boundary (`fork_session_id`, `fork_boundary`); `stats.ts:100/147/208/250` filters by `session.fork_session_id IS NULL OR message.time_created >= session.time_created`.
  - Inbox steering/delivery: `llm.ts:83-108` promotes/delivers items between steps; `message-updater.ts:138-142` handles inbox events.
  - External/process writes: `store.context` reloads from DB; `SessionRunCoordinator` allows different sessions concurrently but same-session resumes join; however a second process/tab or crash recovery can mutate rows.

### Could relaxing it be higher leverage?

- **Speculation (not evidence):** A process-local in-memory history could avoid reload for the common single-process case, but it would have to be invalidated on every mutation above. That is essentially the proposed cache, with the same correctness burden, not a simpler alternative.
- The invariant exists precisely because correctness across mutations is hard. Relaxing it without a durable revision + invalidation mechanism would trade a measured (unknown) cost for a real correctness risk.
- To prove relaxation is safe would require: (a) proof no mutation can occur unobserved within a step boundary; (b) a durable revision counter covering all mutation triggers; (c) crash/recovery equivalence tests. Those are the same prerequisites as the cache, so there is no shortcut.

**Conclusion:** The invariant is load-bearing given the documented mutation surface. Relaxing it is not a cheaper path; it is the same project with a different name.

---

## 5. Risk assessment and decision gate

### Benefit (unmeasured, but bounded)

- Best case: remove O(rows) SQL+decode from every step/retry. For 20k-message sessions this could be large; for typical sessions likely small. End-to-end benefit further bounded by model latency (§2).

### Cost / correctness burden

- Must enumerate **every** invalidation trigger (handoff §5). Missing one ⇒ silent context corruption (stale compaction tail, dropped revert, fork boundary errors, stale inbox steers). This is the dominant risk.
- Must maintain byte-exact equivalence to uncached path (`HANDOFF` §6.1 property test).
- Must handle crash/restart (`HANDOFF` §6.3), concurrency (`HANDOFF` §6.4), and external writes.
- Ongoing maintenance: every future history mutation must update the invalidation checklist. This is a permanent tax, not a one-time cost.

### Decision gate (proceed only if ALL hold)

1. **Dominance:** Baseline (N≥15, median+MAD, warm) shows reload (`entriesForRunner` + `store.context` where applicable) ≥ **20% of per-step time** for at least one representative scale (≥1,000 messages or ≥50k estimated tokens), per handoff A1 threshold.
2. **Micro speedup:** Cached path is ≥ **2×** faster than uncached in the core benchmark at that scale, with non-overlapping MAD.
3. **End-to-end visibility:** End-to-end step latency improves by ≥ **10%** (or ≥1 MAD) at that scale; otherwise report as invisible (A10) and do not ship for perceived latency.
4. **Correctness:** Equivalence property test passes ≥ **10,000** random op-sequences covering every trigger in the invalidation inventory (compaction, revert stage/commit/clear, fork, steer, interrupt-resume, external row edit), with zero mismatches; crash/restart and concurrency tests pass.
5. **Invalidation completeness:** Inventory reviewed against `grep` of all `SessionHistory.*` and `store.context` callers and all durable mutation sites; no unexplained trigger.

If any gate fails: **do not implement**. Re-target to the measured top cost (likely startup, event-feed stringify, or model latency) or close the engagement.

---

## 6. Kill criteria (falsify the whole engagement)

Kill (or formally re-scope) if any of:

1. **A1 dies:** Reload is <20% of per-step time at all tested scales → engagement's premise false; write obituary per handoff §3 rule.
2. **A10 dies:** End-to-end step latency improvement is within measurement noise (MAD) at all scales → optimization invisible to users; not worth correctness risk.
3. **A4 dies:** A mutation sequence is found that a revision counter cannot cheaply capture (e.g., external DB write with no event) → cache cannot be made correct; kill rather than ship unsound cache.
4. **A5 dies:** Equivalence property test cannot be made green without unacceptable complexity (e.g., requires re-running full reload on most steps) → no net benefit.
5. **Cost exceeds benefit:** Invalidation inventory has >~15 triggers or requires touching >~10 mutation sites with non-local changes → maintenance tax too high.
6. **Measurement untrustworthy:** Instrumentation overhead >5% or warm/cold variance >2× median → cannot make a defensible claim; fix measurement first.

---

## 7. Recommended next steps (ordered)

1. Add removable timing instrumentation per §1 "missing" list (single local commit, droppable). Files: `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/context.ts`, `packages/core/src/session/history.ts`, `packages/core/src/session/store.ts`.
2. Build fixtures at 100/1,000/5,000/20,000 messages under `packages/core/test/` (handoff §4.2); reuse existing DB fixture patterns.
3. Run N≥15 warm protocol; produce `BASELINE.md` with A1/A2/A6/A9/A10 verdicts.
4. Apply decision gate (§5). Only then consider implementation.

**Do not touch `packages/desktop`.** No code changes have been made by this report.