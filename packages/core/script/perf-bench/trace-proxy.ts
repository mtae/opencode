// Logging reverse proxy: PROXY_PORT -> TARGET. One line per request: start offset, duration to headers and to end, status, bytes, path.
const target = process.env.TARGET ?? "http://127.0.0.1:47911"
const port = Number(process.env.PROXY_PORT ?? 47912)
const t0 = performance.now() - (Date.now() - Number(process.env.EPOCH ?? Date.now()))
const log = (s: string) => console.log(s)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const start = performance.now()
    const headers = new Headers(req.headers)
    headers.delete("host")
    const res = await fetch(target + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual", decompress: false } as RequestInit)
    const head = performance.now()
    const sse = (res.headers.get("content-type") ?? "").includes("event-stream")
    if (sse || !res.body) {
      log(`${(start - t0).toFixed(0).padStart(6)} +${(head - start).toFixed(0).padStart(5)} ms ${res.status} ${sse ? "SSE" : "-"} ${req.method} ${url.pathname}${url.search.slice(0, 80)}`)
      return new Response(res.body, { status: res.status, headers: res.headers })
    }
    const buf = await res.arrayBuffer()
    log(`${(start - t0).toFixed(0).padStart(6)} +${(head - start).toFixed(0).padStart(5)}/${(performance.now() - start).toFixed(0).padStart(5)} ms ${res.status} ${(buf.byteLength / 1024).toFixed(0).padStart(6)} KB ${res.headers.get("content-encoding") ?? ""} ${req.method} ${url.pathname}${url.search.slice(0, 80)}`)
    return new Response(buf, { status: res.status, headers: res.headers })
  },
})
log(`proxy ${port} -> ${target}`)
