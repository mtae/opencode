import { expect } from "bun:test"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Voice } from "@opencode/core/voice"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const credential = (id: string, method: "key" | "oauth") => ({
  type: "credential" as const,
  id: Credential.ID.make(id),
  label: id,
  method,
})

const keys: Record<string, string> = {
  active: "sk-active",
  stored: "sk-stored",
  XAI_API_KEY: "xai-env-key",
  GEMINI_API_KEY: "gemini-env-key",
  OPENCODE_API_KEY: "opencode-env-key",
}

const sharing = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("chatgpt-token-sharing"),
  access: "sharing-access",
  refresh: "sharing-refresh",
  expires: 1760000999_000,
})

const resolveCredential: Integration.Interface["connection"]["resolve"] = (connection) => {
  if (connection.type === "env") return Effect.succeed(Credential.Key.make({ type: "key", key: keys[connection.name] }))
  if (connection.id === "chatgpt") return Effect.succeed(sharing)
  if (connection.id === "console")
    return Effect.succeed(
      Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "console-access",
        refresh: "console-refresh",
        expires: 1,
        metadata: { orgID: "wrk_console" },
      }),
    )
  return Effect.succeed(Credential.Key.make({ type: "key", key: keys[connection.id] }))
}

const unused = () => Effect.die("unused")

const mockIntegration = (
  connections: (id: Integration.ID) => Integration.Info["connections"],
  resolve: Integration.Interface["connection"]["resolve"] = () => Effect.die("Voice.models resolved a credential"),
) =>
  Layer.mock(Integration.Service, {
    revision: () => 0,
    get: (id) => Effect.succeed({ id, name: id, methods: [], connections: connections(id) }),
    connection: {
      active: unused,
      resolve,
      key: unused,
      external: unused,
      activate: unused,
      update: unused,
      remove: unused,
      status: unused,
    },
    oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
    command: { connect: unused, status: unused, cancel: unused },
  })

