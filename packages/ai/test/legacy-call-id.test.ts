import { expect, test } from "bun:test"
import { legacyCallID } from "../src/experimental/realtime"
import { Realtime } from "../src/experimental"
import { Effect, Redacted } from "effect"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"

test("legacy call attachment validates identifiers without trusting response hosts or raw header content", () => {
  expect(legacyCallID("/v1/realtime/calls/rtc_fixture")).toBe("rtc_fixture")
  expect(legacyCallID("https://untrusted.invalid/v1/realtime/calls/rtc_fixture")).toBe("rtc_fixture")
  expect(legacyCallID(undefined, " 12345678-1234-1234-1234-123456789012 ")).toBe("12345678-1234-1234-1234-123456789012")
  expect(legacyCallID("http://[", "Bearer private")).toBeUndefined()
  expect(legacyCallID(undefined, "rtc_fixture?redirect=elsewhere")).toBeUndefined()
  expect(legacyCallID()).toBeUndefined()
})

it.effect("legacy SDP negotiation attaches control to its returned call and preserves the native session", () =>
  Effect.gen(function* () {
    const attached: string[] = []
    const session = { instructions: "fixture", audio: { output: { voice: "marin" } }, delegation: { type: "responses", responses: { model: "fixture-backend", tools: [] } } }
    const result = yield* Realtime.connect({ model: "gpt-live-1", apiKey: Redacted.make("fixture"), liveProtocol: "codex", session,
      transport: { type: "webrtc", sdp: "fixture-offer", dcid: 4 },
      onLegacyCall: (id) => Effect.sync(() => { attached.push(id) }),
    }).pipe(Effect.provide(dynamicResponse((request) => Effect.sync(() => {
      expect(request.request.url).toBe("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas")
      expect(JSON.parse(request.text)).toEqual({ sdp: "fixture-offer", session: { ...session, model: "gpt-live-1" } })
      return request.respond("fixture-answer", { headers: { location: "/v1/realtime/calls/rtc_fixture" } })
    }))))
    expect(result).toEqual({ type: "webrtc", sdp: "fixture-answer" })
    expect(attached).toEqual(["rtc_fixture"])
  }),
)
