#!/usr/bin/env bash
# process-queue.sh — Legacy file-based message queue processor
#
# NOTE: In v2, the SQLite queue (job-queue.js) handles queuing automatically.
# This script is only needed if you use the optional file-based queue as a
# fallback for when the bridge server is completely down.
#
# Runs from system crontab every 2 minutes. Zero AI tokens — pure bash.

QUEUE_FILE="/tmp/claude-bridge-message-queue.txt"
BRIDGE="$(dirname "$0")/claude-code-bridge.sh"
LOCK_FILE="/tmp/claude-bridge-queue-processing.lock"

# Exit silently if queue file doesn't exist or is empty
[ -s "$QUEUE_FILE" ] || exit 0

# Exit if already processing (prevent race condition)
[ -f "$LOCK_FILE" ] && exit 0
touch "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Read and atomically clear the queue file
QUEUE_CONTENT=$(cat "$QUEUE_FILE")
rm -f "$QUEUE_FILE"

# Process each message
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Format: timestamp|||message
  MSG="${line#*|||}"
  [ -z "$MSG" ] && continue
  bash "$BRIDGE" "$MSG" &
  sleep 1
done <<< "$QUEUE_CONTENT"

wait
