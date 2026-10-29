import { describe, expect, test } from "bun:test"
import type { SessionSearchInput } from "@opencode/plugin/gui"
import { listMatches } from "./matches"

type Row = { id: string; time: { updated: Date } }

const row = (id: string, minute: number): Row => ({ id, time: { updated: new Date(minute * 60_000) } })

// A server holding `rows` per directory; the limit cuts the newest first, as the server's list does.
function input(byDirectory: Record<string, Row[]>, directories?: string[]) {
  const requests: Array<{ directory?: string; limit?: number }> = []
  const all = Object.values(byDirectory).flat()
  const client = {
    session: {
      list: async (query: { directory?: string; limit?: number }) => {
        requests.push({ directory: query.directory, limit: query.limit })
        const rows = query.directory ? (byDirectory[query.directory] ?? []) : all
        return { data: rows.toSorted((a, b) => +b.time.updated - +a.time.updated).slice(0, query.limit) }
      },
    },
  }
  return {
    requests,
    input: { query: "x", client, signal: new AbortController().signal, directories } as unknown as SessionSearchInput,
  }
}

describe("listMatches", () => {
  test("finds an older match in the selected project behind many newer ones elsewhere", async () => {
    const other = Array.from({ length: 60 }, (_, index) => row(`other${index}`, 1000 + index))
    const world = { "/other": other, "/scope": [row("target", 1)] }

    const all = input(world)
    expect((await listMatches(all.input)).some((session) => session.id === "target")).toBe(false)

    const scoped = input(world, ["/scope"])
    expect((await listMatches(scoped.input)).map((session) => session.id)).toEqual(["target"])
    expect(scoped.requests).toEqual([{ directory: "/scope", limit: 50 }])
  })

  test("merges a project's directories without duplicates, newest first, within the limit", async () => {
    const world = {
      "/main": [row("a", 5), row("shared", 4)],
      "/sandbox": [row("b", 6), row("shared", 4)],
    }

    const { input: scoped } = input(world, ["/main", "/sandbox"])
    expect((await listMatches(scoped)).map((session) => session.id)).toEqual(["b", "a", "shared"])
  })

  test("searches the whole server when no project is selected", async () => {
    const { input: all, requests } = input({ "/main": [row("a", 1)] })
    expect((await listMatches(all)).map((session) => session.id)).toEqual(["a"])
    expect(requests).toEqual([{ directory: undefined, limit: 50 }])
  })
})
