// Preloaded into the server: profile only between <PROF_DIR>/start and <PROF_DIR>/stop marker files.
import { Session } from "node:inspector"
import { existsSync } from "node:fs"

const dir = process.env.PROF_DIR
if (dir) {
  const session = new Session()
  const post = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))))
  let state: "idle" | "running" | "done" = "idle"
  const timer = setInterval(async () => {
    if (state === "idle" && existsSync(`${dir}/start`)) {
      state = "running"
      session.connect()
      await post("Profiler.enable")
      await post("Profiler.setSamplingInterval", { interval: 200 })
      await post("Profiler.start")
      await Bun.write(`${dir}/started`, String(Date.now()))
    }
    if (state === "running" && existsSync(`${dir}/stop`)) {
      state = "done"
      clearInterval(timer)
      const result = await post("Profiler.stop")
      session.disconnect()
      await Bun.write(`${dir}/server.cpuprofile`, JSON.stringify(result.profile))
      await Bun.write(`${dir}/written`, String(Date.now()))
    }
  }, 50)
  timer.unref()
}
