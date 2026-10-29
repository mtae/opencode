# Session search

Covers the server plugin (the list-search hook and the built-in `session-search` plugin), the desktop and web plugin, and what they need from core.

## Shape

| Layer           | What it does                                                                                                                                                                                                                                                                                                    | Where                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Index           | SQLite FTS5 in a separate `<db>-search` file, built lazily by a worker that opens the main DB read-only, then updated from message events. Latest search wins; a superseded one fails.                                                                                                                          | built-in plugin `core/src/plugin/session-search*`                                                    |
| List hook       | `Session.list({ search })` asks registered providers for matching session IDs and ORs them with the title match. No providers means title-only, as before.                                                                                                                                                      | core seam `core/src/session/list-search.ts`                                                          |
| RPC             | `opencode.session-search`: `search` (ranked, with snippets) and `settings` (the mode). Replaces an experimental HTTP route.                                                                                                                                                                                     | plugin + `schema/src/session-search.ts`                                                              |
| Config          | `search: false                                                                                                                                                                                                                                                                                                  | { mode: "titles"                                                                                     | "content" }`, default content. `false`is the same as titles.`Config.Patch` also accepts it so clients can write it. | `schema/src/config/search.ts`, `core/src/config.ts` |
| Desktop and web | A `SessionSearch` registry in the GUI plugin SDK. The built-in `session-search` plugin contributes a source that calls `GET /api/session?search=`. Home search shows local title/project matches at once, then, after a 150 ms pause (two or more characters), appends the sources' sessions not already shown. | `plugin/src/gui/registries.ts`, `gui-plugins/src/session-search/`, `app/src/home/sessions/search.ts` |

## Why each seam exists

- **Server owns indexing and scoping.** The index has to see every message and session of every location, and it must apply the same archive and parent rules as the list. Clients only hold a recent window of sessions, so they cannot do this.
- **List hook (core seam).** `GET /api/session?search=` is what the palette, the TUI list, the CLI `session list --search` and other clients already call. Hooking it means all of them gain content search with no client change, and a server without the plugin behaves as before. It is one small generic hook, so it could stand alone upstream.
- **RPC instead of an HTTP route.** Plugins expose APIs through `ctx.rpc`, so the experimental route was removed. Ranked results with snippets and the settings read use it.
- **Config key and `Config.Patch.search`.** The mode must be one setting for every client of the server. The list hook is global, so it follows the config of the last-activated location; the panel therefore writes the global config. `Patch` only accepted `shell`, so it now takes `search` too; each key is applied only when present, so existing callers are unchanged.
- **`SessionSearch` GUI registry.** The GUI plugin API had no slot for the session list or the Home search box. A registry keeps the host generic (it knows nothing about full-text search) and lets the feature be disabled as a plugin.
- **Local first.** Local results are instant and work offline. The server lookup only adds rows, after the local ones, so selection never moves. Failure, absence and empty replies leave local search exactly as it was.

## Alternatives rejected

- **Index in the client.** Needs every message on every device; no scoping or archive rules.
- **Filter returned sessions by title in the client.** Throws away exactly the content matches.
- **Replace the local results with the server's.** Slower, breaks offline, and moves the selection.
- **A new HTTP route per client.** Duplicates the list route and leaves older clients without search.
- **External stock plugin only.** Not possible today, see below.

## Installability

- **Server side: built-in fork plugin only.** It needs core services an external plugin cannot reach: reading session messages (external `ctx.session` has `list/get/context` but no message reads), the DB file for a worker, and the list hook, which is a core change. It cannot be installed with `opencode plugin add` on a stock build.
- **Desktop and web side: also a fork build.** The registry is an SDK addition and Home search is host code, so a stock app cannot load it as an external plugin. The plugin itself follows the built-in pattern, so it rebases cleanly if upstream takes the registry.
- **What stock clients get from the fork server:** palette, TUI list, CLI and any `?search=` client gain content search with no change.
- **What would make a supported stock plugin possible:** message reads in the external plugin API, a documented list-search hook, and a Home search extension point. Each is a separate small upstream proposal .

## Compatibility limits

- A stock server returns title matches only; the desktop plugin then adds nothing beyond local results.
- The list hook is global and follows the config of the newest location still loaded. Closing it hands the hook back to the one before. The GUI writes the global config, so every location agrees unless a project config sets `search`.
- Cap: 500 sessions per server search, 50 requested by the desktop source.
- Not indexed: tool output, reasoning, attachment contents. Each message is capped at 32 KB.
- A server swap does not update an installed desktop renderer; the app needs its own update for the Home change.
- Native iOS is not fixed: it filters loaded sessions locally. A written change request exists for its developers.
- The app-local on/off switch is per device; the mode is the server's.

## Scope and completeness

- **Filters apply before the read budget.** With `directory`, `project`, `parentID` or `archived` set, the index first resolves the sessions they allow and reads only their documents, so matches in other sessions cannot use up the 10,000-document budget and hide an older match in scope.
- **Home passes its project.** With one project selected, the host gives each source the project's directories (`SessionSearchInput.directories`). The built-in source requests those directories, so the 50-row limit cuts only sessions Home would show. With every project selected nothing is passed.
- **Cold index.** The first search of a large history waits one second for indexing and then returns what it has. The RPC says how many sessions are still missing (`pending`). Desktop's palette and the TUI ask again until `pending` is 0. `GET /api/session?search=` has no such field: a first cold query from Home, the CLI or iOS can lack content matches, and repeating the search a few seconds later returns them.

## For native clients (iOS)

Use the existing list route; there is no iOS-only endpoint.

```
GET /api/session?parentID=null&archived=false&limit=50&search=handshake&project=<projectID>
```

- Response: `{ "data": [SessionInfo...], "cursor": { "previous": string | null, "next": string | null } }`, newest first. A session matches by title or by message text.
- Scope: `project` (optionally with `subpath`) or `directory`; omit both for every project. Scope is applied before `limit`.
- Limits: content matches are capped at 500 sessions per search; a cursor repeats the search, so pages agree while a search finds at most 500 sessions.
- Fallback: with the plugin absent or the config set to `titles` the same call returns title matches only. Read the mode with the `opencode.session-search` `settings` RPC if the UI should say so.
- Cold index: see above; treat an empty first result as possibly incomplete and offer a retry.
