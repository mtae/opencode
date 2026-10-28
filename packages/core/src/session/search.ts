export * as SessionSearch from "./search.js"

import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Context, Deferred, Duration, Effect, Layer, Option, Schema, Scope } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Fragment, Result, Source } from "@opencode/schema/session-search"
import { Database } from "../database/database.js"
import { fromRow } from "./info.js"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { SessionStore } from "./store.js"

/** Bump to rebuild every Session's documents after changing what gets extracted. */
const Version = 1
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
const Budget = Duration.seconds(1)
const Weights: Record<Source, number> = { title: 3, user: 2, assistant: 1, synthetic: 1, shell: 1, tool: 0.5 }

// The index is a cache built on the first search, not part of the migrated schema: these tables
// live outside sql.ts so drizzle-kit leaves them alone, and nothing touches them until a search runs.
// They are kept in their own file, attached to the connection as `session_search` beside the main
// database, so index writes never grow the main database or its write-ahead log, and the file can be
// deleted to rebuild. Unqualified names still resolve because no main table shares them.
// Each document is one searchable text of a Session: its title, or one source of one message.
// Future sources (attachment OCR or model descriptions, keyed by `blob` hash in `ref`) add rows here.
const DocTable = sqliteTable("session_search_doc", {
  id: integer().primaryKey(),
  session_id: text().$type<Session.ID>().notNull(),
  message_id: text().$type<SessionMessage.ID>(),
  seq: integer(),
  source: text().$type<Source>().notNull(),
  ref: text(),
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

const Setup = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS session_search.session_search_fts USING fts5(text, content='session_search_doc', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TABLE IF NOT EXISTS session_search.session_search_doc (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT, seq INTEGER, source TEXT NOT NULL, ref TEXT, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS session_search.session_search_doc_message_idx ON session_search_doc (session_id, message_id)`,
  `CREATE TABLE IF NOT EXISTS session_search.session_search_state (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT, time_indexed INTEGER NOT NULL, version INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS session_search.session_search_doc_insert AFTER INSERT ON session_search_doc BEGIN INSERT INTO session_search_fts (rowid, text) VALUES (new.id, new.text); END`,
  `CREATE TRIGGER IF NOT EXISTS session_search.session_search_doc_delete AFTER DELETE ON session_search_doc BEGIN INSERT INTO session_search_fts (session_search_fts, rowid, text) VALUES ('delete', old.id, old.text); END`,
]

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
}

export interface Response {
  readonly data: ReadonlyArray<Result>
  /** Sessions not yet indexed when the search ran. Their messages are missing from the results. */
  readonly pending: number
}

export interface Interface {
  /**
   * Ranks Sessions by their best matching title or message. The first search builds the index,
   * and each later one first catches up on Sessions changed since; a search waits for that
   * briefly and otherwise lets it finish in the background, reporting what is still pending.
   */
  readonly search: (input: Input) => Effect.Effect<Response>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearch") {}

type Stale = { id: Session.ID; title: string | null; seq: number; indexed: number | null }

type Write =
  | { type: "begin"; sessionID: Session.ID }
  | { type: "messages"; sessionID: Session.ID; ids: SessionMessage.ID[]; docs: (typeof DocTable.$inferInsert)[] }
  | { type: "finish"; session: Stale; indexed: number }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const scope = yield* Scope.Scope

    const ready = yield* Effect.cached(
      Effect.gen(function* () {
        const databases = yield* db.all<{ name: string; file: string }>(sql`PRAGMA database_list`)
        if (!databases.some((database) => database.name === "session_search")) {
          const main = databases.find((database) => database.name === "main")?.file
          yield* db.run(sql`ATTACH DATABASE ${main ? `${main}-search` : ":memory:"} AS session_search`)
        }
        yield* db.run(sql`PRAGMA session_search.journal_mode = WAL`)
        // The index can be rebuilt from the main database, so its checkpoints skip the sync to disk,
        // which otherwise stalls the thread for over a second on a large first build.
        yield* db.run(sql`PRAGMA session_search.synchronous = OFF`)
        yield* db.transaction(() => Effect.forEach(Setup, (statement) => db.run(sql.raw(statement)), { discard: true }))
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Session search index unavailable, searching titles only", error).pipe(Effect.as(false)),
        ),
      ),
    )

    // A state ahead of the main database, such as one restored from a backup, re-reads every message.
    const stale = db.all<Stale>(sql`
      SELECT s.id AS id, s.title AS title, coalesce(es.seq, -1) AS seq,
        CASE WHEN st.version = ${Version} AND st.seq <= coalesce(es.seq, -1) THEN st.time_indexed END AS indexed
      FROM session_v2 s
      LEFT JOIN event_sequence es ON es.aggregate_id = s.id
      LEFT JOIN session_search_state st ON st.session_id = s.id
      WHERE st.session_id IS NULL OR st.seq <> coalesce(es.seq, -1) OR st.title IS NOT s.title OR st.version <> ${Version}
      ORDER BY s.time_updated DESC
    `)
    const deleted = db.all<{ session_id: Session.ID }>(sql`
      SELECT session_id FROM session_search_state st
      WHERE NOT EXISTS (SELECT 1 FROM session_v2 s WHERE s.id = st.session_id)
    `)

    const apply = (writes: ReadonlyArray<Write>) =>
      Effect.forEach(
        writes,
        (write) => {
          switch (write.type) {
            case "begin":
              // Marks the Session stale until it finishes, so an interrupted pass resumes on the next search.
              return db
                .insert(StateTable)
                .values({ session_id: write.sessionID, seq: -2, title: null, time_indexed: 0, version: Version })
                .onConflictDoUpdate({ target: StateTable.session_id, set: { seq: -2 } })
                .run()
            case "messages":
              return Effect.gen(function* () {
                yield* db
                  .delete(DocTable)
                  .where(and(eq(DocTable.session_id, write.sessionID), inArray(DocTable.message_id, write.ids)))
                  .run()
                if (write.docs.length > 0) yield* db.insert(DocTable).values(write.docs).run()
              })
            case "finish":
              return Effect.gen(function* () {
                const sessionID = write.session.id
                // Messages removed by a committed revert.
                yield* db.run(sql`
                  DELETE FROM session_search_doc
                  WHERE session_id = ${sessionID} AND message_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM session_message m WHERE m.id = session_search_doc.message_id)
                `)
                yield* db
                  .delete(DocTable)
                  .where(and(eq(DocTable.session_id, sessionID), eq(DocTable.source, "title")))
                  .run()
                if (write.session.title)
                  yield* db
                    .insert(DocTable)
                    .values({ session_id: sessionID, source: "title", text: clip(write.session.title, MaxText) })
                    .run()
                const state = {
                  seq: write.session.seq,
                  title: write.session.title,
                  time_indexed: write.indexed,
                  version: Version,
                }
                yield* db
                  .insert(StateTable)
                  .values({ session_id: sessionID, ...state })
                  .onConflictDoUpdate({ target: StateTable.session_id, set: state })
                  .run()
              })
          }
        },
        { discard: true },
      )

    const flush = (writes: Write[]) =>
      writes.length === 0
        ? Effect.void
        : db
            .transaction(() => apply(writes.splice(0)), { behavior: "immediate" })
            .pipe(Effect.orDie, Effect.andThen(Effect.yieldNow))

    // Writes go out in slices of a few hundred messages, each its own short transaction, so a large
    // first build neither holds the write lock nor blocks the thread for long.
    const catchUp = Effect.gen(function* () {
      const removed = (yield* deleted.pipe(Effect.orDie)).map((row) => row.session_id)
      if (removed.length > 0)
        yield* db
          .transaction(
            () =>
              Effect.all([
                db.delete(DocTable).where(inArray(DocTable.session_id, removed)).run(),
                db.delete(StateTable).where(inArray(StateTable.session_id, removed)).run(),
              ]),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      const sessions = yield* stale.pipe(Effect.orDie)
      const writes: Write[] = []
      const slice = { messages: 0, bytes: 0 }
      yield* Effect.forEach(
        sessions,
        (session) =>
          Effect.gen(function* () {
            // Captured before reading: a message written after this is re-read on the next pass.
            const indexed = Date.now()
            writes.push({ type: "begin", sessionID: session.id })
            const page = (after: number): Effect.Effect<void> =>
              Effect.gen(function* () {
                const rows = yield* db
                  .select({
                    id: SessionMessageTable.id,
                    seq: SessionMessageTable.seq,
                    type: SessionMessageTable.type,
                    data: SessionMessageTable.data,
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
                    session_id: session.id,
                    message_id: row.id,
                    seq: row.seq,
                    source: doc.source,
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

    const pending = stale.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

    const titles = Effect.fn("SessionSearch.titles")(function* (input: Input, limit: number) {
      const pattern = `%${input.query.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      const query = parse(input.query)
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(...SessionStore.filters(input), sql`${SessionTable.title} LIKE ${pattern} ESCAPE '\\'`))
        .orderBy(desc(SessionTable.time_updated))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return {
        data: rows.map(
          (row): Result => ({
            session: fromRow(row),
            hits: 1,
            match: row.title && query ? { source: "title", snippet: snippet(row.title, query) } : undefined,
          }),
        ),
        pending: 0,
      }
    })

    const search = Effect.fn("SessionSearch.search")(function* (input: Input) {
      const limit = input.limit ?? 50
      if (!(yield* ready)) return yield* titles(input, limit)
      const done = yield* start
      const waited = yield* Deferred.await(done).pipe(
        Effect.timeoutOption(Budget),
        Effect.catchCause((cause) =>
          Effect.logWarning("Session search indexing failed", cause).pipe(Effect.as(Option.none<number>())),
        ),
      )
      const remaining = Option.isSome(waited) ? waited.value : yield* pending
      const query = parse(input.query)
      if (!query) return { data: [], pending: remaining }
      const conditions = SessionStore.filters(input)
      const ranked = yield* db
        .all<{ session_id: Session.ID; doc: number; score: number; hits: number }>(
          sql`
          WITH hit AS MATERIALIZED (
            SELECT rowid AS id, bm25(session_search_fts) AS score
            FROM session_search_fts WHERE session_search_fts MATCH ${query.match}
          )
          SELECT d.session_id AS session_id, d.id AS doc, count(*) AS hits,
            min(hit.score * CASE d.source ${sql.join(
              Object.entries(Weights).map(([source, weight]) => sql`WHEN ${source} THEN ${weight}`),
              sql` `,
            )} ELSE 1 END) AS score
          FROM hit
          JOIN session_search_doc d ON d.id = hit.id
          JOIN ${SessionTable} ON ${SessionTable.id} = d.session_id
          LEFT JOIN session_message boundary ON boundary.id = json_extract(${SessionTable.revert}, '$.messageID')
          WHERE (boundary.seq IS NULL OR d.seq IS NULL OR d.seq < boundary.seq)
            ${conditions.length > 0 ? sql`AND ${and(...conditions)}` : sql``}
          GROUP BY d.session_id
          ORDER BY score, ${SessionTable.time_updated} DESC
          LIMIT ${limit}
        `,
        )
        .pipe(Effect.orDie)
      if (ranked.length === 0) return { data: [], pending: remaining }
      const sessions = new Map(
        (yield* db
          .select()
          .from(SessionTable)
          .where(
            inArray(
              SessionTable.id,
              ranked.map((row) => row.session_id),
            ),
          )
          .all()
          .pipe(Effect.orDie)).map((row) => [row.id, fromRow(row)]),
      )
      const docs = new Map(
        (yield* db
          .select({ id: DocTable.id, message_id: DocTable.message_id, source: DocTable.source, text: DocTable.text })
          .from(DocTable)
          .where(
            inArray(
              DocTable.id,
              ranked.map((row) => row.doc),
            ),
          )
          .all()
          .pipe(Effect.orDie)).map((row) => [row.id, row]),
      )
      return {
        data: ranked.flatMap((row) => {
          const session = sessions.get(row.session_id)
          if (!session) return []
          const doc = docs.get(row.doc)
          return [
            {
              session,
              hits: row.hits,
              match: doc
                ? {
                    messageID: doc.message_id ?? undefined,
                    source: doc.source,
                    snippet: snippet(doc.text, query),
                  }
                : undefined,
            },
          ]
        }),
        pending: remaining,
      }
    })

    return Service.of({ search })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
