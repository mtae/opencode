import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import type { HomeSessionRecord } from "./records"
import {
  HOME_SERVER_SEARCH_DEBOUNCE_MS,
  createHomeServerSearchState,
  selectHomeServerIndexing,
  selectHomeServerRecords,
  transitionHomeServerSearch,
  type HomeServerSearchEvent,
  type HomeServerSearchState,
} from "./server-search-machine"

const record = (id: string): HomeSessionRecord => ({
  // SAFETY: the machine stores records as they are; only their identity matters here.
  session: { id, location: { directory: "/a" } } as SessionInfo,
  project: { id: "proj", worktree: "/a" },
  projectName: "a",
})

const requested = (query: string, scope = "server\0/a"): HomeServerSearchEvent => ({
  type: "requested",
  query,
  scope,
  enabled: true,
})

function replay(events: HomeServerSearchEvent[], state: HomeServerSearchState = createHomeServerSearchState([10, 20])) {
  return events.reduce(
    (step, event) => {
      const next = transitionHomeServerSearch(step.state, event)

      return { state: next.state, effects: [...step.effects, ...next.effects] }
    },
    { state, effects: [] as ReturnType<typeof transitionHomeServerSearch>["effects"][number][] },
  )
}

describe("home server session search", () => {
  test("asks an unchanged query again while indexing, keeps rows, gains a body-only hit, then stops", () => {
    const run = replay([
      requested("quokka"),
      { type: "timer.fired", attempt: 1 },
      { type: "resolved", attempt: 1, records: [record("ses_title")], indexing: true },
    ])
    expect(run.effects).toEqual([
      { type: "timer.start", attempt: 1, delayMs: HOME_SERVER_SEARCH_DEBOUNCE_MS },
      { type: "fetch.start", attempt: 1, query: "quokka", timeoutMs: 10_000 },
      { type: "timer.start", attempt: 2, delayMs: 10 },
    ])
    expect(selectHomeServerIndexing(run.state)).toBe("refreshing")
    expect(selectHomeServerRecords(run.state, "quokka", "server\0/a")).toEqual([record("ses_title")])

    const refreshed = replay(
      [
        { type: "timer.fired", attempt: 2 },
        { type: "resolved", attempt: 2, records: [record("ses_title"), record("ses_body")], indexing: false },
      ],
      run.state,
    )
    expect(refreshed.effects).toEqual([{ type: "fetch.start", attempt: 2, query: "quokka", timeoutMs: 10_000 }])
    expect(refreshed.state.status).toBe("done")
    expect(selectHomeServerIndexing(refreshed.state)).toBeUndefined()
    expect(selectHomeServerRecords(refreshed.state, "quokka", "server\0/a").map((item) => item.session.id)).toEqual([
      "ses_title",
      "ses_body",
    ])
  })

  test("ends the budget as incomplete and a retry asks again keeping the rows", () => {
    const run = replay([
      requested("quokka"),
      { type: "timer.fired", attempt: 1 },
      { type: "resolved", attempt: 1, records: [record("ses_a")], indexing: true },
      { type: "timer.fired", attempt: 2 },
      { type: "resolved", attempt: 2, records: [record("ses_a")], indexing: true },
      { type: "timer.fired", attempt: 3 },
      { type: "resolved", attempt: 3, records: [record("ses_a")], indexing: true },
    ])
    expect(run.state.status).toBe("incomplete")
    expect(run.effects.filter((effect) => effect.type === "fetch.start")).toHaveLength(3)
    expect(selectHomeServerIndexing(run.state)).toBe("incomplete")

    const retried = replay([{ type: "retry" }], run.state)
    expect(retried.effects).toEqual([{ type: "timer.start", attempt: 4, delayMs: 0 }])
    expect(selectHomeServerRecords(retried.state, "quokka", "server\0/a")).toEqual([record("ses_a")])
  })

  test("a new query or scope cancels the search and a late answer cannot overwrite current rows", () => {
    const loading = replay([requested("quokka"), { type: "timer.fired", attempt: 1 }])
    const moved = replay([requested("quokka", "server\0/b")], loading.state)
    expect(moved.effects).toEqual([
      { type: "attempt.cancel", attempt: 1 },
      { type: "timer.start", attempt: 2, delayMs: HOME_SERVER_SEARCH_DEBOUNCE_MS },
    ])
    const late = replay([{ type: "resolved", attempt: 1, records: [record("ses_old")], indexing: false }], moved.state)
    expect(late.state).toBe(moved.state)
    expect(selectHomeServerRecords(late.state, "quokka", "server\0/b")).toEqual([])
    expect(selectHomeServerRecords(late.state, "quokka", "server\0/a")).toEqual([])

    const closed = replay([requested("")], moved.state)
    expect(closed.effects).toEqual([{ type: "attempt.cancel", attempt: 2 }])
    expect(closed.state.status).toBe("idle")
    expect(replay([{ type: "disposed" }], moved.state).effects).toEqual([{ type: "attempt.cancel", attempt: 2 }])
  })

  test("a failed first answer leaves only local rows; a failed refresh keeps the rows as incomplete", () => {
    const failed = replay([requested("quokka"), { type: "timer.fired", attempt: 1 }, { type: "failed", attempt: 1 }])
    expect(failed.state.status).toBe("failed")
    expect(selectHomeServerRecords(failed.state, "quokka", "server\0/a")).toEqual([])

    const refreshFailed = replay([
      requested("quokka"),
      { type: "timer.fired", attempt: 1 },
      { type: "resolved", attempt: 1, records: [record("ses_a")], indexing: true },
      { type: "timer.fired", attempt: 2 },
      { type: "failed", attempt: 2 },
    ])
    expect(refreshFailed.state.status).toBe("incomplete")
    expect(selectHomeServerRecords(refreshFailed.state, "quokka", "server\0/a")).toEqual([record("ses_a")])
  })
})
