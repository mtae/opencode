/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import { DialogSessionList } from "../../../src/component/dialog-session-list"
import { ConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider, useStorage } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("scopes sessions to the active session location", async () => {
  const active = "/tmp/opencode/project-b"
  const events = createEventStream()
  const requestedProjects: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      const project = directory === active ? "proj_b" : "proj_a"
      return json({ directory, project: { id: project, directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    // Family syncs list children by parentID; only project-scoped list requests matter here.
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    const project = url.searchParams.get("project") ?? ""
    requestedProjects.push(project)
    return json({
      data: [
        {
          id: project === "proj_b" ? "ses_b" : "ses_a",
          projectID: project,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: project === "proj_b" ? "Project B session" : "Project A session",
          location: { directory: project === "proj_b" ? active : process.cwd() },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "proj_b",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await mount(temporary.path, calls.fetch, Probe)
  app.renderer.start()

  try {
    const frame = await app.waitForFrame((value) => value.includes("Project B session"))
    expect(frame).not.toContain("Project A session")
    expect(requestedProjects.at(-1)).toBe("proj_b")
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})

function mount(state: string, fetch: ReturnType<typeof createFetch>["fetch"], Probe: () => JSX.Element) {
  return testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(fetch)}>
                        <PermissionProvider>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
}

const session = (id: string, title: string) => ({
  id,
  projectID: "proj_a",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title,
  location: { directory: process.cwd() },
})

/**
 * Serves the dialog's searches with `answer(search, nth)`, where nth counts requests for that search. Other session
 * lists answer empty.
 */
async function searchFixture(answer: (search: string, nth: number) => { data: unknown[]; indexing?: boolean }) {
  const searches: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "proj_a", directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    const search = url.searchParams.get("search")
    if (!search) return json({ data: [], cursor: {} })
    searches.push(search)
    const result = answer(search, searches.filter((item) => item === search).length)
    return json({ data: result.data, cursor: {}, ...(result.indexing ? { experimental: { indexing: true } } : {}) })
  }, createEventStream())
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const dialog = useDialog()
    storage = useStorage()
    onMount(() => dialog.replace(() => <DialogSessionList indexingRetryMs={[20, 20, 20]} />))
    return null
  }

  const app = await mount(temporary.path, calls.fetch, Probe)
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
  return {
    app,
    searches,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await storage.flush()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

/** Polls `check` every 10ms for up to 2s; frames alone do not wait for requests or timers. */
async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(10)
  }
}

test("asks an unchanged search again while the index builds, and stops once it is complete", async () => {
  await using fixture = await searchFixture((_, nth) =>
    nth < 3 ? { data: [], indexing: true } : { data: [session("ses_body", "Only the body matched")] },
  )
  await fixture.app.mockInput.typeText("quokka")

  await until(() => fixture.app.captureCharFrame().includes("Only the body matched"))
  expect(fixture.searches).toEqual(["quokka", "quokka", "quokka"])
  expect(fixture.app.captureCharFrame()).not.toContain("results may be incomplete")
  await Bun.sleep(150)
  expect(fixture.searches).toHaveLength(3)
})

test("ends the refresh budget with an incomplete note and searches again on request", async () => {
  await using fixture = await searchFixture(() => ({ data: [session("ses_title", "Quokka title")], indexing: true }))
  await fixture.app.mockInput.typeText("quokka")

  await until(() => fixture.app.captureCharFrame().includes("ctrl+g searches again"))
  // The first answer and one per delay, then nothing until asked.
  expect(fixture.searches).toHaveLength(4)
  expect(fixture.app.captureCharFrame()).toContain("Quokka title")
  await Bun.sleep(150)
  expect(fixture.searches).toHaveLength(4)

  fixture.app.mockInput.pressKey("g", { ctrl: true })
  await until(() => fixture.searches.length === 8)
  expect(fixture.app.captureCharFrame()).toContain("Quokka title")
})

test("a new search drops the refresh of the old one", async () => {
  await using fixture = await searchFixture((search) =>
    search === "quok" ? { data: [], indexing: true } : { data: [session("ses_new", "Quokkas all the way")] },
  )
  await fixture.app.mockInput.typeText("quok")
  await until(() => fixture.searches.length >= 2)
  await fixture.app.mockInput.typeText("kas")

  await until(() => fixture.app.captureCharFrame().includes("Quokkas all the way"))
  const settled = fixture.searches.length
  await Bun.sleep(150)
  expect(fixture.searches).toHaveLength(settled)
  expect(fixture.searches.at(-1)).toBe("quokkas")
  expect(fixture.app.captureCharFrame()).not.toContain("results may be incomplete")
})
