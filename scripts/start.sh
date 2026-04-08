#!/usr/bin/env bash
# start.sh — Start the Claude Code bridge
# Usage: start.sh [--attach]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$ROOT_DIR/config.json"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

# Load config
if [ ! -f "$CONFIG" ]; then
  fail "config.json not found. Copy config.example.json and fill in your values."
  exit 1
fi

PORT=$(jq -r '.port // 18790' "$CONFIG")
TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG")
CLAUDE_CLI=$(jq -r '.claude_cli_path // "claude"' "$CONFIG" | sed "s|~|$HOME|")
WORK_DIR=$(jq -r '.working_directory // "~"' "$CONFIG" | sed "s|~|$HOME|")
LOG_FILE=$(jq -r '.log_file // ""' "$CONFIG" | sed "s|~|$HOME|")
TMUX=$(which tmux 2>/dev/null || echo "tmux")
NODE=$(which node 2>/dev/null || echo "node")

echo "═══════════════════════════════════════"
echo "  Claude Code ↔ OpenClaw Bridge v2"
echo "═══════════════════════════════════════"
echo ""

# --- 1. Start tmux session with Claude Code ---
if $TMUX has-session -t "$TMUX_SESSION" 2>/dev/null; then
  ok "tmux session '$TMUX_SESSION' already running"
else
  warn "Starting tmux session '$TMUX_SESSION'..."
  $TMUX new-session -d -s "$TMUX_SESSION" \
    "/bin/bash -c 'cd $WORK_DIR; $CLAUDE_CLI --dangerously-skip-permissions; exec bash'"
  sleep 5

  # Accept trust prompt if needed
  $TMUX send-keys -t "$TMUX_SESSION:0.0" Enter
  sleep 3

  ok "Claude Code started in tmux session '$TMUX_SESSION'"
fi

# --- 2. Start HTTP bridge server ---
if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
  ok "Bridge server already running on port $PORT"
else
  warn "Starting bridge server on port $PORT..."

  if [ -n "$LOG_FILE" ]; then
    mkdir -p "$(dirname "$LOG_FILE")"
    $NODE "$SCRIPT_DIR/claude-code-server.js" --port "$PORT" >> "$LOG_FILE" 2>&1 &
  else
    $NODE "$SCRIPT_DIR/claude-code-server.js" --port "$PORT" &
  fi

  sleep 2

  if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    ok "Bridge server started on port $PORT"
  else
    fail "Bridge server failed to start"
    exit 1
  fi
fi

# --- 3. Status ---
echo ""
echo "═══════════════════════════════════════"
echo "  Status"
echo "═══════════════════════════════════════"
echo -e "  tmux session:  ${GREEN}$TMUX_SESSION${NC}"
echo -e "  bridge server: ${GREEN}http://localhost:$PORT${NC}"
echo -e "  status:        ${GREEN}http://localhost:$PORT/status${NC}"
echo -e "  SSE events:    ${GREEN}http://localhost:$PORT/events${NC}"
if [ -n "$LOG_FILE" ]; then
  echo -e "  log file:      $LOG_FILE"
fi
echo ""
echo "  Monitor live:  $TMUX attach -t $TMUX_SESSION"
echo "  Stop:          $SCRIPT_DIR/stop.sh"
echo ""

# --- 4. Attach if requested ---
if [ "${1:-}" = "--attach" ]; then
  echo "Attaching to tmux session... (Ctrl+B then D to detach)"
  $TMUX attach -t "$TMUX_SESSION"
fi
