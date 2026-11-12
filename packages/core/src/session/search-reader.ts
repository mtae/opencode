export * as SessionSearchReader from "./search-reader.js"

import { Effect, Exit, Schema, Semaphore } from "effect"
import type { Worker } from "node:worker_threads"
import type { SessionSearchIndex } from "./search-index.js"
import type { Reply, Request } from "./search-reader-worker.js"

/** An idle reader is closed after this long, returning its connection and page cache. */
const IDLE_MILLIS = 60_000

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("SessionSearchReader.UnavailableError", {
  cause: Schema.Defect(),
}) {}

/** Resolves once the worker has opened the database; anything else means reading on the server's thread instead. */
export const spawn = (filename: string, url = new URL("./search-reader-worker.js", import.meta.url)) =>
  Effect.tryPromise({
    try: async (signal) => {
      const { Worker } = await import("node:worker_threads")
      const worker = new Worker(url, { workerData: { filename } })
      const abort = () => void worker.terminate()
      if (signal.aborted) abort()
      signal.addEventListener("abort", abort, { once: true })
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once("message", (reply: Reply) =>
            reply._tag === "Ready" ? resolve() : reject(new Error("search reader did not start")),
          )
          worker.once("error", reject)
          worker.once("exit", (code) => reject(new Error(`search reader exited with code ${code}`)))
        })
      } catch (cause) {
        void worker.terminate()
        throw cause
      }
      return worker
    },
    catch: (cause) => new UnavailableError({ cause }),
  })

const request = (worker: Worker, message: Request) =>
  Effect.callback<unknown>((resume) => {
    const settle = (effect: Effect.Effect<unknown>) => {
      cleanup()
      resume(effect)
    }
    const reply = (reply: Reply) => {
      if (reply._tag === "Done") settle(Effect.succeed(reply.value))
      if (reply._tag === "Failed") settle(Effect.die(new Error(reply.message)))
    }
    const error = (error: Error) => settle(Effect.die(new Error(error.message)))
    const exit = (code: number) => settle(Effect.die(new Error(`search reader exited with code ${code}`)))
    const cleanup = () => {
      worker.off("message", reply).off("messageerror", error).off("error", error).off("exit", exit)
      worker.unref()
    }
    worker.on("message", reply).on("messageerror", error).on("error", error).on("exit", exit)
    worker.ref()
    worker.postMessage(message)
    return Effect.sync(cleanup)
  })

/**
 * List search reads in a worker: the sessions matching an expression, and where listed sessions matched. One at a time. An interrupted read (a client
 * that cancelled or typed on) terminates its worker, which stops the SQLite statement instead of finishing a result
 * nobody reads; the next read starts a new one. Fails with {@link UnavailableError} when no worker can start.
 */
export function make(spawnWorker: Effect.Effect<Worker, UnavailableError>, idleMillis = IDLE_MILLIS) {
  const permit = Semaphore.makeUnsafe(1)
  let current: Worker | undefined
  let idle: ReturnType<typeof setTimeout> | undefined

  const discard = (worker: Worker) => {
    if (current === worker) current = undefined
    void worker.terminate()
  }
  const track = (worker: Worker) =>
    Effect.sync(() => {
      current = worker
      worker.unref()
      const forget = () => {
        if (current === worker) current = undefined
      }
      worker.on("error", forget).once("exit", forget)
      return worker
    })

  const run = (message: Request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        clearTimeout(idle)
        const worker = current ?? (yield* restore(spawnWorker).pipe(Effect.flatMap(track)))
        return yield* restore(request(worker, message)).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) return discard(worker)
              idle = setTimeout(() => discard(worker), idleMillis)
              idle.unref()
            }),
          ),
        )
      }),
    ).pipe(permit.withPermits(1))

  // The worker runs the same SessionSearchIndex code, so its replies have these shapes.
  return {
    /** Ends an idle worker now instead of after the idle timeout. */
    close: Effect.promise(async () => {
      clearTimeout(idle)
      const worker = current
      current = undefined
      await worker?.terminate()
    }),
    sessions: (expression: string) =>
      run({ _tag: "Sessions", expression }) as Effect.Effect<ReadonlyArray<string>, UnavailableError>,
    matches: (input: Parameters<typeof SessionSearchIndex.matches>[1]) =>
      run({ _tag: "Matches", input }) as Effect.Effect<ReadonlyArray<SessionSearchIndex.Match>, UnavailableError>,
  }
}

export type Reader = ReturnType<typeof make>
