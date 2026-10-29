import { expect, test } from "bun:test"
import { RendererControlState } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { destroyRenderer, setTerminalTitle, waitForThemeMode } from "../../src/util/renderer"

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    controlState: RendererControlState.IDLE,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("skips the title from suspend until resume completes and destroys a suspended renderer", async () => {
  await using setup = await createTestRenderer({ width: 10, height: 2 })
  await setup.renderer.setupTerminal()
  const suspending = setup.renderer.suspend()
  setTerminalTitle(setup.renderer, "suspending")
  await suspending
  const resuming = setup.renderer.resume()
  setTerminalTitle(setup.renderer, "resuming")
  await resuming
  await setup.renderer.suspend()
  destroyRenderer(setup.renderer)
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(() => destroyRenderer(setup.renderer)).not.toThrow()
  await setup.renderer.closed
  expect(() => destroyRenderer(setup.renderer)).not.toThrow()
})

function themeRenderer(mode: "dark" | "light" | null = null) {
  const handlers: ((sequence: string) => boolean)[] = []
  const detected = Promise.withResolvers<"dark" | "light" | null>()
  return {
    renderer: {
      themeMode: mode,
      waitForThemeMode: () => detected.promise,
      prependInputHandler: (handler: (sequence: string) => boolean) => handlers.unshift(handler),
      removeInputHandler: (handler: (sequence: string) => boolean) =>
        handlers.splice(handlers.indexOf(handler) >>> 0, 1),
      idle: () => Promise.resolve(),
    },
    handlers,
    input: (sequence: string) => handlers.some((handler) => handler(sequence)),
    detect(value: "dark" | "light" | null) {
      this.renderer.themeMode = value
      detected.resolve(value)
    },
  }
}

test("settles without a theme mode once the terminal answers device attributes", async () => {
  const fake = themeRenderer()
  const written: string[] = []
  const mode = waitForThemeMode(fake.renderer, 1000, (data) => written.push(data))
  await Promise.resolve()
  expect(written).toEqual(["\x1b[c"])
  expect(fake.input("\x1b[?1;0c")).toBe(true)
  expect(await mode).toBeNull()
  expect(fake.handlers).toHaveLength(0)
})

test("returns the theme mode reported before device attributes", async () => {
  const fake = themeRenderer()
  const mode = waitForThemeMode(fake.renderer, 1000, () => {})
  fake.detect("light")
  fake.input("\x1b[?62;22c")
  expect(await mode).toBe("light")
  expect(fake.handlers).toHaveLength(0)
})

test("swallows a device attributes reply that arrives after the timeout", async () => {
  const fake = themeRenderer()
  const mode = waitForThemeMode(fake.renderer, 1000, () => {})
  fake.detect(null)
  expect(await mode).toBeNull()
  expect(fake.input("a")).toBe(false)
  expect(fake.input("[?1;0c")).toBe(true)
  expect(fake.handlers).toHaveLength(0)
})

test("does not query when the theme mode is already known", async () => {
  const written: string[] = []
  expect(await waitForThemeMode(themeRenderer("dark").renderer, 1000, (data) => written.push(data))).toBe("dark")
  expect(written).toEqual([])
})
