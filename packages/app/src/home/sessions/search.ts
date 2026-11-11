import { useCommand } from "@/shell/commands/command"
import { useLayout } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { useServers } from "@/runtime/server/registry"
import { displayName } from "@opencode/ui/project-avatar"
import { sessionLabel } from "@/session/title"
import { makeEventListener } from "@solid-primitives/event-listener"
import { looksLikeSessionID } from "@/session/search"
import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { HomeController } from "../model"
import { homeSessionSearchKey, type HomeSessionRecord, type HomeSessionsController } from "./controller"
import {
  INITIAL_HOME_SESSION_SEARCH_STATE,
  selectSearchExact,
  selectSearchHighlighted,
  selectSearchLookingUp,
  selectSearchOpen,
  selectSearchQuery,
  selectSearchValue,
  transitionHomeSessionSearch,
  type HomeSessionSearchEffect,
  type HomeSessionSearchEvent,
} from "./search-machine"
import {
  createHomeServerSearchState,
  selectHomeServerIndexing,
  selectHomeServerRecords,
  selectHomeServerSearching,
  transitionHomeServerSearch,
  type HomeServerSearchEffect,
  type HomeServerSearchEvent,
} from "./server-search-machine"

type HomeSessionSearchSource = Pick<HomeSessionsController, "data" | "session">

type PendingLookup = { controller: AbortController; timer: ReturnType<typeof setTimeout> }

