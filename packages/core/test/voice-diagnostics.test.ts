import { expect, test } from "bun:test"
import { controlFailure, voiceRejection } from "../src/voice-diagnostics"

test("voice diagnostics preserve rejection codes without logging prose or malformed identifiers", () => {
  const result = voiceRejection(JSON.stringify({ error: { code: "subscription_sharing_route_not_supported", type: "invalid_request_error", param: "session.delegation.responses", message: "PRIVATE account@example.com Bearer secret" } }))
  expect(result).toEqual({ bodyFormat: "json", errorCode: "subscription_sharing_route_not_supported", errorType: "invalid_request_error", errorParameter: "session.delegation.responses" })
  expect(JSON.stringify(result)).not.toContain("PRIVATE")
  expect(voiceRejection('{"error":{"code":"Bearer secret"}}').errorCode).toBeUndefined()
  expect(voiceRejection("<html>private</html>")).toEqual({ bodyFormat: "markup", errorCode: undefined, errorType: undefined, errorParameter: undefined })
  expect(voiceRejection(undefined).bodyFormat).toBe("other")
})

test("WebSocket diagnostics extract status and network code without retaining URL or token", () => {
  expect(controlFailure({ message: "Unexpected server response: 401 https://private.invalid/secret Bearer secret" })).toEqual({ httpStatus: 401, networkCode: undefined })
  expect(controlFailure({ error: { message: "Unable to connect ECONNREFUSED https://private.invalid" } })).toEqual({ httpStatus: undefined, networkCode: "ECONNREFUSED" })
  expect(controlFailure({ message: "Failed to connect" })).toEqual({ httpStatus: undefined, networkCode: undefined })
})

test("WebSocket diagnostics recognize an actual local rejected upgrade", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture rejection", { status: 401 }) })
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  try {
    const event = await new Promise<Event>((resolve) => socket.addEventListener("error", resolve, { once: true }))
    expect(controlFailure(event).httpStatus).toBe(401)
  } finally { socket.close(); server.stop(true) }
})
