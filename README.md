# OpenClaw ↔ Claude Code Bridge

A lightweight bridge that connects [OpenClaw](https://openclaw.ai) to Claude Code running locally — keeping Claude Opus as your AI orchestrator on a **flat Max subscription**, with zero per-token API costs.

## The Problem

OpenClaw normally routes AI requests to Anthropic's API (pay-per-token). When you want Opus-level intelligence without API billing, you need a different approach.

## The Solution

```
Telegram → OpenClaw (:18789) → Bridge (:18790) → Claude Code (tmux) → Response → Telegram
```

Claude Code runs in a persistent `tmux` session. The bridge is a Node.js HTTP server (~100 lines) that translates OpenClaw's chat completion requests into Claude Code CLI inputs via `tmux send-keys`, then captures responses via Claude Code's Stop hook.

**Total cost: Claude Max subscription (~$100/mo) + $10/mo for sub-agents. No Anthropic API charges.**

---

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│   Telegram  │ ←────────────────→ │ OpenClaw Gateway │
└─────────────┘                    │    :18789        │
                                   └────────┬─────────┘
                                            │ HTTP POST
                                   ┌────────▼─────────┐
                                   │  Bridge Server   │
                                   │  (Node.js :18790)│
                                   └────────┬─────────┘
                                            │ tmux send-keys
                                   ┌────────▼─────────┐
                                   │   Claude Code    │
                                   │  (tmux session)  │
                                   └────────┬─────────┘
                                            │ Stop hook
                                   ┌────────▼─────────┐
                                   │  Response JSON   │
                                   │  /tmp/response   │
                                   └──────────────────┘
```

### Sub-agent delegation

| Agent | Model | Cost | Use case |
|-------|-------|------|----------|
| Main (this bridge) | Claude Opus/Sonnet (Max sub) | Flat rate | Orchestration, strategy, architecture |
| Codex | GPT-4o (ChatGPT browser login) | $0 extra | Code, scripts, debugging |
| MiniMax | MiniMax M2.7 (API) | ~$10/mo | Research, summaries, routine tasks |
| Gemini Flash | Gemini (OAuth) | $0 | Fast cheap tasks |
| Local LLM | Ollama on local machine | $0 | Batch inference, private data |

---

## Files

| File | Description |
|------|-------------|
| `scripts/claude-code-server.js` | Node.js HTTP bridge server — receives OpenClaw requests, forwards to Claude Code |
| `scripts/claude-code-bridge.sh` | Bash bridge — sends message to tmux, waits for Stop hook response |
| `scripts/darvin-stop-hook.sh` | Claude Code Stop hook — captures clean response text |
| `scripts/process-queue.sh` | Message queue processor — handles queued messages when Claude is busy |
| `scripts/start.sh` | Start the bridge (tmux session + HTTP server) |
| `scripts/stop.sh` | Stop the bridge |
| `scripts/system-healthcheck.sh` | Health monitoring — checks gateway, bridge, tmux, disk, RAM |
| `config.example.json` | Config template |

---

## Setup

### Requirements

- macOS or Linux
- [Claude Code CLI](https://claude.ai/code) with Max subscription
- [OpenClaw](https://openclaw.ai)
- Node.js 18+
- tmux
- jq

### Installation

```bash
# 1. Clone this repo
git clone https://github.com/iaart-art/openclaw-claude-bridge
cd openclaw-claude-bridge

# 2. Copy and fill in config
cp config.example.json config.json
# Edit config.json with your Telegram bot token, chat ID, paths

# 3. Set up Claude Code Stop hook
# Add to ~/.claude/settings.json:
# {
#   "hooks": {
#     "Stop": [{ "type": "command", "command": "bash /path/to/scripts/darvin-stop-hook.sh" }]
#   }
# }

# 4. Configure OpenClaw to use the bridge
# In OpenClaw settings, set your model endpoint to:
# http://localhost:18790/v1/chat/completions

# 5. Start
bash scripts/start.sh
```

### Message Queue (optional)

When Claude Code is busy, incoming messages are queued automatically. A system cron processes the queue every 2 minutes at zero token cost:

```bash
# Add to crontab (crontab -e):
*/2 * * * * bash /path/to/scripts/process-queue.sh
```

### Health Monitoring

```bash
# Run manually
bash scripts/system-healthcheck.sh

# Or add to OpenClaw cron for automatic hourly alerts
```

---

## How the Stop Hook works

Claude Code fires a Stop hook after every response. The hook writes clean response text to a JSON file:

```json
{ "message": "...", "timestamp": "1234567890", "session_id": "..." }
```

The bridge polls this file, detects the new timestamp, and delivers the response back through OpenClaw to Telegram. **No screen scraping, no parsing terminal output** — clean structured data.

---

## Security notes

- The bridge listens on `localhost` only by default
- No credentials are stored in this repo — use `config.json` (gitignored)
- The Stop hook only writes to local temp files
- Health checks POST to localhost, not external services

---

## Contributing

Pull requests welcome. This is a practical system built for daily use — if you improve it, share it.

## License

MIT

---

Built by [IA Art](https://iaart.art) — Pazardzhik, Bulgaria  
Contact: office@iaart.art
