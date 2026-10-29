import { Schema } from "effect"

export const Json = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownSync(Json)
export const encodeJson = Schema.encodeSync(Json)

const textEncoder = new TextEncoder()

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
 */
export const encodeJsonBytes = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (!isPlainObject(value)) return textEncoder.encode(encodeJson(value))
  const fields = Object.entries(value).filter((field) => !omitted(field[1]))
  const chunks = [
    "{",
    ...fields.flatMap(([key, item], index) => [
      (index === 0 ? "" : ",") + encodeJson(key) + ":",
      ...(Array.isArray(item) ? encodeArray(item) : [encodeJson(item)]),
    ]),
    "}",
  ].map((piece) => textEncoder.encode(piece))
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return bytes
}

// Separators stay separate pieces: joining one onto an element would copy the element.
const encodeArray = (items: unknown[]) => [
  "[",
  ...items.flatMap((item, index) => [index === 0 ? "" : ",", omitted(item) ? "null" : encodeJson(item)]),
  "]",
]
