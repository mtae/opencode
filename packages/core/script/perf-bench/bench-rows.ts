// LOCAL ONLY: per-row Schema decode cost, to find pathological rows.
import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { SessionMessage } from "../../src/session/message.js"
const [file, sessionID] = process.argv.slice(2)
const db = new Database(file, { readonly: true })
const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
const raw = db.query("select id, type, seq, data from session_message where session_id = ? order by seq").all(sessionID) as any[]
const results = []
for (const r of raw) {
  const p = { ...JSON.parse(r.data), id: r.id, type: r.type }
  await Effect.runPromise(Effect.exit(decode(p)))
  const t = performance.now()
  for (let i = 0; i < 3; i++) await Effect.runPromise(Effect.exit(decode(p)))
  results.push({ seq: r.seq, type: r.type, kb: Math.round(r.data.length / 1024), ms: (performance.now() - t) / 3, keys: Object.keys(p).join(",").slice(0, 80) })
}
const total = results.reduce((s, r) => s + r.ms, 0)
console.log(`total ${total.toFixed(1)} ms over ${results.length} rows`)
console.table(results.toSorted((a, b) => b.ms - a.ms).slice(0, 8).map((r) => ({ ...r, ms: r.ms.toFixed(1) })))
