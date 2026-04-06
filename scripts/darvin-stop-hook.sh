#!/bin/bash
# darvin-stop-hook.sh — Claude Code Stop hook
# Captures clean response text after each Claude Code turn
#
# 1. Writes response to a JSON file (for bridge pickup)
# 2. Appends to daily memory log (optional, for OpenClaw integration)
#
# Called automatically by Claude Code via settings.json Stop hook

INPUT=$(cat)
MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION=$(echo "$INPUT" | jq -r '.session_id // empty')

[ -z "$MSG" ] && exit 0

# Response file path — default or from env
RESPONSE_FILE="${CLAUDE_BRIDGE_RESPONSE_FILE:-/tmp/darvin-response.json}"

# 1. Write response for bridge pickup
jq -n \
  --arg msg "$MSG" \
  --arg ts "$(date +%s)" \
  --arg sid "$SESSION" \
  '{message: $msg, timestamp: $ts, session_id: $sid}' \
  > "$RESPONSE_FILE"

# 2. Append to daily memory log (OpenClaw integration)
MEMORY_DIR="${CLAUDE_BRIDGE_MEMORY_DIR:-$HOME/.openclaw/workspace/memory}"
if [ -d "$MEMORY_DIR" ]; then
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
