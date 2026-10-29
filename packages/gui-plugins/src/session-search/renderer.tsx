import { lazy, Suspense } from "solid-js"
import { SessionSearch, SettingsPage, type Plugin } from "@opencode/plugin/gui"
import type SessionSearchDefinition from "./index"
import { listMatches } from "./matches"

/**
 * Adds server matches to the Home session search. The server matches message content when `GET /api/session` has a
 * `search`, so this asks for that and gets title matches only from a server without full-text search or with its
 * `search` config set to titles. Home applies these after its own results and treats a failure as no matches. Off in
 * the options, it never asks.
 */
const setup: Plugin.Setup<typeof SessionSearchDefinition> = (ctx) => {
  const options = ctx.stores.options
  const Section = lazy(() => import("./section"))

  ctx.add(SessionSearch, {
    id: "full-text",
    search: async (input) => {
      if (!options.value.enabled) return []

      return listMatches(input)
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
