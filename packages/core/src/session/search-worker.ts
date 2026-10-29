import { parentPort, workerData } from "node:worker_threads"
import { sqliteLayer } from "#sqlite"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "../database/drizzle.js"
import { SessionSearchIndex } from "./search-index.js"

export const Data = Schema.Struct({ path: Schema.String })

export type Request =
  | { readonly _tag: "Search"; readonly id: number; readonly input: SessionSearchIndex.Input }
  | { readonly _tag: "Cancel"; readonly id: number }

export type Reply =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Unavailable"; readonly message: string }
  | { readonly _tag: "Done"; readonly id: number; readonly found: SessionSearchIndex.Found }
  | { readonly _tag: "Cancelled"; readonly id: number }
  | { readonly _tag: "Failed"; readonly id: number; readonly message: string }

// Session search runs here, off the server's thread: the full-text index lives in its own file
// that only this thread writes, and the main database is opened read-only beside it, which WAL
// lets proceed while the server writes. SQLite cannot open one connection with a read-only main
// database and a writable attachment, so these are two connections and nothing joins across them.
const connect = (config: Parameters<typeof sqliteLayer>[0]) =>
  Layer.build(sqliteLayer(config)).pipe(
    Effect.flatMap((context) => EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.provideContext(context))),
  )

const port = parentPort
if (port) {
  const path = Schema.decodeUnknownSync(Data)(workerData).path
  const program = Effect.gen(function* () {
    const app = yield* connect({ filename: path, readonly: true, readwrite: false, create: false, disableWAL: true })
    const index = yield* connect({ filename: `${path}-search` })
    yield* app.run(sql`PRAGMA busy_timeout = 5000`)
    yield* index.run(sql`PRAGMA busy_timeout = 5000`)
    // The index can be rebuilt from the main database, so its checkpoints skip the sync to disk.
    yield* index.run(sql`PRAGMA synchronous = OFF`)
    const search = yield* SessionSearchIndex.make({ app, index, schema: "main" })
    const context = yield* Effect.context<never>()
    const running = new Map<number, Fiber.Fiber<SessionSearchIndex.Found>>()
    port.on("message", (request: Request) => {
      if (request._tag === "Cancel") return running.get(request.id)?.interruptUnsafe()
      const fiber = Effect.runForkWith(context)(search(request.input))
      running.set(request.id, fiber)
      fiber.addObserver((exit) => {
        running.delete(request.id)
        port.postMessage(
          Exit.isSuccess(exit)
            ? ({ _tag: "Done", id: request.id, found: exit.value } satisfies Reply)
            : Cause.hasInterruptsOnly(exit.cause)
              ? ({ _tag: "Cancelled", id: request.id } satisfies Reply)
              : ({ _tag: "Failed", id: request.id, message: Cause.pretty(exit.cause) } satisfies Reply),
        )
      })
    })
    port.postMessage({ _tag: "Ready" } satisfies Reply)
    return yield* Effect.never
  })
  Effect.runFork(
    Effect.scoped(program).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => port.postMessage({ _tag: "Unavailable", message: Cause.pretty(cause) } satisfies Reply)),
      ),
    ),
  )
}
