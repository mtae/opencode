import { Schema } from "effect"

export const Json = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownSync(Json)
export const encodeJson = Schema.encodeSync(Json)

const textEncoder = new TextEncoder()
const bytes = (text: string) => textEncoder.encode(text)
const COMMA = bytes(",")
const NULL = bytes("null")

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && !("toJSON" in value)
}

// What `JSON.stringify` writes for an array element or object value it cannot represent.
const omitted = (value: unknown) => value === undefined || typeof value === "function" || typeof value === "symbol"

/**
 * The UTF-8 bytes of `encodeJson(value)`.
 *
 * JavaScript engines store a string as UTF-16 once it holds a single character outside Latin-1, so
 * one curly quote anywhere in a request makes `encodeJson` build the whole multi-megabyte body at
 * twice the width, which roughly doubles the cost of encoding it. Encoding each element of the
 * top-level arrays (`messages`, `input`, `contents`, `tools`) on its own confines that widening to
 * the elements that contain such a character.
 *
 * Consecutive steps of a conversation resend the same history, so the encoded elements of recent
 * arrays are kept and reused for the longest prefix that is structurally equal to one of them.
 */
export const encodeJsonBytes = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (!isPlainObject(value)) return bytes(encodeJson(value))
  const fields = Object.entries(value).filter((field) => !omitted(field[1]))
  const chunks = [
    bytes("{"),
    ...fields.flatMap(([key, item], index) => [
      bytes((index === 0 ? "" : ",") + encodeJson(key) + ":"),
      ...(Array.isArray(item) ? [bytes("["), ...encodeArray(item), bytes("]")] : [bytes(encodeJson(item))]),
    ]),
    bytes("}"),
  ]
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    result.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return result
}

interface EncodedArray {
  readonly items: readonly unknown[]
  readonly chunks: readonly Uint8Array<ArrayBuffer>[]
}

// Room for a few concurrent sessions, each with a message array and a tool array.
const RECENT_ARRAYS = 8
const recent: EncodedArray[] = []

const encodeArray = (items: readonly unknown[]) => {
  const base = recent.reduce(
    (best, entry) => {
      const length = sharedPrefix(items, entry.items)
      return length > best.length ? { length, entry } : best
    },
    { length: 0, entry: undefined as EncodedArray | undefined },
  )
  const chunks = items.map((item, index) => {
    if (base.entry && index < base.length) return base.entry.chunks[index]
    return omitted(item) ? NULL : bytes(encodeJson(item))
  })
  if (base.entry) recent.splice(recent.indexOf(base.entry), 1)
  recent.unshift({ items, chunks })
  recent.length = Math.min(recent.length, RECENT_ARRAYS)
  return chunks.flatMap((chunk, index) => (index === 0 ? [chunk] : [COMMA, chunk]))
}

const sharedPrefix = (items: readonly unknown[], previous: readonly unknown[]) => {
  const limit = Math.min(items.length, previous.length)
  const index = items.slice(0, limit).findIndex((item, i) => !sameJson(item, previous[i]))
  return index === -1 ? limit : index
}

/**
 * Whether two values encode to the same JSON. Only plain objects, arrays and primitives are compared:
 * anything else (a `Date`, a class with `toJSON`) counts as different, so it is always encoded fresh.
 */
const sameJson = (a: unknown, b: unknown): boolean => {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => !omitted(item) && !omitted(b[index]) && sameJson(item, b[index]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const left = Object.keys(a).filter((key) => !omitted(a[key]))
  const right = Object.keys(b).filter((key) => !omitted(b[key]))
  return left.length === right.length && left.every((key, index) => key === right[index] && sameJson(a[key], b[key]))
}
