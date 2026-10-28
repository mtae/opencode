// Self and inclusive CPU time per function within the first WINDOW ms of a .cpuprofile.
// usage: WINDOW=2300 bun window.ts <profile> [top]
const profile = await Bun.file(process.argv[2]).json()
const top = Number(process.argv[3] ?? 40)
const window = Number(process.env.WINDOW ?? Infinity) * 1000
const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const name = (n: any) => {
  const f = n.callFrame
  const file = f.url.split(/[\/]/).pop()
  return `${f.functionName || "(anon)"} ${file}:${f.lineNumber + 1}`
}
const self = new Map<string, number>()
const incl = new Map<string, number>()
let t = 0
let total = 0
profile.samples.forEach((id: number, i: number) => {
  const dt = profile.timeDeltas[i] ?? 0
  t += dt
  if (t > window) return
  total += dt
  const leaf = nodes.get(id)
  self.set(name(leaf), (self.get(name(leaf)) ?? 0) + dt)
  const seen = new Set<string>()
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const k = name(nodes.get(cur))
    if (seen.has(k)) continue
    seen.add(k)
    incl.set(k, (incl.get(k) ?? 0) + dt)
  }
})
const fmt = (m: Map<string, number>) =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms  ${k.slice(0, 120)}`).join("\n")
console.log(`window total ${(total / 1000).toFixed(0)} ms (profile span ${(t / 1000).toFixed(0)} ms)\n--- self`)
console.log(fmt(self))
console.log("--- inclusive")
console.log(fmt(incl))
