export * as SessionSearchText from "./search-text.js"

import type { SessionMessage } from "./message.js"

/** Characters indexed per text source. Longer text is nearly always a pasted log or file; its start is enough to find it. */
export const MaxText = 64 * 1024
/** Characters indexed per tool call (name, then its input strings) and per attachment (name or URI, description). */
export const MaxCall = 1024
/**
 * Characters of a shell command's output indexed: its start holds the error or result a user remembers, while a long
 * log would crowd the index. Tool output is not indexed.
 */
export const MaxShellOutput = 4 * 1024
/**
 * Characters of tool calls or attachments indexed per message, after its text and within its own budget, so they never
 * crowd the message's own text out of {@link MaxText}.
 */
export const MaxAudit = 16 * 1024

export interface Fields {
  readonly summary: string
  readonly user_text: string
  readonly assistant_text: string
}

/**
 * The searchable text of a message, or undefined when there is nothing to index. Each column is cut to {@link MaxText}
 * characters of text plus {@link MaxAudit} characters of call or attachment lines, before camelCase expansion.
 * - user: its text, then each attachment's name (or URI) and description. File contents are not indexed.
 * - shell: the command the user ran, as user text, then the first {@link MaxShellOutput} characters of its output.
 * - assistant: text parts, then each non-streaming tool call's name and input strings ({@link MaxCall} each). Tool
 *   output and reasoning are not indexed.
 * - synthetic: its description and text, as a summary (subagent reports, plugin notes). Text of runtime notices
 *   (`metadata.notice`, such as reloaded instruction files) is skipped: it repeats across sessions.
 * - compaction: a completed summary.
 * System and skill messages are not indexed.
 */
export const fromMessage = (message: SessionMessage.Info) => extract(message, true)

/** {@link fromMessage} without the appended camelCase subwords: the text as written, for excerpts. */
export const readable = (message: SessionMessage.Info) => extract(message, false)

const extract = (message: SessionMessage.Info, expanded: boolean): Fields | undefined => {
  const fields = (input: { [K in keyof Fields]?: Sources }) => columns(input, expanded)
  if (message.type === "user") return fields({ user_text: [[message.text], (message.files ?? []).map(attachment)] })
  if (message.type === "shell")
    // Output is text after the command, not an audit line: audit lines are cut to MaxCall.
    return fields({ user_text: [[message.command, message.output?.output.slice(0, MaxShellOutput) ?? ""]] })
  if (message.type === "assistant")
    return fields({
      assistant_text: [
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        message.content.flatMap((part) =>
          part.type === "tool" && part.state.status !== "streaming"
            ? [[part.name, ...strings(part.state.input)].join(" ")]
            : [],
        ),
      ],
    })
  if (message.type === "synthetic")
    return fields({
      summary: [[message.description ?? "", message.metadata?.notice === undefined ? message.text : ""]],
    })
  if (message.type === "compaction" && message.status === "completed") return fields({ summary: [[message.summary]] })
  return undefined
}

/**
 * Appends the subwords of camelCase identifiers on a final line, so `decodeMessageRow` also matches `message` while
 * phrases stay adjacent. Acronyms stay whole (`XML Http Request`) and digits stay with letters (`base64 Encode`).
 */
export const expand = (text: string) => {
  const subwords = Array.from(text.matchAll(WORD)).flatMap((match) => {
    const parts = match[0].split(BOUNDARY)
    return parts.length > 1 ? parts : []
  })
  return subwords.length === 0 ? text : `${text}\n${subwords.join(" ")}`
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu
const BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})|(?<=[\p{Lu}\p{N}])(?=\p{Lu}\p{Ll})/u

const attachment = (file: NonNullable<SessionMessage.User["files"]>[number]) =>
  [file.name ?? (file.source.type === "uri" ? file.source.uri : ""), file.description ?? ""].join(" ").trim()

/** String values of a tool input, in order; keys, numbers and booleans are left out. */
const strings = (value: unknown): string[] => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings)
  return []
}

/** Per column: text sources, then call or attachment lines. */
type Sources = readonly [text: ReadonlyArray<string>, audit?: ReadonlyArray<string>]

const columns = (input: { [K in keyof Fields]?: Sources }, expanded: boolean): Fields | undefined => {
  const join = (sources?: Sources) => (expanded ? expand(bounded(sources)) : bounded(sources))
  const result = {
    summary: join(input.summary),
    user_text: join(input.user_text),
    assistant_text: join(input.assistant_text),
  }
  if (result.summary === "" && result.user_text === "" && result.assistant_text === "") return undefined
  return result
}

