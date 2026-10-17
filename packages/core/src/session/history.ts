import { and, asc, desc, eq, gt, gte, lte, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { Instructions } from "../instructions/index.js"
import { InstructionState } from "./instruction-state.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const TIMING = process.env.OPENCODE_SESSION_HISTORY_TIMING === "1"
const CACHE_ENABLED = process.env.OPENCODE_SESSION_HISTORY_CACHE !== "0"

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)

/**
 * Which completed compactions bound a history read. Local summaries always do. Native
 * windows do for model-neutral readers (`latest`), never for the original transcript
 * (`local`), and only when the target model can replay them (a provenance).
 */
export type Boundary = "latest" | "local" | SessionProviderContext.Provenance

const replayable = (message: SessionMessage.Info, boundary: Boundary) =>
  !SessionProviderContext.isCheckpoint(message) ||
  boundary === "latest" ||
  (boundary !== "local" && SessionProviderContext.compatible(message.providerContext.provenance, boundary))

export const latestCompaction = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        boundary === "latest"
          ? undefined
          : or(
              sql`json_extract(${SessionMessageTable.data}, '$.providerContext') is null`,
              boundary === "local"
                ? undefined
                : and(
                    ...Object.entries(boundary).map(
                      ([key, value]) =>
                        sql`json_extract(${SessionMessageTable.data}, ${`$.providerContext.provenance.${key}`}) = ${value}`,
                    ),
                  ),
            ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.tap((message) =>
      SessionProviderContext.isCheckpoint(message)
        ? SessionProviderContext.validate(message.providerContext)
        : Effect.void,
    ),
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

interface CachedMessageEntries {
  readonly revisionKey: string
  readonly compactionSeq: number | null
  readonly maxSeq: number
  readonly count: number
  readonly maxUpdated: number
  readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>
}

let messageEntryCaches = new WeakMap<object, Map<string, CachedMessageEntries>>()

const messageEntryCacheFor = (db: DatabaseService) => {
  let inner = messageEntryCaches.get(db as object)
  if (!inner) {
    inner = new Map()
    messageEntryCaches.set(db as object, inner)
  }
  return inner
}

const applyVisibilityFilter = (entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>, boundary: Boundary) => {
  const native = entries.findLast((entry) => SessionProviderContext.isCheckpoint(entry.message))
  return entries.filter(
    (entry) =>
      !(entry.message.type === "system" && native && entry.seq < native.seq) && replayable(entry.message, boundary),
  )
}

const messageEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  const t0 = TIMING ? performance.now() : 0
  const compaction = yield* latestCompaction(db, sessionID, boundary)
  const compactionSeq = compaction?.seq ?? null

  const aggRow = yield* db
    .select({
      maxSeq: sql<number>`COALESCE(MAX(${SessionMessageTable.seq}), -1)`,
      count: sql<number>`COUNT(*)`,
      maxUpdated: sql<number>`COALESCE(MAX(${SessionMessageTable.time_updated}), 0)`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  const maxSeq = Number(aggRow?.maxSeq ?? -1)
  const count = Number(aggRow?.count ?? 0)
  const maxUpdated = Number(aggRow?.maxUpdated ?? 0)

  const durableSeq = yield* Bus.latestSequence(db, sessionID)
  const revisionKey = `${compactionSeq}|${maxSeq}|${count}|${maxUpdated}|${durableSeq}`

  const inner = messageEntryCacheFor(db)
  const cacheKey = `${sessionID}::${boundary}`
  const cached = CACHE_ENABLED ? inner.get(cacheKey) : undefined

  // Exact reuse: identical revision.
  if (cached && cached.revisionKey === revisionKey) {
    const t1 = TIMING ? performance.now() : 0
    if (TIMING) {
      console.error(
        "[session-history-timing]",
        JSON.stringify({
          phase: "history.messageEntries",
          sessionID,
          boundary,
          cache: "hit",
          totalMs: t1 - t0,
          rows: count,
          messages: cached.entries.length,
          compactionSeq,
        }),
      )
    }
    return cached.entries.slice() as Array<{ seq: number; message: SessionMessage.Info }>
  }

  const tComp = TIMING ? performance.now() : 0

  // Suffix (append-only) fast path.
  let usedSuffix = false
  let decodedSuffix: Array<{ seq: number; message: SessionMessage.Info }> | null = null
  if (
    cached &&
    cached.compactionSeq === compactionSeq &&
    cached.maxSeq >= 0 &&
    maxSeq > cached.maxSeq &&
    count > cached.count
  ) {
    const oldAgg = yield* db
      .select({
        maxUpdated: sql<number>`COALESCE(MAX(${SessionMessageTable.time_updated}), 0)`,
      })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
          lte(SessionMessageTable.seq, cached.maxSeq),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    const oldMaxUpdated = Number(oldAgg?.maxUpdated ?? 0)
    if (oldMaxUpdated === cached.maxUpdated) {
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
            gt(SessionMessageTable.seq, cached.maxSeq),
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const decoded = yield* Effect.forEach(rows, (row) =>
        decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
      )
      decodedSuffix = cached.entries.concat(decoded)
      usedSuffix = true
    }
  }

  const tSql = TIMING ? performance.now() : 0

  // Full read + decode (fallback).
  let rawEntries: Array<{ seq: number; message: SessionMessage.Info }>
  if (usedSuffix && decodedSuffix) {
    rawEntries = decodedSuffix
  } else {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    rawEntries = yield* Effect.forEach(rows, (row) =>
      decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
    )
  }

  const tDecode = TIMING ? performance.now() : 0

  // Re-expansion may cross a native checkpoint whose completion already advanced the instruction
  // epoch: the baseline supersedes the chronological updates before it. Forks seed their baseline
  // at sequence 0 but retain parent sequences, so the copied checkpoint still retires them.
  const filtered = applyVisibilityFilter(rawEntries, boundary)

  // Update cache.
  if (CACHE_ENABLED) {
    inner.set(cacheKey, {
      revisionKey,
      compactionSeq,
      maxSeq,
      count,
      maxUpdated,
      entries: filtered,
    })
  }

  const tFilter = TIMING ? performance.now() : 0
  if (TIMING) {
    console.error(
      "[session-history-timing]",
      JSON.stringify({
        phase: "history.messageEntries",
        sessionID,
        boundary,
        cache: usedSuffix ? "suffix" : cached ? "rebuild" : "cold",
        compactionMs: tComp - t0,
        sqlMs: tSql - tComp,
        decodeMs: tDecode - tSql,
        filterMs: tFilter - tDecode,
        totalMs: tFilter - t0,
        rows: count,
        messages: filtered.length,
        compactionSeq,
      }),
    )
  }
  return filtered.slice() as Array<{ seq: number; message: SessionMessage.Info }>
})

export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  const t0 = TIMING ? performance.now() : 0
  const result = (yield* messageEntries(db, sessionID, boundary)).map((entry) => entry.message)
  const t1 = TIMING ? performance.now() : 0
  if (TIMING) {
    console.error(
      "[session-history-timing]",
      JSON.stringify({ phase: "history.load", sessionID, boundary, totalMs: t1 - t0, messages: result.length }),
    )
  }
  return result
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  const t0 = TIMING ? performance.now() : 0
  const result = yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        return {
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
  const t1 = TIMING ? performance.now() : 0
  if (TIMING) {
    console.error(
      "[session-history-timing]",
      JSON.stringify({
        phase: "history.entriesForRunner",
        sessionID,
        boundary,
        totalMs: t1 - t0,
        messages: result.entries.length,
        initialChars: result.initial.length,
      }),
    )
  }
  return result
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/** Returns the session's first user message. */
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
  return message?.type === "user" ? message : undefined
})

export const clearHistoryCache = () => {
  messageEntryCaches = new WeakMap<object, Map<string, CachedMessageEntries>>()
}

export * as SessionHistory from "./history.js"
