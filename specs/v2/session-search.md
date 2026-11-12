# Session Search

Session search finds sessions by title, and, when the experimental index is enabled, by what was said and run in
them. It is a filter on the existing session list endpoint. There is no separate search endpoint, ranking, or result
type; a client may ask for a plain-text excerpt of where each content-only row matched.

## Wire Contract

`GET /api/session` (`session.list`) takes `search` alongside the list's other query parameters:

| Parameter   | Encoding                                                 | Meaning                                                          |
| ----------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `search`    | string                                                   | Words to match. Empty or absent means no search.                 |
| `parentID`  | session ID, or the string `null`                         | `null` returns only root sessions.                               |
| `archived`  | the string `true` or `false`                             | Only archived, or only unarchived. Omit for both.                |
| `directory` | absolute path                                            | Sessions whose location is exactly this directory.               |
| `project`   | project ID (the parameter is `project`, not `projectID`) | Sessions of the project. `subpath` narrows to one relative path. |
| `order`     | `asc` or `desc`                                          | First-page order by update time.                                 |
| `limit`     | positive integer                                         | Page size. Defaults to 50.                                       |
| `cursor`    | opaque string from `cursor.previous` or `cursor.next`    | Continues the same ordered list, including its search.           |
| `match`     | the string `true` or `false` (experimental)              | With `search`, also return `experimental.matches`.               |

The response is the ordinary `SessionsResponse`:

```json
{
  "data": [
    /* Session.Info */
  ],
  "cursor": { "previous": "...", "next": "..." },
  "experimental": {
    "indexing": true,
    "matches": [
      { "sessionID": "ses_...", "messageID": "msg_...", "source": "assistant", "snippet": "…the walrus plan…" }
    ]
  }
}
```

`experimental` is optional and appears only for a request with `search`. It may change without compatibility
guarantees. Older clients ignore it, and clients generated before it existed decode the response unchanged.

- `indexing` is `true` while the index is enabled and still being built or has queued changes.
- `matches` appears only for `match=true` and only when non-empty. It explains up to 20 rows of this page whose title
  does not contain the search, in page order: for each, its best message by BM25 among those sessions only (so better
  matches elsewhere never displace it), the message's `source` (`user`, `assistant`, `shell`, `synthetic` or
  `compaction`), and `snippet`. The snippet is plain text of at most 160 characters with `…` where it was cut, taken
  from the window with the most distinct query words; it is never markup and clients render it as text. It is read
  from the same bounded extraction as indexing, without camelCase expansion. `match` never changes rows, order or
  cursors.

## What Matches

- **Titles** always match as a case-insensitive substring (`LIKE %search%`), with or without the index.
- **Content** matches only while `experimental.sqlite_fts` is `true` in any loaded location's config and the index
  exists at the current version. The index covers the whole database, so one enabling location turns content
  matching on for every scope. It is off by default.
- A session matches if its title matches **or** any indexed message matches. Matching selects sessions. The list keeps
  its time order, scope, `parentID`, `archived` and cursor. There is no relevance order or highlight.
- Messages hidden by a staged revert (the boundary message and later ones) do not match until the revert is undone;
  committing it deletes them.

Content queries are literal:

- Words are split on letters, marks and digits. They are case- and diacritic-folded, with no stemming.
- All words must match (`AND`). Text inside double quotes is a phrase.
- The final word is a prefix only when the query ends in a letter or digit. `alp` finds `alpha`; `alp ` does not.
- Typed FTS5 syntax is searched as text.

Indexed text, per message:

- user text, plus attachment names or URIs and descriptions; file contents are not indexed;
- shell commands, then the first 4,096 characters of their output;
- assistant text parts, plus tool-call names and input strings, including assistant parts stored as part rows;
- completed compaction summaries and synthetic notes, except repeated runtime notices.

Tool output, reasoning, and streaming assistant parts are not indexed. Each text source is cut to its first 65,536
characters. Each tool call or attachment is cut to 1,024 characters, and a message's calls and attachments together
to 16,384 characters.

## Readiness

The server keeps the index with one maintenance leader per database:

- It builds the index, backfills history in small batches after a quiet period, then drains a trigger-fed change
  queue.
- While the index does not exist yet, only titles match and `indexing` is `true`.
- Once it exists but the backfill or the queue is unfinished, content matches are possibly incomplete and `indexing`
  is `true`.
- Content matching for the list and for `matches` runs in a read-only worker thread on the same database file and
  index, one read at a time, so a common word or short prefix does not stall other requests. Cancelling a request
  terminates the worker. An in-memory database, or a server that cannot start the worker, reads on the server thread.
- SQLite without the needed FTS5 support reports the index as unsupported. Search then stays title-only and never
  reports `indexing`.

Clients ask the same query again while `indexing` is `true`, bounded, and say results may be incomplete when they stop
asking. Every client below trims the typed query before sending it. A trailing space therefore never reaches the
server from these clients, so they cannot select the server's complete-final-word mode: a query ending in a letter or
digit is always sent as a final-word prefix.

- **CLI** `opencode session list --search <words>`:
  - It lists root sessions in the project scope of the working directory, newest first.
  - It asks again every 2 s for up to 10 s, then prints.
  - If the index is still building, it writes a warning to stderr only, so JSON stdout stays the plain list.
  - A failure to connect, authenticate or list exits 1.
- **Shared by the GUI and TUI clients:**
  - They ask again after 1, 2, 4, 8, 15 and 15 s, then say results may be incomplete and offer a retry: "Try again"
    in the GUI, ctrl+g in the TUI.
  - A new query, scope change, close or disposal cancels the request and the pending refresh.
- **Home (web and Desktop):**
  - Local title matches show at once and keep their place, and server matches are appended by session ID.
  - Server rows show only while they answer the current query and scope.
  - A failed or empty server answer leaves the local rows.
  - Leaving the search, so that its results are hidden, also cancels; returning to the kept query asks again.
- **Command palette and titlebar session search:**
  - Rows from sessions this client already has narrow at once.
  - The server source's rows are added, deduplicated by entry, only when its settled answer is for the current query.
  - A superseded or aborted server search answers with no rows.
  - They ask with `match=true`; a content-only row's description is its excerpt, a title match keeps its project.
    The composer's session picker does not ask for excerpts.
- **TUI session list:**
  - The server's answer replaces the list instead of being appended to local rows.
  - While a request loads, the rows from the latest finished answer stay shown, and they may belong to the previous
    query. A finished answer is used only when it matches the current query and project scope.
  - On a failed answer the TUI shows its local title matches and an error note.
  - It asks with `match=true` and shows a content-only row's excerpt as a detail line under it.

## Why This Shape

- One index in the server serves every client (CLI, TUI, web, Desktop, a native client) through the endpoint they
  already page with. Clients change only to use server rows, merged or as the list depending on the client, and to repeat a query
  while `indexing` is set.
- Content matching needs database triggers, a schema migration and a background maintainer next to the session
  store, so it is a core change. A stock plugin cannot provide it: plugins cannot add list conditions inside the
  store's query or keep an index transactionally in step with session writes.

The index, migration, triggers, backfill and maintenance come from the open upstream PR #62769, which is not merged.
This contract adds content matching in the list, the readiness flag, literal prefix tokens, bounded audit text, the
off-thread reader, staged-revert hiding, bounded shell output, opt-in excerpts, and the client behavior above.
