#!/bin/bash
# stop-hook.sh v2 — Claude Code Stop hook with POST notification
#
# Improvements over v1:
#   1. POSTs response to bridge server (instant notification, no polling delay)
#   2. Still writes response file as fallback
#   3. Clears active-job marker
#   4. Optionally appends to daily memory log
#
# Called automatically by Claude Code via settings.json Stop hook.
# Add to ~/.claude/settings.json:
# {
#   "hooks": {
#     "Stop": [{ "type": "command", "command": "bash /path/to/stop-hook.sh" }]
#   }
# }

INPUT=$(cat)
MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION=$(echo "$INPUT" | jq -r '.session_id // empty')

[ -z "$MSG" ] && exit 0

# Response file path (override with environment variable)
RESPONSE_FILE="${CLAUDE_BRIDGE_RESPONSE_FILE:-/tmp/claude-bridge-response.json}"

# 1. Write response for file-based fallback
jq -n \
  --arg msg "$MSG" \
  --arg ts "$(date +%s)" \
  --arg sid "$SESSION" \
  '{message: $msg, timestamp: $ts, session_id: $sid}' \
  > "$RESPONSE_FILE"

# 2. POST to bridge server (instant notification — primary delivery)
# Non-blocking: if bridge is down, file fallback still works
BRIDGE_URL="${CLAUDE_BRIDGE_URL:-http://127.0.0.1:18790/internal/claude-stop}"
PAYLOAD=$(jq -n \
  --arg msg "$MSG" \
  --arg ts "$(date +%s)" \
  --arg sid "$SESSION" \
  '{message: $msg, timestamp: $ts, session_id: $sid}')

curl -s --connect-timeout 2 --max-time 5 \
  -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  >/dev/null 2>&1 &

# 3. Clear active job marker
rm -f /tmp/claude-bridge-active-job.json

# 4. (Optional) Append to daily memory log
MEMORY_DIR="${CLAUDE_BRIDGE_MEMORY_DIR:-}"
if [ -n "$MEMORY_DIR" ] && [ -d "$MEMORY_DIR" ]; then
  DATE=$(date +%Y-%m-%d)
  LOG_FILE="$MEMORY_DIR/$DATE.md"

  if [ ! -f "$LOG_FILE" ]; then
    echo "# $DATE — Daily Log" > "$LOG_FILE"
    echo "" >> "$LOG_FILE"
  fi

  MSG_LEN=${#MSG}
  if [ "$MSG_LEN" -gt 20 ]; then
    TIMESTAMP=$(date +%H:%M)
    echo "## [$TIMESTAMP] Claude Code Bridge" >> "$LOG_FILE"
    echo "$MSG" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
  fi
fi

exit 0
