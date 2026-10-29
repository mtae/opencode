import { Schema } from "effect"

/**
 * - `titles`: the server may find sessions the list has not loaded, but only title matches are kept, as the local
 *   search does.
 * - `content`: sessions the server matches by message content are added too.
 */
export const Mode = Schema.Literals(["titles", "content"])

export type Mode = Schema.Schema.Type<typeof Mode>

export const Options = Schema.Struct({ enabled: Schema.Boolean, mode: Mode })

export const DEFAULTS: Schema.Schema.Type<typeof Options> = { enabled: true, mode: "content" }