export function createHomeSessionSearchController(
  home: HomeController,
  sessions: HomeSessionSearchSource,
  options?: { indexingRetryMs?: readonly number[] },
) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const servers = useServers()

  const [searchState, setSearchState] = createSignal(INITIAL_HOME_SESSION_SEARCH_STATE)
  let lookup: PendingLookup | undefined
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  const query = createMemo(() => selectSearchQuery(searchState()))
  // Results belong to the server and project they were found in.
  const scope = createMemo(() => {
    const selection = home.selection.value()

    return `${selection.server ?? ""}\0${selection.directory ?? ""}`
  })
  const connected = () => home.server.focusedContext()?.sdk.connection.status() === "connected"
  const [serverState, setServerState] = createSignal(createHomeServerSearchState(options?.indexingRetryMs))
  const serverRuns = new Map<number, { controller?: AbortController; timer: ReturnType<typeof setTimeout> }>()
  const highlighted = createMemo(() => selectSearchHighlighted(searchState()))

  const dispatch = (event: HomeSessionSearchEvent) =>
    untrack(() => {
      const previous = searchState()
      const next = transitionHomeSessionSearch(previous, event)

      if (next.state !== previous) setSearchState(next.state)
      next.effects.forEach(run)
    })

  const dispatchServer = (event: HomeServerSearchEvent) =>
    untrack(() => {
      const previous = serverState()
      const next = transitionHomeServerSearch(previous, event)

      if (next.state !== previous) setServerState(next.state)
      next.effects.forEach(runServer)
    })

  function runServer(effect: HomeServerSearchEffect) {
    const attempt = effect.attempt

    if (effect.type === "attempt.cancel") {
      const current = serverRuns.get(attempt)
      clearTimeout(current?.timer)
      current?.controller?.abort()
      serverRuns.delete(attempt)

      return
    }

    if (effect.type === "timer.start") {
      const timer = setTimeout(() => {
        serverRuns.delete(attempt)
        dispatchServer({ type: "timer.fired", attempt })
      }, effect.delayMs)
      serverRuns.set(attempt, { timer })

      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      dispatchServer({ type: "failed", attempt })
    }, effect.timeoutMs)
    serverRuns.set(attempt, { controller, timer })

    // The machine also ignores a superseded attempt, for a server that answers after the abort.
    const settle = (event: HomeServerSearchEvent) => {
      clearTimeout(timer)
      serverRuns.delete(attempt)

      if (!controller.signal.aborted) dispatchServer(event)
    }

    void Promise.try(() => sessions.session.search(effect.query, controller.signal)).then(
      (result) => settle({ type: "resolved", attempt, records: result.records, indexing: result.indexing }),
      () => settle({ type: "failed", attempt }),
    )
  }

  function run(effect: HomeSessionSearchEffect) {
    clearTimeout(lookup?.timer)
    lookup?.controller.abort()
    lookup = undefined

    if (effect.type === "lookup.abort") return
    const controller = new AbortController()
    const attempt = effect.attempt
    const timer = setTimeout(() => dispatch({ type: "lookup.timed-out", attempt }), effect.timeoutMs)
    lookup = { controller, timer }
    void sessions.session.lookup(effect.sessionID, controller.signal).then(
      (record) => {
        clearTimeout(timer)
        dispatch({ type: "lookup.resolved", attempt, record })
      },
      () => {
        clearTimeout(timer)

        if (controller.signal.aborted) return
        dispatch({ type: "lookup.failed", attempt })
      },
    )
  }

  const results = createMemo(() => {
    const value = query().toLowerCase()

    if (!value) return []

    const records = sessions.data
      .searchRecords()
      .filter((record) => `${sessionLabel(record.session)} ${record.projectName}`.toLowerCase().includes(value))

    const exact = selectSearchExact(searchState())
    const local =
      !exact || records.some((record) => record.session.id === exact.session.id) ? records : [exact, ...records]
    // Local matches show at once and keep their place; the server adds sessions matched by content or not loaded here.
    const shown = new Set(local.map((record) => record.session.id))
    const found = selectHomeServerRecords(serverState(), query(), scope()).filter(
      (record) => !shown.has(record.session.id),
    )

    return found.length === 0 ? local : [...local, ...found]
  })

  const active = createMemo(() => {
    const records = results()

    if (records.some((record) => homeSessionSearchKey(record) === highlighted())) return highlighted()

    return records[0] ? homeSessionSearchKey(records[0]) : ""
  })

  const open = createMemo(() => selectSearchOpen(searchState()))

  const placeholder = createMemo(() => {
    const project = home.project.selected()

    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })

    if (home.server.list().length > 1) {
      const conn = home.server.focused()

      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: servers.label(conn) })
    }

    return language.t("home.sessions.search.placeholder")
  })

  // An exact match belongs to the server and project it was looked up in.
  createEffect(() => dispatch({ type: "scope.changed", scope: scope(), connected: connected() }))

  // A session ID is looked up instead. A new query or scope cancels the previous server search.
  createEffect(() => {
    const value = query()
    dispatchServer({
      type: "requested",
      query: value,
      scope: scope(),
      enabled: connected() && !looksLikeSessionID(value),
    })
  })

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!open()) return
      const target = event.target

      if (!(target instanceof Node) || root?.contains(target)) return
      close()
    }),
  )
  onCleanup(() => {
    dispatch({ type: "disposed" })
    dispatchServer({ type: "disposed" })
  })
  onMount(() => {
    if (layout.home.searchFocus.take()) focus()
  })

  // Home's Find focuses its session search, so Settings > Shortcuts lists one Find and one Search sessions.
  command.register("home.search", () => [
    {
      id: "session.search",
      title: language.t("session.search.placeholder"),
      keybind: "mod+f",
      hidden: true,
      onSelect: focus,
    },
  ])

  function focus() {
    input?.focus()
    dispatch({ type: "focused" })
  }

  // Focus moving inside the search (to a result) keeps it open; the window losing focus keeps the input focused.
  function blur(next: EventTarget | null) {
    if ((next instanceof Node && root?.contains(next)) || document.activeElement === input) return
    dispatch({ type: "blurred" })
  }

  function close() {
    dispatch({ type: "closed" })
  }

  function select(record: HomeSessionRecord, options?: { background?: boolean }) {
    sessions.session.open(record.session, options)

    if (!options?.background) close()
  }

  return {
    query: {
      value: () => selectSearchValue(searchState()),
      placeholder,
      open,
      focus,
      blur,
      input: (value: string) => dispatch({ type: "input.changed", value }),
      close,
    },
    result: {
      // Rows already found stay visible while the server answers.
      loading: () =>
        sessions.data.loading() ||
        selectSearchLookingUp(searchState()) ||
        (selectHomeServerSearching(serverState()) && results().length === 0),
      indexing: () => selectHomeServerIndexing(serverState()),
      retry: () => dispatchServer({ type: "retry" }),
      list: results,
      active,
      noResultsLabel: () => language.t("home.sessions.search.noResults", { query: query() }),
      highlight: (record: HomeSessionRecord) =>
        dispatch({ type: "highlight.changed", key: homeSessionSearchKey(record) }),
      move: (delta: number) => {
        const records = results()

        if (records.length === 0) return
        const index = records.findIndex((record) => homeSessionSearchKey(record) === active())
        const next = ((index === -1 ? 0 : index) + delta + records.length) % records.length
        dispatch({ type: "highlight.changed", key: homeSessionSearchKey(records[next]) })
        list?.querySelector<HTMLElement>(`[data-key="${highlighted()}"]`)?.scrollIntoView({ block: "nearest" })
      },
      select,
      selectActive: () => {
        const record = results().find((item) => homeSessionSearchKey(item) === active())

        if (record) select(record)
      },
    },
    element: {
      setRoot: (element: HTMLDivElement) => (root = element),
      setInput: (element: HTMLInputElement) => (input = element),
      setList: (element: HTMLDivElement) => (list = element),
    },
  }
}

export type HomeSessionSearchController = ReturnType<typeof createHomeSessionSearchController>
