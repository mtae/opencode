export * as SessionListSearch from "./list-search.js"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { Session } from "@opencode/schema/session"
import type { SessionStore } from "./store.js"

/** Finds the Sessions that match `query` by more than their title, such as by their messages. */
export type Provider = (filter: SessionStore.Filter, query: string) => Effect.Effect<ReadonlyArray<Session.ID>>

export interface Interface {
  /**
   * Adds a provider for as long as the scope is open. A plugin activates once per location, so
   * registrations share an id: the provider stays until the last of them closes, and runs once per search.
   */
  readonly register: (id: string, provider: Provider) => Effect.Effect<void, never, Scope.Scope>
  /** The union of every provider's matches, or undefined without providers, when list matches titles only. */
  readonly matches: (
    filter: SessionStore.Filter,
    query: string,
  ) => Effect.Effect<ReadonlyArray<Session.ID> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionListSearch") {}

export const layer = Layer.sync(Service, () => {
  const providers = new Map<string, { provider: Provider; count: number }>()

  const register = (id: string, provider: Provider) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const entry = providers.get(id)
        if (entry) entry.count++
        else providers.set(id, { provider, count: 1 })
      }),
      () =>
        Effect.sync(() => {
          const entry = providers.get(id)
          if (!entry) return
          entry.count--
          if (entry.count === 0) providers.delete(id)
        }),
    )

  const matches = (filter: SessionStore.Filter, query: string) => {
    const active = [...providers.values()].map((entry) => entry.provider)
    if (active.length === 0) return Effect.succeed(undefined)
    return Effect.forEach(active, (provider) => provider(filter, query), { concurrency: "unbounded" }).pipe(
      Effect.map((found) => [...new Set(found.flat())]),
    )
  }

  return Service.of({ register, matches })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
