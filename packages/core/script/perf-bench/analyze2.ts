// Like analyze-profile.ts, but drops samples whose stack touches the profiling hook (idle polling), and adds
// a breakdown by the deepest opencode `packages/` frame (which subsystem the work belongs to).
const [file, ...stages] = process.argv.slice(2)
const p = await Bun.file(file).json()
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const short = (u: string) => u.replace(/^.*opencode-perf[\/]/, "").replace(/^.*node_modules[\/]/, "nm/").replace(/^.*scratchpad[\/]perf[\/]/, "bench/")
const stack = (id: number) => { const out: any[] = []; for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) out.push(nodes.get(c).callFrame); return out }
const self = new Map<number, number>()
p.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)))
const byFn = new Map<string, number>(), byOwner = new Map<string, number>(), inclusive = new Map<string, number>(stages.map((s) => [s, 0]))
let total = 0
for (const [id, us] of self) {
  const frames = stack(id)
  if (frames.some((f) => f.url.includes("profile-hook")) || frames[0].functionName === "(root)" || frames[0].functionName === "(program)" || frames[0].functionName === "(idle)") continue
  total += us
  const top = frames[0]
  const k = `${top.functionName || "(anon)"} ${short(top.url)}:${top.lineNumber + 1}`
  byFn.set(k, (byFn.get(k) ?? 0) + us)
  const owner = frames.find((f) => /packages[\/](core|server|ai|cli|protocol|schema|util|plugin)[\/]src/.test(f.url))
  const ok = owner ? `${owner.functionName || "(anon)"} ${short(owner.url)}:${owner.lineNumber + 1}` : "(no opencode frame)"
  byOwner.set(ok, (byOwner.get(ok) ?? 0) + us)
  const seen = new Set<string>()
  for (const f of frames) for (const s of stages) if (f.functionName.includes(s)) seen.add(s)
  for (const s of seen) inclusive.set(s, inclusive.get(s)! + us)
}
const ms = (us: number) => (us / 1000).toFixed(1).padStart(8)
const pct = (us: number) => ((100 * us) / total).toFixed(1).padStart(5)
console.log(`busy (non-idle) sampled ${ms(total)} ms`)
console.log("\n== self time by function (top 25)")
for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${ms(v)} ms ${pct(v)}%  ${k}`)
console.log("\n== by nearest opencode frame (top 30)")
for (const [k, v] of [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${ms(v)} ms ${pct(v)}%  ${k}`)
if (stages.length) { console.log("\n== inclusive by stage"); for (const [k, v] of inclusive) console.log(`${ms(v)} ms ${pct(v)}%  ${k}`) }
