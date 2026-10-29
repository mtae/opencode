export * as SessionSearchIndex from "./search-index.js"

import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm"
import { alias, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Deferred, Duration, Effect, Exit, Option, Schema, Scope } from "effect"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Fragment, Match, Source } from "@opencode/schema/session-search"
import type { Database } from "../../database/database.js"
import { SessionMessageTable, SessionTable } from "../../session/sql.js"
import { SessionStore } from "../../session/store.js"

/** Bump to rebuild every Session's documents after changing what gets extracted. */
const Version = 1
/** Bump to drop and recreate the index tables after changing their layout. */
const Layout = 3
const PageSize = 100
const SliceMessages = 100
const SliceBytes = 500_000
const MaxText = 32_768
const MaxShellOutput = 4_096
const MaxToolCall = 1_024
const MaxTerms = 8
const MinPrefix = 3
const SnippetWidth = 160
const MaxSnippetHits = 200
// A term in thousands of documents ("the", "a", "con*") ranks only its newest matches, so its cost
// stays flat as history grows. A rarer term ranks every match.
const Candidates = 2_000
const MaxScanned = 10_000
// Document ids are the creation second of their message times this, plus a counter, so the id
// order the full-text index walks fastest is also newest first.
const Bucket = 2 ** 20
const Budget = Duration.seconds(1)
// The longest a search may wait for indexing when its caller asks to wait longer than Budget.
const MaxWait = Duration.seconds(15)
const Weights: Record<Source, number> = { title: 3, user: 2, assistant: 1, synthetic: 1, shell: 1, tool: 0.5 }

type Db = Database.Interface["db"]

// The index is a cache built on the first search, not part of the migrated schema: these tables
// live outside sql.ts so drizzle-kit leaves them alone, and nothing touches them until a search runs.
// They are kept in their own file beside the main database, so index writes never grow the main
// database or its write-ahead log, and the file can be deleted to rebuild.
// Each document is one searchable text of a Session: its title, or one source of one message.
// Future sources (attachment OCR or model descriptions, keyed by `blob` hash in `ref`) add rows here.
// The text is kept apart, so a search that reads thousands of matches' Sessions reads small rows.
const DocTable = sqliteTable("session_search_doc", {
  id: integer().primaryKey(),
  session_id: text().$type<Session.ID>().notNull(),
  message_id: text().$type<SessionMessage.ID>(),
  seq: integer(),
  source: text().$type<Source>().notNull(),
  ref: text(),
})

const TextTable = sqliteTable("session_search_text", {
  id: integer().primaryKey(),
  text: text().notNull(),
})

// What the documents of each Session reflect: its event sequence, title, and the wall-clock time
// its messages were read. A search re-reads only messages updated since then.
const StateTable = sqliteTable("session_search_state", {
  session_id: text().$type<Session.ID>().primaryKey(),
  seq: integer().notNull(),
  title: text(),
  time_indexed: integer().notNull(),
  version: integer().notNull(),
})

