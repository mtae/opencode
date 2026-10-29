import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { DateTime, Effect, Fiber, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSearch } from "@opencode/core/session/search"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { FileAttachment } from "@opencode/schema/prompt"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it as plain, testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionSearch.node]),
  ),
)

const directory = AbsolutePath.make("/project")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const seedProject = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: directory, sandboxes: [] }).run()
})

const createSession = (id: string, title: string, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessionID = Session.ID.make(id)
    yield* bus.publish(SessionEvent.Created, {
      sessionID,
      projectID: Project.ID.global,
      location: { directory },
      parentID,
      slug: id,
      title,
      version: "test",
    })
    return sessionID
  })

const prompt = (sessionID: Session.ID, id: string, text: string, files?: ReadonlyArray<FileAttachment>) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const inboxID = SessionMessage.ID.make(id)
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID,
      item: { type: "user", payload: { text, files }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
    return inboxID
  })

const assistantData = (id: SessionMessage.ID, content: SessionMessage.AssistantContent[]) => {
  const message = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      content,
      time: { created: DateTime.makeUnsafe(0) },
    }),
  )
  const { id: _, type, ...data } = message
  return { type, data }
}

// Assistant messages are written the way transfer imports them: rows plus a reserved sequence.
const reply = (sessionID: Session.ID, id: string, content: SessionMessage.AssistantContent[]) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const messageID = SessionMessage.ID.make(id)
    const seq = (yield* Bus.latestSequence(database.db, sessionID)) + 1
    yield* database.db
      .insert(SessionMessageTable)
      .values({ id: messageID, session_id: sessionID, seq, time_created: 0, ...assistantData(messageID, content) })
      .run()
    yield* Bus.reserveSequence(database.db, sessionID, seq)
    return messageID
  })

const edit = (sessionID: Session.ID, messageID: SessionMessage.ID, content: SessionMessage.AssistantContent[]) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .update(SessionMessageTable)
      .set({ data: assistantData(messageID, content).data })
      .where(eq(SessionMessageTable.id, messageID))
      .run()
    yield* Bus.reserveSequence(database.db, sessionID, (yield* Bus.latestSequence(database.db, sessionID)) + 1)
  })

const text = (value: string): SessionMessage.AssistantContent => ({ type: "text", text: value })

const search = (query: string, filter: SessionStore.Filter & { readonly limit?: number } = {}) =>
  Effect.gen(function* () {
    const service = yield* SessionSearch.Service
    return yield* service.search({ ...filter, query })
  })

const ids = (response: SessionSearch.Response) => response.data.map((result) => String(result.session.id))

const highlighted = (result: SessionSearch.Response["data"][number]) =>
  result.match?.snippet.filter((fragment) => fragment.highlight).map((fragment) => fragment.text)

// Search objects in the main database, which never holds any, and in the attached index database.
const searchTables = Effect.gen(function* () {
  const database = yield* Database.Service
  const attached = yield* database.db.all<{ name: string }>(sql`PRAGMA database_list`)
  const names = (schema: string) =>
    database.db
      .all<{ name: string }>(sql.raw(`SELECT name FROM ${schema}.sqlite_master WHERE name LIKE 'session_search%'`))
      .pipe(Effect.map((rows) => rows.map((row) => row.name).toSorted()))
  return {
    main: yield* names("main"),
    index: attached.some((row) => row.name === "session_search") ? yield* names("session_search") : [],
  }
})

