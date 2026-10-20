// Busy time per 25 ms window (idle/hook samples excluded), with the dominant opencode owners in that window.
const [file, windowMs = "25"] = process.argv.slice(2)
const p = await Bun.file(file).json()
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const short = (u: string) => u.replace(/^.*opencode-perf[\/]packages[\/]/, "").replace(/^.*node_modules[\/]/, "nm/")
const W = Number(windowMs) * 1000
const buckets = new Map<number, { busy: number; owners: Map<string, number> }>()
let t = 0
p.samples.forEach((id: number, i: number) => {
  t += p.timeDeltas[i] ?? 0
  const dt = p.timeDeltas[i + 1] ?? 0
  const frames: any[] = []
  for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) frames.push(nodes.get(c).callFrame)
  if (frames.some((f) => f.url.includes("profile-hook")) || ["(root)", "(program)", "(idle)"].includes(frames[0].functionName)) return
  const b = Math.floor(t / W)
  const bucket = buckets.get(b) ?? { busy: 0, owners: new Map() }
  bucket.busy += dt
  const owner = frames.find((f) => /packages[\/](core|server|ai|cli|util)[\/]src/.test(f.url))
  const k = owner ? `${owner.functionName || "anon"}@${short(owner.url).replace(/\/src\//, "/")}:${owner.lineNumber + 1}` : "-"
  bucket.owners.set(k, (bucket.owners.get(k) ?? 0) + dt)
  buckets.set(b, bucket)
})
for (const [b, v] of [...buckets].sort((a, b) => a[0] - b[0])) {
  if (v.busy < 3000) continue
  const top = [...v.owners].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, us]) => `${k} ${(us / 1000).toFixed(0)}`).join(" | ")
  console.log(`${((b * W) / 1e6).toFixed(2).padStart(7)}s busy ${(v.busy / 1000).toFixed(0).padStart(3)}ms  ${top}`)
}
