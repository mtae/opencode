import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Duration, Effect, Layer, LayerMap, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KVTable } from "@opencode/core/kv/sql"
import { Location } from "@opencode/core/location"
import { LocationServiceMap, type LocationServices } from "@opencode/core/location-services"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
import { SessionMessageTable, SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { Workspace } from "@opencode/core/workspace"
import { Shell } from "@opencode/schema/shell"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { globalProjectNode } from "./lib/project"
import { testEffect } from "./lib/effect"

// experimental.sqlite_fts per workspace, read by each loaded location's Config.
const flags = new Map<string, boolean>()

const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        // Search readiness only reads Config from a location.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mergeAll(
          Config.testLayer([
            new Document({
              type: "document",
              info: new Info({
                experimental: new ConfigExperimental.Info({ sqlite_fts: flags.get(ref.workspaceID ?? "") }),
              }),
            }),
          ]),
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
            }),
          ),
        ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      { idleTimeToLive: Duration.infinity },
    )
    return {
      ...map,
      get: (ref: Location.Ref) => map.get(LocationServiceMap.canonical(ref)),
      contextEffect: (ref: Location.Ref) => map.contextEffect(LocationServiceMap.canonical(ref)),
      contextEffectOption: (ref: Location.Ref) => map.contextEffectOption(LocationServiceMap.canonical(ref)),
      invalidate: (ref: Location.Ref) => map.invalidate(LocationServiceMap.canonical(ref)),
    }
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, Session.node]), [
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    LocationServiceMap.node.replace(
      makeGlobalNode({ service: LocationServiceMap.Service, layer: locations, deps: [] }),
    ),
  ]),
)

const project = AbsolutePath.make("/project")
const other = AbsolutePath.make("/other")
const encode = Schema.encodeSync(SessionMessage.Info)
const encodePart = Schema.encodeSync(SessionMessage.AssistantContent)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }

/** Loads a location whose config turns the index on or off. */
const enable = (on: boolean) =>
  Effect.gen(function* () {
    const workspaceID = Workspace.ID.make(`wrk_${on ? "on" : "off"}`)
    flags.set(workspaceID, on)
    const map = yield* LocationServiceMap.Service
    yield* Location.Service.pipe(
      Effect.provide(map.get(Location.Ref.make({ directory: project, workspaceID }))),
      Effect.scoped,
    )
  })

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: project, sandboxes: [] }).run()
  return db
})

type Db = Effect.Success<typeof setup>

const addSession = (
  db: Db,
  id: string,
  input: { title?: string; updated: number; directory?: AbsolutePath; parent?: string; archived?: boolean },
) =>
  db
    .insert(SessionTable)
    .values({
      id: Session.ID.make(id),
      project_id: Project.ID.global,
      slug: id,
      directory: input.directory ?? project,
      title: input.title ?? "untitled",
      version: "test",
      parent_id: input.parent === undefined ? null : Session.ID.make(input.parent),
      time_archived: input.archived ? input.updated : null,
      time_created: input.updated,
      time_updated: input.updated,
    })
    .run()

let seq = 0
const addUser = (db: Db, sessionID: string, text: string) => {
  const message = SessionMessage.User.make({
    id: SessionMessage.ID.make(`msg_${String(++seq).padStart(4, "0")}`),
    type: "user",
    text,
    time: { created: Schema.decodeSync(Schema.DateTimeUtcFromMillis)(1_000) },
  })
  const { id: _, type, ...data } = encode(message)
  return db
    .insert(SessionMessageTable)
    .values({ id: message.id, session_id: Session.ID.make(sessionID), type, seq, time_created: 1_000, data })
    .run()
}

/** A finished assistant whose text lives only in `session_part` rows, not in the message data. */
const addPartOnlyAssistant = (db: Db, sessionID: string, text: string) =>
  Effect.gen(function* () {
    const created = Schema.decodeSync(Schema.DateTimeUtcFromMillis)(1_000)
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(`msg_${String(++seq).padStart(4, "0")}`),
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content: [],
      time: { created, completed: created },
    })
    const { id: _, type, ...data } = encode(message)
    yield* db
      .insert(SessionMessageTable)
      .values({ id: message.id, session_id: Session.ID.make(sessionID), type, seq, time_created: 1_000, data })
      .run()
    yield* db
      .insert(SessionPartTable)
      .values({
        message_id: message.id,
        session_id: Session.ID.make(sessionID),
        ordinal: 0,
        type: "text",
        call_id: null,
        time_created: 1,
        time_updated: 1,
        data: encodePart(SessionMessage.AssistantText.make({ type: "text", text })),
      })
      .run()
  })

