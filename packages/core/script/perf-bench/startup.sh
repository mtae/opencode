# usage: [OPENCODE_BIN=path] startup.sh <name> <db-source or "empty">: time from spawn to first 200 on /api/info
S="$(cd "$(dirname "$0")" && pwd)"; RUN="${PERF_OUT:-${TMPDIR:-/tmp}/opencode-perf-bench}/run-start-$1"; rm -rf "$RUN"; mkdir -p "$RUN/data" "$RUN/config/opencode" "$RUN/state" "$RUN/cache"
[ "$2" != empty ] && cp "$2" "$RUN/bench.db"
echo '{"autoupdate":false,"share":"disabled"}' > "$RUN/config/opencode/opencode.json"
export XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config" XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache" OPENCODE_DB="$RUN/bench.db" OPENCODE_SERVER_PASSWORD=bench OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_FILEWATCHER=1
cd "$S/../../../cli"
T0=$(date +%s%3N)
${OPENCODE_BIN:-bun src/index.ts} serve --port 47901 --hostname 127.0.0.1 > "$RUN/serve.out" 2>&1 &
for i in $(seq 1 900); do curl -s -o /dev/null -w "%{http_code}" -u opencode:bench http://127.0.0.1:47901/api/info 2>/dev/null | grep -q 200 && break; sleep 0.1; done
echo "$1: ready after $(( $(date +%s%3N) - T0 )) ms; listening line: $(grep -m1 -n listening "$RUN/serve.out")"
pid=$(netstat -ano | grep -E "127.0.0.1:47901 .*LISTENING" | awk '{print $NF}' | head -1); [ -n "$pid" ] && taskkill //F //PID "$pid" >/dev/null 2>&1; sleep 1
