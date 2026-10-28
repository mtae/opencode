// Drive the real TUI under a pseudo-terminal and time what a user sees.
// usage: [MARKER=text] [TIMELINE=1] [DUMP=file] bun tui-probe.ts <run-dir-of-serve-isolated> <label> -- <command...>
// Reports first output, settle (no output for QUIET ms), an optional marker's first appearance, and keystroke echo latency.
const sep = process.argv.indexOf("--")
const [runDir, label] = process.argv.slice(2, sep)
const cmd = process.argv.slice(sep + 1)
const quiet = Number(process.env.QUIET ?? 1500)
const marker = process.env.MARKER
const env = {
  ...process.env,
  XDG_DATA_HOME: `${runDir}/data`,
  XDG_CONFIG_HOME: `${runDir}/config`,
  XDG_STATE_HOME: `${runDir}/state`,
  XDG_CACHE_HOME: `${runDir}/cache`,
  OPENCODE_DB: `${runDir}/bench.db`,
  OPENCODE_PASSWORD: "bench",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}
const ESC = "\x1b"
const ST = `${ESC}\\`
// Terminals end an OSC reply with the query's terminator; OSC_ST=1 uses ST instead of BEL.
const OSC_END = process.env.OSC_ST ? ST : "\x07"
const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1bP[^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "")
// Answer the capability queries a real terminal answers, so the TUI never sits waiting on a timeout.
// NO_OSC=1 leaves only the OSC 10/11 colour queries unanswered, to show what the theme-mode timeout costs.
const osc: Array<[RegExp, string]> = [
  [/\x1b\]10;\?/, `${ESC}]10;rgb:d0d0/d0d0/d0d0${OSC_END}`],
  [/\x1b\]11;\?/, `${ESC}]11;rgb:1e1e/1e1e/1e1e${OSC_END}`],
]
const replies: Array<[RegExp, string]> = [
  ...(process.env.NO_OSC ? [] : osc),
  [/\x1b\[0?c/, `${ESC}[?62;22;52c`],
  [/\x1b\[\?u/, `${ESC}[?0u`],
  [/\x1b\[14t/, `${ESC}[4;800;1600t`],
  [/\x1b\[16t/, `${ESC}[6;16;10t`],
  [/\x1b\[18t/, `${ESC}[8;50;160t`],
  [/\x1b\[6n/, `${ESC}[1;1R`],
  [/\x1b\[>0?q/, `${ESC}P>|perf-probe(1.0)${ST}`],
  [/\x1b_Gi=31337[^\x1b]*\x1b\\/, `${ESC}_Gi=31337;OK${ST}`],
  // CSI ?996n asks for the colour scheme; opentui only sends its OSC 10/11 query after this reply. NO_997=1 drops it.
  ...(process.env.NO_997 ? [] : [[/\x1b\[\?996n/, `${ESC}[?997;1n`] as [RegExp, string]]),
]
const start = performance.now() - (Date.now() - Number(process.env.EPOCH ?? Date.now()))
let last = start
let first = 0
let markerAt = 0
let bytes = 0
let text = ""
const answered = new Set<string>()
const chunks: Array<[number, number, string]> = []
const waiters: Array<(t: number) => void> = []
const proc = Bun.spawn(cmd, {
  env,
  cwd: process.env.PROBE_CWD ?? process.cwd(),
  terminal: {
    cols: 160,
    rows: 50,
    data(term, data) {
      const now = performance.now()
      if (!first) first = now
      last = now
      bytes += data.length
      const raw = new TextDecoder().decode(data)
      for (const m of raw.matchAll(/\x1b\[\?(\d+)\$p/g)) term.write(`${ESC}[?${m[1]};2$y`)
      for (const [re, reply] of replies)
        if (re.test(raw)) {
          term.write(reply)
          answered.add(re.source)
        }
      if (process.env.RAWLOG) require("fs").appendFileSync(process.env.RAWLOG, `${(now - start).toFixed(0)} ${JSON.stringify(raw.slice(0, 300))}
`)
      const visible = strip(raw)
      chunks.push([now - start, data.length, visible.replace(/\s+/g, " ").trim().slice(0, 70)])
      text = (text + visible).slice(-200_000)
      if (marker && !markerAt && text.includes(marker)) markerAt = now
      waiters.splice(0).forEach((w) => w(now))
    },
  },
})
const settle = async (limit = 60_000) => {
  const begin = performance.now()
  while (((marker && !markerAt) || performance.now() - last < quiet) && performance.now() - begin < limit) await Bun.sleep(50)
  return last
}
const settled = await settle()
const ms = (t: number) => (t ? `${(t - start).toFixed(0)} ms` : "never")
console.log(
  `${label}: first output ${ms(first)}, settled ${ms(settled)}, marker ${marker ? ms(markerAt) : "-"}, ${(bytes / 1024).toFixed(0)} KB output, answered ${answered.size} query kinds`,
)
if (process.env.TIMELINE)
  for (const [t, n, txt] of chunks) console.log(`  ${t.toFixed(0).padStart(6)} ms ${String(n).padStart(7)} B  ${txt}`)

// Keystroke echo latency: type one character at a time, time until the terminal next receives output.
const lat: number[] = []
for (const ch of "hello perf probe") {
  const sent = performance.now()
  const echoed = new Promise<number>((resolve) => {
    waiters.push(resolve)
    setTimeout(() => resolve(Number.NaN), 2000)
  })
  proc.terminal?.write(ch)
  lat.push((await echoed) - sent)
  await Bun.sleep(120)
}
const ok = lat.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
if (ok.length)
  console.log(
    `${label}: keystroke echo p50 ${ok[Math.floor(ok.length / 2)].toFixed(1)} ms, max ${ok.at(-1)!.toFixed(1)} ms (${ok.length}/${lat.length} echoed)`,
  )
if (process.env.DUMP) await Bun.write(process.env.DUMP, text)
// EXIT_KEYS (for example "\x03") quits through the app, so profilers that write on exit get to run.
if (process.env.EXIT_KEYS) {
  proc.terminal?.write(JSON.parse(`"${process.env.EXIT_KEYS}"`))
  await Promise.race([proc.exited, Bun.sleep(15_000)])
}
proc.kill()
await Promise.race([proc.exited, Bun.sleep(3000)])
const usage = proc.resourceUsage()
if (usage) console.log(`${label}: process CPU user ${(Number(usage.cpuTime.user) / 1000).toFixed(0)} ms, system ${(Number(usage.cpuTime.system) / 1000).toFixed(0)} ms, max RSS ${(usage.maxRSS / 1024 / 1024).toFixed(0)} MB`)
