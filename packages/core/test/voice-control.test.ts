import { expect, test } from "bun:test"
import { Effect, Logger, Redacted } from "effect"
import { legacyControl } from "../src/voice-control"

class FakeSocket extends EventTarget {
  closed = false
  sent = 0
  close() { this.closed = true }
  send() { this.sent++ }
}

test("same-call control uses platform auth, sends no commands, and omits upstream message bodies", async () => {
  const socket = new FakeSocket()
  const logs: unknown[] = []
  const logger = Logger.make((options) => { logs.push(options.message) })
  let endpoint = ""
  let options: unknown
  await Effect.runPromise(legacyControl({
    callID: "rtc_fixture",
    apiKey: Redacted.make("fixture-token"),
    headers: { "ChatGPT-Account-ID": "fixture-account" },
    constructor: (url, input) => {
      endpoint = url; options = input
      queueMicrotask(() => {
        socket.dispatchEvent(new Event("open"))
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.started" }) }))
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", error: { code: "invalid_value", param: "session.delegation.responses", message: "PRIVATE TRANSCRIPT fixture-token" } }) }))
      })
      return socket as unknown as WebSocket
    },
  }).pipe(Effect.provide(Logger.layer([logger]))))
  expect(endpoint).toBe("wss://api.openai.com/v1/live/rtc_fixture")
  expect(options).toEqual({ headers: { Authorization: "Bearer fixture-token", "ChatGPT-Account-ID": "fixture-account" } })
  expect(socket.closed).toBe(true)
  expect(socket.sent).toBe(0)
  const output = JSON.stringify(logs)
  expect(output).toContain("session.delegation.responses")
  expect(output).toContain('"started":true')
  expect(output).not.toContain("PRIVATE TRANSCRIPT")
  expect(output).not.toContain("fixture-token")
  expect(output).not.toContain("fixture-account")
})

test("control observer closes its connection at the bounded trial deadline", async () => {
  const socket = new FakeSocket()
  await Effect.runPromise(legacyControl({ callID: "rtc_fixture", apiKey: Redacted.make("fixture"), duration: 5,
    constructor: () => socket as unknown as WebSocket,
  }))
  expect(socket.closed).toBe(true)
  expect(socket.sent).toBe(0)
})

test("transient pre-activation attachment retries the same call and then observes startup", async () => {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  await Effect.runPromise(legacyControl({ callID: "rtc_same_call", apiKey: Redacted.make("fixture"), constructor: (url) => {
    const socket = new FakeSocket(); sockets.push(socket); urls.push(url)
    const first = sockets.length === 1
    queueMicrotask(() => {
      if (first) { socket.dispatchEvent(new ErrorEvent("error", { message: "Unexpected server response: 404" })); return }
      socket.dispatchEvent(new Event("open"))
      socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"session.started"}' }))
      socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"session.closed"}' }))
    })
    return socket as unknown as WebSocket
  } }))
  expect(sockets).toHaveLength(2)
  expect(new Set(urls).size).toBe(1)
  expect(sockets.every((socket) => socket.closed && socket.sent === 0)).toBe(true)
})

test("an explicit authentication rejection does not retry the control handshake", async () => {
  let attempts = 0
  await Effect.runPromise(legacyControl({ callID: "rtc_same_call", apiKey: Redacted.make("fixture"), constructor: () => {
    attempts++
    const socket = new FakeSocket()
    queueMicrotask(() => socket.dispatchEvent(new ErrorEvent("error", { message: "Unexpected server response: 401" })))
    return socket as unknown as WebSocket
  } }))
  expect(attempts).toBe(1)
})
