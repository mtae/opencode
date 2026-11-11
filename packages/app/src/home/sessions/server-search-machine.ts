import { SESSION_SEARCH_INDEXING_RETRY_MS } from "@/session/search"
import type { HomeSessionRecord } from "./records"

export const HOME_SERVER_SEARCH_DEBOUNCE_MS = 150

export const HOME_SERVER_SEARCH_TIMEOUT_MS = 10_000

type Fields = {
  readonly issued: number
  /** The query and scope the records answer. Records only show while both are current. */
  readonly query: string
  readonly scope: string
  readonly records: readonly HomeSessionRecord[]
  readonly retryMs: readonly number[]
}

/**
 * Home's search of the focused server's session list, next to its instant local matches. A typed query waits for a
 * pause, then asks the server in the selected scope. While the server answers that its search index is still building,
 * the same query is asked again after each delay in `retryMs` (`round` counts the asks), keeping the rows already
 * shown. It ends `done`, `failed`, or `incomplete` once the delays run out or a refresh fails.
 */
export type HomeServerSearchState =
  | (Fields & { readonly status: "idle" | "done" | "failed" | "incomplete" })
  | (Fields & {
      readonly status: "debouncing" | "loading" | "waiting"
      readonly attempt: number
      readonly round: number
    })
  | { readonly status: "disposed" }

export type HomeServerSearchEvent =
  /** The query or scope changed; an empty query, or a scope that cannot search, stops searching. */
  | { readonly type: "requested"; readonly query: string; readonly scope: string; readonly enabled: boolean }
  | { readonly type: "timer.fired"; readonly attempt: number }
  | {
      readonly type: "resolved"
      readonly attempt: number
      readonly records: readonly HomeSessionRecord[]
      readonly indexing: boolean
    }
  | { readonly type: "failed"; readonly attempt: number }
  /** Asks the current query again with a fresh budget. */
  | { readonly type: "retry" }
  | { readonly type: "disposed" }

export type HomeServerSearchEffect =
  | { readonly type: "timer.start"; readonly attempt: number; readonly delayMs: number }
  | {
      readonly type: "fetch.start"
      readonly attempt: number
      readonly query: string
      readonly timeoutMs: number
    }
  /** Stops the attempt's timer and request. */
  | { readonly type: "attempt.cancel"; readonly attempt: number }

export type HomeServerSearchTransition = {
  readonly state: HomeServerSearchState
  readonly effects: readonly HomeServerSearchEffect[]
}

export function createHomeServerSearchState(
  retryMs: readonly number[] = SESSION_SEARCH_INDEXING_RETRY_MS,
): HomeServerSearchState {
  return { status: "idle", issued: 0, query: "", scope: "", records: [], retryMs }
}

export function transitionHomeServerSearch(
  state: HomeServerSearchState,
  event: HomeServerSearchEvent,
): HomeServerSearchTransition {
  if (state.status === "disposed") return { state, effects: [] }

  const cancel: HomeServerSearchEffect[] =
    "attempt" in state ? [{ type: "attempt.cancel", attempt: state.attempt }] : []

  if (event.type === "disposed") return { state: { status: "disposed" }, effects: cancel }

  if (event.type === "requested") {
    const query = event.enabled ? event.query : ""

    if (query === state.query && event.scope === state.scope) return { state, effects: [] }

    return start({ ...fields(state), query, scope: event.scope, records: [] }, cancel, HOME_SERVER_SEARCH_DEBOUNCE_MS)
  }

  if (event.type === "retry") {
    if (state.status !== "incomplete" && state.status !== "failed") return { state, effects: [] }

    return start(fields(state), [], 0)
  }

  if (!("attempt" in state) || state.attempt !== event.attempt) return { state, effects: [] }

  if (event.type === "timer.fired") {
    if (state.status === "loading") return { state, effects: [] }

    const round = state.status === "waiting" ? state.round + 1 : 0

    return {
      state: { ...state, status: "loading", round },
      effects: [
        { type: "fetch.start", attempt: state.attempt, query: state.query, timeoutMs: HOME_SERVER_SEARCH_TIMEOUT_MS },
      ],
    }
  }

  if (state.status !== "loading") return { state, effects: [] }

  // A refresh that fails keeps the rows it was refreshing; the search just stays incomplete.
  if (event.type === "failed")
    return { state: { ...fields(state), status: state.round > 0 ? "incomplete" : "failed" }, effects: cancel }

  const answered = { ...fields(state), records: event.records }
  const delayMs = state.retryMs[state.round]

  if (!event.indexing) return { state: { ...answered, status: "done" }, effects: [] }

  if (delayMs === undefined) return { state: { ...answered, status: "incomplete" }, effects: [] }

  const attempt = state.issued + 1

  return {
    state: { ...answered, issued: attempt, status: "waiting", attempt, round: state.round },
    effects: [{ type: "timer.start", attempt, delayMs }],
  }
}

/** Server rows for `query` in `scope`; none while the server answers an older query or scope. */
export function selectHomeServerRecords(state: HomeServerSearchState, query: string, scope: string) {
  if (state.status === "disposed" || state.query !== query || state.scope !== scope) return []

  return state.records
}

/** Whether the server has not answered the current query at all yet. */
export function selectHomeServerSearching(state: HomeServerSearchState) {
  return (state.status === "debouncing" || state.status === "loading") && state.round === 0
}

/** `refreshing` while the server is still indexing and the query will be asked again; `incomplete` once it stops. */
export function selectHomeServerIndexing(state: HomeServerSearchState) {
  if (state.status === "waiting" || (state.status === "loading" && state.round > 0)) return "refreshing" as const

  if (state.status === "incomplete") return "incomplete" as const
}

function start(next: Fields, cancel: HomeServerSearchEffect[], delayMs: number): HomeServerSearchTransition {
  if (!next.query) return { state: { ...next, status: "idle" }, effects: cancel }

  const attempt = next.issued + 1

  return {
    state: { ...next, issued: attempt, status: "debouncing", attempt, round: 0 },
    effects: [...cancel, { type: "timer.start", attempt, delayMs }],
  }
}

function fields(state: Exclude<HomeServerSearchState, { status: "disposed" }>): Fields {
  return {
    issued: state.issued,
    query: state.query,
    scope: state.scope,
    records: state.records,
    retryMs: state.retryMs,
  }
}
