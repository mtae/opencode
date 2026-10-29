export * as ConfigSearch from "./search.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Mode = Schema.Literals(["titles", "content"]).annotate({
  description: "titles matches Session titles only. content also matches message text (default).",
})
export type Mode = typeof Mode.Type

export class Info extends Schema.Class<Info>("ConfigSearch.Info")({
  mode: Mode.pipe(optional),
}) {}

/** false is the same as mode titles. */
export const Selection = Schema.Union([Schema.Literal(false), Info])
export type Selection = typeof Selection.Type

export const DefaultMode: Mode = "content"

export function mode(selection: Selection | undefined): Mode {
  if (selection === false) return "titles"
  return selection?.mode ?? DefaultMode
}
