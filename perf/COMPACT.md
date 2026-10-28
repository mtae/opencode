# Compaction instructions for the OpenCode perf session

Paste this into the session as `/compact <text below>`. The compactor can't read files, so the instructions have to be inline:

```
Keep: the user's latest requests verbatim, with any unanswered questions; decisions and approvals given (what may be committed or pushed); running background agents (full-text search in opencode-fts, request-encoding research in scratchpad\stringify) and whether they have reported; measured numbers that aren't yet in perf/STATUS.md; the current step and the next step. Drop: raw tool output, profiles, file dumps, gh JSON, superseded numbers, and anything already recorded in C:\Users\aahlad\Documents\claude\opencode-perf\perf\STATUS.md and TODO.md. After compacting, read perf/STATUS.md, then perf/TODO.md, before doing anything else.
```

Before asking for compaction, the session must update STATUS.md and TODO.md, then commit them on `perf-harness`.
