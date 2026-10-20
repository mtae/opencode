// Attribute busy samples in [from,to] seconds to subsystems, by the first matching rule (checked against every frame in the stack).
const [file, from, to, steps] = process.argv.slice(2)
const p = await Bun.file(file).json()
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const rules: [string, (f: any) => boolean][] = [
  ["logger", (f) => /effect[\/]dist[\/]Logger/.test(f.url)],
  ["provider/model snapshot (Integration.list, models-dev)", (f) => /core[\/]src[\/](provider|integration|models-dev|variant)\.ts/.test(f.url) || /plugin[\/]provider/.test(f.url)],
  ["tool json schema", (f) => /tool[\/]runtime\.ts/.test(f.url) && /toJsonSchema|inlineLocal/.test(f.functionName) || /emptyInputJsonSchema/.test(f.functionName)],
  ["history load+decode", (f) => /session[\/]history\.ts/.test(f.url)],
  ["tool execution (read)", (f) => /core[\/]src[\/]tool[\/](plugin|read)/.test(f.url)],
  ["projectors / event commit", (f) => /session[\/](projector|message-updater)\.ts|core[\/]src[\/]bus\.ts/.test(f.url)],
  ["stream parse + event publish", (f) => /publish-llm-event|protocols[\/]openai-chat\.ts:?/.test(f.url) && /publish|parse|decode|Event/i.test(f.functionName + f.url)],
  ["request build/encode/send", (f) => /packages[\/]ai[\/]src/.test(f.url) || /to-llm-message|model-request/.test(f.url)],
  ["db (other)", (f) => /database[\/]/.test(f.url)],
  ["runner (other)", (f) => /session[\/]runner/.test(f.url)],
  ["http server / sse", (f) => /packages[\/]server|http-api|_http_|node:net/.test(f.url)],
]
const out = new Map<string, number>()
let t = 0, total = 0
p.samples.forEach((id: number, i: number) => {
  t += p.timeDeltas[i] ?? 0
  const dt = p.timeDeltas[i + 1] ?? 0
  if (t / 1e6 < Number(from) || t / 1e6 > Number(to)) return
  const frames: any[] = []
  for (let c: number | undefined = id; c !== undefined; c = parent.get(c)) frames.push(nodes.get(c).callFrame)
  if (frames.some((f) => f.url.includes("profile-hook")) || ["(root)", "(program)", "(idle)"].includes(frames[0].functionName)) return
  const k = rules.find(([, r]) => frames.some(r))?.[0] ?? "unattributed (effect runtime, GC, natives)"
  out.set(k, (out.get(k) ?? 0) + dt); total += dt
})
const n = Number(steps)
console.log(`window ${from}-${to}s busy ${(total / 1000).toFixed(0)} ms = ${(total / 1000 / n).toFixed(1)} ms/step over ${n} steps`)
for (const [k, v] of [...out].sort((a, b) => b[1] - a[1])) console.log(`${(v / 1000 / n).toFixed(1).padStart(6)} ms/step ${(100 * v / total).toFixed(0).padStart(3)}%  ${k}`)
