export * as Voice from "./voice.js"

import { type AIError } from "@opencode/ai/effect"
import {
  Realtime,
  type RealtimeConnectInput,
  type RealtimeSession,
  type RealtimeTransport,
  type RealtimeTransportInput,
  type RealtimeTransportType,
} from "@opencode/ai/experimental"
import { RequestExecutor } from "@opencode/ai/route"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import { App } from "./app.js"
import { Credential } from "./credential.js"
import { requestExecutor, webSocketConstructor } from "./effect/app-node-platform.js"
import { Integration } from "./integration.js"
import { legacyControl } from "./voice-control.js"
import { voiceRejection } from "./voice-diagnostics.js"

export interface ModelInfo {
  readonly model: string
  readonly provider: string
  readonly transports: readonly RealtimeTransportType[]
  readonly available: boolean
}

export interface Models {
  readonly models: readonly ModelInfo[]
  readonly default?: string
}

export interface SessionInput {
  readonly model: string
  readonly session?: RealtimeSession
  readonly transport: RealtimeTransportInput
}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Voice.InvalidRequestError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Voice.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = InvalidRequestError | UnavailableError

export interface Interface {
  readonly models: () => Effect.Effect<Models>
  readonly session: (input: SessionInput) => Effect.Effect<RealtimeTransport, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const app = yield* App.Metadata
    const scope = yield* Effect.scope
    const sockets = yield* Effect.serviceOption(Socket.WebSocketConstructor)

    // Integration lists the active credential first, then newer stored credentials, then non-empty env vars.
    const findConnection = (provider: string, methods: readonly string[] = ["key"]) =>
      integrations
        .get(Integration.ID.make(provider))
        .pipe(
          Effect.map((info) => info?.connections.find((item) => item.type === "env" || methods.includes(item.method))),
        )

    // GPT-Live also accepts the server's OpenAI sign-in. Select one connection before resolving it;
    // failures must not switch accounts or fall through to the hosted Console route.
    const source = Effect.fnUntraced(function* (engine: (typeof Realtime.engines)[number]) {
      const connection = yield* findConnection(
        engine.provider,
        engine.id === "openai-live" ? ["key", "oauth"] : ["key"],
      )
      if (connection) return { provider: engine.provider, connection }
      if (engine.id !== "openai-live") return undefined
      const hosted = yield* findConnection(openCodeLive.provider, ["key", "oauth"])
      return hosted && { provider: openCodeLive.provider, connection: hosted }
    })

    const models = Effect.fn("Voice.models")(function* () {
      const list = yield* Effect.forEach(Realtime.engines, (engine) =>
        source(engine).pipe(
          Effect.map((found) => ({
            model: engine.model,
            provider: found?.provider ?? engine.provider,
            transports: engine.transports,
            available: found !== undefined,
          })),
        ),
      )
      const first = list.find((item) => item.available)?.model
      return first ? { models: list, default: first } : { models: list }
    })

