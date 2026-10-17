import { and, asc, desc, eq, gte, or, sql } from "drizzle-orm"
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
  readonly revision: number // durableSeq at snapshot time
  readonly entries: ReadonlyArray<{ readonly seq: number; readonly message: SessionMessage.Info }>
}

// Bounded per-db cache: an unbounded WeakMap<Map> of fully-decoded transcripts would pin
// every session ever read for the life of the process. Cap entries per db and evict FIFO.
const CACHE_MAX_ENTRIES = 64

let messageEntryCaches = new WeakMap<object, Map<string, CachedMessageEntries>>()

const messageEntryCacheFor = (db: DatabaseService) => {
  let inner = messageEntryCaches.get(db as object)
  if (!inner) {
    inner = new Map()
    messageEntryCaches.set(db as object, inner)
  }
  return inner
}

const cacheSet = (inner: Map<string, CachedMessageEntries>, key: string, value: CachedMessageEntries) => {
  if (inner.size >= CACHE_MAX_ENTRIES) {
    const first = inner.keys().next().value
    if (first !== undefined) inner.delete(first)
  }
  inner.set(key, value)
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
  // The durable event counter advances on every message-write-causing durable event
  // (bus.ts:commitDurableEvent runs the projector + EventSequenceTable bump in one txn),
  // so it is a complete, O(1) revision fingerprint of session_message for this session.
  // Read it first so a cache hit skips the latestCompaction query entirely.
  const durableSeq = yield* Bus.latestSequence(db, sessionID)

  const inner = messageEntryCacheFor(db)
  // Provenance boundaries are plain objects; serialize them so distinct models/providers
  // never share (and never collide on) one cache slot.
  const boundaryKey = typeof boundary === "string" ? boundary : JSON.stringify(boundary)
  const cacheKey = `${sessionID}::${boundaryKey}`
  const cached = CACHE_ENABLED ? inner.get(cacheKey) : undefined

  // Exact reuse: identical durable revision ⇒ no message-row write since snapshot ⇒
  // identical post-filter entries. durableSeq is the only component needed because every
  // compaction (which moves the window lower bound) is itself a durable event.
  if (cached && cached.revision === durableSeq) {
    return cached.entries.slice() as Array<{ seq: number; message: SessionMessage.Info }>
  }

  // Cache miss: compute the compaction window and do a full read + decode.
  const compaction = yield* latestCompaction(db, sessionID, boundary)
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
  const rawEntries = yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )

  // Re-expansion may cross a native checkpoint whose completion already advanced the instruction
  // epoch: the baseline supersedes the chronological updates before it. Forks seed their baseline
  // at sequence 0 but retain parent sequences, so the copied checkpoint still retires them.
  const filtered = applyVisibilityFilter(rawEntries, boundary)

  // Update cache.
  if (CACHE_ENABLED) {
    cacheSet(inner, cacheKey, { revision: durableSeq, entries: filtered })
  }

  return filtered.slice() as Array<{ seq: number; message: SessionMessage.Info }>
})

export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  const result = (yield* messageEntries(db, sessionID, boundary)).map((entry) => entry.message)
  return result
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
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
