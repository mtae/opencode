import { RendererControlState, type CliRenderer, type ThemeMode } from "@opentui/core"

type TitleRenderer = Pick<CliRenderer, "isDestroyed" | "controlState" | "setTerminalTitle">

// OpenTUI rejects terminal control from suspend() until resume() completes, e.g. while $EDITOR runs.
export function setTerminalTitle(renderer: TitleRenderer, title: string) {
  if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
  renderer.setTerminalTitle(title)
}

export function destroyRenderer(renderer: TitleRenderer & Pick<CliRenderer, "destroy">) {
  if (renderer.isDestroyed) return
  setTerminalTitle(renderer, "")
  renderer.destroy()
}

type ThemeModeRenderer = Pick<
  CliRenderer,
  "themeMode" | "waitForThemeMode" | "prependInputHandler" | "removeInputHandler" | "idle"
>

const PRIMARY_DEVICE_ATTRIBUTES = /^\x1b\[\?[\d;]*c$/

// OpenTUI settles the mode only on OSC 10/11 replies, so a terminal that never answers them, such as ConPTY
// on Windows 10, would wait out the whole timeout. Terminals answer queries in order, so a reply to the
// primary device attributes query sent after the OSC queries means no theme mode is coming.
export function waitForThemeMode(renderer: ThemeModeRenderer, timeoutMs: number, write: (data: string) => void) {
  if (renderer.themeMode !== null) return Promise.resolve(renderer.themeMode)
  return new Promise<ThemeMode | null>((resolve) => {
    const settle = () => resolve(renderer.themeMode)
    // Stays until the reply arrives, even after a timeout, so a late reply is never read as typed keys.
    const sentinel = (sequence: string) => {
      if (!PRIMARY_DEVICE_ATTRIBUTES.test(sequence)) return false
      renderer.removeInputHandler(sentinel)
      settle()
      return true
    }
    renderer.prependInputHandler(sentinel)
    void renderer.waitForThemeMode(timeoutMs).then(settle)
    // The query goes around OpenTUI's output queue, so wait for the startup OSC queries to reach the terminal first.
    void renderer.idle().then(
      () => write("\x1b[c"),
      () => {},
    )
  })
}
