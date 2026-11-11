export * as SessionSearchText from "./search-text.js"

import type { SessionMessage } from "./message.js"

/** Characters indexed per text source. Longer text is nearly always a pasted log or file; its start is enough to find it. */
export const MaxText = 64 * 1024
/** Characters indexed per tool call (name, then its input strings) and per attachment (name or URI, description). */
export const MaxCall = 1024
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
 * - shell: the command the user ran, as user text. Its output is not indexed.
 * - assistant: text parts, then each non-streaming tool call's name and input strings ({@link MaxCall} each). Tool
 *   output and reasoning are not indexed.
 * - synthetic: its description and text, as a summary (subagent reports, plugin notes). Text of runtime notices
 *   (`metadata.notice`, such as reloaded instruction files) is skipped: it repeats across sessions.
 * - compaction: a completed summary.
 * System and skill messages are not indexed.
 */
export const fromMessage = (message: SessionMessage.Info): Fields | undefined => {
  if (message.type === "user") return fields({ user_text: [[message.text], (message.files ?? []).map(attachment)] })
  if (message.type === "shell") return fields({ user_text: [[message.command]] })
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

const fields = (input: { [K in keyof Fields]?: Sources }): Fields | undefined => {
  const result = {
    summary: join(input.summary),
    user_text: join(input.user_text),
    assistant_text: join(input.assistant_text),
  }
  if (result.summary === "" && result.user_text === "" && result.assistant_text === "") return undefined
  return result
}

const join = ([text, audit = []]: Sources = [[]]) =>
  expand(
    [
      nonblank(text).join("\n\n").slice(0, MaxText),
      nonblank(audit.map((line) => line.slice(0, MaxCall)))
        .join("\n")
        .slice(0, MaxAudit),
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  )

const nonblank = (texts: ReadonlyArray<string>) => texts.filter((text) => text.trim() !== "")
