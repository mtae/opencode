import { parentPort, workerData } from "node:worker_threads"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { sqliteLayer } from "#sqlite"
import { EffectDrizzleSqlite } from "../database/drizzle.js"
import { SessionSearchIndex } from "./search-index.js"

export type Request =
  | { readonly _tag: "Sessions"; readonly expression: string }
  | { readonly _tag: "Matches"; readonly input: Parameters<typeof SessionSearchIndex.matches>[1] }
export type Reply =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Done"; readonly value: unknown }
  | { readonly _tag: "Failed"; readonly message: string }

// List search's content reads run here, off the server's thread: a common word or a short prefix matches most of
// the index, and building that set on the server's thread stalled every other request. This is a read-only connection
// to the same database and index; it never writes, so maintenance stays with the one leader.
const port = parentPort
if (port) {
  const filename = (workerData as { readonly filename: string }).filename
  // A failure to open rejects before Ready, so the host reads on its own thread instead.
  void Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(sqliteLayer({ filename, readonly: true, disableWAL: true }))
        const db = yield* EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.provideContext(context))
        yield* db.run(sql`PRAGMA busy_timeout = 5000`)
        port.on("message", (request: Request) => {
          const read: Effect.Effect<unknown> =
            request._tag === "Sessions"
              ? SessionSearchIndex.matchingSessions(db, request.expression)
              : SessionSearchIndex.matches(db, request.input)
          void Effect.runPromise(read).then(
            (value: unknown) => port.postMessage({ _tag: "Done", value } satisfies Reply),
            (error: unknown) => port.postMessage({ _tag: "Failed", message: String(error) } satisfies Reply),
          )
        })
        port.postMessage({ _tag: "Ready" } satisfies Reply)
        return yield* Effect.never
      }),
    ),
  )
}
