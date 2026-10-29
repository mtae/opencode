import { Schema } from "effect"

export const Options = Schema.Struct({ enabled: Schema.Boolean })

export const DEFAULTS: Schema.Schema.Type<typeof Options> = { enabled: true }
