import { expect, test } from "bun:test"
import { mergeSearchRows } from "./merge"

const row = (id: string, label = id) => ({ session: { id }, label })

test("server matches follow the local rows and the local order is kept", () => {
  const merged = mergeSearchRows({ local: [row("b"), row("a")], exact: undefined, remote: [row("c"), row("d")] })

  expect(merged.map((item) => item.session.id)).toEqual(["b", "a", "c", "d"])
})

test("a session found locally and by the server appears once, at its local position", () => {
  const merged = mergeSearchRows({
    local: [row("a", "local"), row("b")],
    exact: undefined,
    remote: [row("b", "remote"), row("c")],
  })

  expect(merged).toEqual([row("a", "local"), row("b"), row("c")])
})

test("an exact ID match the listing lacks goes first, and one it has stays where it is", () => {
  expect(
    mergeSearchRows({ local: [row("a")], exact: row("x"), remote: [row("x"), row("c")] }).map(
      (item) => item.session.id,
    ),
  ).toEqual(["x", "a", "c"])
  expect(
    mergeSearchRows({ local: [row("a"), row("x")], exact: row("x"), remote: [] }).map((item) => item.session.id),
  ).toEqual(["a", "x"])
})

test("no local rows and no server matches gives no rows", () => {
  expect(mergeSearchRows({ local: [], exact: undefined, remote: [] })).toEqual([])
})
