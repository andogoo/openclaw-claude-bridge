#!/usr/bin/env bash
# system-healthcheck.sh — проверява здравето на OpenClaw системата
# Извиква се от OpenClaw cron на всеки час
# При проблем → POST до Claude Code bridge + Telegram alert

set -euo pipefail

BRIDGE_URL="http://localhost:18790/v1/chat/completions"
GATEWAY_URL="http://localhost:18789/health"
OPENCLAW="/opt/homebrew/bin/openclaw"
BOT_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.openclaw/openclaw.json')); print(d['channels']['telegram']['botToken'])" 2>/dev/null || echo "")
CHAT_ID="8483895344"
ALERT_THRESHOLD_DISK=85
ALERT_THRESHOLD_RAM=90

issues=()
info=()

# --- 1. Gateway health ---
gw_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$GATEWAY_URL" 2>/dev/null || echo "000")
if [ "$gw_status" = "200" ]; then
    info+=("Gateway :18789 — OK")
else
    issues+=("❌ Gateway :18789 DEAD (HTTP $gw_status)")
fi

# --- 2. Bridge health ---
bridge_status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$BRIDGE_URL" -X POST \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"HEALTHCHECK_PING"}]}' 2>/dev/null || echo "000")
if [ "$bridge_status" = "200" ]; then
    info+=("Bridge :18790 — OK")
else
    issues+=("❌ Bridge :18790 DEAD (HTTP $bridge_status)")
fi

# --- 3. tmux session ---
if /opt/homebrew/bin/tmux has-session -t claude-code 2>/dev/null; then
    info+=("tmux claude-code — OK")
else
    issues+=("❌ tmux session 'claude-code' NOT FOUND")
fi

# --- 4. Failed cron jobs ---
failed_crons=$($OPENCLAW gateway call cron.list --json 2>/dev/null | python3 -c "
import json,sys,re
raw = sys.stdin.read()
match = re.search(r'\{[\s\S]*\}', raw)
if match:
    d = json.loads(match.group())
    failed = []
    for j in d.get('jobs',[]):
        if j.get('state',{}).get('lastRunStatus') == 'error' and j.get('enabled', True):
            failed.append(j.get('name','?'))
    if failed:
        print(', '.join(failed))
" 2>/dev/null || echo "")

if [ -n "$failed_crons" ]; then
    issues+=("⚠️ Failed crons: $failed_crons")
else
    info+=("Cron jobs — all OK")
fi

# --- 5. Disk usage ---
disk_pct=$(df -h / | awk 'NR==2{gsub(/%/,""); print $5}')
if [ "$disk_pct" -ge "$ALERT_THRESHOLD_DISK" ]; then
    issues+=("❌ Disk ${disk_pct}% used (threshold ${ALERT_THRESHOLD_DISK}%)")
else
    info+=("Disk — ${disk_pct}% used")
fi

# --- 6. RAM pressure ---
ram_pressure=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%' || echo "0")
ram_used=$((100 - ${ram_pressure:-0}))
if [ "$ram_used" -ge "$ALERT_THRESHOLD_RAM" ]; then
    issues+=("❌ RAM ${ram_used}% used (threshold ${ALERT_THRESHOLD_RAM}%)")
else
    info+=("RAM — ${ram_used}% used")
fi

# --- 7. Load average ---
load=$(uptime | awk -F'load averages: ' '{print $2}' | awk '{print $1}' | tr -d ',')
info+=("Load — $load")

# --- Build report ---
timestamp=$(date '+%Y-%m-%d %H:%M')

if [ ${#issues[@]} -eq 0 ]; then
    # All good — silent (no alert needed)
    echo "[$timestamp] HEALTHCHECK OK — ${#info[@]} checks passed"
    exit 0
fi

# Problems found — alert!
report="🔴 SYSTEM HEALTHCHECK — $timestamp\n\n"
for issue in "${issues[@]}"; do
    report+="$issue\n"
done
report+="\n✅ Healthy:\n"
for i in "${info[@]}"; do
    report+="$i\n"
done

echo -e "$report"

# --- Alert to Telegram ---
if [ -n "$BOT_TOKEN" ]; then
    tg_text=$(echo -e "$report" | head -20)
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=${tg_text}" \
        -d "parse_mode=HTML" >/dev/null 2>&1 || true
fi

# --- Alert to Claude Code bridge ---
bridge_msg="[CRON-ALERT] system-healthcheck: $(echo -e "$report" | tr '\n' ' ' | sed 's/"/\\"/g' | head -c 500)"
python3 -c "
import json, subprocess, sys
msg = sys.argv[1]
payload = json.dumps({'messages':[{'role':'user','content': msg}]})
subprocess.run(['curl','-s','-X','POST','$BRIDGE_URL','-H','Content-Type: application/json','-d',payload], capture_output=True, timeout=10)
" "$bridge_msg" 2>/dev/null || true

echo "ALERT SENT"