    const session = Effect.fn("Voice.session")(function* (input: SessionInput) {
      yield* Effect.logInfo("voice.session.request", { model: input.model, transport: input.transport.type })
      const engine = Realtime.engine(input.model)
      if (!engine) return yield* new InvalidRequestError({ message: `Unsupported voice model: ${input.model}` })

      const found = yield* source(engine)
      const credential = found
        ? yield* integrations.connection
            .resolve(found.connection)
            .pipe(Effect.mapError((error) => new UnavailableError({ service: found.provider, message: error.message })))
        : undefined
      const access = found && credential && sessionAccess(found.provider, credential, app)
      if (found === undefined || access === undefined)
        return yield* new UnavailableError({
          service: engine.provider,
          message: engine.id === "openai-live" ? missingLiveKeyMessage : missingKeyMessage[engine.provider],
        })

      yield* Effect.logInfo("voice.session.connector", {
        provider: found.provider,
        authMethod: credential?.type === "oauth" ? credential.methodID : credential?.type,
        protocol: access.liveProtocol ?? "live",
      })

      return yield* Realtime.connect({
        model: input.model,
        session: input.session,
        transport: input.transport,
        ...access,
        onLegacyCall: access.liveProtocol === "codex" && Option.isSome(sockets)
          ? (callID) => legacyControl({ callID, apiKey: access.apiKey, headers: access.headers, constructor: sockets.value })
              .pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
          : undefined,
      }).pipe(
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.tap((transport) => Effect.logInfo("voice.session.negotiated", { transport: transport.type })),
        Effect.tapError((error) =>
          Effect.logInfo("voice.session.rejected", { status: error.reason.http?.status, reason: error.reason._tag, ...voiceRejection(error.reason.body) }),
        ),
        Effect.mapError(
          (error: AIError): Error =>
            found.provider === "openai" && credential?.type === "oauth"
              ? new UnavailableError({
                  service: found.provider,
                  // Admission failures may contain identity details instead of a standard API error.
                  message: `GPT-Live rejected Sign in with ChatGPT${error.reason.http ? ` (HTTP ${error.reason.http.status})` : ""}. Voice capability is unverified; no other credential was tried.`,
                })
              : error.reason._tag === "InvalidRequest" || error.reason._tag === "UnsupportedOperation"
                ? new InvalidRequestError({ message: error.message })
                : new UnavailableError({ message: error.message, service: found.provider }),
        ),
      )
    })

    return Service.of({ models, session })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, requestExecutor, webSocketConstructor],
})

/** OpenCode hosts GPT-Live on its OpenAI account, billed to the workspace whose credential starts a session. */
const openCodeLive = { provider: "opencode", baseURL: "https://opencode.ai/inference/openai/v1" } as const

/**
 * Keep credential material and endpoint selection on the server. Modern ChatGPT sign-in uses the public Live
 * connector; legacy Codex needs its call envelope. Console credentials retain their hosted workspace route.
 */
const sessionAccess = (
  provider: string,
  credential: Credential.Value,
  app: App.Info,
): Pick<RealtimeConnectInput, "apiKey" | "baseURL" | "headers" | "liveProtocol"> | undefined => {
  if (provider === "openai" && credential.type === "oauth") {
    if (credential.methodID === "chatgpt-token-sharing") return { apiKey: Redacted.make(credential.access) }
    if (credential.methodID !== "chatgpt-browser" && credential.methodID !== "chatgpt-headless") return undefined
    const accountID = credential.metadata?.accountID
    if (typeof accountID !== "string" || !accountID) return undefined
    // Match the plugin's legacy negotiation contract; the client's session remains unchanged.
    return {
      apiKey: Redacted.make(credential.access),
      baseURL: "https://chatgpt.com/backend-api/codex",
      liveProtocol: "codex" as const,
      headers: {
        "ChatGPT-Account-ID": accountID,
        "OpenAI-Alpha": "quicksilver=v2",
        "session-id": crypto.randomUUID(),
        "thread-id": crypto.randomUUID(),
        "x-session-id": crypto.randomUUID(),
        originator: "opencode",
        "User-Agent": App.useragent(app),
      },
    }
  }
  if (provider !== openCodeLive.provider)
    return credential.type === "key" ? { apiKey: Redacted.make(credential.key) } : undefined
  if (credential.type === "external") return undefined
  const orgID = credential.metadata?.orgID
  return {
    apiKey: Redacted.make(credential.type === "oauth" ? credential.access : credential.key),
    baseURL: openCodeLive.baseURL,
    ...(typeof orgID === "string" ? { headers: { "x-opencode-org-id": orgID } } : {}),
  }
}

const missingLiveKeyMessage =
  "GPT-Live needs an OpenAI key, a usable ChatGPT sign-in, or an OpenCode Console connection on the server."

const missingKeyMessage = {
  openai: "GPT-Realtime needs an OpenAI API key on the server (a stored key or OPENAI_API_KEY).",
  xai: "Voice needs an xAI API key on the server (a stored key or XAI_API_KEY).",
  google:
    "Voice needs a Google API key on the server (a stored key, GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GOOGLE_API_KEY).",
} as const
