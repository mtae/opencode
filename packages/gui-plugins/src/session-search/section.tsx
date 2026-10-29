import { createStore } from "solid-js/store"
import { Show, type JSX } from "solid-js"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { showToast } from "@opencode/ui/toast"
import { createLatest, usePlugin } from "@opencode/plugin/gui"
import { ConfigSearch } from "@opencode/schema/config/search"
import { SessionSearch } from "@opencode/schema/session-search"
import type definition from "./index"

const MODES: readonly ConfigSearch.Mode[] = ["titles", "content"]

export default function SessionSearchSection() {
  const ctx = usePlugin<typeof definition>()
  const options = ctx.stores.options

  // The mode is the server's, shared by every client of it, so it lives in that server's global config. That is the
  // desktop's own server, or on the web the one server the page talks to.
  const server = () => {
    const refs = ctx.servers.list().map((id) => ctx.servers.get(id))
    const found = refs.find((item) => item?.builtin) ?? (refs.length === 1 ? refs[0] : undefined)

    return found?.connected ? found : undefined
  }

  const settings = createLatest(server, (ref, signal) =>
    ref.client.rpc(SessionSearch.Definition).settings(undefined, { signal }),
  )

  // The mode just written, shown until the server's own answer catches up.
  const [written, setWritten] = createStore<{ mode?: ConfigSearch.Mode }>({})
  const mode = () => written.mode ?? settings.latest?.mode

  const select = (next: ConfigSearch.Mode) => {
    const ref = server()

    if (!ref || next === mode()) return
    void ref.client.experimental.config.update({ search: { mode: next } }).then(
      () => setWritten("mode", next),
      (error: Error) => showToast({ variant: "error", title: ctx.t("mode.title"), description: error.message }),
    )
  }

  return (
    <div class="settings-section">
      <h3 class="settings-section-title">{ctx.t("section.title")}</h3>

      <div data-component="settings-list">
        <Row title={ctx.t("enabled.title")} description={ctx.t("enabled.description")}>
          <div data-action="settings-session-search-enabled">
            <Switch
              checked={options.value.enabled}
              onChange={(checked) =>
                options.update((draft) => {
                  draft.enabled = checked
                })
              }
            />
          </div>
        </Row>

        <Row title={ctx.t("mode.title")} description={mode() ? ctx.t("mode.description") : ctx.t("mode.unavailable")}>
          <Show when={mode()}>
            {(current) => (
              <Select
                data-action="settings-session-search-mode"
                options={[...MODES]}
                current={current()}
                value={(item) => item}
                label={(item) => ctx.t(`mode.${item}`)}
                onSelect={(item) => item && select(item)}
                placement="bottom-end"
                gutter={6}
              />
            )}
          </Show>
        </Row>
      </div>
    </div>
  )
}

// The host's settings row markup; its stylesheet is loaded with the settings screen.
function Row(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <div data-component="settings-row">
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">{props.title}</div>
        <div data-slot="settings-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-row-control">{props.children}</div>
    </div>
  )
}
