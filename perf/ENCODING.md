# Provider request encoding: research summary (2026-10-19)

Scripts are in `scratchpad\stringify\`:
- `real-pipeline.ts`: stage costs;
- `fragcache.ts`: the prefix memo prototype;
- `steps.ts`: the per-step simulator;
- `assemble.ts`: buffer reuse;
- `zstd.ts`: compression;
- `canonical.ts`: the WebSocket continuation check.

Test data: session `ses_eb90c95feffe65819DFE049147`, rows after the last compaction. The openai-compatible body is 7.27 MB with 329 wire messages. The 1.7 MB and 29 MB bodies come from truncating or duplicating rows. Every encoder was checked byte-identical to `JSON.stringify`.

## Main finding
Most of the ~50 ms stringify at 7 MB comes from text encoding, not from the amount of JSON.
- **The cause:** the body holds 7,633 characters outside Latin-1 (dashes, curly quotes, box-drawing). One such character makes JSC write the whole stringify output as UTF-16.
- **The cost:** stringify takes 17–25 ms on 8-bit input and 40–67 ms as served.
- **The amplifier:** parsing the DB `data` column already makes every string 16-bit.
- **A side effect:** three of the 19 base64 images are 16-bit only because a curly apostrophe sits elsewhere in the same row.

## Passes per step
A step makes about 11 full passes over the request:
1. history load + JSON parse + schema decode (no cache);
2. `toLLMMessages` (85% of it is `new Message` deep validation: 13.3 vs 1.7 ms);
3. the unsupported-part and image-budget scans;
4. `normalizeToolHistory`;
5. `sanitizeSurrogates`, which rebuilds everything and flattens class instances;
6. `LLMRequest.update` re-decoding and re-validating because of that flattening;
7. protocol lowering (not 1:1 per message);
8. `encodeJson`;
9. `Buffer.byteLength`;
10. `Buffer.from`;
11. the fetch copy.

The WebSocket Responses route adds:
- a second full encode;
- `canonical()` on both the previous and current input, 59 ms vs 2.5 ms for a structural compare;
- zstd of the HTTP fallback body even when WS is used.

| Stage (ms) | 1.7 MB | 7.3 MB | 29 MB |
|---|---|---|---|
| toLLMMessages | 1.5 | 5.7 | 37 |
| sanitize | 0.7 | 2.8 | 12 |
| re-validate | 1.0 | 4.3 | 29 |
| lowering | 1.3 | 5.4 | 22 |
| stringify | 7.5–11 | 39–59 | 379–500 |
| Buffer.from | 1.0 | 3.9 | 55 |
| **total** | **19** | **~81** | **~616** |

## Fragment cache (prefix memo)
- **Where it lives:** in packages/ai, after protocol lowering, replacing `encodeBody`/`encodeJson`. It can't be earlier, because lowering merges and reorders messages and the cache breakpoint moves every step.
- **What gets cached:** the envelope (model, system, tools, options) is encoded fresh. The `messages`/`input` array is emitted as cached UTF-8 fragments.
- **Keying:** one memo per session, keyed by prompt-cache key.
  - Each wire message is compared structurally with the previous step's message at the same index, and everything from the first mismatch is re-encoded.
  - It uses no ids or hashes, so it can't serve stale data.
  - Invalidation is automatic: breakpoint moves, image-budget changes, model switches, compaction, plugin hooks. An `http.body` overlay falls back to a full encode.
- **Forks** copy rows with new ids, so an id-keyed cache misses completely. Seeding the fork's memo from the parent makes the first fork request a warm hit: 7.3 MB goes from 25–81 ms to 12–16 ms; 29 MB from 177 to 40 ms.
- **Subagents** share only system and tools, so they gain only from their own step-to-step reuse.
- **Memory:** one body-sized buffer per active session, under an LRU cap. Reusing a double-buffered allocation cuts the final copy from 7.3 to 1.2 ms at 9.5 MB.

Steady-state per step (ms), today (E0) vs per-message fragments without a cache (E1) vs the prefix memo (E2):

| Body | E0 | E1 | E2 |
|---|---|---|---|
| 1.7 MB | 15.8 | 6.9 | 2.6 |
| 7.3 MB | 59–72 | 25–43 | 9.4–13 |
| 29 MB | 316 | 138 | 38.7 |

With buffer reuse, the floor is ~3–4 ms at 7 MB.

## Ranked options (savings per step at 1.7 / 7.3 / 29 MB)
1. Prefix memo emitting bytes, plus fork seeding and a reused buffer: ~13 / 50–60 / ~280 ms. Medium complexity, because everything that reads the body text must accept bytes (sigv4, compression, WS send, http overlay).
2. Per-message UTF-8 encode with no cache, which fixes the UTF-16 output: ~9 / 30–35 / ~180 ms. Low complexity.
3. Identity-preserving sanitize and trusted `Message` construction: ~2–3 / 7–18 / ~70 ms. Already in flight upstream: #57173 (rekram1-node) and #52787 (nexxeln); only one should land.
4. WS continuation fixes (structural compare, no second encode, no fallback zstd): ~10 / ~100 / 400+ ms on the WS route.
5. Cached per-message zstd frames on top of #1: 4 ms vs 71 ms. The open question is whether every endpoint accepts multi-frame zstd.
6. End state: delta history cache (#51497) plus memoized `toLLMMessages` and lowering.

Not worth doing:
- skipping the Effect schema encode (~0 ms);
- streaming the body (slower);
- a compiled serializer (its only gain is the 8-bit fix that #2 also gets);
- an image-only cache;
- gzip.

## Upstream overlap
- Nobody upstream addresses fragment caching, the UTF-16 output, double validation, or the WS double encode.
- #56993 (kitlangton, evict images after N steps) would invalidate the prefix memo every step, so it needs coordinating.
- #56991's media_blob hash could key image fragments.
- #54932 (merged) added zstd/gzip request bodies.