const setup = (schema: string) => [
  // The 3-character prefix index serves the first prefix a search matches while typing ("con*").
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${schema}.session_search_fts USING fts5(text, content='session_search_text', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='3')`,
  `CREATE TABLE IF NOT EXISTS ${schema}.session_search_doc (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, seq INTEGER, source TEXT NOT NULL, ref TEXT)`,
  `CREATE INDEX IF NOT EXISTS ${schema}.session_search_doc_message_idx ON session_search_doc (session_id, message_id)`,
  `CREATE TABLE IF NOT EXISTS ${schema}.session_search_text (id INTEGER PRIMARY KEY, text TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${schema}.session_search_state (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT, time_indexed INTEGER NOT NULL, version INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS ${schema}.session_search_text_insert AFTER INSERT ON session_search_text BEGIN INSERT INTO session_search_fts (rowid, text) VALUES (new.id, new.text); END`,
  `CREATE TRIGGER IF NOT EXISTS ${schema}.session_search_text_delete AFTER DELETE ON session_search_text BEGIN INSERT INTO session_search_fts (session_search_fts, rowid, text) VALUES ('delete', old.id, old.text); END`,
  `CREATE TRIGGER IF NOT EXISTS ${schema}.session_search_doc_delete AFTER DELETE ON session_search_doc BEGIN DELETE FROM session_search_text WHERE id = old.id; END`,
  `PRAGMA ${schema}.user_version = ${Layout}`,
]

const teardown = (schema: string) =>
  ["session_search_fts", "session_search_doc", "session_search_text", "session_search_state"].map(
    (table) => `DROP TABLE IF EXISTS ${schema}.${table}`,
  )

// Only the fields that get indexed are decoded; everything else in a message, such as inline
// attachment data, is skipped.
const Indexed = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    text: Schema.String,
    files: Schema.Array(
      Schema.Struct({
        name: Schema.String.pipe(Schema.optional),
        description: Schema.String.pipe(Schema.optional),
        source: Schema.Union([
          Schema.Struct({ type: Schema.Literal("uri"), uri: Schema.String }),
          Schema.Struct({ type: Schema.Literal("inline") }),
        ]).pipe(Schema.optional),
      }),
    ).pipe(Schema.optional),
  }),
  Schema.Struct({ type: Schema.Literal("synthetic"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("shell"),
    command: Schema.String,
    output: Schema.Struct({ output: Schema.String }).pipe(Schema.optional),
  }),
  Schema.Struct({ type: Schema.Literal("assistant"), content: Schema.Array(Schema.Unknown) }),
])
const decodeIndexed = Schema.decodeUnknownOption(Indexed)
const decodeText = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("tool"), name: Schema.String, state: Schema.Struct({ input: Schema.Unknown }) }),
)

type Doc = { source: Source; text: string }

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max) : text
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings)
  return []
}

export function extract(row: { type: string; data: object }): Doc[] {
  const message = decodeIndexed({ ...row.data, type: row.type })
  if (Option.isNone(message)) return []
  return docs(message.value)
    .filter((doc) => doc.text.trim() !== "")
    .map((doc) => ({ ...doc, text: clip(doc.text, MaxText) }))
}

function docs(message: typeof Indexed.Type): Doc[] {
  switch (message.type) {
    case "user": {
      const files = (message.files ?? []).flatMap((file) => [
        file.name ?? (file.source?.type === "uri" ? file.source.uri : ""),
        file.description ?? "",
      ])
      return [{ source: "user", text: [message.text, ...files].filter((part) => part !== "").join("\n") }]
    }
    case "synthetic":
      return [{ source: "synthetic", text: message.text }]
    case "shell":
      return [
        { source: "shell", text: [message.command, clip(message.output?.output ?? "", MaxShellOutput)].join("\n") },
      ]
    case "assistant":
      return [
        {
          source: "assistant",
          text: message.content
            .flatMap((part) => Option.toArray(decodeText(part)))
            .map((part) => part.text)
            .join("\n\n"),
        },
        {
          source: "tool",
          text: message.content
            .flatMap((part) => Option.toArray(decodeTool(part)))
            .map((part) => clip([part.name, ...strings(part.state.input)].join(" "), MaxToolCall))
            .join("\n"),
        },
      ]
  }
}

const Token = /[\p{L}\p{N}]+/gu

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

export type Query = {
  /** The FTS5 expression: one quoted phrase per whitespace-separated word, all required. */
  readonly match: string
  readonly terms: ReadonlyArray<string>
  /** Whether the last term also matches as a prefix, for search-as-you-type. */
  readonly prefix: boolean
}

export function parse(input: string): Query | undefined {
  const phrases = input
    .split(/\s+/u)
    .map((word) => Array.from(fold(word).matchAll(Token), (match) => match[0]))
    .filter((tokens) => tokens.length > 0)
    .slice(0, MaxTerms)
  const last = phrases.at(-1)?.at(-1)
  if (last === undefined) return undefined
  const prefix = /[\p{L}\p{N}]$/u.test(input) && last.length >= MinPrefix
  return {
    match: phrases
      .map((tokens, index) => `"${tokens.join(" ")}"${prefix && index === phrases.length - 1 ? "*" : ""}`)
      .join(" "),
    terms: phrases.flat(),
    prefix,
  }
}

/** Picks the window of `text` with the most distinct query terms and marks every term in it. */
export function snippet(text: string, query: Query, width = SnippetWidth): Fragment[] {
  const last = query.terms.length - 1
  const found = Array.from(text.matchAll(Token)).flatMap((match) => {
    const token = fold(match[0])
    const term = query.terms.findIndex(
      (candidate, index) => token === candidate || (query.prefix && index === last && token.startsWith(candidate)),
    )
    return term === -1 ? [] : [{ start: match.index, end: match.index + match[0].length, term }]
  })
  const best = found
    .slice(0, MaxSnippetHits)
    .map((hit, index) => {
      const after = found.slice(index)
      const count = after.findIndex((other) => other.end - hit.start > width)
      const inside = count === -1 ? after : after.slice(0, count)
      return { hit, last: inside[inside.length - 1], distinct: new Set(inside.map((other) => other.term)).size }
    })
    .reduce<{ hit: Hit; last: Hit; distinct: number } | undefined>(
      (best, window) => (best && best.distinct >= window.distinct ? best : window),
      undefined,
    )
  // Center the matched span in the window, leaning toward showing what follows it.
  const lead = best ? Math.max(0, Math.floor((width - (best.last.end - best.hit.start)) / 3)) : 0
  const start = boundary(text, best ? Math.max(0, best.hit.start - lead) : 0, -1)
  const end = boundary(text, Math.min(text.length, start + width), 1)
  const marked = found
    .filter((hit) => hit.start >= start && hit.end <= end)
    .reduce(
      (state, hit) => ({
        cursor: hit.end,
        fragments: [
          ...state.fragments,
          { text: text.slice(state.cursor, hit.start), highlight: false },
          { text: text.slice(hit.start, hit.end), highlight: true },
        ],
      }),
      { cursor: start, fragments: new Array<Fragment>() },
    )
  return [
    { text: start > 0 ? "…" : "", highlight: false },
    ...marked.fragments,
    { text: text.slice(marked.cursor, end) + (end < text.length ? "…" : ""), highlight: false },
  ]
    .map((fragment) => ({ ...fragment, text: fragment.text.replace(/\s+/gu, " ") }))
    .filter((fragment) => fragment.text !== "")
    .reduce<Fragment[]>((merged, fragment) => {
      const previous = merged[merged.length - 1]
      if (previous && !previous.highlight && !fragment.highlight)
        return [...merged.slice(0, -1), { text: previous.text + fragment.text, highlight: false }]
      return [...merged, fragment]
    }, [])
}

type Hit = { start: number; end: number; term: number }

// Moves an offset onto whitespace so a snippet does not start or end mid-word.
function boundary(text: string, offset: number, direction: -1 | 1) {
  if (offset <= 0 || offset >= text.length) return offset
  const limit = 24
  const range = direction === -1 ? text.slice(Math.max(0, offset - limit), offset) : text.slice(offset, offset + limit)
  const index = direction === -1 ? range.search(/\s\S*$/u) : range.search(/\s/u)
  if (index === -1) return offset
  return direction === -1 ? offset - range.length + index + 1 : offset + index
}

export type Input = SessionStore.Filter & {
  readonly query: string
  readonly limit?: number
  /**
   * Milliseconds to wait for indexing before answering with what is indexed so far; 1,000 by default, 15,000 at most.
   * Indexing carries on after the search answers or is cancelled.
   */
  readonly wait?: number
}

/** Ranked Sessions as plain rows, so they can cross from a worker thread. */
export type Found = {
  readonly data: ReadonlyArray<{
    readonly session: typeof SessionTable.$inferSelect
    readonly hits: number
    readonly match?: Match
  }>
  readonly pending: number
}

type State = typeof StateTable.$inferSelect

type Stale = { id: Session.ID; title: string | null; seq: number; updated: number; indexed: number | null }

type Write =
  | { type: "begin"; sessionID: Session.ID }
  | {
      type: "messages"
      sessionID: Session.ID
      ids: SessionMessage.ID[]
      docs: { time: number; row: Omit<typeof DocTable.$inferInsert, "id">; text: string }[]
    }
  | { type: "finish"; session: Stale; indexed: number }

type Candidate = { id: number; score: number; session_id: Session.ID; seq: number | null; source: Source }

/**
 * Searches Sessions read from `app` through an index kept in `index`, under `schema` there.
 * The two may be one connection; nothing here joins across them, so they may also be two.
 * The first search builds the index, and each later one first catches up on Sessions changed
 * since; a search waits for that briefly and otherwise lets it finish in the background,
 * reporting what is still pending.
 */
export const make = Effect.fn("SessionSearchIndex.make")(function* (options: {
  readonly app: Db
  readonly index: Db
  readonly schema: string
}) {
  const app = options.app
  const index = options.index
  const scope = yield* Scope.Scope

  const layout = yield* index.all<{ user_version: number }>(sql.raw(`PRAGMA ${options.schema}.user_version`))
  yield* index.transaction(() =>
    Effect.forEach(
      [...(layout[0]?.user_version === Layout ? [] : teardown(options.schema)), ...setup(options.schema)],
      (statement) => index.run(sql.raw(statement)),
      { discard: true },
    ),
  )

  // The states are read from the index once and then kept in step with each committed write.
  // Another process writing the same index file only leaves this copy behind, which re-reads a
  // few Sessions.
  const known: { states?: Map<Session.ID, State> } = {}
  const states = Effect.suspend(() =>
    known.states
      ? Effect.succeed(known.states)
      : index
          .select()
          .from(StateTable)
          .all()
          .pipe(
            Effect.map((rows) => {
              known.states = new Map(rows.map((state) => [state.session_id, state] as const))
              return known.states
            }),
          ),
  )
  const remember = (write: Write) => {
    if (write.type === "begin")
      return known.states?.set(write.sessionID, {
        session_id: write.sessionID,
        title: null,
        time_indexed: 0,
        version: Version,
        ...known.states.get(write.sessionID),
        seq: -2,
      })
    if (write.type === "finish")
      return known.states?.set(write.session.id, {
        session_id: write.session.id,
        seq: write.session.seq,
        title: write.session.title,
        time_indexed: write.indexed,
        version: Version,
      })
  }

  // A state ahead of the main database, such as one restored from a backup, re-reads every message.
  const stale = Effect.gen(function* () {
    const sessions = yield* app.all<{ id: Session.ID; title: string | null; seq: number; updated: number }>(sql`
      SELECT s.id AS id, s.title AS title, coalesce(es.seq, -1) AS seq, s.time_updated AS updated
      FROM session_v2 s
      LEFT JOIN event_sequence es ON es.aggregate_id = s.id
    `)
    const indexed = yield* states
    const live = new Set(sessions.map((session) => session.id))
    return {
      sessions: sessions
        .flatMap((session): Stale[] => {
          const state = indexed.get(session.id)
          if (state && state.seq === session.seq && state.title === session.title && state.version === Version)
            return []
          return [
            {
              ...session,
              indexed: state && state.version === Version && state.seq <= session.seq ? state.time_indexed : null,
            },
          ]
        })
        .toSorted((a, b) => b.updated - a.updated),
      deleted: [...indexed.keys()].filter((id) => !live.has(id)),
    }
  }).pipe(Effect.orDie)

  // Ids within one second count up from the second's first id, past any already taken.
  const allocate = (slots: Map<number, number>, time: number) =>
    Effect.gen(function* () {
      const first = Math.floor(time / 1000) * Bucket
      const taken = slots.get(first)
      const next =
        taken ??
        (yield* index
          .all<{
            next: number | null
          }>(sql`SELECT max(id) + 1 AS next FROM session_search_doc WHERE id >= ${first} AND id < ${first + Bucket}`)
          .pipe(Effect.map((rows) => rows[0]?.next ?? first)))
      slots.set(first, next + 1)
      return next
    })

  const apply = (writes: ReadonlyArray<Write>) =>
    Effect.gen(function* () {
      const slots = new Map<number, number>()
      yield* Effect.forEach(
        writes,
        (write) => {
          switch (write.type) {
            case "begin":
              // Marks the Session stale until it finishes, so an interrupted pass resumes on the next search.
              return index
                .insert(StateTable)
                .values({ session_id: write.sessionID, seq: -2, title: null, time_indexed: 0, version: Version })
                .onConflictDoUpdate({ target: StateTable.session_id, set: { seq: -2 } })
                .run()
            case "messages":
              return Effect.gen(function* () {
                yield* index
                  .delete(DocTable)
                  .where(and(eq(DocTable.session_id, write.sessionID), inArray(DocTable.message_id, write.ids)))
                  .run()
                if (write.docs.length === 0) return
                const ids = yield* Effect.forEach(write.docs, (doc) => allocate(slots, doc.time))
                yield* index
                  .insert(DocTable)
                  .values(write.docs.map((doc, position) => ({ ...doc.row, id: ids[position] })))
                  .run()
                yield* index
                  .insert(TextTable)
                  .values(write.docs.map((doc, position) => ({ id: ids[position], text: doc.text })))
                  .run()
              })
            case "finish":
              return Effect.gen(function* () {
                const sessionID = write.session.id
                // Messages removed by a committed revert.
                const kept = new Set(
                  (yield* app
                    .select({ id: SessionMessageTable.id })
                    .from(SessionMessageTable)
                    .where(eq(SessionMessageTable.session_id, sessionID))
                    .all()).map((row) => row.id),
                )
                const removed = (yield* index
                  .selectDistinct({ id: DocTable.message_id })
                  .from(DocTable)
                  .where(eq(DocTable.session_id, sessionID))
                  .all()).flatMap((row) => (row.id === null || kept.has(row.id) ? [] : [row.id]))
                if (removed.length > 0)
                  yield* index
                    .delete(DocTable)
                    .where(and(eq(DocTable.session_id, sessionID), inArray(DocTable.message_id, removed)))
                    .run()
                yield* index
                  .delete(DocTable)
                  .where(and(eq(DocTable.session_id, sessionID), eq(DocTable.source, "title")))
                  .run()
                if (write.session.title) {
                  const id = yield* allocate(slots, write.session.updated)
                  yield* index.insert(DocTable).values({ id, session_id: sessionID, source: "title" }).run()
                  yield* index
                    .insert(TextTable)
                    .values({ id, text: clip(write.session.title, MaxText) })
                    .run()
                }
                const state = {
                  seq: write.session.seq,
                  title: write.session.title,
                  time_indexed: write.indexed,
                  version: Version,
                }
                yield* index
                  .insert(StateTable)
                  .values({ session_id: sessionID, ...state })
                  .onConflictDoUpdate({ target: StateTable.session_id, set: state })
                  .run()
              })
          }
        },
        { discard: true },
      )
    })

  const flush = (writes: Write[]) => {
    if (writes.length === 0) return Effect.void
    const batch = writes.splice(0)
    return index
      .transaction(() => apply(batch), { behavior: "immediate" })
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) return batch.forEach(remember)
            known.states = undefined
          }),
        ),
        Effect.orDie,
        Effect.andThen(Effect.yieldNow),
      )
  }

  // Writes go out in slices of a few hundred messages, each its own short transaction, so a large
  // first build never holds the write lock for long.
  // Whether the main database changed since the last pass that left nothing stale began: another
  // connection's commit moves `data_version`, and this connection's own writes `total_changes()`.
  // A search while nothing changed then skips reading every Session to compare with the index.
  const changes = app
    .all<{
      version: number
      changes: number
    }>(sql`SELECT (SELECT data_version FROM pragma_data_version()) AS version, total_changes() AS changes`)
    .pipe(
      Effect.map((rows) => `${rows[0]?.version}:${rows[0]?.changes}`),
      Effect.orDie,
    )
  const checked: { at?: string } = {}

  const catchUp = Effect.gen(function* () {
    const at = yield* changes
    if (checked.at === at) return 0
    const found = yield* stale
    if (found.deleted.length > 0)
      yield* index
        .transaction(
          () =>
            Effect.all([
              index.delete(DocTable).where(inArray(DocTable.session_id, found.deleted)).run(),
              index.delete(StateTable).where(inArray(StateTable.session_id, found.deleted)).run(),
            ]),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.onExit(() => Effect.sync(() => (known.states = undefined))),
          Effect.orDie,
        )
    const writes: Write[] = []
    const slice = { messages: 0, bytes: 0 }
    yield* Effect.forEach(
      found.sessions,
      (session) =>
        Effect.gen(function* () {
          // Captured before reading: a message written after this is re-read on the next pass.
          const indexed = Date.now()
          writes.push({ type: "begin", sessionID: session.id })
          const page = (after: number): Effect.Effect<void> =>
            Effect.gen(function* () {
              const rows = yield* app
                .select({
                  id: SessionMessageTable.id,
                  seq: SessionMessageTable.seq,
                  type: SessionMessageTable.type,
                  data: SessionMessageTable.data,
                  time: SessionMessageTable.time_created,
                })
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, session.id),
                    gt(SessionMessageTable.seq, after),
                    session.indexed === null ? undefined : gte(SessionMessageTable.time_updated, session.indexed),
                  ),
                )
                .orderBy(asc(SessionMessageTable.seq))
                .limit(PageSize)
                .all()
                .pipe(Effect.orDie)
              if (rows.length === 0) return
              const docs = rows.flatMap((row) =>
                extract(row).map((doc) => ({
                  time: row.time,
                  row: { session_id: session.id, message_id: row.id, seq: row.seq, source: doc.source },
                  text: doc.text,
                })),
              )
              writes.push({ type: "messages", sessionID: session.id, ids: rows.map((row) => row.id), docs })
              slice.messages += rows.length
              slice.bytes += docs.reduce((total, doc) => total + doc.text.length, 0)
              if (slice.messages >= SliceMessages || slice.bytes >= SliceBytes) {
                slice.messages = 0
                slice.bytes = 0
                yield* flush(writes)
              }
              if (rows.length === PageSize) yield* page(rows[rows.length - 1].seq)
            })
          yield* page(-1)
          writes.push({ type: "finish", session, indexed })
        }),
      { discard: true },
    )
    yield* flush(writes)
    checked.at = at
    return 0
  })

  // One catch-up at a time; searches that arrive meanwhile wait on the running one.
  const flight: { current?: Deferred.Deferred<number> } = {}
  const start = Effect.suspend(() => {
    if (flight.current) return Effect.succeed(flight.current)
    const done = Deferred.makeUnsafe<number>()
    flight.current = done
    return catchUp.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (flight.current === done) flight.current = undefined
          Deferred.doneUnsafe(done, exit)
        }),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.as(done),
    )
  })

  // The newest matches first, in pages, keeping those in Sessions the filters allow and before
  // any revert boundary, until enough are kept or enough were read. With filters the Sessions they
  // allow are known up front, so matches in other Sessions never spend the read budget.
  const candidates = Effect.fn("SessionSearchIndex.candidates")(function* (query: Query, input: Input) {
    const sessions = new Map<Session.ID, { updated: number; boundary: number | null } | undefined>()
    const conditions = SessionStore.filters(input)
    const boundary = alias(SessionMessageTable, "boundary")
    const eligible =
      conditions.length === 0
        ? undefined
        : JSON.stringify(
            (yield* app
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(and(...conditions))
              .all()
              .pipe(Effect.orDie)).map((row) => row.id),
          )
    if (eligible === "[]") return { found: [] as Candidate[], sessions }
    const next = (
      before: number | undefined,
      kept: Candidate[],
      scanned: number,
      size: number,
    ): Effect.Effect<Candidate[]> =>
      Effect.gen(function* () {
        const hits = yield* index
          .all<Candidate>(
            sql`
            SELECT f.rowid AS id, bm25(session_search_fts) AS score, d.session_id AS session_id, d.seq AS seq,
              d.source AS source
            FROM session_search_fts f
            JOIN session_search_doc d ON d.id = f.rowid
            WHERE session_search_fts MATCH ${query.match} ${before === undefined ? sql`` : sql`AND f.rowid < ${before}`}
              ${eligible === undefined ? sql`` : sql`AND d.session_id IN (SELECT value FROM json_each(${eligible}))`}
            ORDER BY f.rowid DESC
            LIMIT ${size}
          `,
          )
          .pipe(Effect.orDie)
        const unknown = [...new Set(hits.map((hit) => hit.session_id))].filter((id) => !sessions.has(id))
        if (unknown.length > 0) {
          const rows = yield* app
            .select({
              id: SessionTable.id,
              updated: SessionTable.time_updated,
              boundary: boundary.seq,
            })
            .from(SessionTable)
            .leftJoin(boundary, sql`${boundary.id} = json_extract(${SessionTable.revert}, '$.messageID')`)
            .where(and(inArray(SessionTable.id, unknown), ...conditions))
            .all()
            .pipe(Effect.orDie)
          unknown.forEach((id) => sessions.set(id, undefined))
          rows.forEach((row) => sessions.set(row.id, { updated: row.updated, boundary: row.boundary }))
        }
        const found = [
          ...kept,
          ...hits.filter((hit) => {
            const session = sessions.get(hit.session_id)
            return session && (session.boundary === null || hit.seq === null || hit.seq < session.boundary)
          }),
        ]
        const last = hits.at(-1)
        const total = scanned + hits.length
        if (!last || hits.length < size || found.length >= Candidates || total >= MaxScanned) return found
        // Each page repeats the term lookup, so the next reads twice what the share kept so far
        // says the rest needs.
        const share = Math.max(found.length, 1) / total
        return yield* next(
          last.id,
          found,
          total,
          Math.min(MaxScanned - total, Math.max(Candidates, Math.ceil(((Candidates - found.length) / share) * 2))),
        )
      })
    return { found: yield* next(undefined, [], 0, Candidates), sessions }
  })

  const search = Effect.fn("SessionSearchIndex.search")(function* (input: Input) {
    const limit = input.limit ?? 50
    const done = yield* start
    const waited = yield* Deferred.await(done).pipe(
      Effect.timeoutOption(
        input.wait === undefined ? Budget : Duration.min(Duration.millis(Math.max(0, input.wait)), MaxWait),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Session search indexing failed", cause).pipe(Effect.as(Option.none<number>())),
      ),
    )
    const remaining = Option.isSome(waited) ? waited.value : (yield* stale).sessions.length
    const query = parse(input.query)
    if (!query) return { data: [], pending: remaining }
    const result = yield* candidates(query, input)
    // Each Session ranks by its best weighted match.
    const best = result.found.reduce((best, hit) => {
      const score = hit.score * Weights[hit.source]
      const current = best.get(hit.session_id)
      return best.set(
        hit.session_id,
        !current || score < current.score
          ? { doc: hit.id, score, hits: (current?.hits ?? 0) + 1 }
          : { ...current, hits: current.hits + 1 },
      )
    }, new Map<Session.ID, { doc: number; score: number; hits: number }>())
    const ranked = [...best]
      .toSorted(
        (a, b) =>
          a[1].score - b[1].score ||
          (result.sessions.get(b[0])?.updated ?? 0) - (result.sessions.get(a[0])?.updated ?? 0),
      )
      .slice(0, limit)
    if (ranked.length === 0) return { data: [], pending: remaining }
    const sessions = new Map(
      (yield* app
        .select()
        .from(SessionTable)
        .where(
          inArray(
            SessionTable.id,
            ranked.map((entry) => entry[0]),
          ),
        )
        .all()
        .pipe(Effect.orDie)).map((row) => [row.id, row]),
    )
    const docs = new Map(
      (yield* index
        .select({ id: DocTable.id, message_id: DocTable.message_id, source: DocTable.source, text: TextTable.text })
        .from(DocTable)
        .innerJoin(TextTable, eq(TextTable.id, DocTable.id))
        .where(
          inArray(
            DocTable.id,
            ranked.map((entry) => entry[1].doc),
          ),
        )
        .all()
        .pipe(Effect.orDie)).map((row) => [row.id, row]),
    )
    return {
      data: ranked.flatMap(([sessionID, entry]) => {
        const session = sessions.get(sessionID)
        if (!session) return []
        const doc = docs.get(entry.doc)
        return [
          {
            session,
            hits: entry.hits,
            match: doc
              ? { messageID: doc.message_id ?? undefined, source: doc.source, snippet: snippet(doc.text, query) }
              : undefined,
          },
        ]
      }),
      pending: remaining,
    }
  })

  // Starts the catch-up without a search, so an index whose first search was cancelled still gets built.
  return Object.assign(search, { warm: start.pipe(Effect.asVoid) })
})
