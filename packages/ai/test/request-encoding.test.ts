import { describe, expect, test } from "bun:test"
import { gunzipSync, zstdDecompressSync } from "node:zlib"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, type RequestEncoding } from "../src/effect.js"
import { LLMClient } from "../src/route.js"
import { encodeJsonBytes } from "../src/utils/json.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")

const send = (prompt: string, encoding?: RequestEncoding) =>
  Effect.gen(function* () {
    const seen: { encoding: string | null; body: Uint8Array }[] = []
    const server = dynamicResponse((input) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
        seen.push({
          encoding: web.headers.get("content-encoding"),
          body: new Uint8Array(yield* Effect.promise(() => web.arrayBuffer())),
        })
        return input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    )
    yield* LLMClient.generate(ai.request({ model, prompt, http: encoding ? { encoding } : undefined })).pipe(
      Effect.provide(server),
    )
    return seen[0]
  })

describe("HTTP request encoding", () => {
  it.effect("compresses the JSON body with the requested encoding", () =>
    Effect.gen(function* () {
      const zstd = yield* send("Hello", "zstd")
      expect(zstd.encoding).toBe("zstd")
      expect(JSON.parse(zstdDecompressSync(zstd.body).toString())).toMatchObject({ model: "gpt-4.1-mini" })

      const gzip = yield* send("Hello", "gzip")
      expect(gzip.encoding).toBe("gzip")
      expect(JSON.parse(gunzipSync(gzip.body).toString())).toMatchObject({ model: "gpt-4.1-mini" })
    }),
  )

  it.effect("sends plain JSON when unset or none", () =>
    Effect.gen(function* () {
      for (const sent of [yield* send("Hello"), yield* send("Hello", "none")]) {
        expect(sent.encoding).toBeNull()
        expect(JSON.parse(new TextDecoder().decode(sent.body))).toMatchObject({ model: "gpt-4.1-mini" })
      }
    }),
  )
})

describe("encodeJsonBytes", () => {
  const encodes = (value: unknown) =>
    expect(new TextDecoder().decode(encodeJsonBytes(value))).toBe(JSON.stringify(value))

  test("matches JSON.stringify for request bodies", () => {
    encodes({
      model: "m",
      skipped: undefined,
      messages: [
        { role: "user", content: "plain" },
        { role: "assistant", content: "curly ’ and 😀" },
      ],
      empty: [],
      holes: [undefined, () => 1, null, 0],
      nested: { list: [1, "—"] },
      stream: true,
    })
    encodes({})
  })

  test("is byte-identical to the UTF-8 of JSON.stringify for lone surrogates and control characters", () => {
    const value = {
      model: "m",
      messages: [
        { role: "user", content: "lone high \ud800 and low \udfff, pair 😀, nul \u0000, bell \u0007, line sep" },
        { role: "tool", content: "\ud83d" },
        { role: "user", content: ["é", "日本語", "😀".repeat(3)] },
      ],
    }
    const expected = new TextEncoder().encode(JSON.stringify(value))
    expect(Buffer.from(encodeJsonBytes(value)).equals(Buffer.from(expected))).toBe(true)
  })

  test("matches JSON.stringify for values that are not plain objects", () => {
    encodes(["a", "’"])
    encodes("text")
    encodes({ toJSON: () => ({ replaced: [1] }) })
  })

  test("does not reuse bytes for a message that was mutated in place after it was encoded", () => {
    const message = { role: "user", content: "original", parts: [{ text: "a" }] }
    encodes({ model: "m", messages: [message] })
    message.content = "mutated in place"
    message.parts[0].text = "b"
    encodes({ model: "m", messages: [structuredClone(message)] })
    const stamp = { role: "user", at: new Date(0) }
    encodes({ model: "m", messages: [stamp] })
    stamp.at.setTime(1)
    encodes({ model: "m", messages: [stamp] })
  })

  test("stays byte-identical after many sessions evict old history from the memo", () => {
    const session = (id: number, steps: number) =>
      Array.from({ length: steps }, (_, step) => ({ role: step % 2 ? "assistant" : "user", content: `s${id} step ${step} ’` }))
    // More interleaved histories than the memo keeps, each growing one message per round.
    for (let round = 1; round <= 4; round++)
      for (let id = 0; id < 20; id++) encodes({ model: "m", messages: session(id, round) })
    // A history evicted long ago is encoded again from scratch.
    encodes({ model: "m", messages: session(0, 5) })
  })

  test("reuses earlier steps only where the history is unchanged", () => {
    const history = [
      { role: "user", content: "first ’" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ]
    encodes({ model: "m", messages: history })
    encodes({ model: "m", messages: [...structuredClone(history), { role: "user", content: "next" }] })
    encodes({ model: "m", messages: [history[0], { role: "assistant", content: [{ type: "text", text: "edited" }] }] })
    encodes({
      model: "m",
      messages: [history[0], { role: "assistant", content: [{ type: "text", text: "reply", extra: 1 }] }],
    })
    encodes({ model: "m", messages: [{ role: "user", content: "first ’", at: new Date(0) }] })
    encodes({ model: "m", messages: [{ role: "user", content: "first ’", at: new Date(1) }] })
    encodes({ model: "m", messages: [{ role: "user", content: "first ’", skipped: undefined }, 1, undefined] })
    encodes({ model: "m", messages: [{ role: "user", content: "first ’" }, 1, null] })
    encodes({ model: "m", messages: [[5, 1]] })
    encodes({ model: "m", messages: [[, 1]] })
  })
})
