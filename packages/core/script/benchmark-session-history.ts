import path from "path"
import { Effect, Logger } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { SessionProjector } from "../src/session/projector"
import { SessionInbox } from "../src/session/inbox"
import { SessionHistory } from "../src/session/history"
import { SessionStore } from "../src/session/store"
import { InstructionState } from "../src/session/instruction-state"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { ProjectTable } from "../src/project/sql"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import { Instructions } from "../src/instructions/index"

const args = process.argv.slice(2)
const getArg = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1] ?? fallback
}
const messages = Number(getArg("--messages", "1000"))
const runs = Number(getArg("--runs", "15"))
const warmup = Number(getArg("--warmup", "3"))
const textSize = Number(getArg("--text-size", "256"))
const compaction = getArg("--compaction", "0") === "1"
const boundary = (getArg("--boundary", "local") as "latest" | "local")
const grow = getArg("--grow", "0") === "1"

if (!Number.isInteger(messages) || messages < 1) {
  console.error("--messages must be a positive integer")
  process.exit(1)
}

const sessionID = SessionSchema.ID.make("ses_bench_history")
const projectID = Project.ID.global
const directory = path.resolve(process.cwd())
const largeText = "x".repeat(textSize)

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
  [Bus.node.replace(Bus.configured({ persist: true }))],
)

const stats = (samples: ReadonlyArray<number>) => {
  const sorted = samples.toSorted((a, b) => a - b)
  const percentile = (value: number) => sorted[Math.min(Math.ceil(sorted.length * value) - 1, sorted.length - 1)]
  const median = sorted.length % 2 === 0
    ? ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2
    : (sorted[Math.floor(sorted.length / 2)] ?? 0)
  const mad = sorted.length
    ? sorted.map((v) => Math.abs(v - median)).toSorted((a, b) => a - b)[Math.floor(sorted.length / 2)] ?? 0
    : 0
  return {
    n: samples.length,
    min: sorted[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
    median,
    mad,
    mean: samples.reduce((t, s) => t + s, 0) / (samples.length || 1),
  }
}
const print = (name: string, samples: ReadonlyArray<number>) => {
  const r = stats(samples)
  console.log(
    `${name.padEnd(28)} n=${r.n} median=${r.median.toFixed(3)} ms  MAD=${r.mad.toFixed(3)}  p50=${r.p50.toFixed(3)}  p95=${r.p95.toFixed(3)}  min=${r.min.toFixed(3)}  max=${r.max.toFixed(3)}`,
  )
}

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const db = database.db

  yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()

  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID,
    location: { directory: AbsolutePath.make(directory) },
    slug: "bench",
    version: "test",
  })

  // Generate messages
  const tGen0 = performance.now()
  for (let i = 0; i < messages; i++) {
    const id = SessionMessage.ID.create()
    yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text: `${i}: ${largeText}` }, delivery: "steer" } })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
    if (compaction && i === Math.floor(messages / 2)) {
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "checkpoint summary", recent: "" })
    }
  }
  const genMs = performance.now() - tGen0
  console.log(`generated ${messages} messages in ${genMs.toFixed(1)} ms (compaction=${compaction})`)

  const instructions = [] as unknown as Instructions.List
  yield* InstructionState.prepare(db, bus, instructions, sessionID)
  const modelRef = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-4") })

  // Warmup
  for (let i = 0; i < warmup; i++) {
    yield* SessionHistory.entriesForRunner(db, sessionID, instructions, boundary)
  }

  const reloadSamples: number[] = []
  const convertSamples: number[] = []
  const totalSamples: number[] = []
  for (let i = 0; i < runs; i++) {
    if (grow) {
      const id = SessionMessage.ID.create()
      yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text: `${messages + i}: ${largeText}` }, delivery: "steer" } })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
    }
    const t0 = performance.now()
    const history = yield* SessionHistory.entriesForRunner(db, sessionID, instructions, boundary)
    const t1 = performance.now()
    const msgs = history.entries.map((e) => e.message)
    toLLMMessages(msgs, modelRef)
    const t2 = performance.now()
    reloadSamples.push(t1 - t0)
    convertSamples.push(t2 - t1)
    totalSamples.push(t2 - t0)
  }

  console.log(`scale=${messages} text_size=${textSize} boundary=${boundary} compaction=${compaction}`)
  print("reload (entriesForRunner)", reloadSamples)
  print("convert (toLLMMessages)", convertSamples)
  print("reload+convert", totalSamples)

  const r = stats(reloadSamples)
  console.log(`JSON_RESULT ${JSON.stringify({ messages, textSize, boundary, compaction, runs, warmup, reload: r })}`)
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([])))

await Effect.runPromise(program)