const countDocs = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return (yield* database.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM session_search_doc WHERE session_id = ${sessionID}`,
    ))?.count
  })

describe("SessionSearch", () => {
  it.effect("ranks user, assistant, and tool text with highlighted snippets", () =>
    Effect.gen(function* () {
      yield* seedProject
      const asked = yield* createSession("ses_asked", "Setup questions")
      yield* prompt(asked, "msg_asked", "How do I configure the frobnicator for staging?")
      const answered = yield* createSession("ses_answered", "Refactor")
      yield* reply(answered, "msg_answered", [
        text("The frobnicator reads its settings from config.ts."),
        {
          type: "tool",
          id: "call_1",
          name: "read",
          state: { status: "running", input: { filePath: "/src/widget.ts" }, metadata: {} },
          time: { created: DateTime.makeUnsafe(0) },
        },
      ])
      yield* createSession("ses_other", "Unrelated")

      const found = yield* search("frobnicator")
      expect(found.pending).toBe(0)
      expect(ids(found).toSorted()).toEqual(["ses_answered", "ses_asked"])
      const user = found.data.find((result) => result.session.id === asked)
      expect(user?.match).toMatchObject({ messageID: "msg_asked", source: "user" })
      expect(highlighted(user!)).toEqual(["frobnicator"])
      expect(user?.match?.snippet.map((fragment) => fragment.text).join("")).toBe(
        "How do I configure the frobnicator for staging?",
      )
      const assistant = found.data.find((result) => result.session.id === answered)
      expect(assistant?.match).toMatchObject({ messageID: "msg_answered", source: "assistant" })

      expect(ids(yield* search("widget"))).toEqual(["ses_answered"])
      expect((yield* search("widget")).data[0]?.match?.source).toBe("tool")
      expect(ids(yield* search("setup"))).toEqual(["ses_asked"])
      expect((yield* search("setup")).data[0]?.match?.source).toBe("title")
      expect(ids(yield* search("frobnicator staging"))).toEqual(["ses_asked"])
    }),
  )

  it.effect("indexes attachment names but not their bytes", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_files", "Files")
      yield* prompt(session, "msg_files", "see attached", [
        FileAttachment.create({
          data: "iVBORw0KGgoAAAANSUhEUg==",
          mime: "image/png",
          source: { type: "inline" },
          name: "architecture-diagram.png",
        }),
      ])

      expect((yield* search("diagram")).data[0]?.match).toMatchObject({ messageID: "msg_files", source: "user" })
      expect(ids(yield* search("iVBORw0KGgo"))).toEqual([])
    }),
  )

  it.effect("matches the last term as a prefix while typing", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_prefix", "Prefix")
      yield* prompt(session, "msg_prefix", "Résumé parsing breaks on accented names")

      expect(ids(yield* search("pars"))).toEqual(["ses_prefix"])
      expect(highlighted((yield* search("pars")).data[0]!)).toEqual(["parsing"])
      expect(ids(yield* search("resume"))).toEqual(["ses_prefix"])
      expect(ids(yield* search("pars "))).toEqual([])
      expect(ids(yield* search("pa"))).toEqual([])
      // Query syntax is treated as text: every word must match.
      expect(ids(yield* search('"parsing" names*'))).toEqual(["ses_prefix"])
      expect(ids(yield* search("parsing OR missing"))).toEqual([])
      expect(yield* search("  -- ")).toEqual({ data: [], pending: 0 })
    }),
  )

  it.effect("creates nothing until the first search and leaves writes to the next one", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_lazy", "Lazy")
      yield* prompt(session, "msg_lazy_1", "first quokka")
      expect(yield* searchTables).toEqual({ main: [], index: [] })

      expect(ids(yield* search("quokka"))).toEqual(["ses_lazy"])
      expect(yield* searchTables).toEqual({
        main: [],
        index: [
          "session_search_doc",
          "session_search_doc_delete",
          "session_search_doc_message_idx",
          "session_search_fts",
          "session_search_fts_config",
          "session_search_fts_data",
          "session_search_fts_docsize",
          "session_search_fts_idx",
          "session_search_state",
          "session_search_text",
          "session_search_text_delete",
          "session_search_text_insert",
        ],
      })
      const indexed = yield* countDocs(session)

      yield* prompt(session, "msg_lazy_2", "second wombat")
      expect(yield* countDocs(session)).toBe(indexed)
      expect(ids(yield* search("wombat"))).toEqual(["ses_lazy"])
      expect(yield* countDocs(session)).toBe((indexed ?? 0) + 1)
    }),
  )

  it.effect("reindexes edited messages and renamed sessions", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_edit", "Original name")
      const message = yield* reply(session, "msg_edit", [text("alpha draft")])
      expect(ids(yield* search("alpha"))).toEqual(["ses_edit"])

      yield* edit(session, message, [text("bravo final")])
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Renamed, { sessionID: session, title: "Renamed topic" })

      expect(ids(yield* search("alpha"))).toEqual([])
      expect(ids(yield* search("bravo"))).toEqual(["ses_edit"])
      expect(ids(yield* search("original"))).toEqual([])
      expect(ids(yield* search("renamed topic"))).toEqual(["ses_edit"])
    }),
  )

  it.effect("hides a staged revert and drops committed messages", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_revert", "Revert")
      yield* prompt(session, "msg_keep", "keep the pelican")
      const boundary = yield* prompt(session, "msg_drop", "drop the pelican and the walrus")
      expect(ids(yield* search("walrus"))).toEqual(["ses_revert"])

      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: session, revert: { messageID: boundary } })
      expect(ids(yield* search("walrus"))).toEqual([])
      expect((yield* search("pelican")).data[0]).toMatchObject({ hits: 1, match: { messageID: "msg_keep" } })

      yield* bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID: session })
      expect(ids(yield* search("walrus"))).toEqual(["ses_revert"])

      yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: session, revert: { messageID: boundary } })
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: session, to: boundary })
      expect(ids(yield* search("walrus"))).toEqual([])
      expect((yield* search("pelican")).data[0]?.hits).toBe(1)
      // The title and the one remaining prompt.
      expect(yield* countDocs(session)).toBe(2)
    }),
  )

  it.effect("keeps history searchable after compaction", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_compact", "Compaction")
      yield* prompt(session, "msg_before", "the narwhal migration plan")
      expect(ids(yield* search("narwhal"))).toEqual(["ses_compact"])

      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: session, reason: "manual" })
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID: session,
        reason: "manual",
        text: "summary of earlier work",
      })

      expect((yield* search("narwhal")).data[0]?.match?.messageID).toBe(SessionMessage.ID.make("msg_before"))
      // Compaction summaries repeat earlier text, so they are not indexed.
      expect(ids(yield* search("summary"))).toEqual([])
    }),
  )

  it.effect("purges deleted sessions", () =>
    Effect.gen(function* () {
      yield* seedProject
      const session = yield* createSession("ses_gone", "Gone")
      yield* prompt(session, "msg_gone", "ephemeral axolotl")
      expect(ids(yield* search("axolotl"))).toEqual(["ses_gone"])

      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Deleted, { sessionID: session })

      expect(ids(yield* search("axolotl"))).toEqual([])
      expect(yield* countDocs(session)).toBe(0)
    }),
  )

  it.effect("applies session list filters", () =>
    Effect.gen(function* () {
      yield* seedProject
      const parent = yield* createSession("ses_parent", "Parent")
      yield* prompt(parent, "msg_parent", "shared capybara")
      const child = yield* createSession("ses_child", "Child", parent)
      yield* prompt(child, "msg_child", "shared capybara in a subagent")

      expect(ids(yield* search("capybara")).toSorted()).toEqual(["ses_child", "ses_parent"])
      expect(ids(yield* search("capybara", { parentID: null }))).toEqual(["ses_parent"])
      expect(ids(yield* search("capybara", { parentID: parent }))).toEqual(["ses_child"])
      expect(ids(yield* search("capybara", { directory: AbsolutePath.make("/elsewhere") }))).toEqual([])
      expect(ids(yield* search("capybara", { limit: 1 }))).toHaveLength(1)
    }),
  )
})

// A database in a file is searched by a worker thread, with the index in its own file beside it.
const withFileDatabase = <A, E, R>(body: (file: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const file = path.join(tmp.path, "opencode.db")
    return yield* body(file).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionSearch.node]),
          [Database.node.replace(Database.configured({ path: file }))],
        ),
      ),
    )
  })

describe("SessionSearch worker", () => {
  plain.live("searches messages from a worker and keeps the index out of the main database", () =>
    withFileDatabase((file) =>
      Effect.gen(function* () {
        yield* seedProject
        const session = yield* createSession("ses_worker", "Unrelated")
        yield* prompt(session, "msg_worker", "The frobnicator resizes images off the main thread")

        const found = yield* search("frobnicator")
        expect(found.data[0]?.match).toMatchObject({ messageID: "msg_worker", source: "user" })
        expect(ids(yield* search("resiz"))).toEqual(["ses_worker"])
        expect(existsSync(`${file}-search`)).toBe(true)
        expect((yield* searchTables).main).toEqual([])
      }),
    ),
  )

  plain.live("answers a search superseded while it waited with a conflict", () =>
    withFileDatabase(() =>
      Effect.gen(function* () {
        yield* seedProject
        yield* prompt(yield* createSession("ses_worker", "Unrelated"), "msg_worker", "frobnicator")
        yield* search("frobnicator")

        // The first runs, the second waits, and the third replaces the second before it starts.
        const fibers = yield* Effect.forEach(["frob", "frobn", "frobni"], (query) =>
          search(query).pipe(
            Effect.match({ onSuccess: ids, onFailure: (error) => error._tag }),
            Effect.forkChild({ startImmediately: true }),
          ),
        )
        expect(yield* Fiber.joinAll(fibers)).toEqual([["ses_worker"], "SessionSearch.SupersededError", ["ses_worker"]])
      }),
    ),
  )
})

describe("SessionSearch.parse", () => {
  test("quotes each word as a phrase and leaves syntax inert", () => {
    expect(SessionSearch.parse('foo.bar "baz" OR qux*')).toEqual({
      match: '"foo bar" "baz" "or" "qux"',
      terms: ["foo", "bar", "baz", "or", "qux"],
      prefix: false,
    })
    expect(SessionSearch.parse("Crème brû")?.match).toBe('"creme" "bru"*')
    expect(SessionSearch.parse("ab")?.prefix).toBe(false)
    expect(SessionSearch.parse("!!")).toBeUndefined()
  })
})

describe("SessionSearch.snippet", () => {
  test("windows long text around the densest match", () => {
    const query = SessionSearch.parse("needle haystack ")!
    const text = `${"lead ".repeat(60)}needle once. ${"filler ".repeat(10)}needle and haystack together ${"tail ".repeat(60)}`
    const fragments = SessionSearch.snippet(text, query, 80)
    const joined = fragments.map((fragment) => fragment.text).join("")
    expect(joined.startsWith("…")).toBe(true)
    expect(joined.endsWith("…")).toBe(true)
    expect(joined).toContain("needle and haystack together")
    expect(fragments.filter((fragment) => fragment.highlight).map((fragment) => fragment.text)).toContain("haystack")
  })
})
