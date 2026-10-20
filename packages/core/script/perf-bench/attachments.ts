import { Database } from "bun:sqlite"
const db = new Database(process.argv[2], { readonly: true })
// Every long base64-looking string inside message data, with its JSON path, mime hint and origin.
const rows = db.query("select id, session_id, type, length(data) len, data from session_message where length(data) > 200000").all() as any[]
const found: any[] = []
const walk = (v: any, path: string, ctx: any, row: any) => {
  if (typeof v === "string") { if (v.length > 100000 && /^[A-Za-z0-9+/=]{200}/.test(v.slice(v.indexOf(",") + 1))) found.push({ session: row.session_id.slice(-6), type: row.type, path, chars: v.length, mime: ctx.mime ?? ctx.mediaType ?? ctx.type, tool: ctx.tool, filename: ctx.filename ?? ctx.name ?? ctx.path }) ; return }
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, ctx, row))
  else if (v && typeof v === "object") { const c = { ...ctx }; for (const k of ["mime", "mediaType", "tool", "filename", "name", "path"]) if (typeof v[k] === "string") c[k] = v[k]; if (typeof v.type === "string") c.type = v.type; for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, c, row) }
}
for (const r of rows) walk(JSON.parse(r.data), "", {}, r)
const norm = (p: string) => p.replace(/\[\d+\]/g, "[]")
const groups = new Map<string, { n: number; max: number; total: number; over: number }>()
for (const f of found) { const k = `${f.type} ${norm(f.path)} mime=${f.mime} tool=${f.tool ?? "-"}`; const g = groups.get(k) ?? { n: 0, max: 0, total: 0, over: 0 }; g.n++; g.max = Math.max(g.max, f.chars); g.total += f.chars; if (f.chars > 424000) g.over++; groups.set(k, g) }
for (const [k, g] of [...groups].sort((a, b) => b[1].total - a[1].total)) console.log(`${String(g.n).padStart(3)} strings  max ${(g.max / 1e6).toFixed(2)}M chars  total ${(g.total / 1e6).toFixed(1)}M  over-cliff ${g.over}  ${k}`)
console.log(`--- items in session ${process.argv[3] ?? "(none given)"}:`)
for (const f of found.filter((f) => f.session === (process.argv[3] ?? "").slice(-6))) console.log(`${(f.chars / 1e6).toFixed(2)}M ${f.type} ${norm(f.path)} ${f.mime} ${f.tool ?? ""} ${f.filename ?? ""}`)
