import { OpenCode, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option, Stream } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"

const handler = Effect.fn("cli.session.list")(function* (
  input: Runtime.Input<typeof Commands.commands.session.commands.list>,
) {
  const server = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  const location = yield* Effect.tryPromise({
    try: (signal) => client.location.get({ location: { directory: process.cwd() } }, { signal }),
    catch: (cause) => cause,
  })
  const search = Option.getOrUndefined(input.search)?.trim()
  const list = Effect.tryPromise({
    try: (signal) =>
      client.session.list(
        {
          project: location.project.id,
          parentID: null,
          order: "desc",
          limit: Option.getOrElse(input.maxCount, () => 100),
          ...(search ? { search } : {}),
        },
        { signal },
      ),
    catch: (cause) => cause,
  })
  // While the server is still indexing, the same search may find more sessions. Ask again for a short, bounded time,
  // then print what there is and say on stderr that it may be incomplete, so stdout stays the plain list.
  let page = yield* list
  let waited = 0
  while (page.experimental?.indexing && waited < SearchIndexingWaitMs) {
    yield* Effect.sleep(SearchIndexingRetryMs)
    waited += SearchIndexingRetryMs
    page = yield* list
  }
  if (page.experimental?.indexing)
    process.stderr.write(
      `Warning: the session search index is still being built, so results may be incomplete (waited ${waited / 1000}s). Run the search again later.` +
        EOL,
    )
  if (input.format === "table" && page.data.length === 0) return
  const output =
    (input.format === "json"
      ? JSON.stringify(
          page.data.map((session) => ({
            id: session.id,
            title: session.title,
            updated: session.time.updated,
            created: session.time.created,
            projectId: session.projectID,
            directory: session.location.directory,
          })),
          null,
          2,
        )
      : formatList(page.data)) + EOL
  const write = Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(output, (error) => (error ? reject(error) : resolve()))
      }),
  )
  if (!process.stdout.isTTY || Option.isSome(input.maxCount) || input.format === "json") {
    yield* write
    return
  }

  const { AppProcess } = yield* Effect.promise(() => import("@opencode/util/process"))
  const { LayerNode } = yield* Effect.promise(() => import("@opencode/util/effect/layer-node"))
  const { ChildProcess } = yield* Effect.promise(() => import("effect/process"))
  yield* Effect.gen(function* () {
    const processService = yield* AppProcess.Service
    const pager = yield* processService
      .spawn(
        ChildProcess.make(
          process.platform === "win32" ? "cmd" : "less",
          process.platform === "win32" ? ["/c", "more"] : ["-R", "-S"],
          {
            stdin: Stream.make(new TextEncoder().encode(output)),
            stdout: "inherit",
            stderr: "inherit",
          },
        ),
      )
      .pipe(Effect.option)
    if (Option.isNone(pager)) {
      yield* write
      return
    }
    yield* pager.value.exitCode
  }).pipe(Effect.provide(LayerNode.compile(AppProcess.node)))
})

export default Runtime.handler(Commands.commands.session.commands.list, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

/** How long `--search` keeps asking an indexing server, every {@link SearchIndexingRetryMs}, before printing. */
const SearchIndexingWaitMs = 10_000
const SearchIndexingRetryMs = 2_000

function formatList(sessions: ReadonlyArray<SessionInfo>) {
  return sessions
    .map((session) =>
      [
        session.id,
        (session.title ?? "Untitled session").replace(/[\r\n\t]/g, " "),
        new Date(session.time.updated).toLocaleString(),
      ].join("\t"),
    )
    .join(EOL)
}
