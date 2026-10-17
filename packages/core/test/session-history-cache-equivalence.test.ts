import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instructions } from "@opencode/core/instructions/index"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

/**
 * Phase-3 equivalence property test (HANDOFF-SESSION-PERF.md section 6.1).
 *
 * Drives a real session through the event bus + SQLite projector with a
 * seeded PRNG over adversarial op-sequences (append user/synthetic, local
 * compaction, revert committed, instructions updated). After EVERY op it
 * asserts the cached path (`SessionHistory.entriesForRunner`) is
 * byte-identical to a fresh uncached full rebuild (`clearHistoryCache` then
 * reload).
 *
 * This is the falsifier: a stale cache hit (e.g. a naive suffix cache that
 * resurrects rows deleted by RevertEvent.Committed) shows up as
 * cached !== fresh. The current implementation invalidates on durableSeq,
 * which advances on every message-write-causing durable event
 * (bus.ts:commitDurableEvent), so every bus-mediated mutation forces a rebuild
 * and this test passes.
 *
 * Out of scope: external direct DB row edits bypassing the bus are NOT
 * captured by any revision key (the bus/projector is the sole writer per
 * AGENTS.md durable-event discipline); they are documented, not fuzzed here.
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

// xorshift32 PRNG - deterministic, dependency-free.
class Rng {
  constructor(private seed: number) {}
  nextUint32() {
    let x = this.seed | 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x
    return x >>> 0
  }
  int(max: number) {
    return Math.abs((this.nextUint32() % max + max) % max)
  }
  pick<T>(items: ReadonlyArray<T>): T {
    return items[this.int(items.length)]!
  }
}

type OpKind = "user" | "synthetic" | "compact" | "revert" | "instructions"

it.effect("cached history equals fresh full rebuild after every bus-mediated op", () =>
  Effect.gen(function* () {
    const rng = new Rng(20261017)
    const sequences = 25
    const opsPerSequence = 20
    const kinds: ReadonlyArray<OpKind> = ["user", "synthetic", "compact", "revert", "instructions"]

    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const inbox = yield* SessionInbox.Service
    const db = database.db

    for (let s = 0; s < sequences; s++) {
      const sessionID = SessionSchema.ID.make(`ses_fuzz_${s}`)
      const projectID = Project.ID.make(`proj_fuzz_${s}`)
      yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* bus.publish(SessionEvent.Created, {
        sessionID,
        projectID,
        location: { directory: AbsolutePath.make("/project") },
        slug: "fuzz",
        version: "test",
      })
      const instructions = Instructions.make({
        key: Instructions.Key.make("test/fuzz"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.sync(() => "fuzz instructions"),
        render: { initial: String, changed: (_previous: unknown, value: string) => value, removed: () => "removed" },
      })
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const prepared = yield* InstructionState.current(db, sessionID)
      expect(prepared).toBeDefined()
      const insideTx = yield* db.transaction(() =>
        Effect.gen(function* () {
          return yield* InstructionState.current(db, sessionID)
        }),
      )
      expect(insideTx).toBeDefined()
      const messageIDs: SessionMessage.ID[] = []
      // Seed one user message so the session has an admitted instruction baseline (mirrors session-provider-context test).
      const seedID = SessionMessage.ID.create()
      yield* inbox.admit({ id: seedID, sessionID, item: { type: "user", payload: { text: "seed" }, delivery: "steer" } })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: seedID })
      messageIDs.push(seedID)

      const runOp = (kind: OpKind) =>
        Effect.gen(function* () {
          const id = SessionMessage.ID.create()
          if (kind === "user") {
            yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text: "fuzz" }, delivery: "steer" } })
            yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
            messageIDs.push(id)
            return
          }
          if (kind === "synthetic") {
            yield* bus.publish(SessionEvent.Synthetic, {
              sessionID,
              text: "fuzz",
              description: undefined,
              metadata: undefined,
            })
            messageIDs.push(id)
            return
          }
          if (kind === "compact") {
            yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
            yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "fuzz summary", recent: "" })
            return
          }
          if (kind === "revert") {
            const rows = yield* db
              .select({ id: SessionMessageTable.id })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, sessionID))
              .all()
              .pipe(Effect.orDie)
            if (rows.length === 0) return
            const boundary = rows[rng.int(rows.length)]!.id
            yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: boundary })
            return
          }
          if (kind === "instructions") {
            yield* bus.publish(SessionEvent.InstructionsUpdated, { sessionID, delta: {}, text: "fuzz instruction update" })
            return
          }
        })

      // Seed a few messages so revert has targets.
      for (let i = 0; i < 3; i++) yield* runOp("user")

      // Re-prepare instructions after every op (mirrors `prepareContext` in llm.ts, which calls
      // `InstructionState.prepare` each step). `RevertEvent.Committed` resets instruction state via
      // `InstructionState.reset`, so this keeps `entriesForRunner` able to read it.
      const prepareEachStep = () => InstructionState.prepare(db, bus, instructions, sessionID)

      const refreshMessageIDs = () =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ id: SessionMessageTable.id })
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, sessionID))
            .orderBy(asc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          messageIDs.splice(0, messageIDs.length, ...rows.map((r) => r.id))
        })

      for (let o = 0; o < opsPerSequence; o++) {
        const kind = rng.pick(kinds)
        yield* runOp(kind)
        if (kind === "revert") yield* refreshMessageIDs()
        yield* prepareEachStep()

        // First read after the op (cache miss: every op is a durable event, so durableSeq changes).
        const afterOp = yield* SessionHistory.entriesForRunner(db, sessionID, instructions, "local")
        // Second read without an intervening op (cache hit: revisionKey unchanged).
        const cachedHit = yield* SessionHistory.entriesForRunner(db, sessionID, instructions, "local")
        expect(JSON.stringify(cachedHit)).toBe(JSON.stringify(afterOp))
        // Fresh uncached full rebuild.
        SessionHistory.clearHistoryCache()
        const fresh = yield* SessionHistory.entriesForRunner(db, sessionID, instructions, "local")
        expect(JSON.stringify(fresh)).toBe(JSON.stringify(afterOp))
      }
    }
  }),
  30000,
)
