#!/usr/bin/env bash
# system-healthcheck.sh — Check health of the OpenClaw + Claude Code bridge system
# Runs from cron (e.g. hourly). Alerts to Telegram + bridge on problems.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$(dirname "$SCRIPT_DIR")/config.json"

# Load config
BRIDGE_URL="http://localhost:$(jq -r '.port // 18790' "$CONFIG_FILE" 2>/dev/null)/v1/chat/completions"
GATEWAY_URL="http://localhost:18789/health"
OPENCLAW=$(jq -r '.openclaw_bin // "openclaw"' "$CONFIG_FILE" 2>/dev/null | sed "s|~|$HOME|")
BOT_TOKEN=$(jq -r '.telegram_bot_token // ""' "$CONFIG_FILE" 2>/dev/null)
CHAT_ID=$(jq -r '.telegram_chat_id // ""' "$CONFIG_FILE" 2>/dev/null)
TMUX_SESSION=$(jq -r '.tmux_session // "claude-code"' "$CONFIG_FILE" 2>/dev/null)
TMUX_BIN=$(which tmux 2>/dev/null || echo "tmux")

ALERT_THRESHOLD_DISK=85
ALERT_THRESHOLD_RAM=90

issues=()
info=()

# --- 1. Gateway health ---
gw_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$GATEWAY_URL" 2>/dev/null || echo "000")
if [ "$gw_status" = "200" ]; then
    info+=("Gateway — OK")
else
    issues+=("Gateway DEAD (HTTP $gw_status)")
fi

# --- 2. Bridge health ---
bridge_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BRIDGE_URL" -X POST \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"HEALTHCHECK_PING"}]}' 2>/dev/null || echo "000")
if [ "$bridge_status" = "200" ]; then
    info+=("Bridge — OK")
else
    issues+=("Bridge DEAD (HTTP $bridge_status)")
fi

# --- 3. tmux session ---
if $TMUX_BIN has-session -t "$TMUX_SESSION" 2>/dev/null; then
    info+=("tmux $TMUX_SESSION — OK")
else
    issues+=("tmux session '$TMUX_SESSION' NOT FOUND")
fi

# --- 4. Disk usage ---
disk_pct=$(df -h / | awk 'NR==2{gsub(/%/,""); print $5}')
if [ "$disk_pct" -ge "$ALERT_THRESHOLD_DISK" ]; then
    issues+=("Disk ${disk_pct}% used (threshold ${ALERT_THRESHOLD_DISK}%)")
else
    info+=("Disk — ${disk_pct}% used")
fi

# --- 5. RAM pressure (macOS) ---
if command -v memory_pressure >/dev/null 2>&1; then
    ram_pressure=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%' || echo "0")
    ram_used=$((100 - ${ram_pressure:-0}))
    if [ "$ram_used" -ge "$ALERT_THRESHOLD_RAM" ]; then
        issues+=("RAM ${ram_used}% used (threshold ${ALERT_THRESHOLD_RAM}%)")
    else
        info+=("RAM — ${ram_used}% used")
    fi
fi

# --- 6. Load average ---
load=$(uptime | awk -F'load averages: ' '{print $2}' | awk '{print $1}' | tr -d ',')
info+=("Load — $load")

# --- Build report ---
timestamp=$(date '+%Y-%m-%d %H:%M')

if [ ${#issues[@]} -eq 0 ]; then
    echo "[$timestamp] HEALTHCHECK OK — ${#info[@]} checks passed"
    exit 0
fi

# Problems found — alert
report="SYSTEM HEALTHCHECK — $timestamp\n\n"
for issue in "${issues[@]}"; do
    report+="[ISSUE] $issue\n"
done
report+="\nHealthy:\n"
for i in "${info[@]}"; do
    report+="$i\n"
done

echo -e "$report"

# --- Alert to Telegram ---
if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    tg_text=$(echo -e "$report" | head -20)
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=${tg_text}" >/dev/null 2>&1 || true
fi

# --- Alert to bridge ---
bridge_msg="[CRON-ALERT] system-healthcheck: $(echo -e "$report" | tr '\n' ' ' | head -c 500)"
curl -s -X POST "$BRIDGE_URL" \
    -H "Content-Type: application/json" \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$bridge_msg\"}]}" \
    --connect-timeout 5 --max-time 10 >/dev/null 2>&1 || true

echo "ALERT SENT"
