#!/usr/bin/env bash
# claude-code-bridge.sh v2 — Safe UTF-8 injection via tmux load-buffer/paste-buffer
#
# Key improvements over v1:
#   1. load-buffer/paste-buffer instead of send-keys (safe UTF-8/Cyrillic)
#   2. Writes active-job.json for bridge-owned idle detection
#   3. No file polling — waits for Stop hook POST (with file fallback)
#   4. Stale lock auto-kill after 5 minutes
#   5. Structured JSON output for server consumption
#
# Usage: claude-code-bridge.sh "Your message here"
# Or:    claude-code-bridge.sh --job-id <id> "Your message here"

set -u

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="$PARENT_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then
  TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG_FILE")
  RESPONSE_FILE=$(jq -r '.response_file // "/tmp/claude-bridge-response.json"' "$CONFIG_FILE")
  TIMEOUT=$(jq -r '.timeout_ms // 900000' "$CONFIG_FILE")
  TIMEOUT=$((TIMEOUT / 1000))
else
  TMUX_SESSION="claude-code"
  RESPONSE_FILE="/tmp/claude-bridge-response.json"
  TIMEOUT=900
fi

# Find tmux binary and socket
TMUX_BIN=$(which tmux 2>/dev/null || echo "tmux")
TMUX_SOCKET="/private/tmp/tmux-$(id -u)/default"
if [ -S "$TMUX_SOCKET" ]; then
  TMUX_CMD="$TMUX_BIN -S $TMUX_SOCKET"
else
  TMUX_CMD="$TMUX_BIN"
fi

PANE="${TMUX_SESSION}:0.0"
POLL_INTERVAL=2
ACTIVE_JOB_FILE="/tmp/claude-bridge-active-job.json"
LOCK_FILE="/tmp/claude-bridge.lock"
BUFFER_FILE="/tmp/claude-bridge-tmux-buffer.txt"

# --- Parse args ---
JOB_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --job-id) JOB_ID="$2"; shift 2 ;;
    *) break ;;
  esac
done

MESSAGE="$*"
[ -z "$MESSAGE" ] && { echo '{"error":"No message provided"}'; exit 1; }

# --- Helpers ---
die() {
  echo "{\"error\":\"$1\"}" >&2
  rm -f "$ACTIVE_JOB_FILE"
  exit 1
}

session_exists() {
  $TMUX_CMD has-session -t "$TMUX_SESSION" 2>/dev/null
}

is_idle() {
  # Bridge-owned idle detection: no active job file means idle
  if [ -f "$ACTIVE_JOB_FILE" ]; then
    local age
    age=$(( $(date +%s) - $(stat -f %m "$ACTIVE_JOB_FILE" 2>/dev/null || echo 0) ))
    if [ "$age" -gt 900 ]; then
      rm -f "$ACTIVE_JOB_FILE"
      return 0
    fi
    return 1
  fi
  # Fallback: check tmux pane content for Claude Code prompt
  local content
  content=$($TMUX_CMD capture-pane -t "$PANE" -p 2>/dev/null || echo "")
  echo "$content" | grep -q "for shortcut" && return 0
  echo "$content" | grep -q "^>" && return 0
  return 1
}

is_system_message() {
  case "$1" in
    HEALTHCHECK_PING*) return 0 ;;
    *CRON-ALERT*) return 0 ;;
    *HEALTHCHECK*) return 0 ;;
    *system-healthcheck*) return 0 ;;
  esac
  return 1
}

# --- Main ---
session_exists || die "tmux session '$TMUX_SESSION' not found"

# Lock management with stale detection
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -gt 300 ]; then
      echo "Stale lock (${LOCK_AGE}s) — killing PID $LOCK_PID" >&2
      kill "$LOCK_PID" 2>/dev/null || true
      rm -f "$LOCK_FILE" "$ACTIVE_JOB_FILE"
    else
      echo '{"status":"busy","message":"Bridge is processing another request"}'
      exit 0
    fi
  else
    rm -f "$LOCK_FILE"
  fi
fi

# Acquire lock
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE" "$ACTIVE_JOB_FILE" "$BUFFER_FILE"' EXIT

# Write active job marker
jq -n \
  --arg id "${JOB_ID:-bridge-$$}" \
  --arg prompt "$MESSAGE" \
  --arg ts "$(date +%s)" \
  --arg pid "$$" \
  '{job_id: $id, prompt: $prompt, started_at: $ts, pid: $pid}' \
  > "$ACTIVE_JOB_FILE"

# Determine timeout (system messages get short timeout)
if is_system_message "$MESSAGE"; then
  MAX_WAIT=10
else
  MAX_WAIT=$TIMEOUT
fi

# Wait for idle (max 30s, then send anyway)
IDLE_WAIT=30
if ! is_idle; then
  echo "Waiting for Claude Code to become idle..." >&2
  WAITED=0
  while [ "$WAITED" -lt "$IDLE_WAIT" ]; do
    sleep "$POLL_INTERVAL"
    WAITED=$((WAITED + POLL_INTERVAL))
    is_idle && break
  done
  if ! is_idle; then
    echo "Not idle after ${IDLE_WAIT}s — sending anyway" >&2
  fi
fi

# Record current response file timestamp (for file-based fallback)
OLD_TS=0
if [ -f "$RESPONSE_FILE" ]; then
  OLD_TS=$(stat -f %m "$RESPONSE_FILE" 2>/dev/null || stat -c %Y "$RESPONSE_FILE" 2>/dev/null || echo 0)
fi

# --- KEY IMPROVEMENT: Use load-buffer/paste-buffer for safe UTF-8 injection ---
# Write message to temp file (handles Cyrillic, special chars, multiline safely)
printf '%s' "$MESSAGE" > "$BUFFER_FILE"

# Load into tmux named buffer
$TMUX_CMD load-buffer -b bridge "$BUFFER_FILE" 2>/dev/null || {
  echo "load-buffer failed, falling back to send-keys" >&2
  $TMUX_CMD send-keys -t "$PANE" "$MESSAGE" Enter
}

# Paste from buffer into the active pane, then press Enter
if $TMUX_CMD paste-buffer -b bridge -t "$PANE" 2>/dev/null; then
  sleep 0.2
  $TMUX_CMD send-keys -t "$PANE" Enter
else
  echo "paste-buffer failed, message may not have been sent" >&2
fi

# Clean up tmux buffer and temp file
$TMUX_CMD delete-buffer -b bridge 2>/dev/null || true
rm -f "$BUFFER_FILE"

# --- Wait for response ---
# Primary: Stop hook POSTs response to server (instant)
# Fallback: file timestamp polling (same as v1 but as backup)
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

  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    die "Timeout after ${MAX_WAIT}s"
  fi
done