const bounded = ([text, audit = []]: Sources = [[]]) =>
  [
    nonblank(text).join("\n\n").slice(0, MaxText),
    nonblank(audit.map((line) => line.slice(0, MaxCall)))
      .join("\n")
      .slice(0, MaxAudit),
  ]
    .filter((part) => part !== "")
    .join("\n\n")

const nonblank = (texts: ReadonlyArray<string>) => texts.filter((text) => text.trim() !== "")

/** Characters a match excerpt has at most, its leading and trailing `…` included. */
export const SnippetWidth = 160
// Words looked at to place an excerpt; matches past them are not needed to pick a window.
const MaxSnippetHits = 200

/**
 * A plain-text excerpt around the words of `query`, from the first of `texts` holding one (the first text otherwise):
 * at most `width` characters, `…` where it was cut, whitespace collapsed. It shows the window with the most distinct
 * query words as the index matches them: case- and diacritic-folded, camelCase subwords included, the last word a
 * prefix while it is being typed. The result is text, never markup.
 */
export const snippet = (texts: ReadonlyArray<string>, query: string, width = SnippetWidth) => {
  const terms = [...new Set(Array.from(fold(query).matchAll(WORD), (match) => match[0]))]
  const prefix = /[\p{L}\p{M}\p{N}]$/u.test(query)
  const found = texts.filter((text) => text.trim() !== "").map((text) => ({ text, hits: hits(text, terms, prefix) }))
  const best = found.find((item) => item.hits.length > 0) ?? found[0]
  return best ? excerpt(best.text, best.hits, width) : ""
}

type Hit = { start: number; end: number; term: number }

const hits = (text: string, terms: ReadonlyArray<string>, prefix: boolean) => {
  const last = terms.length - 1
  const matches = (word: string, term: number) =>
    word === terms[term] || (prefix && term === last && word.startsWith(terms[term]))
  const found: Hit[] = []
  for (const match of text.matchAll(WORD)) {
    if (found.length >= MaxSnippetHits) break
    const words = [match[0], ...match[0].split(BOUNDARY)].map(fold)
    const term = terms.findIndex((_, index) => words.some((word) => matches(word, index)))
    if (term !== -1) found.push({ start: match.index, end: match.index + match[0].length, term })
  }
  return found
}

const excerpt = (text: string, hits: ReadonlyArray<Hit>, width: number) => {
  const room = width - 2
  const best = hits.reduce<{ start: number; end: number; distinct: number } | undefined>((best, hit, index) => {
    const inside = hits.slice(index).filter((other) => other.end - hit.start <= room)
    const distinct = new Set(inside.map((other) => other.term)).size
    if (best && best.distinct >= distinct) return best
    return { start: hit.start, end: (inside.at(-1) ?? hit).end, distinct }
  }, undefined)
  // Lead with some context, a third of what the matched span leaves, then cut at word boundaries.
  const lead = best ? Math.max(0, Math.floor((room - (best.end - best.start)) / 3)) : 0
  // Near the end of the text, the window takes what precedes the match instead of running short.
  const start = boundary(text, best ? Math.max(0, Math.min(best.start - lead, text.length - room)) : 0, -1)
  const end = boundary(text, Math.min(text.length, start + room), 1)
  const body = text.slice(start, end).replace(/\s+/gu, " ").trim()
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

// Moves an offset that would split a word, staying inside the window: a start forward past that word (-1), an end
// back before it (1), when it is shorter than 24 characters.
const boundary = (text: string, offset: number, direction: -1 | 1) => {
  if (offset <= 0 || offset >= text.length || !LETTER.test(text[offset - 1]) || !LETTER.test(text[offset]))
    return offset
  if (direction === -1) {
    const rest = text.slice(offset, offset + 24).search(NON_LETTER)
    return rest === -1 ? offset : offset + rest
  }
  const before = text.slice(Math.max(0, offset - 24), offset)
  const start = before.search(/[^\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}]*$/u)
  return start === -1 ? offset : offset - before.length + start + 1
}

const LETTER = /[\p{L}\p{M}\p{N}]/u
const NON_LETTER = /[^\p{L}\p{M}\p{N}]/u
