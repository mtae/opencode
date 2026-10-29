export * as SessionSearchPlugin from "./session-search.js"

import { define } from "@opencode/plugin/effect/plugin"
import { ConfigSearch } from "@opencode/schema/config/search"
import { SessionSearch as SessionSearchSchema } from "@opencode/schema/session-search"
import { Cause, Effect, Schema } from "effect"
import { Config } from "../config.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { SessionListSearch } from "../session/list-search.js"
import { SessionSearch } from "./session-search/search.js"

// How many full-text matches list's `search` also accepts. A cursor re-runs the search, so pages agree as long as a
// search finds no more Sessions than this.
const ListSearchMatches = 500

const encode = Schema.encodeEffect(SessionSearchSchema.SearchResponse)

/** List's search hook: full-text matches in content mode, none in titles mode, so list matches titles only. */
export const listProvider =
  (search: SessionSearch.Interface, mode: () => ConfigSearch.Mode): SessionListSearch.Provider =>
  (filter, query) =>
    mode() === "titles"
      ? Effect.succeed([])
      : search.search({ ...filter, query, limit: ListSearchMatches }).pipe(
          Effect.map((found) => found.data.map((result) => result.session.id)),
          // Superseded by another search, or the index failed: match titles only, as before.
          Effect.catchTag("SessionSearch.SupersededError", () => Effect.succeed([])),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning("Session list search fell back to titles", cause).pipe(Effect.as([])),
          ),
        )

/**
 * Full-text Session search. It answers the `opencode.session-search` RPC, and makes list's `search` also match
 * message text, so clients that only know list's title filter, such as the mobile app, find Sessions by their messages.
 * The `search` config's titles mode turns both off, leaving list's title match. List's hook is shared by every
 * location, so it follows the config of the location that activated last; set it in the global config.
 */
export const Plugin = define({
  id: "opencode.session-search",
  effect: Effect.fn(function* (ctx) {
    const search = yield* SessionSearch.Service
    const listSearch = yield* SessionListSearch.Service
    const loaded = yield* ConfigEntryObserver.observe(yield* Config.Service, ctx.event, Effect.void)
    const mode = () => ConfigSearch.mode(Config.latest(loaded.entries, "search"))

    yield* listSearch.register("opencode.session-search", listProvider(search, mode))

    yield* ctx.rpc
      .register(SessionSearchSchema.Definition, {
        settings: () => Effect.sync(() => ({ mode: mode() })),
        search: (input, context) =>
          mode() === "titles"
            ? Effect.fail(context.error("disabled", "Session search matches titles only"))
            : search.search(input).pipe(
                Effect.catchTag("SessionSearch.SupersededError", () =>
                  Effect.fail(context.error("superseded", "Superseded by a newer search")),
                ),
                Effect.flatMap((response) => encode(response).pipe(Effect.orDie)),
              ),
      })
      .pipe(Effect.orDie)
  }),
})
