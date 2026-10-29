import { Plugin, Store } from "@opencode/plugin/gui"
import en from "./i18n/en"
import { DEFAULTS, Options } from "./options"

export default Plugin.define({
  stores: {
    // The user's choices for the Home session search; kept across reloads, restarts and updates.
    options: Store.global(Options, DEFAULTS),
  },
  i18n: { en },
})
