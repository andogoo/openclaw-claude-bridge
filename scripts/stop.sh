#!/usr/bin/env bash
# stop.sh — Stop the Claude Code ↔ OpenClaw bridge
# Usage: stop.sh [--kill-tmux]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$ROOT_DIR/config.json"

GREEN='\033[0;32m'
NC='\033[0m'
ok() { echo -e "${GREEN}✓${NC} $1"; }

TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG" 2>/dev/null || echo "claude-code")
TMUX=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

echo "Stopping Claude Code bridge..."

# Stop HTTP server
PIDS=$(pgrep -f "claude-code-server.js" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  ok "Bridge server stopped"
else
  ok "Bridge server not running"
fi

# Stop watchdog
PIDS=$(pgrep -f "watchdog.sh" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  ok "Watchdog stopped"
fi

# Kill tmux session only if --kill-tmux
if [ "${1:-}" = "--kill-tmux" ]; then
  $TMUX kill-session -t "$TMUX_SESSION" 2>/dev/null && ok "tmux session killed" || ok "tmux session not running"
else
  echo "  tmux session '$TMUX_SESSION' left running (use --kill-tmux to stop)"
fi

echo "Done."
