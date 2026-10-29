type Row = { session: { id: string } }

/**
 * Orders the Home search rows: the sessions already listed (with an exact ID match put first when the listing lacks
 * it), then server matches the list did not have. The local rows keep their order, so a row the user is on never moves
 * when the server's matches arrive.
 */
export function mergeSearchRows<T extends Row>(input: { local: T[]; exact: T | undefined; remote: T[] }): T[] {
  const exact = input.exact

  const local =
    !exact || input.local.some((row) => row.session.id === exact.session.id) ? input.local : [exact, ...input.local]

  const known = new Set(local.map((row) => row.session.id))

  return [...local, ...input.remote.filter((row) => !known.has(row.session.id))]
}
