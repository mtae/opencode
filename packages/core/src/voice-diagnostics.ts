const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined

/** Retain provider protocol identifiers, never upstream prose or credential-bearing bodies. */
export function voiceRejection(body?: string) {
  let data: Record<string, unknown> | undefined
  try { data = record(JSON.parse(body ?? "")) } catch {}
  const error = record(data?.error)
  return { bodyFormat: data ? "json" : body?.trim().startsWith("<") ? "markup" : "other", errorCode: identifier(error?.code ?? data?.code), errorType: identifier(error?.type ?? data?.type), errorParameter: identifier(error?.param ?? data?.param) }
}

/** WebSocket libraries put upgrade failures in ErrorEvent prose; extract only fixed status/network codes. */
export function controlFailure(event: unknown) {
  const data = record(event)
  const error = record(data?.error)
  const messages = [data?.message, error?.message].filter((value): value is string => typeof value === "string").join(" ")
  const status = /(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|server\s+response)\s*[:=]?\s*(?:was\s+)?([45]\d\d)\b/i.exec(messages)?.[1]
  const networkCode = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EPROTO|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/.exec(messages)?.[1]
  return { httpStatus: status ? Number(status) : undefined, networkCode }
}
