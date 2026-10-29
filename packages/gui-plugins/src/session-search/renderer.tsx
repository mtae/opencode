import { lazy, Suspense } from "solid-js"
import { SessionSearch, SettingsPage, type Plugin } from "@opencode/plugin/gui"
import type SessionSearchDefinition from "./index"

// Past this many matches the Home list stops being a search; the title and project filter has no such cap.
const LIMIT = 50

/**
 * Adds server matches to the Home session search. The server matches message content when `GET /api/session` has a
 * `search`, so this asks for that and gets title matches only from a server without full-text search. Home applies
 * these after its own results and treats a failure as no matches. Off in the options, it never asks.
 */
const setup: Plugin.Setup<typeof SessionSearchDefinition> = (ctx) => {
  const options = ctx.stores.options
  const Section = lazy(() => import("./section"))

  ctx.add(SessionSearch, {
    id: "full-text",
    search: async (input) => {
      if (!options.value.enabled) return []

      const result = await input.client.session.list(
        { parentID: null, search: input.query, archived: false, limit: LIMIT },
        { signal: input.signal },
      )

      const query = input.query.toLowerCase()

      return options.value.mode === "content"
        ? result.data
        : result.data.filter((session) => (session.title ?? "").toLowerCase().includes(query))
    },
  })

  ctx.add(SettingsPage, {
    id: "session-search",
    page: "general",
    get title() {
      return ctx.t("section.title")
    },
    get entries() {
      return [
        { id: "settings-session-search-enabled", title: ctx.t("enabled.title") },
        { id: "settings-session-search-mode", title: ctx.t("mode.title") },
      ]
    },
    render: () => (
      <Suspense>
        <Section />
      </Suspense>
    ),
  })
}

export default setup
