import { useCommand } from "@/shell/commands/command"
import { useLayout } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { useServers } from "@/runtime/server/registry"
import { displayName } from "@opencode/ui/project-avatar"
import { sessionLabel } from "@/session/title"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMemo, onCleanup, onMount } from "solid-js"
import { SessionSearch } from "@opencode/plugin/gui"
import { usePluginHost } from "@/runtime/plugin/host"
import { createStore } from "solid-js/store"
import type { HomeController } from "../model"
import { homeSessionSearchKey, type HomeSessionRecord, type HomeSessionsController } from "./controller"
import { looksLikeSessionID } from "@/session/search"
import { mergeSearchRows } from "./merge"

// Matches the palette's pause before it asks the server, and skips single characters, which match nearly everything.
const REMOTE_DELAY = 150

const REMOTE_MIN_LENGTH = 2

type HomeSessionSearchSource = Pick<HomeSessionsController, "data" | "session">

export function createHomeSessionSearchController(home: HomeController, sessions: HomeSessionSearchSource) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const servers = useServers()
  const plugins = usePluginHost()

  const [state, setState] = createStore<{
    value: string
    focused: boolean
    highlighted: string
    exact: HomeSessionRecord | undefined
    lookingUp: boolean
    remote: HomeSessionRecord[]
    searching: boolean
  }>({
    value: "",
    focused: false,
    highlighted: "",
    exact: undefined,
    lookingUp: false,
    remote: [],
    searching: false,
  })

  let lookup = 0
  let remote: { timer: ReturnType<typeof setTimeout>; abort: AbortController } | undefined
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  const query = createMemo(() => state.value.trim())

  const results = createMemo(() => {
    const value = query().toLowerCase()

    if (!value) return []

    const records = sessions.data
      .searchRecords()
      .filter((record) => `${sessionLabel(record.session)} ${record.projectName}`.toLowerCase().includes(value))

    return mergeSearchRows({ local: records, exact: state.exact, remote: state.remote })
  })

  const active = createMemo(() => {
    const records = results()

    if (records.some((record) => homeSessionSearchKey(record) === state.highlighted)) return state.highlighted

    return records[0] ? homeSessionSearchKey(records[0]) : ""
  })

  const open = createMemo(() => state.focused && query().length > 0)

  const placeholder = createMemo(() => {
    const project = home.project.selected()

    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })

    if (home.server.list().length > 1) {
      const conn = home.server.focused()

      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: servers.label(conn) })
    }

    return language.t("home.sessions.search.placeholder")
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
    lookup++
    cancelRemote()
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
    setState("focused", true)
  }

  function close() {
    lookup++
    cancelRemote()
    setState({ value: "", focused: false, exact: undefined, lookingUp: false, remote: [], searching: false })
  }

  function cancelRemote() {
    if (!remote) return
    clearTimeout(remote.timer)
    remote.abort.abort()
    remote = undefined
  }

  // Asks the plugins' session search sources once typing pauses. The local results are already showing, so a source
  // that is slow, fails or finds nothing leaves them as they are.
  function searchRemote(text: string) {
    cancelRemote()
    setState({ remote: [], searching: false })

    const sources = plugins.list(SessionSearch)
    const client = home.server.focusedContext()?.sdk.api

    if (text.length < REMOTE_MIN_LENGTH || looksLikeSessionID(text) || !client || sources.length === 0) return

    const abort = new AbortController()
    setState("searching", true)
    remote = {
      abort,
      timer: setTimeout(() => {
        void Promise.all(
          sources.map((source) =>
            Promise.resolve()
              .then(() => source.search({ query: text, client, signal: abort.signal }))
              .catch(() => []),
          ),
        ).then((found) => {
          if (abort.signal.aborted) return
          remote = undefined
          setState({
            remote: sessions.data.recordsFor(found.flat().filter((session) => !session.time.archived)),
            searching: false,
          })
        })
      }, REMOTE_DELAY),
    }
  }

  function update(value: string) {
    const current = ++lookup
    const sessionID = value.trim()
    setState({ value, highlighted: "", exact: undefined, lookingUp: false })
    searchRemote(sessionID)

    if (!looksLikeSessionID(sessionID)) return
    setState("lookingUp", true)
    void sessions.session.lookup(sessionID).then(
      (record) => {
        if (current !== lookup) return
        setState({ exact: record, lookingUp: false })
      },
      () => {
        if (current !== lookup) return
        setState("lookingUp", false)
      },
    )
  }

  function select(record: HomeSessionRecord, options?: { background?: boolean }) {
    sessions.session.open(record.session, options)

    if (!options?.background) close()
  }

  return {
    query: {
      value: () => state.value,
      placeholder,
      open,
      focus,
      input: update,
      close,
    },
    result: {
      // The list stays up while the server looks: only an empty one waits, so its no-results line does not flash.
      loading: () => sessions.data.loading() || state.lookingUp || (state.searching && results().length === 0),
      list: results,
      active,
      noResultsLabel: () => language.t("home.sessions.search.noResults", { query: query() }),
      highlight: (record: HomeSessionRecord) => setState("highlighted", homeSessionSearchKey(record)),
      move: (delta: number) => {
        const records = results()

        if (records.length === 0) return
        const index = records.findIndex((record) => homeSessionSearchKey(record) === active())
        const next = ((index === -1 ? 0 : index) + delta + records.length) % records.length
        setState("highlighted", homeSessionSearchKey(records[next]))
        list?.querySelector<HTMLElement>(`[data-key="${state.highlighted}"]`)?.scrollIntoView({ block: "nearest" })
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
