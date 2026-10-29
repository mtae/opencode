export * as SessionListSearch from "./list-search.js"

import type { Session } from "@opencode/schema/session"
import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { SessionStore } from "./store.js"

/** Finds Sessions for list's `search` text beyond the title match, such as by their messages. Never fails. */
export type Provider = (filter: SessionStore.Filter, query: string) => Effect.Effect<ReadonlyArray<Session.ID>>

export interface Interface {
  /**
   * Adds a provider until the Scope closes. A reloading plugin registers its new provider before the old Scope
   * closes, so the newest registration for an id wins and the id stays until every registration is released.
   */
  readonly register: (id: string, provider: Provider) => Effect.Effect<void, never, Scope.Scope>
  /** The union of every provider's matches, or undefined when none is registered, so list matches titles only. */
  readonly matches: (filter: SessionStore.Filter, query: string) => Effect.Effect<ReadonlyArray<Session.ID> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionListSearch") {}

const layer = Layer.sync(Service, () => {
  const providers = new Map<string, { provider: Provider; count: number }>()

  const register = (id: string, provider: Provider) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        providers.set(id, { provider, count: (providers.get(id)?.count ?? 0) + 1 })
      }),
      () =>
        Effect.sync(() => {
          const entry = providers.get(id)
          if (!entry) return
          if (entry.count <= 1) providers.delete(id)
          else providers.set(id, { ...entry, count: entry.count - 1 })
        }),
    )

  const matches = Effect.fn("SessionListSearch.matches")(function* (filter: SessionStore.Filter, query: string) {
    if (providers.size === 0) return undefined
    const found = yield* Effect.forEach([...providers.values()], (entry) => entry.provider(filter, query), {
      concurrency: "unbounded",
    })
    return [...new Set(found.flat())]
  })

  return Service.of({ register, matches })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
