#!/usr/bin/env bash
# Local dev helper for running the Bridge under git-bash while iterating - not part of the
# shipped product (§9: aibridge carries no project-specific/test-only code of its own; this is
# tooling for developing *it*, kept at the repo root like setup-windows.ps1 rather than under any
# package). Exists because the exact env vars needed (AIBRIDGE_DEV_CONTROL_PORT in particular) are
# easy to forget between restarts - confirmed live 2026-08-04, a restart without it silently made
# the dev-only diagnostic endpoint unreachable for several cycles.
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/bridge" && pwd)"
STATE_DIR="${LOCALAPPDATA:-$HOME}/aibridge"
mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/bridge-dev.log"
PID_FILE="$STATE_DIR/bridge-dev.pid"

find_pid() {
  # Matches the Bridge's own node process by command line, not just "any node.exe" - this machine
  # routinely has other Node processes running (editor extensions, this very tool) at the same time.
  powershell -NoProfile -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*packages\\bridge\\src\\index.ts*' -or \$_.CommandLine -like '*src/index.ts*' } | Select-Object -First 1 -ExpandProperty ProcessId" \
    2>/dev/null | tr -d '\r'
}

status() {
  local pid
  pid="$(find_pid)"
  if [ -n "$pid" ]; then
    echo "running (pid $pid)"
    echo "log: $LOG_FILE"
  else
    echo "not running"
  fi
}

stop() {
  local pid
  pid="$(find_pid)"
  if [ -z "$pid" ]; then
    echo "not running"
    return 0
  fi
  echo "stopping pid $pid"
  powershell -NoProfile -Command "Stop-Process -Id $pid -Force" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  sleep 1
}

start() {
  local pid
  pid="$(find_pid)"
  if [ -n "$pid" ]; then
    echo "already running (pid $pid) - use restart to relaunch"
    return 1
  fi
  echo "starting (control port 8799, debug PTY log on) - log: $LOG_FILE"
  (
    cd "$BRIDGE_DIR"
    AIBRIDGE_DEV_CONTROL_PORT=8799 AIBRIDGE_DEBUG_PTY_LOG=1 node --experimental-strip-types src/index.ts \
      > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )
  sleep 2
  status
}

restart() {
  stop
  start
}

logs() {
  tail -n "${1:-40}" "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  logs) logs "${2:-40}" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [n]}"
    exit 1
    ;;
esac
