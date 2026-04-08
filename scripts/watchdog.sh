#!/usr/bin/env bash
# watchdog.sh — Monitor and auto-restart bridge components
# Usage: watchdog.sh [--daemon]
# Checks every 30 seconds that tmux and HTTP server are running

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$ROOT_DIR/config.json"

PORT=$(jq -r '.port // 18790' "$CONFIG" 2>/dev/null || echo 18790)
TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG" 2>/dev/null || echo "claude-code")
LOG_FILE=$(jq -r '.log_file // ""' "$CONFIG" 2>/dev/null | sed "s|~|$HOME|")
TMUX=$(which tmux 2>/dev/null || echo "tmux")
CHECK_INTERVAL=30

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  if [ -n "$LOG_FILE" ]; then
    echo "$msg" >> "${LOG_FILE%.log}-watchdog.log" 2>/dev/null
  fi
}

check_and_restart() {
  # Check tmux session
  if ! $TMUX has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "WARN: tmux session '$TMUX_SESSION' not found. Restarting..."
    "$SCRIPT_DIR/start.sh" 2>/dev/null
    log "INFO: Restart triggered"
    return
  fi

  # Check HTTP server
  if ! curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    log "WARN: Bridge server not responding on port $PORT. Restarting..."
    "$SCRIPT_DIR/start.sh" 2>/dev/null
    log "INFO: Restart triggered"
    return
  fi
}

# Run once or as daemon
if [ "${1:-}" = "--daemon" ]; then
  log "INFO: Watchdog started (interval: ${CHECK_INTERVAL}s)"
  while true; do
    check_and_restart
    sleep "$CHECK_INTERVAL"
  done
else
  check_and_restart
  echo "Single check complete. Use --daemon for continuous monitoring."
fi
