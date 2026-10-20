#!/usr/bin/env bash
# usage: run-bench.sh <name> <session-id> [steps] [extra bun flags for serve]
set -u
S="$(cd "$(dirname "$0")" && pwd)"; OUT="${PERF_OUT:-${TMPDIR:-/tmp}/opencode-perf-bench}"
REPO="$(cd "$S/../../../.." && pwd)"
NAME=$1; SESSION=$2; STEPS=${3:-8}; SERVE_FLAGS=${4:-}
RUN="$OUT/run-$NAME"
rm -rf "$RUN"; mkdir -p "$RUN/data" "$RUN/config/opencode" "$RUN/state" "$RUN/cache"

# Disposable DB copy with every stored credential removed, so nothing can reach a real provider.
cp "${PERF_DB:?set PERF_DB to a SQLite snapshot (VACUUM INTO) of an opencode.db}" "$RUN/bench.db"
bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); for (const t of ["credential","account","account_state","control_account"]) db.run(`delete from ${t}`); db.close()' "$RUN/bench.db"

cat > "$RUN/config/opencode/opencode.json" <<EOF
{
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake",
      "options": { "baseURL": "http://127.0.0.1:47900/v1", "apiKey": "bench" },
      "models": { "bench": { "name": "bench", "limit": { "context": 100000000, "output": 8192 } } }
    }
  },
  "model": "fake/bench",
  "small_model": "fake/bench",
  "autoupdate": false,
  "share": "disabled"
}
EOF

export XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config" XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache"
export OPENCODE_DB="$RUN/bench.db" OPENCODE_SERVER_PASSWORD=bench OPENCODE_PASSWORD=bench
export OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_BENCH_TIMING=1
export OPENCODE_DISABLE_FILEWATCHER=1 OPENCODE_DISABLE_FFF=1 OPENCODE_DISABLE_CLAUDE_CODE=1

FAKE_PORT=47900 FAKE_STEPS=$STEPS FAKE_LOG="$RUN/fake.log" bun "$S/fake-provider.ts" > "$RUN/fake.out" 2>&1 &
FAKE=$!
cd "$REPO/packages/cli"
if [ "${PROFILE:-0}" = "1" ]; then SERVE_FLAGS="$SERVE_FLAGS --preload=$S/profile-hook.ts"; export PROF_DIR="$RUN"; fi
if [ "${BIGJSON:-0}" = "1" ]; then SERVE_FLAGS="$SERVE_FLAGS --preload=$S/bigjson-hook.ts"; fi
bun $SERVE_FLAGS src/index.ts serve --port 47901 --hostname 127.0.0.1 > "$RUN/serve.out" 2>&1 &
SERVE=$!
T0=$(date +%s%3N)
for i in $(seq 1 600); do
  curl -s -o /dev/null -w "%{http_code}" -u opencode:bench http://127.0.0.1:47901/api/info 2>/dev/null | grep -q 200 && break
  sleep 0.1
done
echo "server ready after $(( $(date +%s%3N) - T0 )) ms"

if [ "${PROFILE:-0}" = "1" ]; then touch "$RUN/start"; for i in $(seq 1 100); do [ -f "$RUN/started" ] && break; sleep 0.1; done; fi
T1=$(date +%s%3N)
timeout 900 bun run src/index.ts run --server http://127.0.0.1:47901 --session "$SESSION" --model fake/bench --auto "bench step" > "$RUN/run.out" 2>&1
echo "run exit=$? wall=$(( $(date +%s%3N) - T1 )) ms"
if [ "${PROFILE:-0}" = "1" ]; then touch "$RUN/stop"; for i in $(seq 1 300); do [ -f "$RUN/written" ] && break; sleep 0.1; done; ls -la "$RUN/server.cpuprofile" 2>&1 | tail -1; fi

kill $SERVE $FAKE 2>/dev/null
sleep 2
for p in 47900 47901; do
  pid=$(netstat -ano | grep -E "127.0.0.1:$p .*LISTENING" | awk '{print $NF}' | head -1)
  [ -n "$pid" ] && taskkill //F //PID "$pid" > /dev/null 2>&1
done
echo "--- fake log"; cat "$RUN/fake.log" 2>/dev/null
echo "--- run.out tail"; tail -5 "$RUN/run.out"
