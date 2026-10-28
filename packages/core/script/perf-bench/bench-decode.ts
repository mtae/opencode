// LOCAL ONLY (untracked): split history reload cost into SQL+JSON.parse vs Schema decode on a real session.
import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { SessionMessage } from "../../src/session/message.js"
const [file, sessionID, runs = "7"] = process.argv.slice(2)
const db = new Database(file, { readonly: true })
const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]
const sel: number[] = [], parse: number[] = [], dec: number[] = []
let bytes = 0, rows = 0
for (let i = 0; i < Number(runs); i++) {
  const t0 = performance.now()
  const raw = db.query("select id, type, seq, data from session_message where session_id = ? order by seq").all(sessionID) as any[]
  const t1 = performance.now()
  const parsed = raw.map((r) => ({ ...JSON.parse(r.data), id: r.id, type: r.type }))
  const t2 = performance.now()
  for (const p of parsed) await Effect.runPromise(Effect.exit(decode(p)))
  const t3 = performance.now()
  sel.push(t1 - t0); parse.push(t2 - t1); dec.push(t3 - t2)
  bytes = raw.reduce((s, r) => s + r.data.length, 0); rows = raw.length
}
console.log(`${sessionID}: ${rows} rows, ${(bytes / 1048576).toFixed(1)} MB`)
console.log(`select ${median(sel).toFixed(1)} ms | JSON.parse ${median(parse).toFixed(1)} ms | Schema decode ${median(dec).toFixed(1)} ms`)
