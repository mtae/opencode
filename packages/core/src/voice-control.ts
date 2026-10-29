import { Effect, Redacted } from "effect"
import type { Socket } from "effect/socket"
import { controlFailure } from "./voice-diagnostics.js"

type Constructor = (url: string, options?: Socket.WebSocketConstructorOptions) => Socket.WebSocketLike
type Report = { opened: boolean; started: boolean; closed: boolean; socketError: boolean; timedOut: boolean; closeCode?: number; httpStatus?: number; networkCode?: string; errors: Array<{ code?: string; parameter?: string }> }
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined
interface Input {
  callID: string
  apiKey: Redacted.Redacted
  headers?: Readonly<Record<string, string>>
  constructor: Constructor
  duration?: number
}

const attemptControl = (input: Input, attempt: number) => Effect.gen(function* () {
  const control = yield* Effect.acquireRelease(
    Effect.sync(() => open(input)),
    (connection) => Effect.sync(connection.dispose),
  )
  yield* Effect.promise(() => control.opened)
  yield* Effect.logInfo("voice.session.control.connected", { opened: control.report.opened, attempt })
  yield* Effect.promise(() => control.done)
  yield* Effect.logInfo("voice.session.control.result", { ...control.report, attempt })
  return control.report
}).pipe(Effect.scoped)

/** Same-call legacy sideband, matching the plugin. Observes control only; sends no application events. */
export const legacyControl = (input: Input) => Effect.gen(function* () {
  const deadline = Date.now() + (input.duration ?? 60_000)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const report = yield* attemptControl({ ...input, duration: Math.max(1, deadline - Date.now()) }, attempt)
    if (report.opened || report.timedOut || report.httpStatus === 401 || report.httpStatus === 403 || attempt === 5) return
    // The plugin retries attachment, and Codex documents a brief 404 before ICE activates an existing call.
    // Reuse this call and credential; never create another provider session or fall back to another account.
    yield* Effect.sleep(Math.min(200 * 2 ** (attempt - 1), Math.max(0, deadline - Date.now())))
    if (Date.now() >= deadline) return
  }
}).pipe(Effect.catchCause(() => Effect.logInfo("voice.session.control.failed")))

const open = (input: Input) => {
  const report: Report = { opened: false, started: false, closed: false, socketError: false, timedOut: false, errors: [] }
  const opened = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  const socket = input.constructor(`wss://api.openai.com/v1/live/${encodeURIComponent(input.callID)}`, {
    headers: { ...input.headers, Authorization: `Bearer ${Redacted.value(input.apiKey)}` },
  })
  const finish = () => { opened.resolve(); done.resolve() }
  const timer = setTimeout(() => { report.timedOut = true; finish() }, input.duration ?? 60_000)
  socket.addEventListener("open", () => { report.opened = true; opened.resolve() })
  socket.addEventListener("error", (event) => { report.socketError = true; Object.assign(report, controlFailure(event)); finish() })
  socket.addEventListener("close", (event) => { report.closeCode = event.code; finish() })
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message?.type === "session.started") report.started = true
    if (message?.type === "session.closed") { report.closed = true; finish() }
    if (message?.type === "error") {
      report.errors.push({ code: identifier(message.error?.code ?? message.code), parameter: identifier(message.error?.param ?? message.param) })
      finish()
    }
  })
  return { report, opened: opened.promise, done: done.promise, dispose: () => { clearTimeout(timer); socket.close() } }
}
