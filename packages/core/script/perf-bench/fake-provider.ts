// OpenAI-compatible fake: answers the first STEPS tool-bearing requests with a `read` tool call, then a final text.
// Logs one JSON line per request so per-step overhead = next arrival - previous response end.
const port = Number(process.env.FAKE_PORT ?? 47900)
const steps = Number(process.env.FAKE_STEPS ?? 8)
const log = process.env.FAKE_LOG ?? "fake.log"
const writer = Bun.file(log).writer()
let served = 0

const chunk = (delta: object, finish: string | null, usage?: object) =>
  `data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 0, model: "bench", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "bench", object: "model" }] })
    const arrived = performance.now()
    const text = await req.text()
    const body = JSON.parse(text)
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const index = served++
    const tool = hasTools && index < steps
    const usage = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 }
    const parts = tool
      ? [
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "bench-missing-file.txt" }) } }] }, null),
          chunk({}, "tool_calls", usage),
        ]
      : [chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop", usage)]
    const stream = new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
        writer.write(
          JSON.stringify({ index, arrived, ended: performance.now(), bytes: text.length, messages: body.messages?.length, tools: body.tools?.length ?? 0, kind: tool ? "tool" : "text" }) + "\n",
        )
        writer.flush()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})
console.log(`fake provider on ${port}, steps=${steps}, log=${log}`)
