export * as SessionListSearch from "./list-search.js"

import type { Session } from "@opencode/schema/session"
import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { SessionStore } from "./store.js"

export interface Found {
  readonly ids: ReadonlyArray<Session.ID>
  /** Sessions the provider could not search yet, such as ones still being indexed. Their matches are missing from ids. */
  readonly pending?: number
}

/** Finds Sessions for list's `search` text beyond the title match, such as by their messages. Never fails. */
export type Provider = (filter: SessionStore.Filter, query: string) => Effect.Effect<Found>

export interface Interface {
  /**
   * Adds a provider until the Scope closes. A reloading plugin registers its new provider before the old Scope
   * closes, and every location registers its own, so the newest registration still held for an id wins. Releasing
   * it hands the id back to the one before, so a closed location never leaves its provider behind.
   */
  readonly register: (id: string, provider: Provider) => Effect.Effect<void, never, Scope.Scope>
  /**
   * The union of every provider's matches and the most Sessions any of them still has pending, or undefined when none
   * is registered, so list matches titles only.
   */
  readonly matches: (
    filter: SessionStore.Filter,
    query: string,
  ) => Effect.Effect<{ readonly ids: ReadonlyArray<Session.ID>; readonly pending: number } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionListSearch") {}

const layer = Layer.sync(Service, () => {
  // Registrations per id, oldest first. Each is its own object so a provider registered twice releases separately.
  const providers = new Map<string, Array<{ readonly provider: Provider }>>()

  const register = (id: string, provider: Provider) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const registration = { provider }
        providers.set(id, [...(providers.get(id) ?? []), registration])
        return registration
      }),
      (registration) =>
        Effect.sync(() => {
          const held = (providers.get(id) ?? []).filter((entry) => entry !== registration)
          if (held.length === 0) providers.delete(id)
          else providers.set(id, held)
        }),
    ).pipe(Effect.asVoid)

  const matches = Effect.fn("SessionListSearch.matches")(function* (filter: SessionStore.Filter, query: string) {
    if (providers.size === 0) return undefined
    const found = yield* Effect.forEach([...providers.values()], (held) => held.at(-1)!.provider(filter, query), {
      concurrency: "unbounded",
    })
    return {
      ids: [...new Set(found.flatMap((item) => item.ids))],
      pending: Math.max(0, ...found.map((item) => item.pending ?? 0)),
    }
  })

  return Service.of({ register, matches })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
