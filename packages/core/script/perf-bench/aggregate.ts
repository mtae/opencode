// Per-step breakdown from BENCH lines in serve.out: calls and ms per stage, median over steps 2..n (step 1 is warm-up).
const text = await Bun.file(process.argv[2]).text()
const steps: Map<string, { calls: number; ms: number }>[] = []
for (const line of text.split("\n")) {
  const m = /^BENCH (\S+) ([\d.]+)/.exec(line.trim())
  if (!m) continue
  if (m[1] === "step") { steps.push(new Map()); continue }
  const cur = steps.at(-1)
  if (!cur) continue
  const e = cur.get(m[1]) ?? { calls: 0, ms: 0 }
  e.calls++; e.ms += Number(m[2]); cur.set(m[1], e)
}
const measured = steps.slice(1)
const names = [...new Set(measured.flatMap((s) => [...s.keys()]))]
const median = (xs: number[]) => { const s = xs.toSorted((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }
console.log(`steps captured: ${steps.length} (median over ${measured.length} after warm-up)`)
for (const n of names.toSorted()) {
  const ms = measured.map((s) => s.get(n)?.ms ?? 0), calls = measured.map((s) => s.get(n)?.calls ?? 0)
  console.log(`${n.padEnd(26)} calls/step ${String(median(calls)).padStart(4)}   ms/step median ${median(ms).toFixed(1).padStart(7)}   (min ${Math.min(...ms).toFixed(1)}, max ${Math.max(...ms).toFixed(1)})`)
}
