import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import path from "path"
import type { SessionInfo } from "@opencode/client"
import { Project } from "@opencode/schema/project"
import { TextAttributes, type RGBA } from "@opentui/core"
import { DIALOG_LIST_INSET, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { Locale } from "../util/locale"
import { useTheme } from "../context/theme"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { DialogSessionRename } from "./dialog-session-rename"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { useSessionTabs } from "../context/session-tabs"
import { useStorage } from "../context/storage"
import { useConfig, useNewDesigns } from "../config"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { projectName } from "../util/project"
import { useLocation } from "../context/location"

/**
 * Delays before the same search is asked again while the server reports `experimental.indexing`; about 45 seconds in
 * all. After the last one the list says it may be incomplete and offers to search again.
 */
export const SEARCH_INDEXING_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]

type SessionSearchResult = {
  query: string
  allProjects: boolean
  sessions: SessionInfo[]
  /** The server was still indexing when it answered this search. */
  indexing: boolean
  /** Where sessions found by their content matched: plain-text excerpts by session ID. */
  snippets: ReadonlyMap<string, string>
  round: number
  error: unknown
}

export function DialogSessionList(props: { indexingRetryMs?: readonly number[] } = {}) {
  const retryDelays = props.indexingRetryMs ?? SEARCH_INDEXING_RETRY_MS
  const dialog = useDialog()
  const route = useRoute()
  const data = useData()
  const theme = useTheme().surface("dialog")
  const client = useClient()
  const local = useLocal()
  const sessionTabs = useSessionTabs()
  const config = useConfig().data
  const newDesigns = useNewDesigns()
  const toast = useToast()
  const activeLocation = useLocation()
  const [filter, setFilter] = createSignal("")
  const shortcuts = Keymap.useShortcuts()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [toDelete, setToDelete] = createSignal<string>()
  const [prefs, updatePrefs] = useStorage().store("session-list", {
    initial: { allProjects: config.tabs?.scope !== "cwd" },
  })
  const allProjects = () => prefs.allProjects
  const pickerLocation = () =>
    (route.data.type === "session" ? data.session.get(route.data.sessionID)?.location : undefined) ??
    activeLocation.ref ??
    data.location.default()

  // One request at a time: a new search, scope or refresh aborts the previous one, and Solid drops its late answer.
  let request: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    clearTimeout(retry)
    request?.abort()
  })

  const [searchResults, { mutate: setSearchResults, refetch }] = createResource(
    () => ({
      query: search().trim(),
      allProjects: allProjects(),
      location: pickerLocation(),
    }),
    // `refetching` carries the refresh round while the index builds; a new search or scope starts again at 0.
    async ({ query, allProjects, location }, info): Promise<SessionSearchResult> => {
      request?.abort()
      const controller = new AbortController()
      request = controller
      const round = typeof info.refetching === "number" ? info.refetching : 0
      const previous = round > 0 ? searchResults.latest : undefined
      try {
        if (!data.location.info(location)) await data.location.sync(location)
        const current = data.location.info(location)
        if (!current) throw new Error("Location unavailable")
        const response = await client.api.session.list(
          {
            ...(allProjects
              ? {}
              : current.project.id === Project.ID.global
                ? { directory: current.directory }
                : {
                    project: current.project.id,
                    subpath: path.relative(current.project.directory, current.directory).replaceAll("\\", "/"),
                  }),
            ...(query ? { search: query, match: true } : {}),
            limit: 50,
            order: "desc",
            parentID: null,
            archived: false,
          },
          { signal: controller.signal },
        )
        const indexing = !!query && !!response.experimental?.indexing
        const snippets = new Map(
          (response.experimental?.matches ?? []).map((match) => [match.sessionID, match.snippet] as const),
        )
        return { query, allProjects, sessions: response.data, indexing, snippets, round, error: undefined }
      } catch (error) {
        // A failed refresh keeps the rows already shown and stops refreshing, as when the budget runs out.
        if (previous && !previous.error) return { ...previous, round: retryDelays.length }
        // A transient transport failure must degrade search, not crash the TUI
        // through the root ErrorBoundary when the errored resource is read.
        return { query, allProjects, sessions: [] as SessionInfo[], indexing: false, snippets: new Map(), round, error }
      }
    },
  )

  // While the index is incomplete, ask the unchanged search again after the next delay. A new answer, search or scope
  // reruns this and clears the pending timer first.
  createEffect(() => {
    clearTimeout(retry)
    retry = undefined
    if (searchResults.loading) return
    const result = searchResults()
    if (!result?.indexing || result.round >= retryDelays.length) return
    const round = result.round
    retry = setTimeout(() => void refetch(round + 1), retryDelays[round])
  })
  const indexing = createMemo(() => {
    const result = searchResults.latest
    if (!result?.indexing || result.query !== filter().trim() || result.allProjects !== allProjects()) return
    return result.round < retryDelays.length ? "refreshing" : "stopped"
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const localSessions = createMemo(() => {
    const query = filter().trim().toLowerCase()
    const current = data.location.info(pickerLocation())
    const sessions = data.session
      .list()
      .filter(
        (session) =>
          session.time.archived === undefined &&
          (allProjects() ||
            (session.projectID === current?.project.id && session.location.directory === current.directory)),
      )
    if (!query) return sessions
    return sessions.filter(
      (session) => !session.parentID && withTimestampedFallback(session).toLowerCase().includes(query),
    )
  })
  const sessions = createMemo(() => {
    const query = filter().trim()
    const local = localSessions()
    if (query !== search().trim()) return searchResults.latest?.sessions ?? local
    if (searchResults.loading) return searchResults.latest?.sessions ?? []
    const result = searchResults()
    if (result?.query !== query || result.allProjects !== allProjects() || result.error) return local
    return result.sessions
  })
  const searchState = createMemo(() => {
    const query = filter().trim()
    if (query !== search().trim() || searchResults.loading)
      return { message: query ? "Searching sessions…" : "Loading sessions…", error: false }
    const result = searchResults()
    if (result?.query === query && result.error)
      return {
        message: query ? "Could not search sessions. Change the search to try again." : "Could not load sessions.",
        error: true,
      }
    return { message: query ? "No sessions found" : "No sessions available", error: false }
  })

  const quickSwitchHint = createMemo(() => {
    if (sessionTabs.enabled()) return
    const first = shortcuts.get("session.quick_switch.1")
    const last = shortcuts.get("session.quick_switch.9")
    if (!first || !last) return
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })
  const currentProjectName = createMemo(() => {
    const current = data.location.info(pickerLocation())
    if (!current) return ""
    const project = data.project.get(current.project.id)
    return projectName(project) ?? ""
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    // Excerpts belong to the search that found them; rows kept from an earlier search show none.
    const query = filter().trim()
    const snippets = query && searchResults.latest?.query === query ? searchResults.latest.snippets : undefined
    const sessionMap = new Map(
      sessions()
        .filter((session) => !session.parentID)
        .map((session) => [session.id, session]),
    )
    const pinned = sessionTabs.enabled() ? [] : local.session.pinned().filter((sessionID) => sessionMap.has(sessionID))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map(local.session.slots().map((sessionID, index) => [sessionID, index + 1]))

    const option = (session: SessionInfo, category: string) => {
      const directory = session.location.directory
      const project = data.project.get(session.projectID)
      const root = session.subpath ? path.resolve(directory, ...session.subpath.split("/").map(() => "..")) : directory
      const relative = path.relative(project?.canonical ?? root, root)
      const footer =
        relative.startsWith("..") || path.isAbsolute(relative)
          ? Locale.truncate(path.basename(relative), 25)
          : undefined
      const slot = sessionTabs.enabled() ? undefined : slotByID.get(session.id)
      const deleting = toDelete() === session.id
      const attention = sessionTabs.status(session.id).attention
      return {
        title: deleting
          ? `Press ${shortcuts.get("session.delete")} again to confirm`
          : withTimestampedFallback(session),
        value: session.id,
        category,
        footer,
        details: snippets?.has(session.id) ? [snippets.get(session.id) ?? ""] : undefined,
        bg: deleting ? theme.background.action.destructive.focused : undefined,
        fg: deleting ? theme.text.action.destructive.focused : undefined,
        gutter: sessionStatusGutter(
          theme,
          attention,
          !attention &&
            (data.session.status(session.id) === "running" ||
              data.session.family(session.id).some((id) => data.session.status(id) === "running")),
          slot === undefined ? undefined : () => <text fg={theme.hue.accent[200]}>{slot}</text>,
        ),
      }
    }

    const remaining = sessions()
      .filter((session) => !session.parentID && !pinnedSet.has(session.id))
      .map((session) => {
        const date = new Date(session.time.updated).toDateString()
        return option(session, date === today ? "Today" : date)
      })

    return [...pinned.map((sessionID) => option(sessionMap.get(sessionID)!, "Pinned")), ...remaining]
  })

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Sessions"
      titleView={
        <box flexDirection="row">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Sessions
          </text>
          <Show when={!allProjects() && currentProjectName()}>
            <text fg={theme.text.muted}> for {currentProjectName()}</text>
          </Show>
        </box>
      }
      searchInTitle
      titlePlaceholder={
        !allProjects() && currentProjectName() ? `Search sessions in ${currentProjectName()}` : "Search sessions"
      }
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      focusCurrent={false}
      onFilter={(query) => {
        setFilter(query)
        setSearch(query)
      }}
      footer={
        <Show when={indexing()}>
          <text fg={theme.text.feedback.info.base}>
            {indexing() === "refreshing"
              ? "Indexing sessions, results may be incomplete…"
              : "Still indexing, results may be incomplete. ctrl+g searches again."}
          </text>
        </Show>
      }
      bindings={[
        ...(indexing() === "stopped"
          ? [{ bind: "ctrl+g", title: "Search sessions again", group: "Dialog", run: () => void refetch(0) }]
          : []),
        {
          bind: "ctrl+a",
          title: allProjects() ? "Show current directory sessions" : "Show all project sessions",
          group: "Dialog",
          run: () => {
            void updatePrefs((draft) => {
              draft.allProjects = !draft.allProjects
            }).catch(() => {})
          },
        },
      ]}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={searchState().error ? theme.text.feedback.error.base : theme.text.muted}>
            {searchState().message}
          </text>
        </box>
      }
      noMatchView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={searchState().error ? theme.text.feedback.error.base : theme.text.muted}>
            {searchState().message}
          </text>
        </box>
      }
      onMove={() => setToDelete(undefined)}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          hidden: sessionTabs.enabled(),
          onTrigger: (option) => local.session.togglePin(option.value),
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option: { value: string }) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            void client.api.session
              .remove({ sessionID: option.value })
              .then(() => {
                setSearchResults((result) =>
                  result
                    ? { ...result, sessions: result.sessions.filter((session) => session.id !== option.value) }
                    : result,
                )
              })
              .catch((error) => {
                setToDelete(undefined)
                toast.show({
                  message: `Failed to delete session: ${errorMessage(error)}`,
                  variant: "error",
                  duration: 5000,
                })
              })
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: (option: { value: string; title: string }) =>
            DialogSessionRename.show(dialog, option.value, option.title),
        },
      ]}
      footerHints={[
        ...(newDesigns() ? [] : quickSwitchFooterHints()),
        { title: allProjects() ? "current directory" : "all projects", label: "ctrl+a", side: "right" },
      ]}
    />
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}

export function sessionStatusGutter(
  theme: ReturnType<ReturnType<typeof useTheme>["surface"]>,
  attention: "permission" | "question" | false,
  running: boolean,
  fallback?: () => JSX.Element,
) {
  if (attention) {
    return (color: RGBA) => (
      <text
        fg={color === theme.text.action.primary.focused ? color : theme.text.feedback.warning.base}
        attributes={TextAttributes.BOLD}
      >
        {attention === "permission" ? "!" : "?"}
      </text>
    )
  }
  if (running) return (color: RGBA) => <Spinner color={color} />
  return fallback
}
