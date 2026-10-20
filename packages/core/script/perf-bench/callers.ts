const [file, target, depth = "6"] = process.argv.slice(2)
const p = await Bun.file(file).json()
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const self = new Map<number, number>()
p.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)))
const short = (u: string) => u.replace(/^.*opencode-perf[\/]/, "").replace(/^.*node_modules[\/]/, "nm/").replace(/^.*scratchpad[\/]perf[\/]/, "bench/")
const chains = new Map<string, number>()
for (const [id, us] of self) {
  const n = nodes.get(id)
  if (!`${n.callFrame.functionName} ${short(n.callFrame.url)}`.includes(target)) continue
  const chain: string[] = []
  for (let cur = parent.get(id), d = 0; cur !== undefined && d < Number(depth); cur = parent.get(cur), d++) {
    const c = nodes.get(cur).callFrame
    chain.push(`${c.functionName || "(anon)"}@${short(c.url)}:${c.lineNumber + 1}`)
  }
  const key = chain.join(" < ")
  chains.set(key, (chains.get(key) ?? 0) + us)
}
for (const [k, v] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`)
