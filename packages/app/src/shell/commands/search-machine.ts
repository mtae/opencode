import type { SessionInfo } from "@opencode/client/promise"
import { SESSION_SEARCH_INDEXING_RETRY_MS } from "@/session/search"
import type { CommandPaletteEntry } from "./palette"

export const PALETTE_SEARCH_TIMEOUT_MS = 10_000

export const PALETTE_SESSION_DEBOUNCE_MS = 150

/** A source's answer. `indexing` says the server may find more for the same query once its search index catches up. */
export type PaletteSourceAnswer = {
  readonly items: readonly CommandPaletteEntry[]
  readonly indexing?: boolean
}

export type PaletteSource = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly CommandPaletteEntry[] | PaletteSourceAnswer>

/** A source's last answer and the query it answered. */
export type PaletteSearchSettled = {
  readonly query: string
  readonly items: readonly CommandPaletteEntry[]
}

/**
 * One remote source of the palette, such as one server's sessions or the files. Each source settles on its own, so a
 * slow or failing source never holds back or hides another. `seen` keeps every entry the source returned while the
 * palette is open, to match refined queries before the source answers them.
 *
 * While a source answers that its index is still building, it `waits` and then asks the same query again, `round`
 * counting the asks, until the answer is complete or the delays run out. It then stays `ready` but `incomplete`.
 */
export type PaletteSourceState =
  | {
      readonly status: "loading"
      readonly attempt: number
      readonly round: number
      readonly settled: PaletteSearchSettled
      readonly seen: readonly CommandPaletteEntry[]
    }
  | {
      readonly status: "waiting"
      readonly attempt: number
      readonly round: number
      readonly settled: PaletteSearchSettled
      readonly seen: readonly CommandPaletteEntry[]
    }
  | {
      readonly status: "ready"
      readonly settled: PaletteSearchSettled
      readonly seen: readonly CommandPaletteEntry[]
      readonly incomplete?: boolean
    }
  | {
      readonly status: "failed"
      readonly settled: PaletteSearchSettled
      readonly seen: readonly CommandPaletteEntry[]
    }

export type PaletteSearchState =
  | { readonly status: "uninitialized"; readonly count: number; readonly retryMs: readonly number[] }
  | {
      readonly status: "active"
      readonly query: string
      readonly issued: number
      readonly retryMs: readonly number[]
      readonly sources: readonly PaletteSourceState[]
    }
  | { readonly status: "disposed" }

export type PaletteSearchEvent =
  | { readonly type: "query.changed"; readonly query: string }
  /** Asks every source the current query again, with a fresh refresh budget. */
  | { readonly type: "retry.requested" }
  | {
      readonly type: "source.resolved"
      readonly index: number
      readonly attempt: number
      readonly items: readonly CommandPaletteEntry[]
      readonly indexing?: boolean
    }
  /** A waiting source's delay ended. */
  | { readonly type: "source.refresh"; readonly index: number; readonly attempt: number }
  | { readonly type: "source.failed"; readonly index: number; readonly attempt: number }
  | { readonly type: "source.timed-out"; readonly index: number; readonly attempt: number }
  | { readonly type: "disposed" }

export type PaletteSearchEffect =
  | {
      readonly type: "source.load"
      readonly index: number
      readonly attempt: number
      readonly query: string
      readonly timeoutMs: number
    }
  | { readonly type: "source.wait"; readonly index: number; readonly attempt: number; readonly delayMs: number }
  /** Stops the attempt's request or delay. */
  | { readonly type: "source.abort"; readonly attempt: number }

export type PaletteSearchTransition = {
  readonly state: PaletteSearchState
  readonly effects: readonly PaletteSearchEffect[]
}

const EMPTY_SETTLED: PaletteSearchSettled = Object.freeze({ query: "", items: Object.freeze([]) })

const DISPOSED_SEARCH: PaletteSearchState = Object.freeze({ status: "disposed" })

export function createPaletteSearchState(
  count: number,
  retryMs: readonly number[] = SESSION_SEARCH_INDEXING_RETRY_MS,
): PaletteSearchState {
  return { status: "uninitialized", count, retryMs }
}