// Starts a session with each integration's connections, recording the requests it sends upstream.
const start = (
  model: string,
  connections: Partial<Record<string, Integration.Info["connections"]>>,
  requests: HttpClientRequest.HttpClientRequest[],
  options: {
    resolve?: Integration.Interface["connection"]["resolve"]
    session?: Voice.SessionInput["session"]
    response?: () => Response
  } = {},
) =>
  Effect.flatMap(Voice.Service, (voice) =>
    voice.session({
      model,
      session: options.session,
      transport:
        model.startsWith("grok-") || model.startsWith("gemini-")
          ? { type: "websocket" }
          : { type: "webrtc", sdp: "v=0", dcid: 4 },
    }),
  ).pipe(
    Effect.provide(
      Voice.layer.pipe(
        Layer.provide(
          Layer.merge(
            mockIntegration((id) => connections[id] ?? [], options.resolve ?? resolveCredential),
            RequestExecutor.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((req: HttpClientRequest.HttpClientRequest) =>
                    Effect.sync(() => {
                      requests.push(req)
                      return HttpClientResponse.fromWeb(
                        req,
                        options.response
                          ? options.response()
                          : model.startsWith("gemini-")
                            ? Response.json({ name: "auth_tokens/ek_gemini" })
                            : model.startsWith("grok-")
                              ? Response.json({ value: "ek_xai", expires_at: 1760000999 })
                              : Response.json({ transport: { sdp: "v=0\r\no=answer\r\n" } }),
                      )
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

const session = {
  model: "gpt-live-1",
  instructions: "Preserve the caller's voice instructions.",
  audio: { output: { voice: "marin" } },
  delegation: {
    type: "responses",
    responses: {
      model: "gpt-6.1-sol",
      instructions: "Preserve the caller's coding delegation instructions.",
      tools: [{ type: "function", name: "send_message", parameters: { type: "object" } }],
      reasoning: { effort: "low" },
    },
  },
}

it.effect("modern ChatGPT and Console forward the same complete client session and transport", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const hosted = yield* start("gpt-live-1", { opencode: [credential("console", "oauth")] }, requests, { session })
    const modern = yield* start(
      "gpt-live-1",
      {
        openai: [credential("chatgpt", "oauth"), credential("stored", "key")],
        opencode: [credential("console", "oauth")],
      },
      requests,
      { session },
    )
    expect(modern).toEqual(hosted)
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url)).toEqual([
      "https://opencode.ai/inference/openai/v1/live/sessions",
      "https://api.openai.com/v1/live/sessions",
    ])
    yield* Effect.forEach(requests, (request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        expect(yield* Effect.promise(() => web.json())).toEqual({
          session,
          transport: { type: "webrtc", sdp: "v=0", dcid: 4 },
        })
      }),
    )
    expect(requests[1].headers.authorization).toBe("Bearer sharing-access")
    expect(requests[1].headers["x-opencode-org-id"]).toBeUndefined()
    expect(requests[1].headers["chatgpt-account-id"]).toBeUndefined()
  }),
)

for (const method of ["chatgpt-browser", "chatgpt-headless"]) {
  it.effect(`${method} adapts only legacy call negotiation and returns the existing transport contract`, () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const result = yield* start(
        "gpt-live-1",
        {
          openai: [credential("legacy", "oauth"), credential("stored", "key")],
          opencode: [credential("console", "oauth")],
        },
        requests,
        {
          session,
          resolve: () =>
            Effect.succeed(
              Credential.OAuth.make({
                ...sharing,
                methodID: Integration.MethodID.make(method),
                metadata: { accountID: "legacy-account", orgID: "must-not-be-forwarded" },
              }),
            ),
          response: () =>
            new Response("v=0\r\no=legacy-answer\r\n", { headers: { "content-type": "application/sdp" } }),
        },
      )
      expect(result).toEqual({ type: "webrtc", sdp: "v=0\r\no=legacy-answer\r\n" })
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe(
        "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
      )
      expect(requests[0].headers.authorization).toBe("Bearer sharing-access")
      expect(requests[0].headers["chatgpt-account-id"]).toBe("legacy-account")
      expect(requests[0].headers["openai-alpha"]).toBe("quicksilver=v2")
      expect(requests[0].headers["x-opencode-org-id"]).toBeUndefined()
      expect(requests[0].headers["session-id"]).toBeDefined()
      expect(requests[0].headers["thread-id"]).toBeDefined()
      expect(requests[0].headers["x-session-id"]).toBeDefined()
      const web = yield* HttpClientRequest.toWeb(requests[0]).pipe(Effect.orDie)
      expect(yield* Effect.promise(() => web.json())).toEqual({ sdp: "v=0", session })
    }),
  )
}

it.effect("OAuth rejection stops without trying a stored key, a different OAuth account, or Console", () =>
  Effect.gen(function* () {
    yield* Effect.forEach(["chatgpt-token-sharing", "chatgpt-browser"], (method) =>
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = []
        const resolved: string[] = []
        const failure = yield* start(
          "gpt-live-1",
          {
            openai: [credential("selected", "oauth"), credential("other", "oauth"), credential("stored", "key")],
            opencode: [credential("console", "oauth")],
          },
          requests,
          {
            resolve: (connection) => {
              if (connection.type !== "credential") return Effect.die("unexpected env resolution")
              resolved.push(connection.id)
              return Effect.succeed(
                Credential.OAuth.make({
                  ...sharing,
                  methodID: Integration.MethodID.make(method),
                  metadata: { accountID: "legacy-account" },
                }),
              )
            },
            response: () => Response.json({ detail: "identity sharing-access sharing-refresh" }, { status: 401 }),
          },
        ).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "Voice.UnavailableError", service: "openai" })
        expect(failure.message).toContain("HTTP 401")
        expect(failure.message).not.toContain("sharing-access")
        expect(failure.message).not.toContain("identity")
        expect(requests).toHaveLength(1)
        expect(resolved).toEqual(["selected"])
      }),
    )
  }),
)

it.effect("each session uses the resolver's current token instead of caching OAuth access", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const resolve: Integration.Interface["connection"]["resolve"] = () =>
      Effect.succeed(Credential.OAuth.make({ ...sharing, access: `token-${requests.length}` }))
    yield* start("gpt-live-1", { openai: [credential("chatgpt", "oauth")] }, requests, { resolve })
    yield* start("gpt-live-1", { openai: [credential("chatgpt", "oauth")] }, requests, { resolve })
    expect(requests.map((request) => request.headers.authorization)).toEqual(["Bearer token-0", "Bearer token-1"])
  }),
)

it.effect("unknown OAuth and legacy OAuth without account metadata fail before contacting any provider", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    yield* Effect.forEach(["unrecognized-oauth", "chatgpt-browser"], (method) =>
      Effect.gen(function* () {
        const failure = yield* start(
          "gpt-live-1",
          {
            openai: [credential("selected", "oauth"), credential("stored", "key")],
            opencode: [credential("console", "oauth")],
          },
          requests,
          {
            resolve: () =>
              Effect.succeed(Credential.OAuth.make({ ...sharing, methodID: Integration.MethodID.make(method) })),
          },
        ).pipe(Effect.flip)
        expect(failure._tag).toBe("Voice.UnavailableError")
      }),
    )
    expect(requests).toHaveLength(0)
  }),
)

