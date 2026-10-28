# usage: stop-port.sh <port>... — kill whatever listens on each port, by PID (never by process name).
for p in "$@"; do pid=$(netstat -ano | grep -E "127.0.0.1:$p .*LISTENING" | awk '{print $NF}' | head -1); [ -n "$pid" ] && taskkill //F //PID "$pid" > /dev/null 2>&1; done; true
