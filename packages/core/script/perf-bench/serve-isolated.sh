# usage: serve-isolated.sh <name> <port> [db]  — starts an isolated server (binary via OPENCODE_BIN, else from source) in the background; prints its PID dir.
# Every XDG dir and the DB point at a throwaway copy so the live install (service on 45278, ~/.local/share/opencode) is never touched.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; NAME=$1; PORT=$2; DB=${3:-${PERF_DB:-}}
RUN="${PERF_OUT:-${TMPDIR:-/tmp}/opencode-perf-bench}/serve-$NAME"
rm -rf "$RUN"; mkdir -p "$RUN/data" "$RUN/config/opencode" "$RUN/state" "$RUN/cache"
if [ -n "$DB" ]; then cp "$DB" "$RUN/bench.db"; bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); for (const t of ["credential","account","account_state","control_account"]) db.run(`delete from ${t}`); db.close()' "$RUN/bench.db"; fi
echo '{"autoupdate":false,"share":"disabled"}' > "$RUN/config/opencode/opencode.json"
export XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config" XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache" OPENCODE_DB="$RUN/bench.db"
export OPENCODE_SERVER_PASSWORD=bench OPENCODE_PASSWORD=bench OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_FILEWATCHER=1
cd "$S/../../../cli"
${OPENCODE_BIN:-bun src/index.ts} serve --port "$PORT" --hostname 127.0.0.1 > "$RUN/serve.out" 2>&1 &
for i in $(seq 1 900); do curl -s -o /dev/null -w "%{http_code}" -u opencode:bench "http://127.0.0.1:$PORT/api/info" 2>/dev/null | grep -q 200 && break; sleep 0.1; done
echo "$RUN"
