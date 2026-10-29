import { expect, test } from "bun:test"
import { OpenApi } from "effect/http-api"
import { ClientApi } from "../src/client.js"

// Clients generated before `pending` existed decode list responses without it, and decode ones that carry it.
test("session list response keeps pending optional beside data and cursor", () => {
  const schemas = OpenApi.fromApi(ClientApi).components.schemas as Record<
    string,
    { properties?: Record<string, unknown>; required?: ReadonlyArray<string> }
  >
  const response = schemas.SessionsResponse!
  expect(Object.keys(response.properties ?? {})).toEqual(expect.arrayContaining(["data", "cursor", "pending"]))
  expect(response.required).toEqual(["data", "cursor"])
})
