import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("searches session titles through the experimental endpoint", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, init?: RequestInit) =>
      Effect.promise(async () => {
        const response = await handler(new Request(`http://opencode.local${path}`, init))
        expect(response.status).toBe(200)
        return response.json()
      })
    const created = yield* request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Quarterly zebra review" }),
    })
    yield* request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Unrelated" }),
    })

    expect(yield* request("/api/experimental/session/search?query=zebr&parentID=null")).toMatchObject({
      data: [
        {
          session: { id: created.data.id, title: "Quarterly zebra review" },
          hits: 1,
          match: {
            source: "title",
            snippet: [
              { text: "Quarterly ", highlight: false },
              { text: "zebra", highlight: true },
              { text: " review", highlight: false },
            ],
          },
        },
      ],
      pending: 0,
    })
  }).pipe(Effect.scoped),
)
