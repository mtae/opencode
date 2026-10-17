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
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const setup = (n: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const inbox = yield* SessionInbox.Service
    const db = database.db
    const sessionID = SessionSchema.ID.make("ses_cache_test")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* bus.publish(SessionEvent.Created, {
      sessionID,
      projectID: Project.ID.global,
      location: { directory: AbsolutePath.make("/project") },
      slug: "cache",
      version: "test",
    })
    const instructions = [] as unknown as Instructions.List
    yield* InstructionState.prepare(db, bus, instructions, sessionID)
    for (let i = 0; i < n; i++) {
      const id = SessionMessage.ID.create()
      yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text: `msg ${i}` }, delivery: "steer" } })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
    }
    return { db, bus, inbox, sessionID, instructions }
  })

it.effect("cache reuse equals fresh rebuild", () =>
  Effect.gen(function* () {
    const s = yield* setup(50)
    const first = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    const second = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    SessionHistory.clearHistoryCache()
    const fresh = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    expect(JSON.stringify(fresh)).toBe(JSON.stringify(first))
  }),
)

it.effect("append keeps cache correct", () =>
  Effect.gen(function* () {
    const s = yield* setup(20)
    const before = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    const id = SessionMessage.ID.create()
    yield* s.inbox.admit({ id, sessionID: s.sessionID, item: { type: "user", payload: { text: "appended" }, delivery: "steer" } })
    yield* s.bus.publish(SessionEvent.InboxDelivered, { sessionID: s.sessionID, inboxID: id })
    const afterCached = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    SessionHistory.clearHistoryCache()
    const afterFresh = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    expect(JSON.stringify(afterCached)).toBe(JSON.stringify(afterFresh))
    expect(afterCached.entries.length).toBe(before.entries.length + 1)
  }),
)

it.effect("compaction keeps cache correct", () =>
  Effect.gen(function* () {
    const s = yield* setup(40)
    yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: s.sessionID, reason: "manual", recent: "" })
    yield* s.bus.publish(SessionEvent.Compaction.Ended, { sessionID: s.sessionID, reason: "manual", text: "summary", recent: "" })
    const cached = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    SessionHistory.clearHistoryCache()
    const fresh = yield* SessionHistory.entriesForRunner(s.db, s.sessionID, s.instructions, "local")
    expect(JSON.stringify(cached)).toBe(JSON.stringify(fresh))
  }),
)


