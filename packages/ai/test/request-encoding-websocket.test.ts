import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, Message } from "../src/effect.js"
import { LLMClient, RequestExecutor, WebSocketTransport } from "../src/route.js"
import * as ProviderShared from "../src/protocols/shared.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-4.1-mini")

const completed = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.completed", response: { id: "resp_1" } },
]

// A history that grows by one exchange per step and holds characters outside Latin-1, lone surrogates and
// control characters, so the encode memo reuses earlier messages and the per-message encoder is exercised.
const history = (steps: number) =>
  Array.from({ length: steps }, (_, step) => [
    Message.user(`step ${step} curly ’ emoji 😀 lone \ud800 nul \u0000 sep   日本語`),
    Message.assistant(`reply ${step} — dash “quoted” lone \udfff`),
  ]).flat()

const viaHttp = (steps: number) =>
  Effect.gen(function* () {
    const seen: Uint8Array[] = []
    const server = dynamicResponse((input) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
        seen.push(new Uint8Array(yield* Effect.promise(() => web.arrayBuffer())))
        return input.respond(sseEvents(...completed), { headers: { "content-type": "text/event-stream" } })
      }),
    )
    yield* LLMClient.generate(ai.request({ model, messages: [...history(steps), Message.user("next")] })).pipe(
      Effect.provide(server),
    )
    return seen[0]
  })

const viaWebSocket = (steps: number) =>
  Effect.gen(function* () {
    const sent: unknown[] = []
    const deps = Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
    )
    const webSocket = WebSocketTransport.makeDirect({
      open: () =>
        Effect.succeed({
          sendText: (message) => Effect.sync(() => void sent.push(message)),
          messages: Stream.fromArray(completed.map((event) => ProviderShared.encodeJson(event))),
          close: Effect.void,
        }),
    })
    yield* LLMClient.generate(ai.request({ model, messages: [...history(steps), Message.user("next")] }), {
      webSocket,
    }).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))
    return sent[0]
  })

describe("request bytes on the HTTP and WebSocket routes", () => {
  it.effect("matches JSON.stringify bytes over growing histories, and the WebSocket frame is text with the same input", () =>
    Effect.gen(function* () {
      for (const steps of [1, 2, 3, 5, 2]) {
        const body = yield* viaHttp(steps)
        const text = new TextDecoder().decode(body)
        // The bytes on the wire are exactly the UTF-8 of the JSON text, i.e. what JSON.stringify produced before.
        expect(Buffer.from(body).equals(Buffer.from(new TextEncoder().encode(JSON.stringify(JSON.parse(text)))))).toBe(
          true,
        )

        const frame = yield* viaWebSocket(steps)
        expect(typeof frame).toBe("string")
        expect(JSON.parse(frame as string).input).toEqual(JSON.parse(text).input)
        // The WebSocket frame is encoded by the unchanged text path.
        expect(frame).toBe(ProviderShared.encodeJson(JSON.parse(frame as string)))
      }
    }),
  )
})
