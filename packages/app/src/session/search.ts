/**
 * Delays before a client asks the same session search again while the server answers it with
 * `experimental.indexing`, about 45 seconds in all. Then the client says results may be incomplete and offers a retry.
 */
export const SESSION_SEARCH_INDEXING_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]

export function looksLikeSessionID(value: string) {
  return value.length > 20 && value.startsWith("ses_")
}
