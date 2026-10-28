// Time what a client does to open sessions: session list, then every message page (desc, limit 200), with and without compression.
const [base, ...sessions] = process.argv.slice(2)
const auth = { authorization: "Basic " + btoa("opencode:bench") }
const get = async (path: string, enc = "identity") => {
  const t = performance.now()
  const res = await fetch(base + path, { headers: { ...auth, "accept-encoding": enc }, decompress: false } as RequestInit)
  const buf = new Uint8Array(await res.arrayBuffer())
  return { ms: performance.now() - t, bytes: buf.length, status: res.status, encoding: res.headers.get("content-encoding") ?? "none", buf }
}
for (const enc of ["identity", "gzip, br"]) {
  const list = await get("/api/session", enc)
  console.log(`session list [${enc}] ${list.status} ${list.ms.toFixed(0)} ms ${(list.bytes / 1024).toFixed(0)} KB enc=${list.encoding}`)
}
for (const id of sessions) {
  for (const enc of ["identity", "gzip, br"]) {
    let cursor: string | undefined, pages = 0, bytes = 0, ms = 0, first = 0, firstBytes = 0, encoding = ""
    const t0 = performance.now()
    do {
      const r = await get(`/api/session/${id}/message?limit=200` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "&order=desc"), enc)
      if (r.status !== 200) { console.log(id, "status", r.status, new TextDecoder().decode(r.buf).slice(0, 200)); break }
      if (pages === 0) { first = r.ms; firstBytes = r.bytes }
      pages++; bytes += r.bytes; ms += r.ms; encoding = r.encoding
      const body = r.encoding === "none" ? JSON.parse(new TextDecoder().decode(r.buf)) : undefined
      cursor = body?.cursor?.next
      if (!body) break
    } while (cursor)
    console.log(`${id.slice(-8)} [${enc}] first page ${first.toFixed(0)} ms ${(firstBytes / 1048576).toFixed(2)} MB; all ${pages} pages ${(performance.now() - t0).toFixed(0)} ms ${(bytes / 1048576).toFixed(2)} MB enc=${encoding}`)
  }
}
