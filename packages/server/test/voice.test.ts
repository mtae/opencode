import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Voice } from "@opencode/core/voice"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, ErrorReporter, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const voice = makeLocationNode({
  service: Voice.Service,
  layer: Layer.succeed(
    Voice.Service,
    Voice.Service.of({
      models: () =>
        Effect.succeed({
          models: [
            { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
            { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
            { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
            { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
          ],
          default: "gpt-live-1",
        }),
      session: (input) => {
        if (input.model === "invalid")
          return Effect.fail(new Voice.InvalidRequestError({ message: "Unsupported voice model" }))
        if (input.model === "unavailable")
          return Effect.fail(new Voice.UnavailableError({ message: "OpenAI API key is required", service: "openai" }))
        return Effect.succeed(
          input.transport.type === "webrtc"
            ? { type: "webrtc" as const, sdp: `answer:${input.model}:${input.transport.sdp}` }
            : {
                type: "websocket" as const,
                url: `wss://api.x.ai/v1/realtime?model=${input.model}`,
                token: "ek_test",
                expiresAt: 1760000000,
              },
        )
      },
    }),
  ),
  deps: [],
})

it.live("routes experimental voice models and session endpoints", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-voice-endpoint-")))
    const global = path.join(tmp.path, "global")
    yield* Effect.promise(() => fs.mkdir(global))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Voice.node.replace(voice)] },
    )
    const modelsRes = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/experimental/voice/models")),
    )
    expect(modelsRes.status).toBe(200)
    expect(yield* Effect.promise(() => modelsRes.json())).toEqual({
      data: {
        models: [
          { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
          { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: true },
          { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
          { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
        ],
        default: "gpt-live-1",
      },
    })

    const post = (body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request("http://opencode.local/api/experimental/voice/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )

    const rtcRes = yield* post({
      model: "gpt-live-1",
      session: { voice: "marin" },
      transport: { type: "webrtc", sdp: "v=0", dcid: 4 },
    })
    expect(rtcRes.status).toBe(200)
    expect(yield* Effect.promise(() => rtcRes.json())).toEqual({
      data: { transport: { type: "webrtc", sdp: "answer:gpt-live-1:v=0" } },
    })

    const wsRes = yield* post({ model: "grok-voice-3.0", transport: { type: "websocket" } })
    expect(wsRes.status).toBe(200)
    expect(yield* Effect.promise(() => wsRes.json())).toEqual({
      data: {
        transport: {
          type: "websocket",
          url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
          token: "ek_test",
          expiresAt: 1760000000,
        },
      },
    })

    expect((yield* post({ model: "invalid", transport: { type: "websocket" } })).status).toBe(400)
    expect((yield* post({ model: "unavailable", transport: { type: "websocket" } })).status).toBe(503)
  }),
)

it.live("real server voice routes reuse stored ChatGPT selection and preserve the client's session", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-chatgpt-voice-")))
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const executor = makeGlobalNode({
      service: HttpClient.HttpClient,
      layer: Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            // Built-in provider discovery also uses this client; it stays offline and unavailable.
            if (request.method === "GET")
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
            requests.push(request)
            return HttpClientResponse.fromWeb(
              request,
              request.url.startsWith("https://chatgpt.com/backend-api/codex/")
                ? new Response("legacy-answer", { headers: { "content-type": "application/sdp" } })
                : Response.json({ transport: { sdp: "modern-answer" } }),
            )
          }),
        ),
      ),
      deps: [],
    })
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path, project: false },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [httpClient.replace(executor)] },
    )
    const errors: string[] = []
    const context = Context.make(
      ErrorReporter.CurrentErrorReporters,
      new Set([ErrorReporter.make(({ error }) => errors.push(error.message))]),
    )
    const send = (endpoint: string, body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          context,
        ),
      )
    const oauth = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 3600_000,
    }
    expect(
      (yield* send("/api/credential", {
        id: "cred_voice_console",
        integrationID: "opencode",
        value: { ...oauth, methodID: "oauth", metadata: { orgID: "fixture-workspace" } },
      })).status,
    ).toBe(200)
    expect(
      (yield* send("/api/credential", {
        id: "cred_voice_modern",
        integrationID: "openai",
        value: {
          ...oauth,
          methodID: "chatgpt-token-sharing",
          metadata: { clientID: "fixture-client", scopes: ["chatgpt.tokens.use.direct", "resource.invoke"] },
        },
      })).status,
    ).toBe(200)
    expect(
      (yield* send("/api/credential", {
        id: "cred_voice_legacy",
        integrationID: "openai",
        activate: false,
        value: { ...oauth, methodID: "chatgpt-browser", metadata: { accountID: "fixture-account" } },
      })).status,
    ).toBe(200)
    const body = {
      model: "gpt-live-1",
      session: {
        instructions: "Keep official instructions",
        audio: { output: { voice: "marin" } },
        delegation: {
          type: "responses",
          responses: { model: "gpt-6.1-sol", tools: [], instructions: "Keep official delegation instructions" },
        },
      },
      transport: { type: "webrtc", sdp: "fixture-offer", dcid: 4 },
    }
    const modern = yield* send("/api/experimental/voice/session", body)
    expect({ status: modern.status, errors }).toEqual({ status: 200, errors: [] })
    expect(yield* Effect.promise(() => modern.json())).toEqual({
      data: { transport: { type: "webrtc", sdp: "modern-answer" } },
    })
    expect((yield* send("/api/credential/cred_voice_legacy/activate", {})).status).toBe(204)
    const legacy = yield* send("/api/experimental/voice/session", body)
    expect(legacy.status).toBe(200)
    expect(yield* Effect.promise(() => legacy.json())).toEqual({
      data: { transport: { type: "webrtc", sdp: "legacy-answer" } },
    })
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.openai.com/v1/live/sessions",
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    ])
    const modernRequest = yield* HttpClientRequest.toWeb(requests[0]).pipe(Effect.orDie)
    expect(yield* Effect.promise(() => modernRequest.json())).toEqual({
      transport: body.transport,
      session: { ...body.session, model: body.model },
    })
    const legacyRequest = yield* HttpClientRequest.toWeb(requests[1]).pipe(Effect.orDie)
    expect(yield* Effect.promise(() => legacyRequest.json())).toEqual({
      sdp: body.transport.sdp,
      session: { ...body.session, model: body.model },
    })
  }),
)