export function transitionPaletteSearch(state: PaletteSearchState, event: PaletteSearchEvent): PaletteSearchTransition {
  if (state.status === "disposed") return { state, effects: [] }

  if (event.type === "disposed")
    return { state: DISPOSED_SEARCH, effects: state.status === "active" ? aborts(state.sources) : [] }

  if (event.type === "query.changed" || event.type === "retry.requested") {
    if (event.type === "query.changed" && state.status === "active" && state.query === event.query)
      return { state, effects: [] }

    if (event.type === "retry.requested" && state.status !== "active") return { state, effects: [] }

    const query = event.type === "query.changed" ? event.query : state.status === "active" ? state.query : ""

    const previous: readonly PaletteSourceState[] =
      state.status === "active"
        ? state.sources
        : Array.from(
            { length: state.count },
            (): PaletteSourceState => ({ status: "ready", settled: EMPTY_SETTLED, seen: [] }),
          )

    const issued = state.status === "active" ? state.issued : 0

    return {
      state: {
        status: "active",
        query,
        issued: issued + previous.length,
        retryMs: state.retryMs,
        sources: previous.map(
          (source, index): PaletteSourceState => ({
            status: "loading",
            attempt: issued + index + 1,
            round: 0,
            settled: source.settled,
            seen: source.seen,
          }),
        ),
      },
      effects: [
        ...aborts(previous),
        ...previous.map((_, index) => ({
          type: "source.load" as const,
          index,
          attempt: issued + index + 1,
          query,
          timeoutMs: PALETTE_SEARCH_TIMEOUT_MS,
        })),
      ],
    }
  }

  if (state.status !== "active") return { state, effects: [] }
  const source = state.sources[event.index]

  if (source === undefined || source.status === "ready" || source.status === "failed") return { state, effects: [] }

  if (source.attempt !== event.attempt) return { state, effects: [] }

  if (event.type === "source.refresh") {
    if (source.status !== "waiting") return { state, effects: [] }

    return {
      state: replace(state, event.index, { ...source, status: "loading", round: source.round + 1 }),
      effects: [
        {
          type: "source.load",
          index: event.index,
          attempt: source.attempt,
          query: state.query,
          timeoutMs: PALETTE_SEARCH_TIMEOUT_MS,
        },
      ],
    }
  }

  if (source.status !== "loading") return { state, effects: [] }

  const abort: PaletteSearchEffect[] =
    event.type === "source.timed-out" ? [{ type: "source.abort", attempt: event.attempt }] : []

  // A refresh that fails keeps the rows it was refreshing; the search just stays incomplete.
  if (event.type !== "source.resolved")
    return {
      state: replace(
        state,
        event.index,
        source.round > 0
          ? { status: "ready", settled: source.settled, seen: source.seen, incomplete: true }
          : { status: "failed", settled: { query: state.query, items: [] }, seen: source.seen },
      ),
      effects: abort,
    }

  const settled = { query: state.query, items: event.items }
  const seen = state.query && event.items.length > 0 ? uniqueByID([...event.items, ...source.seen]) : source.seen

  if (!event.indexing || !state.query)
    return { state: replace(state, event.index, { status: "ready", settled, seen }), effects: [] }

  const delayMs = state.retryMs[source.round]

  if (delayMs === undefined)
    return { state: replace(state, event.index, { status: "ready", settled, seen, incomplete: true }), effects: [] }

  const attempt = state.issued + 1

  return {
    state: replace({ ...state, issued: attempt }, event.index, {
      status: "waiting",
      attempt,
      round: source.round,
      settled,
      seen,
    }),
    effects: [{ type: "source.wait", index: event.index, attempt, delayMs }],
  }
}

export function selectPaletteSearchLoading(state: PaletteSearchState) {
  return state.status === "active" && state.sources.some((source) => source.status === "loading")
}

/**
 * Whether the current results may be incomplete because a server is still indexing: `refreshing` while a source will
 * ask again, `incomplete` once a source has stopped asking.
 */
export function selectPaletteSearchIndexing(state: PaletteSearchState) {
  if (state.status !== "active" || !state.query) return

  if (state.sources.some((source) => source.status === "waiting" || (source.status === "loading" && source.round > 0)))
    return "refreshing" as const

  if (state.sources.some((source) => source.status === "ready" && source.incomplete)) return "incomplete" as const
}

/** A source failed the current query; one still answering it is not a failure yet. */
export function selectPaletteSearchFailed(state: PaletteSearchState) {
  return state.status === "active" && state.sources.some((source) => source.status === "failed")
}

export function selectPaletteSearchSources(state: PaletteSearchState): readonly PaletteSourceState[] {
  return state.status === "active" ? state.sources : []
}

function aborts(sources: readonly PaletteSourceState[]): PaletteSearchEffect[] {
  return sources.flatMap((source) =>
    source.status === "loading" || source.status === "waiting"
      ? [{ type: "source.abort" as const, attempt: source.attempt }]
      : [],
  )
}