it.effect("uses the first GPT-Live key or OAuth connection and retains other engines' key selection", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1760000000_000)
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const call = (model: string, connections: Partial<Record<string, Integration.Info["connections"]>>) =>
      start(model, connections, requests)

    yield* call("gpt-live-1", { openai: [credential("active", "key"), credential("stored", "key")] })
    yield* call("gpt-live-1", { openai: [credential("chatgpt", "oauth"), credential("stored", "key")] })
    const grok = yield* call("grok-voice-3.0", { xai: [{ type: "env", name: "XAI_API_KEY" }] })
    const gemini = yield* call("gemini-3.8-live", { google: [{ type: "env", name: "GEMINI_API_KEY" }] })
    expect(requests.map((req) => req.headers.authorization ?? req.headers["x-goog-api-key"])).toEqual([
      "Bearer sk-active",
      "Bearer sharing-access",
      "Bearer xai-env-key",
      "gemini-env-key",
    ])
    expect(grok).toEqual({
      type: "websocket",
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
      token: "ek_xai",
      expiresAt: 1760000999,
    })
    expect(gemini).toEqual({
      type: "websocket",
      url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
      token: "auth_tokens/ek_gemini",
      expiresAt: 1760000060,
    })

    expect(yield* call("gpt-live-1", { openai: [credential("chatgpt", "oauth")] })).toMatchObject({ type: "webrtc" })

    const missingGoogle = yield* call("gemini-3.8-live", {}).pipe(Effect.flip)
    expect(missingGoogle).toMatchObject({ _tag: "Voice.UnavailableError", service: "google" })
    expect(missingGoogle.message).toContain("GEMINI_API_KEY")
  }),
)

it.effect("retains GPT-Live's hosted Console endpoint when no OpenAI connection is selected", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const opencode = { opencode: [credential("console", "oauth")] }

    yield* start("gpt-live-1", opencode, requests)
    yield* start("gpt-live-1", { opencode: [{ type: "env", name: "OPENCODE_API_KEY" }] }, requests)
    yield* start("gpt-live-1", { openai: [credential("active", "key")], ...opencode }, requests)
    expect(
      requests.map((req): (string | undefined)[] => [
        req.url,
        req.headers.authorization,
        req.headers["x-opencode-org-id"],
      ]),
    ).toEqual([
      ["https://opencode.ai/inference/openai/v1/live/sessions", "Bearer console-access", "wrk_console"],
      ["https://opencode.ai/inference/openai/v1/live/sessions", "Bearer opencode-env-key", undefined],
      ["https://api.openai.com/v1/live/sessions", "Bearer sk-active", undefined],
    ])

    const realtime = yield* start("gpt-realtime-2.1", opencode, requests).pipe(Effect.flip)
    expect(realtime).toMatchObject({ _tag: "Voice.UnavailableError", service: "openai" })
    expect(requests).toHaveLength(3)
  }),
)

it.effect("lists voice models with availability and default without resolving credentials", () =>
  Effect.gen(function* () {
    const list = (connections: Partial<Record<string, Integration.Info["connections"]>>) =>
      Effect.flatMap(Voice.Service, (voice) => voice.models()).pipe(
        Effect.provide(
          Voice.layer.pipe(
            Layer.provide(
              Layer.merge(
                mockIntegration((id) => connections[id] ?? []),
                Layer.mock(RequestExecutor.Service, {}),
              ),
            ),
          ),
        ),
      )

    expect(
      yield* list({
        openai: [credential("chatgpt", "oauth")],
        xai: [{ type: "env", name: "XAI_API_KEY" }],
        google: [credential("gemini", "key")],
      }),
    ).toEqual({
      models: [
        { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
        { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: false },
        { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: true },
        { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: true },
      ],
      default: "gpt-live-1",
    })

    expect(
      yield* list({ openai: [credential("chatgpt", "oauth")], opencode: [credential("console", "oauth")] }),
    ).toEqual({
      models: [
        { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: true },
        { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: false },
        { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
        { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
      ],
      default: "gpt-live-1",
    })

    const none = yield* list({})
    expect(none).toEqual({
      models: [
        { model: "gpt-live-1", provider: "openai", transports: ["webrtc"], available: false },
        { model: "gpt-realtime-2.1", provider: "openai", transports: ["webrtc", "websocket"], available: false },
        { model: "grok-voice-3.0", provider: "xai", transports: ["websocket"], available: false },
        { model: "gemini-3.8-live", provider: "google", transports: ["websocket"], available: false },
      ],
    })
    expect("default" in none).toBe(false)
  }),
)