const nextID = () => SessionMessage.ID.make(`msg_${String(++seq).padStart(4, "0")}`)
const created = Schema.decodeSync(Schema.DateTimeUtcFromMillis)(1_000)

const addMessage = (db: Db, sessionID: string, message: SessionMessage.Info) => {
  const { id: _, type, ...data } = encode(message)
  return db
    .insert(SessionMessageTable)
    .values({ id: message.id, session_id: Session.ID.make(sessionID), type, seq, time_created: 1_000, data })
    .run()
}

const toolCall = (callID: string, name: string, input: Record<string, unknown>, output: string) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: callID,
    name,
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input,
      content: [{ type: "text", text: output }],
    }),
    time: { created },
  })

const finished = (content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({
    id: nextID(),
    type: "assistant",
    agent: Agent.defaultID,
    model,
    content,
    time: { created, completed: created },
  })

const index = (db: Db) =>
  Effect.gen(function* () {
    yield* SessionSearchIndex.ensure(db)
    while (!(yield* SessionSearchIndex.backfillBatch(db)).done) {}
    while ((yield* SessionSearchIndex.processBatch(db)) > 0) {}
  })

const ids = (result: { readonly data: ReadonlyArray<{ readonly id: string }> }) => result.data.map((item) => item.id)

describe("Session.list search", () => {
  it.effect("matches assistant text stored only in part rows", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_parts", { title: "Untitled chat", updated: 10 })
      yield* addPartOnlyAssistant(db, "ses_parts", "the walrus migration needs a rollback plan")
      yield* index(db)
      const session = yield* Session.Service

      const result = yield* session.list({ search: "walrus migration" })

      expect(ids(result)).toEqual(["ses_parts"])
      expect(result.experimental).toBeUndefined()
    }),
  )

  it.effect("matches a partially typed word literally, without stemming", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_log", { updated: 10 })
      yield* addUser(db, "ses_log", "logging the migration")
      yield* index(db)
      const session = yield* Session.Service

      // A porter index stores `logging` as `log`, so the typed prefix `loggi` matched nothing.
      expect(ids(yield* session.list({ search: "loggi" }))).toEqual(["ses_log"])
      expect(ids(yield* session.list({ search: "the migr" }))).toEqual(["ses_log"])
      expect(ids(yield* session.list({ search: "Logging" }))).toEqual(["ses_log"])
      // Literal words: a different form of the word is no longer the same term.
      expect(ids(yield* session.list({ search: "logged " }))).toEqual([])
      expect(ids(yield* session.list({ search: "migrate" }))).toEqual([])
    }),
  )

  it.effect("matches bounded audit metadata: tool inputs, attachments, shell commands and synthetic notes", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* Effect.forEach(["ses_inline", "ses_part", "ses_attach", "ses_shell", "ses_synth", "ses_notice"], (id, n) =>
        addSession(db, id, { updated: 10 + n }),
      )
      // A command present only in an inline tool call's input; its output is not indexed.
      yield* addMessage(
        db,
        "ses_inline",
        finished([toolCall("call_1", "bash", { command: "kubectl rollout restart" }, "inlineoutputonly")]),
      )
      // A file name present only in a tool call stored as a session_part row.
      const part = finished([])
      yield* addMessage(db, "ses_part", part)
      yield* db
        .insert(SessionPartTable)
        .values({
          message_id: part.id,
          session_id: Session.ID.make("ses_part"),
          ordinal: 0,
          type: "tool",
          call_id: "call_2",
          time_created: 1,
          time_updated: 1,
          data: encodePart(toolCall("call_2", "read", { filePath: "src/quokka-handler.ts" }, "partoutputonly")),
        })
        .run()
      yield* addMessage(
        db,
        "ses_attach",
        SessionMessage.User.make({
          id: nextID(),
          type: "user",
          text: "see attached",
          files: [{ data: "aGVsbG8=", mime: "application/pdf", source: { type: "inline" }, name: "wombat-report.pdf" }],
          time: { created },
        }),
      )
      yield* addMessage(
        db,
        "ses_shell",
        SessionMessage.Shell.make({
          id: nextID(),
          type: "shell",
          shellID: Shell.ID.make("sh_1"),
          command: "terraform plan -out=numbat",
          status: "exited",
          output: { output: "shelloutputonly", cursor: 15, size: 15, truncated: false },
          time: { created },
        }),
      )
      yield* addMessage(
        db,
        "ses_synth",
        SessionMessage.Synthetic.make({
          id: nextID(),
          type: "synthetic",
          text: "<subagent>found the leak</subagent>",
          description: "Audit the platypus service",
          metadata: { source: "subagent" },
          time: { created },
        }),
      )
      yield* addMessage(
        db,
        "ses_notice",
        SessionMessage.Synthetic.make({
          id: nextID(),
          type: "synthetic",
          text: "echidna instructions",
          metadata: { notice: "instructions" },
          time: { created },
        }),
      )
      yield* index(db)
      const session = yield* Session.Service
      const search = (query: string) => session.list({ search: query }).pipe(Effect.map(ids))

      expect(yield* search("kubectl rollout")).toEqual(["ses_inline"])
      expect(yield* search("quokka")).toEqual(["ses_part"])
      expect(yield* search("wombat")).toEqual(["ses_attach"])
      expect(yield* search("terraform plan")).toEqual(["ses_shell"])
      expect(yield* search("platypus")).toEqual(["ses_synth"])
      expect(yield* search("found the leak")).toEqual(["ses_synth"])
      for (const excluded of ["inlineoutputonly", "partoutputonly", "aGVsbG8", "shelloutputonly", "echidna"])
        expect(yield* search(excluded)).toEqual([])
    }),
  )

  it.effect("scopes before limiting, so a hit outside the global best still lists", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      // 30 newer, more relevant sessions in another directory.
      yield* Effect.forEach(
        Array.from({ length: 30 }, (_, n) => n),
        (n) =>
          Effect.gen(function* () {
            yield* addSession(db, `ses_other_${String(n).padStart(2, "0")}`, { directory: other, updated: 100 + n })
            yield* addUser(db, `ses_other_${String(n).padStart(2, "0")}`, "kestrel kestrel kestrel")
          }),
      )
      yield* addSession(db, "ses_here", { updated: 1 })
      yield* addUser(db, "ses_here", "a long note that mentions a kestrel once among many other words")
      yield* index(db)
      const session = yield* Session.Service

      expect(ids(yield* session.list({ directory: project, search: "kestrel", limit: 1 }))).toEqual(["ses_here"])
      expect((yield* session.list({ search: "kestrel" })).data).toHaveLength(31)
    }),
  )

  it.effect("excludes archived and child sessions when asked", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_live", { updated: 3 })
      yield* addSession(db, "ses_archived", { updated: 2, archived: true })
      yield* addSession(db, "ses_child", { updated: 1, parent: "ses_live" })
      yield* Effect.forEach(["ses_live", "ses_archived", "ses_child"], (id) => addUser(db, id, "ocelot sighting"))
      yield* index(db)
      const session = yield* Session.Service

      expect(ids(yield* session.list({ search: "ocelot", archived: false, parentID: null }))).toEqual(["ses_live"])
      expect(ids(yield* session.list({ search: "ocelot", archived: true }))).toEqual(["ses_archived"])
      expect(ids(yield* session.list({ search: "ocelot", parentID: Session.ID.make("ses_live") }))).toEqual([
        "ses_child",
      ])
    }),
  )

  it.effect("lists a session with many hits once and pages to the next matching sessions", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_busy", { updated: 30 })
      yield* Effect.forEach(Array.from({ length: 40 }), () => addUser(db, "ses_busy", "heron heron heron"))
      yield* addSession(db, "ses_title", { title: "Heron notes", updated: 25 })
      yield* addSession(db, "ses_none", { updated: 22 })
      yield* addUser(db, "ses_none", "nothing relevant")
      yield* addSession(db, "ses_quiet", { updated: 20 })
      yield* addUser(db, "ses_quiet", "one heron")
      yield* addSession(db, "ses_last", { updated: 10 })
      yield* addPartOnlyAssistant(db, "ses_last", "a heron in the reeds")
      yield* index(db)
      const session = yield* Session.Service

      const first = yield* session.list({ search: "heron", limit: 2 })
      const second = yield* session.list({ cursor: first.cursor.next, limit: 2 })
      const back = yield* session.list({ cursor: second.cursor.previous, limit: 2 })
      const end = yield* session.list({ cursor: second.cursor.next, limit: 2 })

      expect(ids(first)).toEqual(["ses_busy", "ses_title"])
      expect(ids(second)).toEqual(["ses_quiet", "ses_last"])
      expect(ids(back)).toEqual(["ses_busy", "ses_title"])
      expect(ids(end)).toEqual([])
    }),
  )

  it.effect("requires every word and quoted phrase, with the last word as a typed prefix", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_both", { updated: 3 })
      yield* addUser(db, "ses_both", "fix the login bug before release")
      yield* addSession(db, "ses_fix", { updated: 2 })
      yield* addUser(db, "ses_fix", "fix the build")
      yield* addSession(db, "ses_split", { updated: 1 })
      yield* addUser(db, "ses_split", "fix one thing")
      yield* addUser(db, "ses_split", "the login page")
      yield* index(db)
      const session = yield* Session.Service
      const search = (query: string) => session.list({ search: query }).pipe(Effect.map(ids))

      expect(yield* search("fix login")).toEqual(["ses_both"])
      expect(yield* search("fix logi")).toEqual(["ses_both"])
      expect(yield* search("fix logi ")).toEqual([])
      expect(yield* search('"login bug"')).toEqual(["ses_both"])
      expect(yield* search('"bug login"')).toEqual([])
      expect(yield* search('fix "the log')).toEqual(["ses_both"])
      expect(yield* search("fix")).toEqual(["ses_both", "ses_fix", "ses_split"])
    }),
  )

  it.effect("treats malformed or wordless queries as text without failing", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_title", { title: "-- notes", updated: 2 })
      yield* addSession(db, "ses_body", { updated: 1 })
      yield* addUser(db, "ses_body", "rows NEAR the GLM-5.3 OR AND marker")
      yield* index(db)
      const session = yield* Session.Service
      const search = (query: string) => session.list({ search: query }).pipe(Effect.map(ids))

      expect(yield* search("--")).toEqual(["ses_title"])
      expect(yield* search('"')).toEqual([])
      expect(yield* search('NEAR( "rows')).toEqual(["ses_body"])
      expect(yield* search("GLM-5.3 OR")).toEqual(["ses_body"])
      expect(yield* search("AND*")).toEqual(["ses_body"])
    }),
  )

  it.effect("matches titles only while the index is off or unsupported", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(false)
      yield* addSession(db, "ses_title", { title: "Puffin plans", updated: 2 })
      yield* addSession(db, "ses_body", { updated: 1 })
      yield* addUser(db, "ses_body", "puffin colony")
      yield* index(db)
      const session = yield* Session.Service

      const off = yield* session.list({ search: "puffin" })
      expect(ids(off)).toEqual(["ses_title"])
      expect(off.experimental).toBeUndefined()

      yield* enable(true)
      expect(ids(yield* session.list({ search: "puffin" }))).toEqual(["ses_title", "ses_body"])

      // An index from a newer version cannot be read here.
      yield* db
        .update(KVTable)
        .set({ value: { version: SessionSearchIndex.Version + 1, layout: "compact", backfill: "done" } })
        .where(eq(KVTable.key, "session.search"))
        .run()
      const newer = yield* session.list({ search: "puffin" })
      expect(ids(newer)).toEqual(["ses_title"])
      expect(newer.experimental).toBeUndefined()
    }),
  )

  it.effect("reports indexing through setup, backfill with an empty queue, and queued changes", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* enable(true)
      yield* addSession(db, "ses_title", { title: "Gannet log", updated: 3 })
      yield* addSession(db, "ses_old", { updated: 1 })
      yield* addUser(db, "ses_old", "an old gannet sighting")
      const session = yield* Session.Service
      const search = session.list({ search: "gannet" })

      // Before the index exists: titles still match.
      const cold = yield* search
      expect(ids(cold)).toEqual(["ses_title"])
      expect(cold.experimental).toEqual({ indexing: true })

      // Built, nothing queued, history not yet backfilled.
      yield* SessionSearchIndex.ensure(db)
      expect((yield* SessionSearchIndex.status(db)).pending).toBe(0)
      expect((yield* search).experimental).toEqual({ indexing: true })

      // The unchanged query fills in once the backfill completes.
      while (!(yield* SessionSearchIndex.backfillBatch(db)).done) {}
      const warm = yield* search
      expect(ids(warm)).toEqual(["ses_title", "ses_old"])
      expect(warm.experimental).toBeUndefined()
      expect(Object.keys(warm)).toEqual(["data", "cursor"])

      // A new message is queued, then processed.
      yield* addSession(db, "ses_new", { updated: 2 })
      yield* addUser(db, "ses_new", "gannet again")
      const queued = yield* search
      expect(ids(queued)).toEqual(["ses_title", "ses_old"])
      expect(queued.experimental).toEqual({ indexing: true })
      while ((yield* SessionSearchIndex.processBatch(db)) > 0) {}
      const done = yield* search
      expect(ids(done)).toEqual(["ses_title", "ses_new", "ses_old"])
      expect(done.experimental).toBeUndefined()

      // Without a search there is nothing to report.
      expect((yield* session.list()).experimental).toBeUndefined()
    }),
  )
})