function replace(
  state: Extract<PaletteSearchState, { status: "active" }>,
  at: number,
  next: PaletteSourceState,
): PaletteSearchState {
  return { ...state, sources: state.sources.map((item, index) => (index === at ? next : item)) }
}

function uniqueByID(entries: readonly CommandPaletteEntry[]) {
  const ids = new Set<string>()

  return entries.filter((entry) => !ids.has(entry.id) && !!ids.add(entry.id))
}

/**
 * One server's session search inside the palette or the composer. Typed searches wait for a pause; each new search,
 * or the caller's abort, cancels the one before it. `loaded` keeps the sessions learned while the owner is open.
 */
export type SessionSourceState =
  | { readonly status: "idle"; readonly issued: number; readonly loaded: readonly SessionInfo[] }
  | {
      readonly status: "debouncing"
      readonly issued: number
      readonly attempt: number
      readonly query: string
      readonly loaded: readonly SessionInfo[]
    }
  | {
      readonly status: "loading"
      readonly issued: number
      readonly attempt: number
      readonly query: string
      readonly loaded: readonly SessionInfo[]
    }
  | { readonly status: "disposed"; readonly loaded: readonly SessionInfo[] }

export type SessionSourceEvent =
  | { readonly type: "search.requested"; readonly query: string; readonly delayMs: number }
  | { readonly type: "debounce.fired"; readonly attempt: number }
  /** The caller's signal aborted. */
  | { readonly type: "search.aborted"; readonly attempt: number }
  | {
      readonly type: "fetch.succeeded"
      readonly attempt: number
      readonly sessions: readonly SessionInfo[]
      readonly indexing?: boolean
    }
  | { readonly type: "fetch.failed"; readonly attempt: number; readonly error: unknown }
  | { readonly type: "disposed" }

export type SessionSourceEffect =
  | { readonly type: "debounce.start"; readonly attempt: number; readonly delayMs: number }
  | { readonly type: "fetch.start"; readonly attempt: number; readonly query: string }
  /** Stops the attempt's timer and request, and answers its caller with no results. */
  | { readonly type: "attempt.cancel"; readonly attempt: number }
  | {
      readonly type: "attempt.resolve"
      readonly attempt: number
      readonly query: string
      readonly sessions: readonly SessionInfo[]
      readonly indexing?: boolean
    }
  | { readonly type: "attempt.reject"; readonly attempt: number; readonly error: unknown }

export type SessionSourceTransition = {
  readonly state: SessionSourceState
  readonly effects: readonly SessionSourceEffect[]
}

export const INITIAL_SESSION_SOURCE_STATE: SessionSourceState = Object.freeze({
  status: "idle",
  issued: 0,
  loaded: Object.freeze([]),
})

export function transitionSessionSource(state: SessionSourceState, event: SessionSourceEvent): SessionSourceTransition {
  if (state.status === "disposed") return { state, effects: [] }

  const cancel: SessionSourceEffect[] =
    state.status === "idle" ? [] : [{ type: "attempt.cancel", attempt: state.attempt }]

  if (event.type === "disposed") return { state: { status: "disposed", loaded: state.loaded }, effects: cancel }

  if (event.type === "search.requested") {
    const attempt = state.issued + 1

    return {
      state: { status: "debouncing", issued: attempt, attempt, query: event.query, loaded: state.loaded },
      effects: [...cancel, { type: "debounce.start", attempt, delayMs: event.delayMs }],
    }
  }

  if (state.status === "idle" || state.attempt !== event.attempt) return { state, effects: [] }
  const idle: SessionSourceState = { status: "idle", issued: state.issued, loaded: state.loaded }

  if (event.type === "search.aborted") return { state: idle, effects: cancel }

  if (event.type === "debounce.fired") {
    if (state.status !== "debouncing") return { state, effects: [] }

    return {
      state: { ...state, status: "loading" },
      effects: [{ type: "fetch.start", attempt: state.attempt, query: state.query }],
    }
  }

  if (state.status !== "loading") return { state, effects: [] }

  if (event.type === "fetch.failed")
    return { state: idle, effects: [{ type: "attempt.reject", attempt: state.attempt, error: event.error }] }

  return {
    state: {
      status: "idle",
      issued: state.issued,
      loaded: [
        ...new Map([...state.loaded, ...event.sessions].map((session) => [session.id, session] as const)).values(),
      ],
    },
    effects: [
      {
        type: "attempt.resolve",
        attempt: state.attempt,
        query: state.query,
        sessions: event.sessions,
        indexing: event.indexing,
      },
    ],
  }
}
