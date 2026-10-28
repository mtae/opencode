# OpenCode perf: TODO

The goal is to profile the CLI, TUI and local server across common workflows, and the desktop app at lower priority. The mobile app is out of scope except for the server it talks to.
- Rank fixes by headroom: current time ÷ (operations × cost per operation).
- Measure areas others touched in the past week, but don't work on them; document them instead.

## Profiling matrix (all against the binary v2.0.32 and/or origin/dev from source; note which)
- [ ] **Cold start.** Time `--version`, `serve` ready, a TUI first frame, and a `run` one-shot, each with an empty DB and with the real DB. Explain the extra 1–1.5 s with the real DB.
- [ ] **Tool loop scaling** with synthetic sessions:
  - text: 100K, 500K and 1M tokens
  - images: 10, 50, 100 and 200
  - mixed
  
  Per-step gap, history decode, encode, request bytes, RSS.
- [ ] **Streaming:** CPU per delta and per 1K output tokens (fake provider with many small deltas). Projector and DB writes per delta. SSE fan-out to N clients.
- [ ] **Opening a long session** (the app shows several seconds):
  - message list API time and bytes;
  - SSE catch-up;
  - TUI render of a long session;
  - web app render in Chromium (packages/app served by the server).
- [ ] **Session list** with many sessions; session switch.
- [ ] **Tools on a large repo:** read, grep, glob, list, edit, bash; file search (fff); first LSP diagnostics.
- [ ] Compaction cost; subagent (task) spawn and run overhead; MCP startup.
- [ ] Memory: RSS growth over a long session and with many sessions loaded.
- [ ] **Wire compression:** server ↔ clients (HTTP and SSE gzip/br?, mobile path) and server ↔ provider (request compression?).
- [ ] Desktop app (optional): startup and long-session render.

## Questions to answer
- [ ] Attachment capability gating: does OpenCode send PDFs or images to models that can't take them, and only learn from an error? Where is the gate?
- [ ] PDF handling: is 20M base64 chars inline the right transport? Compare provider file APIs, text extraction, and page images.
- [ ] Would a faster local tokenizer help? Where is tokenizing or counting on the hot path?
- [ ] Prefix-referenced requests: can the server keep cached encoded prefixes per session, subagent and fork, so a step only encodes new messages? (The stringify agent is researching this.)

## Fix candidates (ranked by headroom; fill in as measured)
1. Base64 regex cliff: upstream PR #51272 exists. Comment with data, or offer a rebase.
2. Delta/prefix history cache (#51497, no live PR).
3. Cache per-message request JSON (pending the agent's report).
4. `Provider.snapshot` 8× per step (check #57223 and #56994 first).
5. Cache tool JSON schemas.

## Possible upstream PR later: server step benchmark (flesh out)
- A deterministic benchmark in-repo:
  - a fake OpenAI-compatible provider;
  - a generated session: text, tool calls, images; sized by parameter;
  - `opencode run` drives N tool steps.
- Report the gap per step, stage timings from spans (Effect spans already exist; no ad hoc hooks), bytes per request and RSS.
- Run in CI as a non-blocking job with a stored baseline.
- Needs an issue first. Check the existing app/desktop perf suites for conventions.

## Housekeeping
- [ ] Remove `opencode-perf` and the snapshot when the work is done (ask the user).
- [ ] The `session-history-cache` branch is stale: 58 behind dev, carries docs and stray lockfile lines. Decide whether to rebuild it as a delta cache.
