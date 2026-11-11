import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionsResponse } from "../src/groups/session.js"

const decode = Schema.decodeUnknownSync(SessionsResponse)
const encode = Schema.encodeSync(SessionsResponse)

test("SessionsResponse decodes the shape without readiness and with experimental indexing", () => {
  expect(decode({ data: [], cursor: {} })).toEqual({ data: [], cursor: {} })
  expect(decode({ data: [], cursor: {}, experimental: { indexing: true } })).toEqual({
    data: [],
    cursor: {},
    experimental: { indexing: true },
  })
})

test("SessionsResponse encodes no experimental key when nothing is indexing", () => {
  expect(Object.keys(encode({ data: [], cursor: {} }))).toEqual(["data", "cursor"])
})
