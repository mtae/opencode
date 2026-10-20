# perf-bench (local measurement harness, not for upstream)

Measures the server's per-step cost in a tool loop against a copy of a real `opencode.db`, with a local fake provider so nothing leaves the machine.

This branch also carries timing wrappers in `packages/core/src` (`bench-timing.ts`, plus `timed`/`mark` calls in `integration.ts`, `provider.ts`, `tool/runtime.ts`, `session/context.ts`, `session/runner/llm.ts`). They print `BENCH <name> <ms>` to stderr only when `OPENCODE_BENCH_TIMING=1`.

## Setup

Take a consistent snapshot of your database, then point the harness at it. Each run copies it and deletes the credential and account tables from the copy.

```bash
sqlite3 ~/.local/share/opencode/opencode.db "VACUUM INTO '/tmp/snap.db'"
export PERF_DB=/tmp/snap.db
```

## Runs

| Command | What it does |
|---|---|
| `bash run-bench.sh <name> <session-id> [steps]` | Server plus fake provider on 47901/47900; `opencode run --session` drives `steps` tool calls. Output goes to `$PERF_OUT/run-<name>/`, which defaults to `$TMPDIR/opencode-perf-bench`. Keep it outside the repo: with the run data inside the worktree, `opencode run` hung without sending a request. |
| `PROFILE=1 bash run-bench.sh ...` | Adds a CPU profile of the steady state, written to `server.cpuprofile`. |
| `BIGJSON=1 bash run-bench.sh ...` | Logs every `JSON.stringify` over 1 MB with its size, time and stack. |
| `[OPENCODE_BIN=...] bash startup.sh <name> <db or empty>` | Time from spawn to the first 200 on `/api/info`. |

`fake.log` records when each provider request arrived and ended, plus its size, so the gap between steps is the time from one request's `ended` to the next request's `arrived`.

## Analysis

| Script | Output |
|---|---|
| `aggregate.ts $PERF_OUT/run-x/serve.out` | Per-step median of each `BENCH` stage. |
| `buckets.ts <profile> <from-s> <to-s> <steps>` | Busy CPU per step, split by subsystem. |
| `timeline.ts <profile> [window-ms]` | Busy time and the dominant owners in each window. |
| `analyze2.ts`, `callers.ts`, `unattr.ts` | Self time, caller chains, and work with no opencode frame on the stack. |
| `attachments.ts <db> [session-id]` | The large base64 payloads stored in messages, grouped by path and MIME type. |
| `bench-decode.ts`, `bench-rows.ts <db> <session-id>` | History decode cost split into select, JSON.parse and schema decode. |

## Notes

- Effect fibers resume across async boundaries, so many samples carry no opencode frame. `buckets.ts` reports them as unattributed rather than guessing.
- JSC charges idle time to the last frame, so the analyzers drop samples that touch the profile hook or that are idle.
- Running from source starts the server in about 17 s on Windows, mostly transpiling. The compiled v2.0.32 binary starts in 0.7–2.2 s. Don't read anything into the startup numbers from a source run.
