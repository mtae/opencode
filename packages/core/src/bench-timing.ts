// Local benchmark instrumentation for the perf-harness branch; never upstream. Prints only with OPENCODE_BENCH_TIMING=1.
import { Effect } from "effect"

const enabled = process.env.OPENCODE_BENCH_TIMING === "1"
const emit = (name: string, start: number) => {
  if (enabled) console.error(`BENCH ${name} ${(performance.now() - start).toFixed(3)}`)
}

export const timed =
  <Args extends ReadonlyArray<unknown>, A, E, R>(name: string, f: (...args: Args) => Effect.Effect<A, E, R>) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const start = performance.now()
      return f(...args).pipe(Effect.ensuring(Effect.sync(() => emit(name, start))))
    })

export const timedSync =
  <Args extends ReadonlyArray<unknown>, A>(name: string, f: (...args: Args) => A) =>
  (...args: Args): A => {
    const start = performance.now()
    const result = f(...args)
    emit(name, start)
    return result
  }

export const mark = (name: string) => {
  if (enabled) console.error(`BENCH ${name} 0`)
}
