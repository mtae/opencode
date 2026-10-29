export * as SessionSearch from "./search.js"

import { and, desc, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import type { Worker } from "node:worker_threads"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { Result } from "@opencode/schema/session-search"
import { Database } from "../database/database.js"
import { fromRow } from "./info.js"
import { SessionSearchIndex } from "./search-index.js"
import type { Reply, Request } from "./search-worker.js"
import { SessionTable } from "./sql.js"
import { SessionStore } from "./store.js"

export const extract = SessionSearchIndex.extract
export const parse = SessionSearchIndex.parse
export const snippet = SessionSearchIndex.snippet
export type Input = SessionSearchIndex.Input

export interface Response {
  readonly data: ReadonlyArray<Result>
  /** Sessions not yet indexed when the search ran. Their messages are missing from the results. */
  readonly pending: number
}

/** A newer search arrived before this one started, so it never ran. */
export class SupersededError extends Schema.TaggedError<SupersededError>()("SessionSearch.SupersededError", {}) {}

export class WorkerUnavailableError extends Schema.TaggedError<WorkerUnavailableError>()(
  "SessionSearch.WorkerUnavailableError",
  { cause: Schema.Defect() },
) {}

export interface Interface {
  /**
   * Ranks Sessions by their best matching title or message. The index is built on the first search
   * and caught up on each later one, in a worker thread so the server's thread never runs it.
   * One search runs at a time: a newer one supersedes any still waiting, and an interrupted one
   * that has not started never runs. Without a worker, only titles are searched.
   */
  readonly search: (input: Input) => Effect.Effect<Response, SupersededError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearch") {}

type Backend = (input: Input) => Effect.Effect<SessionSearchIndex.Found, SupersededError>

// Resolves once the worker has opened both databases and the index. Anything else (no
// worker_threads, a bundle without the worker entry, an index that cannot be created) means the
// worker is unavailable, and a worker that never got ready is terminated.
export const spawnWorker = (path: string, url = new URL("./search-worker.js", import.meta.url)) =>
  Effect.tryPromise({
    try: async (signal) => {
      const { Worker } = await import("node:worker_threads")
      const worker = new Worker(url, { workerData: { path } })
      const abort = () => void worker.terminate()
      if (signal.aborted) abort()
      signal.addEventListener("abort", abort, { once: true })
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once("message", (reply: Reply) =>
            reply._tag === "Ready" ? resolve() : reject(new Error(reply._tag === "Unavailable" ? reply.message : "")),
          )
          worker.once("error", reject)
          worker.once("exit", (code) => reject(new Error(`session search worker exited with code ${code}`)))
        })
      } catch (cause) {
        void worker.terminate()
        throw cause
      }
      return worker
    },
    catch: (cause) => new WorkerUnavailableError({ cause }),
  })

type Waiting = {
  readonly id: number
  readonly input: Input
  readonly resume: (effect: Effect.Effect<SessionSearchIndex.Found, SupersededError>) => void
}

// The worker gets one search at a time. The next waits here, where a newer search replaces it,
// so a burst of keystrokes costs at most the search running plus the last one.
function remote(worker: Worker, fallback: Backend): Backend {
  const queue: { ids: number; running?: Waiting; waiting?: Waiting; exited?: boolean } = { ids: 0 }
  const pump = () => {
    if (queue.running || !queue.waiting) return
    const next = queue.waiting
    queue.running = next
    queue.waiting = undefined
    // Ref'd only while a search runs, so an idle worker never holds the process open.
    worker.ref()
    worker.postMessage({ _tag: "Search", id: next.id, input: next.input } satisfies Request)
  }
  worker.unref()
  worker.on("message", (reply: Reply) => {
    if (!("id" in reply) || queue.running?.id !== reply.id) return
    const running = queue.running
    queue.running = undefined
    worker.unref()
    running.resume(
      reply._tag === "Done"
        ? Effect.succeed(reply.found)
        : reply._tag === "Failed"
          ? Effect.die(new Error(reply.message))
          : Effect.interrupt,
    )
    pump()
  })
  worker.once("exit", (code) => {
    queue.exited = true
    const lost = [queue.running, queue.waiting]
    queue.running = undefined
    queue.waiting = undefined
    lost.forEach((request) => request?.resume(Effect.die(new Error(`session search worker exited with code ${code}`))))
  })
  return (input) =>
    queue.exited
      ? fallback(input)
      : Effect.callback<SessionSearchIndex.Found, SupersededError>((resume) => {
          const request = { id: ++queue.ids, input, resume }
          queue.waiting?.resume(Effect.fail(new SupersededError()))
          queue.waiting = request
          pump()
          return Effect.sync(() => {
            if (queue.waiting === request) queue.waiting = undefined
            // A running search stops at its next pause, such as while it waits for indexing.
            if (queue.running === request) worker.postMessage({ _tag: "Cancel", id: request.id } satisfies Request)
          })
        })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope

    const titles: Backend = Effect.fn("SessionSearch.titles")(function* (input: Input) {
      const pattern = `%${input.query.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      const query = parse(input.query)
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(...SessionStore.filters(input), sql`${SessionTable.title} LIKE ${pattern} ESCAPE '\\'`))
        .orderBy(desc(SessionTable.time_updated))
        .limit(input.limit ?? 50)
        .all()
        .pipe(Effect.orDie)
      return {
        data: rows.map((row) => ({
          session: row,
          hits: 1,
          match: row.title && query ? { source: "title" as const, snippet: snippet(row.title, query) } : undefined,
        })),
        pending: 0,
      }
    })

    const backend = yield* Effect.cached(
      Effect.gen(function* () {
        const databases = yield* db.all<{ name: string; file: string }>(sql`PRAGMA database_list`)
        const file = databases.find((database) => database.name === "main")?.file
        if (file) {
          const worker = yield* spawnWorker(file)
          yield* Scope.addFinalizer(
            scope,
            Effect.promise(() => worker.terminate()),
          )
          return remote(worker, titles)
        }
        // Nothing else can open an in-memory database, so its index is attached to the same connection.
        if (!databases.some((database) => database.name === "session_search"))
          yield* db.run(sql`ATTACH DATABASE ':memory:' AS session_search`)
        return yield* SessionSearchIndex.make({ app: db, index: db, schema: "session_search" }).pipe(
          Scope.provide(scope),
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Session search index unavailable, searching titles only", cause).pipe(Effect.as(titles)),
        ),
      ),
    )

    const search = Effect.fn("SessionSearch.search")(function* (input: Input) {
      const run = yield* backend
      const found = yield* run(input)
      return {
        data: found.data.map((result) => ({ ...result, session: fromRow(result.session) })),
        pending: found.pending,
      }
    })

    return Service.of({ search })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
