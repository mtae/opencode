// Preloaded: log every JSON.stringify result over 1 MB with a short stack, to count large encodes per step.
const original = JSON.stringify
JSON.stringify = function (this: unknown, ...args: Parameters<typeof JSON.stringify>) {
  const start = performance.now()
  const out = original.apply(JSON, args)
  if (typeof out === "string" && out.length > 1_000_000) {
    const stack = (new Error().stack ?? "").split("\n").slice(2, 9).map((l) => l.trim().replace(/^at /, "").replace(/\(?[A-Z]:.*?opencode-perf[\/]/, "").replace(/\)$/, "")).filter((l) => !l.includes("effect/dist/internal")).slice(0, 4).join(" < ")
    console.error(`BIGJSON ${(out.length / 1048576).toFixed(1)}MB ${(performance.now() - start).toFixed(1)}ms ${stack}`)
  }
  return out
} as typeof JSON.stringify
