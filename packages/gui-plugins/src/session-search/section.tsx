import { type JSX } from "solid-js"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { usePlugin } from "@opencode/plugin/gui"
import type definition from "./index"
import type { Mode } from "./options"

const MODES: readonly Mode[] = ["titles", "content"]

export default function SessionSearchSection() {
  const ctx = usePlugin<typeof definition>()
  const options = ctx.stores.options

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

        <Row title={ctx.t("mode.title")} description={ctx.t("mode.description")}>
          <Select
            data-action="settings-session-search-mode"
            options={[...MODES]}
            current={options.value.mode}
            value={(mode) => mode}
            label={(mode) => ctx.t(`mode.${mode}`)}
            onSelect={(mode) =>
              mode &&
              options.update((draft) => {
                draft.mode = mode
              })
            }
            placement="bottom-end"
            gutter={6}
          />
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
