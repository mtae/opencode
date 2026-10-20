const [file, from, to] = process.argv.slice(2)
const p = await Bun.file(file).json()
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const short = (u: string) => u.replace(/^.*opencode-perf[\/]/, "").replace(/^.*node_modules[\/]\.bun[\/][^\/]+[\/]node_modules[\/]/, "nm/")
const leaf = new Map<string, number>(), mid = new Map<string, number>()
let t = 0
p.samples.forEach((id: number, i: number) => {
  t += p.timeDeltas[i] ?? 0
  const dt = p.timeDeltas[i + 1] ?? 0
  if (t / 1e6 < Number(from) || t / 1e6 > Number(to)) return
  const frames: any[] = []
  for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) frames.push(nodes.get(c).callFrame)
  if (frames.some((f) => f.url.includes("profile-hook")) || ["(root)", "(program)", "(idle)"].includes(frames[0].functionName)) return
  if (frames.some((f) => /packages[\/]/.test(f.url) && !/node_modules/.test(f.url))) return
  const l = `${frames[0].functionName || "anon"} ${short(frames[0].url)}:${frames[0].lineNumber + 1}`
  leaf.set(l, (leaf.get(l) ?? 0) + dt)
  const m = frames.find((f) => f.url && !/effect[\/]dist[\/]internal|^$/.test(f.url) && f !== frames[0]) ?? { functionName: "-", url: "", lineNumber: -1 }
  const mk = `${m.functionName || "anon"} ${short(m.url)}:${m.lineNumber + 1}`
  mid.set(mk, (mid.get(mk) ?? 0) + dt)
})
for (const [name, mp] of [["leaf", leaf], ["first non-internal caller", mid]] as const) { console.log(`== ${name}`); for (const [k, v] of [...mp].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${(v / 1000).toFixed(0).padStart(5)} ms  ${k}`) }
