# OpenClaw ↔ Claude Code Bridge v2

A lightweight bridge that connects [OpenClaw](https://openclaw.ai) to Claude Code running locally — keeping Claude Opus as your AI orchestrator on a **flat Max subscription**, with zero per-token API costs.

## The Problem

OpenClaw normally routes AI requests to Anthropic's API (pay-per-token). When you want Opus-level intelligence without API billing, you need a different approach.

## The Solution

```
Telegram → OpenClaw (:18789) → Bridge (:18790) → Claude Code (tmux) → Response → Telegram
                                     ↑
                              Telegram Webhook
                              (instant, <1s)
```

Claude Code runs in a persistent `tmux` session. The bridge is a Node.js HTTP server that translates OpenClaw's chat completion requests into Claude Code CLI inputs via `tmux load-buffer/paste-buffer` (safe UTF-8), then captures responses via Claude Code's Stop hook POST.

**Total cost: Claude Max subscription (~$100/mo). No Anthropic API charges.**

---

## What's New in v2

| Feature | v1 | v2 |
|---------|----|----|
| **Message queue** | File-based, lossy | SQLite WAL, durable |
| **Response capture** | File polling (slow) | Stop hook POST (instant) |
| **UTF-8 injection** | `send-keys` (breaks on Cyrillic) | `load-buffer/paste-buffer` (safe) |
| **Busy handling** | Drop message | Retry 3x at 5s intervals |
| **Delivery ACK** | None (silent) | Immediate Telegram confirmation |
| **Progress indicator** | None | Live Telegram updates (activity, tokens, elapsed) |
| **Status API** | None | `/status` JSON + `/events` SSE stream |
| **Telegram delivery** | Polling (15-30s avg) | Webhook (<1s) |
| **Model switching** | None | `/model` + `/effort` via tmux injection |
| **Idle detection** | Screen scraping | Active-job.json marker |

---

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│   Telegram  │ ←────────────────→ │ OpenClaw Gateway │
└─────────────┘                    │    :18789        │
       │                           └────────┬─────────┘
       │ Webhook (optional)                 │ HTTP POST
       │                           ┌────────▼─────────┐
       └──────────────────────────→│  Bridge Server   │
                                   │  (Node.js :18790)│
                                   │                  │
                                   │  ┌────────────┐  │
                                   │  │ SQLite WAL │  │
                                   │  │ Job Queue  │  │
                                   │  └────────────┘  │
                                   └────────┬─────────┘
                                            │ tmux load-buffer
                                   ┌────────▼─────────┐
                                   │   Claude Code    │
                                   │  (tmux session)  │
                                   └────────┬─────────┘
                                            │ Stop hook POST
                                   ┌────────▼─────────┐
                                   │  Bridge receives  │
                                   │  response instant │
                                   └──────────────────┘
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/chat/completions` | POST | OpenAI-compatible chat endpoint |
| `/v1/models` | GET | Available model list |
| `/status` | GET | Full JSON status (busy, queue, tokens, activity) |
| `/events` | GET | SSE stream (live status, heartbeat, ACK, response events) |
| `/telegram/webhook` | POST | Telegram Bot API webhook receiver |
| `/internal/claude-stop` | POST | Stop hook response delivery |
| `/internal/queue-stats` | GET | Queue statistics |

---

## Files

| File | Description |
|------|-------------|
| `scripts/claude-code-server.js` | Node.js HTTP bridge server — queue, ACK, SSE, webhooks, progress |
| `scripts/job-queue.js` | **NEW** SQLite WAL job queue — zero dependencies (Node.js 22.5+) |
| `scripts/claude-code-bridge.sh` | Bash bridge — load-buffer injection, idle detection, lock management |
| `scripts/darvin-stop-hook.sh` | Claude Code Stop hook — POST + file response, memory logging |
| `scripts/process-queue.sh` | Legacy file-based queue processor (v2 uses SQLite instead) |
| `scripts/start.sh` | Start the bridge (tmux session + HTTP server) |
| `scripts/stop.sh` | Stop the bridge |
| `scripts/watchdog.sh` | Auto-restart monitor (checks every 30s) |
| `scripts/system-healthcheck.sh` | Health monitoring — gateway, bridge, tmux, disk, RAM |
| `config.example.json` | Config template |

---

## Setup

### Requirements

- macOS or Linux
- [Claude Code CLI](https://claude.ai/code) with Max subscription
- [OpenClaw](https://openclaw.ai)
- **Node.js 22.5+** (required for built-in `node:sqlite`)
- tmux
- jq

### Installation

```bash
# 1. Clone this repo
git clone https://github.com/andogoo/openclaw-claude-bridge
cd openclaw-claude-bridge

# 2. Copy and fill in config
cp config.example.json config.json
# Edit config.json with your Telegram bot token, chat ID, paths

# 3. Set up Claude Code Stop hook
# Add to ~/.claude/settings.json:
{
  "hooks": {
    "Stop": [{
      "type": "command",
      "command": "bash /path/to/scripts/darvin-stop-hook.sh"
    }]
  }
}

# 4. (Optional) Set up Telegram webhook access control
# Create ~/.claude/channels/telegram/access.json:
{
  "allowFrom": ["YOUR_TELEGRAM_USER_ID"]
}

# 5. Configure OpenClaw to use the bridge
# In OpenClaw settings, set your model endpoint to:
# http://localhost:18790/v1/chat/completions

# 6. Start
bash scripts/start.sh
```

### Telegram Webhook (Optional — replaces polling)

For instant (<1s) Telegram message delivery, set up a webhook:

```bash
# Option A: Cloudflare Tunnel (recommended)
cloudflared tunnel --url http://localhost:18790

# Option B: ngrok
ngrok http 18790

# Register webhook with Telegram
curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=https://YOUR_TUNNEL_URL/telegram/webhook"

# Verify
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

### Watchdog (Optional)

Auto-restart if bridge or tmux goes down:

```bash
bash scripts/watchdog.sh --daemon &
```

### Health Monitoring

```bash
# Run manually
bash scripts/system-healthcheck.sh

# Or add to crontab for automatic hourly checks:
0 * * * * bash /path/to/scripts/system-healthcheck.sh
```

---

## How It Works

### 1. Message Flow

1. User sends message via Telegram
2. OpenClaw gateway receives it, forwards to bridge as OpenAI-compatible chat completion
3. Bridge enqueues in SQLite job queue
4. Bridge sends **delivery ACK** to Telegram ("Received...")
5. Bridge injects message into Claude Code via `tmux load-buffer/paste-buffer`
6. **Progress indicator** updates in Telegram every 3s (activity, tokens, elapsed time)
7. Claude Code generates response
8. **Stop hook** fires, POSTs response JSON to bridge `/internal/claude-stop`
9. Bridge delivers response back through OpenClaw to Telegram

### 2. Stop Hook (Instant Response)

Claude Code fires a Stop hook after every response. The hook:
1. Writes response to a JSON file (fallback)
2. **POSTs response to bridge server** (instant — no polling delay)
3. Clears active-job marker

The bridge races these two sources — first response wins. No screen scraping, no parsing terminal output.

### 3. Safe UTF-8 Injection

`tmux send-keys` breaks on non-ASCII characters (Cyrillic, emoji, special chars). v2 uses:

```
message → temp file → tmux load-buffer → tmux paste-buffer → Enter
```

This handles any UTF-8 content safely, including multiline messages.

### 4. SQLite Job Queue

Zero-dependency queue using Node.js built-in `node:sqlite`:
- **WAL mode** for concurrent reads + single writer
- **State machine**: `pending → running → waiting_stop → delivering → done | failed`
- **Stale lease detection**: if a worker PID dies, jobs are auto-recovered
- **Cleanup**: keeps last 100 completed jobs, prunes the rest

### 5. Busy Retry

When Claude Code is busy (lock active), instead of dropping the message:
1. First retry: wait 5s, re-enqueue
2. Second retry: wait 5s, re-enqueue
3. Third retry: wait 5s, re-enqueue
4. After 3 retries: fail with error message to user

### 6. Model Switching

The bridge supports model selection via the OpenAI `model` parameter:

```
opus-high, opus-medium, opus-low
sonnet-high, sonnet-medium, sonnet-low
haiku-high, haiku-medium, haiku-low
```

It injects `/model` and `/effort` commands into Claude Code via tmux.

---

## API Examples

### Send a message

```bash
curl -X POST http://localhost:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus-high",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Check status

```bash
curl http://localhost:18790/status
# Returns: { alive, busy, activity, queue, uptime, tokens, current_job, messages }
```

### Stream live events (SSE)

```bash
curl -N http://localhost:18790/events
# event: status
# data: {"busy":true,"activity":"📖 Reading file...","queue":{"running":1}}
#
# event: heartbeat
# data: {"ts":"2025-01-15T10:30:00Z","uptime":3600}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TMUX_PATH` | auto-detect | Path to tmux binary |
| `CLAUDE_BRIDGE_RESPONSE_FILE` | `/tmp/claude-bridge-response.json` | Stop hook response file |
| `CLAUDE_BRIDGE_URL` | `http://127.0.0.1:18790/internal/claude-stop` | Stop hook POST URL |
| `CLAUDE_BRIDGE_MEMORY_DIR` | (none) | Directory for daily memory logs |

---

## Security Notes

- The bridge listens on `127.0.0.1` only by default
- No credentials stored in this repo — use `config.json` (gitignored)
- Telegram webhook validates user IDs against access.json allowlist
- The Stop hook only writes to local temp files
- SQLite database is in `/tmp/` (ephemeral)

---

## Contributing

Pull requests welcome. This is a practical system built for daily use.

## License

MIT
