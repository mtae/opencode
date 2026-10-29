import type { SessionSearchInput } from "@opencode/plugin/gui"

// Past this many matches the Home list stops being a search; the title and project filter has no such cap.
const LIMIT = 50

/**
 * The server's matches for the query. Home drops matches outside the project the user scoped the search to, so those
 * directories are asked for one by one, and each request's limit cuts only matches Home would show.
 */
export async function listMatches(input: SessionSearchInput) {
  const found = await Promise.all(
    (input.directories ?? [undefined]).map((directory) =>
      input.client.session.list(
        { ...(directory ? { directory } : {}), parentID: null, search: input.query, archived: false, limit: LIMIT },
        { signal: input.signal },
      ),
    ),
  )

  return [...new Map(found.flatMap((result) => result.data).map((session) => [session.id, session])).values()]
    .toSorted((a, b) => +b.time.updated - +a.time.updated)
    .slice(0, LIMIT)
}
