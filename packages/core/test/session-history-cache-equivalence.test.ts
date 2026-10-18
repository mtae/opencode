import { expect } from "bun:test"
import * as fc from "fast-check"
import { Effect, Schema } from "effect"
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
import { SessionStore } from "@opencode/core/session/store"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

/**
 * Phase-3 equivalence property test (HANDOFF-SESSION-PERF.md section 6.1).
 *
 * fast-check drives randomized op-sequences against a real session (event bus +
 * SQLite projector). After EVERY op it asserts the cached path
 * (`SessionHistory.entriesForRunner`) is byte-identical to a fresh uncached
 * full rebuild (`clearHistoryCache` then reload).
 *
 * This is the falsifier: a stale cache hit shows up as `cached !== fresh`.
 * The current cache invalidates on `durableSeq` (`Bus.latestSequence`, an O(1)
 * PK lookup bumped atomically with every message-write-causing durable event,
 * bus.ts:commitDurableEvent), so every bus-mediated mutation forces a rebuild
 * and this test passes.
 *
 * The old suffix fast path is gone — it was unsound:
 *   - RevertEvent.Committed deletes rows (projector.ts:770-776); the suffix gate
 *     only checked net `count`/`maxSeq` growth and prefix MAX(time_updated), so
 *     a delete-then-re-grow resurrecting deleted rows passed the gate.
 *   - time_updated = Date.now() has ms resolution; an in-place prefix-row update
 *     in the same millisecond as cached.maxUpdated left maxUpdated unchanged,
 *     serving stale prefix content via cached.entries.concat(decoded).
 *   - The suffix path never re-consulted durableSeq, which would have caught both.
 *
 * Out of scope: external direct DB row edits bypassing the bus are NOT captured
 * by any revision key (bus/projector is the sole writer per AGENTS.md durable-
 * event discipline); documented, not fuzzed here.
 */

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
  [Bus.node.replace(Bus.configured({ persist: true }))],
)

const it = testEffect(layer)

const instructions = Instructions.make({
  key: Instructions.Key.make("test/fuzz"),
  codec: Schema.toCodecJson(Schema.String),
  read: Effect.sync(() => "fuzz instructions"),
  render: {
    initial: String,
    changed: (_previous: unknown, value: string) => value,
    removed: () => "removed",
  },
})

type OpKind = "user" | "synthetic" | "compact" | "revert" | "instructions" | "content"

const buildSession = Effect.gen(function* () {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  const db = database.db
  const sessionID = SessionSchema.ID.make("ses_fuzz")
  const projectID = Project.ID.make("proj_fuzz")
  yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID,
    location: { directory: AbsolutePath.make("/project") },
    slug: "fuzz",
    version: "test",
  })
  yield* InstructionState.prepare(db, bus, instructions, sessionID)
  return { db, bus, inbox, sessionID, instructions }
})

type Ctx = Effect.Success<typeof buildSession>

const applyOp = (ctx: Ctx, kind: OpKind) =>
  Effect.gen(function* () {
    const { db, bus, inbox, sessionID } = ctx
    const id = SessionMessage.ID.create()
    if (kind === "user") {
      yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text: "fuzz" }, delivery: "steer" } })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
      return
    }
    if (kind === "synthetic") {
      yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: "fuzz", description: undefined, metadata: undefined })
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
      const boundary = rows[Math.floor(Math.random() * rows.length)]!.id
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: boundary })
      return
    }
    if (kind === "instructions") {
      yield* bus.publish(SessionEvent.InstructionsUpdated, { sessionID, delta: {}, text: "fuzz instruction update" })
      return
    }
    if (kind === "content") {
      const rows = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return
      const target = rows[Math.floor(Math.random() * rows.length)]!.id
      yield* bus.publish(SessionEvent.MessageContentUpdated, {
        sessionID,
        messageID: target,
        content: [{ type: "text", text: "fuzz" }],
      })
      return
    }
  })

// runPromise requires R = never; Effect.provide(layer) satisfies all context at
// runtime, so this cast is sound by construction. Each call opens/closes its own
// DB sub-scope; the outer it.effect layer stays open for the whole test.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>)

it.effect(
  "cached history equals fresh full rebuild after every bus-mediated op",
  () =>
    Effect.gen(function* () {
      const ctx = yield* buildSession
      const { db, bus, sessionID } = ctx

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(
            fc.array(fc.constantFrom<OpKind>("user", "synthetic", "compact", "revert", "instructions", "content"), {
              minLength: 1,
              maxLength: 30,
            }),
            async (ops) => {
              for (const kind of ops) {
                await run(applyOp(ctx, kind))
                // Re-prepare instruction state each step (mirrors prepareContext in llm.ts).
                // RevertEvent.Committed resets instruction state via InstructionState.reset.
                await run(InstructionState.prepare(db, bus, instructions, sessionID))

                // Cache hit vs fresh rebuild: revision unchanged since last op because every
                // op above is a durable event, so durableSeq changed. We compare against a
                // fresh uncached full rebuild (clearHistoryCache forces a miss).
                const cached = await run(
                  SessionHistory.entriesForRunner(db, sessionID, instructions, "local"),
                )
                SessionHistory.clearHistoryCache()
                const fresh = await run(
                  SessionHistory.entriesForRunner(db, sessionID, instructions, "local"),
                )
                expect(JSON.stringify(cached)).toBe(JSON.stringify(fresh))
              }
            },
          ),
          { numRuns: 25, seed: 20261017 },
        ),
      )
    }),
  { timeout: 120000 },
)
