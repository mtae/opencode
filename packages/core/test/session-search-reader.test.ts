import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { SessionSearchReader } from "@opencode/core/session/search-reader"

// The tables the reader's query reads, in a file a worker can open read-only.
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "search-reader-"))
  const file = join(dir, "test.db")
  const db = new Database(file)
  db.run("PRAGMA journal_mode = WAL")
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, revert TEXT)")
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER)")
  db.run("CREATE TABLE session_search_document (id INTEGER PRIMARY KEY, source_id TEXT, session_id TEXT)")
  db.run("CREATE VIRTUAL TABLE session_search USING fts5(title, summary, user_text, assistant_text, content='')")
  const add = (id: number, session: string, text: string) => {
    db.run("INSERT OR IGNORE INTO session_v2 (id) VALUES (?)", [session])
    db.run("INSERT INTO session_message VALUES (?, ?, ?)", [`msg_${id}`, session, id])
    db.run("INSERT INTO session_search_document VALUES (?, ?, ?)", [id, `msg_${id}`, session])
    db.run("INSERT INTO session_search (rowid, title, summary, user_text, assistant_text) VALUES (?, '', '', ?, '')", [
      id,
      text,
    ])
  }
  add(1, "ses_a", "the walrus plan")
  add(2, "ses_a", "walrus again")
  add(3, "ses_b", "a walrus too")
  add(4, "ses_c", "nothing here")
  db.close()
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("SessionSearchReader", () => {
  test("reads matching sessions in a worker, and a new worker after an interrupted read", async () => {
    const { file, cleanup } = fixture()
    try {
      const reader = SessionSearchReader.make(SessionSearchReader.spawn(file))
      const sessions = await Effect.runPromise(reader.sessions('"walrus"'))
      expect([...sessions].toSorted()).toEqual(["ses_a", "ses_b"])

      // An interrupted read terminates its worker; the next read starts another.
      const fiber = Effect.runFork(reader.sessions('"walrus"'))
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect([...(await Effect.runPromise(reader.sessions('"nothing"')))]).toEqual(["ses_c"])
      await Effect.runPromise(reader.close)
    } finally {
      cleanup()
    }
  })

  test("fails as unavailable when the worker cannot start, so list search reads inline", async () => {
    const reader = SessionSearchReader.make(
      SessionSearchReader.spawn(join(tmpdir(), "missing.db"), new URL("./missing-reader.js", import.meta.url)),
    )
    const exit = await Effect.runPromiseExit(reader.sessions('"walrus"'))
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("SessionSearchReader.UnavailableError")
  })
})
