#!/usr/bin/env bash
# claude-code-bridge.sh — Bridge between OpenClaw and Claude Code via tmux
# Uses Stop hook for clean response capture (no screen scraping)
#
# Usage: claude-code-bridge.sh "Your message here"
#
# Flow:
#   1. Sends message to Claude Code via tmux send-keys
#   2. Waits for Stop hook to write response to response file
#   3. Reads clean response and prints to stdout

set -euo pipefail

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config.json"

if [ -f "$CONFIG_FILE" ]; then
  TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG_FILE")
  RESPONSE_FILE=$(jq -r '.response_file // "/tmp/claude-bridge-response.json"' "$CONFIG_FILE")
  TIMEOUT=$(jq -r '.timeout_ms // 300000' "$CONFIG_FILE")
  TIMEOUT=$((TIMEOUT / 1000))  # Convert to seconds
else
  TMUX_SESSION="claude-code"
  RESPONSE_FILE="/tmp/claude-bridge-response.json"
  TIMEOUT=300
fi

# Find tmux binary
TMUX=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")
PANE="${TMUX_SESSION}:0.0"
POLL_INTERVAL=2

# --- Queue file for pending messages ---
QUEUE_FILE="/tmp/darvin-message-queue.txt"

# --- Helpers ---
die() { echo "ERROR: $1" >&2; exit 1; }

queue_message() {
  local msg="$1"
  local ts
  ts=$(date +%s)
  echo "${ts}|||${msg}" >> "$QUEUE_FILE"
  echo "⏳ Дарвин е зает — съобщението е на опашка и ще бъде обработено автоматично" >&2
  exit 0
}

session_exists() {
  $TMUX has-session -t "$TMUX_SESSION" 2>/dev/null
}

is_idle() {
  local content
  content=$($TMUX capture-pane -t "$PANE" -p)
  echo "$content" | grep -q "for shortcut" && return 0
  echo "$content" | grep -q "❯" && return 0
  return 1
}

# --- Main ---
MESSAGE="$*"
[ -z "$MESSAGE" ] && die "Usage: claude-code-bridge.sh <message>"
session_exists || die "tmux session '$TMUX_SESSION' not found. Start it with: start.sh"

# Wait for Claude Code to be idle
if ! is_idle; then
  echo "Waiting for Claude Code to become idle..." >&2
  for i in $(seq 1 $((TIMEOUT / POLL_INTERVAL))); do
    sleep "$POLL_INTERVAL"
    is_idle && break
    [ "$i" -eq $((TIMEOUT / POLL_INTERVAL)) ] && queue_message "$MESSAGE"
  done
fi

# Record current response file timestamp
OLD_TS=0
if [ -f "$RESPONSE_FILE" ]; then
  OLD_TS=$(stat -f %m "$RESPONSE_FILE" 2>/dev/null || stat -c %Y "$RESPONSE_FILE" 2>/dev/null || echo 0)
fi

# Send message to Claude Code
$TMUX send-keys -t "$PANE" "$MESSAGE" Enter

# Wait for Stop hook to write new response
sleep 3
ELAPSED=3
while true; do
  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  if [ -f "$RESPONSE_FILE" ]; then
    NEW_TS=$(stat -f %m "$RESPONSE_FILE" 2>/dev/null || stat -c %Y "$RESPONSE_FILE" 2>/dev/null || echo 0)
    if [ "$NEW_TS" -gt "$OLD_TS" ]; then
      RESPONSE=$(jq -r '.message // empty' "$RESPONSE_FILE" 2>/dev/null)
      if [ -n "$RESPONSE" ]; then
        echo "$RESPONSE"
        exit 0
      fi
    fi
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    die "⏳ Дарвин не отговори навреме — опитай пак"
  fi
done
