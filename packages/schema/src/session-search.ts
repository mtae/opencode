export * as SessionSearch from "./session-search.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { Session } from "./session.js"
import { SessionMessage } from "./session-message.js"

/** Where a match was found. Attachment text (OCR or a model description) is a planned future source. */
export const Source = Schema.Literals(["title", "user", "assistant", "synthetic", "shell", "tool"]).annotate({
  identifier: "SessionSearch.Source",
})
export type Source = typeof Source.Type

export const Fragment = Schema.Struct({
  text: Schema.String,
  highlight: Schema.Boolean,
}).annotate({ identifier: "SessionSearch.Fragment" })
export type Fragment = typeof Fragment.Type

export const Match = Schema.Struct({
  messageID: SessionMessage.ID.pipe(optional),
  source: Source,
  /** A short excerpt of the best matching text; highlighted fragments are the matched terms. */
  snippet: Schema.Array(Fragment),
}).annotate({ identifier: "SessionSearch.Match" })
export type Match = typeof Match.Type

export const Result = Schema.Struct({
  session: Session.Info,
  /** Number of matching title and message documents in the Session. */
  hits: NonNegativeInt,
  match: Match.pipe(optional),
}).annotate({ identifier: "SessionSearch.Result" })
export type Result = typeof Result.Type
