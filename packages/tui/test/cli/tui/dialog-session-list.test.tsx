/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
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

  const app = await renderDialog(createApi(calls.fetch), temporary.path, Probe)
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

function renderDialog(api: ReturnType<typeof createApi>, state: string, Probe: () => null) {
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
                      <ClientProvider api={api}>
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

const sessionInfo = (id: string, title: string, directory: string) => ({
  id,
  projectID: "proj_a",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title,
  location: { directory },
})

test("searches session content and shows the matching snippet", async () => {
  const events = createEventStream()
  const searches: URLSearchParams[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "proj_a", directory, canonical: directory } })
    }
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname !== "/api/experimental/session/search") return undefined
    searches.push(url.searchParams)
    return json({
      data: [
        {
          session: sessionInfo("ses_hit", "Refactor auth", process.cwd()),
          hits: 2,
          match: {
            messageID: "msg_hit",
            source: "assistant",
            snippet: [
              { text: "rotate the ", highlight: false },
              { text: "frobnicator", highlight: true },
              { text: " keys weekly", highlight: false },
            ],
          },
        },
      ],
      pending: 0,
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const dialog = useDialog()
    storage = useStorage()
    onMount(() => dialog.replace(() => <DialogSessionList />))
    return null
  }

  const app = await renderDialog(createApi(calls.fetch), temporary.path, Probe)
  app.renderer.start()

  try {
    await app.waitForFrame(
      (frame) => frame.includes("Sessions") && app.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    await app.mockInput.typeText("frob")
    const frame = await app.waitForFrame((value) => value.includes("rotate the frobnicator keys weekly"))
    expect(frame).toContain("Refactor auth")
    expect(searches.at(-1)?.get("query")).toBe("frob")
    expect(searches.at(-1)?.get("parentID")).toBe("null")
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})

test("aborts a search the next keystroke supersedes", async () => {
  const events = createEventStream()
  const aborted: string[] = []
  const started = Promise.withResolvers<void>()
  const calls = createFetch((url, request) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "proj_a", directory, canonical: directory } })
    }
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname !== "/api/experimental/session/search") return undefined
    const query = url.searchParams.get("query") ?? ""
    if (query === "frob")
      return json({ data: [{ session: sessionInfo("ses_hit", "Refactor auth", process.cwd()), hits: 1 }], pending: 0 })
    started.resolve()
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () => {
        aborted.push(query)
        reject(request.signal.reason)
      }),
    )
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const dialog = useDialog()
    storage = useStorage()
    onMount(() => dialog.replace(() => <DialogSessionList />))
    return null
  }

  const app = await renderDialog(createApi(calls.fetch), temporary.path, Probe)
  app.renderer.start()

  try {
    await app.waitForFrame(
      (frame) => frame.includes("Sessions") && app.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    await app.mockInput.typeText("fro")
    await started.promise
    await app.mockInput.typeText("b")
    await app.waitForFrame((frame) => frame.includes("Refactor auth"))
    expect(aborted).toEqual(["fro"])
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})
