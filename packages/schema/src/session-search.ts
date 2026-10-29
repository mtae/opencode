export * as SessionSearch from "./session-search.js"

import { Schema, Struct } from "effect"
import { ConfigSearch } from "./config/search.js"
import { Location } from "./location.js"
import { Project } from "./project.js"
import { Rpc } from "./rpc.js"
import { AbsolutePath, NonNegativeInt, optional, PositiveInt, RelativePath } from "./schema.js"
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

/** A Result as clients see it: the Session's location without its workspace. */
export const PublicResult = Schema.Struct({
  ...Struct.omit(Result.fields, ["session"]),
  session: Schema.Struct({ ...Struct.omit(Session.Info.fields, ["location"]), location: Location.PublicRef }),
}).annotate({ identifier: "SessionSearch.PublicResult" })
export type PublicResult = typeof PublicResult.Type

export const SearchInput = Schema.Struct({
  /** Words to find in Session titles and messages. Every word must match; the last also matches as a prefix. */
  query: Schema.String,
  /** Maximum number of Sessions to return. Defaults to 50. */
  limit: PositiveInt.pipe(optional),
  /** Only children of this Session, or only root Sessions with null. */
  parentID: Schema.NullOr(Session.ID).pipe(optional),
  archived: Schema.Boolean.pipe(optional),
  directory: AbsolutePath.pipe(optional),
  project: Project.ID.pipe(optional),
  subpath: RelativePath.pipe(optional),
}).annotate({ identifier: "SessionSearch.SearchInput" })
export type SearchInput = typeof SearchInput.Type

export const SearchResponse = Schema.Struct({
  data: Schema.Array(PublicResult),
  /** Sessions not yet indexed. Their messages are missing from these results. */
  pending: NonNegativeInt,
}).annotate({ identifier: "SessionSearch.SearchResponse" })
export type SearchResponse = typeof SearchResponse.Type

export const Settings = Schema.Struct({
  /** The `search` config's mode. With titles, `search` fails with `disabled` and list matches titles only. */
  mode: ConfigSearch.Mode,
}).annotate({ identifier: "SessionSearch.Settings" })
export type Settings = typeof Settings.Type

/**
 * The session-search plugin's RPC. `search` ranks Sessions by their best matching title or message. Searches run one at
 * a time, so one still waiting when a newer search arrives fails with `superseded` instead of running. With the
 * `search` config set to titles it fails with `disabled`, and clients fall back to list's title search. The output is
 * the encoded response, since Promise clients receive it as JSON. `settings` reports the config clients show.
 */
export const Definition = Rpc.define({
  id: "opencode.session-search",
  methods: {
    search: {
      input: Schema.toStandardSchemaV1(SearchInput),
      output: Schema.toStandardSchemaV1(Schema.toEncoded(SearchResponse)),
      errors: {
        superseded: Schema.toStandardSchemaV1(Schema.Undefined),
        disabled: Schema.toStandardSchemaV1(Schema.Undefined),
      },
    },
    settings: {
      input: Schema.toStandardSchemaV1(Schema.Undefined),
      output: Schema.toStandardSchemaV1(Settings),
    },
  },
  events: {},
})
