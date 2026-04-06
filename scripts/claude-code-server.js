#!/usr/bin/env node
/**
 * claude-code-server.js — OpenAI-compatible HTTP bridge to Claude Code
 *
 * Receives chat completion requests from OpenClaw, forwards them to
 * Claude Code running in a tmux session, and delivers responses back
 * to Telegram via OpenClaw gateway.
 *
 * Response capture uses Claude Code's Stop hook (clean text, no scraping).
 *
 * Configuration: reads from config.json in the package root directory.
 */

const http = require("http");
const { execFile, execSync } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");

// --- Load Config ---
const CONFIG_PATHS = [
  path.join(__dirname, "..", "config.json"),
  path.join(process.env.HOME || "", ".claude-bridge", "config.json"),
];
let config = {};
for (const p of CONFIG_PATHS) {
  try {
    config = JSON.parse(fs.readFileSync(p, "utf-8"));
    break;
  } catch {}
}

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || config.port || "18790");
const BRIDGE = path.join(__dirname, "claude-code-bridge.sh");
const TIMEOUT = config.timeout_ms || 300_000;
const OPENCLAW = (config.openclaw_bin || "~/.openclaw/bin/openclaw").replace("~", process.env.HOME);
const TELEGRAM_TARGET = config.telegram_chat_id || "";
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token || "";
const TMUX_SESSION = config.tmux_session || "claude-code";
const TMUX = process.env.TMUX_PATH || "/opt/homebrew/bin/tmux";
const TMUX_PANE = `${TMUX_SESSION}:0.0`;
const LOG_FILE = (config.log_file || "").replace("~", process.env.HOME);

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// --- Logging ---
function log(level, msg, data) {
  const entry = JSON.stringify({ time: new Date().toISOString(), level, msg, ...data });
  console.log(entry);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, entry + "\n"); } catch {}
  }
}

// --- Claude Code Status ---
function getClaudeStatus() {
  try {
    const pane = execSync(`${TMUX} capture-pane -t ${TMUX_PANE} -p -S -30`, { timeout: 2000 }).toString();
    const lines = pane.split("\n").filter(l => l.trim());

    let activity = "🧠 Мисли...";
    let workTime = "";
    let liveStatus = "";
    let toolUses = "";

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i].trim();

      const thinkMatch = line.match(/[✳✻☆★⚡]\s*(\w+[…\.]+)\s*\(([^)]+)\)/);
      if (thinkMatch && !liveStatus) liveStatus = `${thinkMatch[1]} (${thinkMatch[2]})`;

      const toolMatch = line.match(/\+(\d+)\s+more tool use/);
      if (toolMatch && !toolUses) toolUses = `🔧 ${toolMatch[1]} tools`;

      if (activity === "🧠 Мисли...") {
        if (line.match(/^⏺\s*Read/i)) activity = "📖 Чете файл...";
        else if (line.match(/^⏺\s*Write/i)) activity = "✏️ Пише файл...";
        else if (line.match(/^⏺\s*Edit/i)) activity = "✏️ Редактира...";
        else if (line.match(/^⏺\s*Bash/i) || line.match(/^⏺.*\$/)) activity = "⚙️ Изпълнява команда...";
        else if (line.match(/^⏺\s*Glob/i) || line.match(/^⏺\s*Grep/i)) activity = "🔍 Търси...";
        else if (line.match(/^⏺\s*WebSearch/i) || line.match(/^⏺\s*WebFetch/i)) activity = "🌐 Търси в уеб...";
        else if (line.match(/^⏺\s*Agent/i)) activity = "🤖 Стартира агент...";
        else if (line.match(/Read \d+ file/)) activity = "📖 Чете файлове...";
      }

      const timeMatch = line.match(/[✻]\s*(Worked|Cooked|Sautéed|Simmered)\s+for\s+(.+)/);
      if (timeMatch && !workTime) workTime = timeMatch[2];
    }

    if (liveStatus) activity = `⚡ ${liveStatus}`;
    else if (pane.includes("esc to interrupt")) {
      if (activity === "🧠 Мисли...") activity = "✍️ Генерира отговор...";
    }
    if (toolUses && !activity.includes("tool")) activity += ` | ${toolUses}`;

    // Token usage from session JSONL
    let tokens = null;
    try {
      const homeDir = process.env.HOME || "";
      const projectDir = `${homeDir}/.claude/projects/-Users-${path.basename(homeDir)}`;
      const latestSession = execSync(`ls -t "${projectDir}"/*.jsonl 2>/dev/null | head -1`, { timeout: 1000 }).toString().trim();
      if (latestSession) {
        const lastAssistant = execSync(`grep '"type":"assistant"' "${latestSession}" | tail -1`, { timeout: 1000 }).toString().trim();
        if (lastAssistant) {
          const u = JSON.parse(lastAssistant).message?.usage;
          if (u) {
            tokens = {
              input: u.input_tokens || 0,
              output: u.output_tokens || 0,
              cacheRead: u.cache_read_input_tokens || 0,
            };
          }
        }
      }
    } catch {}

    return { activity, workTime, tokens, toolUses };
  } catch { return { activity: "🧠 Обработва...", workTime: "", tokens: null, toolUses: "" }; }
}

// --- Telegram Helpers ---
async function sendStatusMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch { return null; }
}

async function editStatusMessage(chatId, messageId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" }),
    });
  } catch {}
}

async function deleteMessage(chatId, messageId) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {}
}

// --- Progress Indicator ---
function startProgressIndicator(chatId) {
  let active = true;
  let messageId = null;
  let tick = 0;
  const startTime = Date.now();

  const update = async () => {
    if (!active) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const spinner = SPINNERS[tick % SPINNERS.length];
    const { activity, workTime, tokens, toolUses } = getClaudeStatus();
    tick++;

    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}м ${secs}с` : `${secs}с`;

    const barLen = 10;
    const filled = Math.min(barLen, Math.floor(elapsed / 3));
    const bar = "▓".repeat(filled) + "░".repeat(barLen - filled);

    let text = `${spinner} ${activity}\n${bar} ${timeStr}`;
    if (workTime) text += ` (${workTime})`;

    if (tokens) {
      const fmt = (n) => n > 1000 ? `${(n/1000).toFixed(1)}k` : `${n}`;
      text += `\n📊 in:${fmt(tokens.input)} out:${fmt(tokens.output)}`;
      if (tokens.cacheRead > 0) text += ` cache:${fmt(tokens.cacheRead)}`;
      text += `\n📊 total: ${fmt(tokens.input + tokens.output)} tokens`;
      if (toolUses) text += ` | ${toolUses}`;
    } else if (toolUses) {
      text += `\n${toolUses}`;
    }

    // Typing indicator
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});

    if (!messageId) messageId = await sendStatusMessage(chatId, text);
    else await editStatusMessage(chatId, messageId, text);
  };

  update();
  const interval = setInterval(update, 3000);

  return async () => {
    active = false;
    clearInterval(interval);
    if (messageId) await deleteMessage(chatId, messageId);
  };
}

// --- Message Parsing ---
function messagesToPrompt(messages) {
  if (!messages || !messages.length) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const parts = [];
        for (const c of msg.content) {
          if (c.type === "text") parts.push(c.text);
          else if (c.type === "image_url" && c.image_url?.url)
            parts.push(`[Attached image: ${c.image_url.url}]`);
        }
        content = parts.join("\n");
      }
      if (!content) continue;

      // Strip OpenClaw metadata
      content = content.replace(/```json\s*\{[\s\S]*?\}\s*```/g, "").trim();
      content = content.replace(/Sender\s*\(untrusted metadata\):/gi, "").trim();
      content = content.replace(/Conversation info \(untrusted metadata\):/gi, "").trim();
      content = content.replace(/^\{[\s\S]*?\}\s*/gm, "").trim();
      content = content.replace(/<media:image>/g, "").trim();

      if (content) return content;
    }
  }
  return "";
}

// --- Model & Effort Switching ---
function switchModel(modelId) {
  const match = modelId.match(/^(opus|sonnet|haiku)-(high|medium|low)$/);
  if (!match) return;
  const [, model, effort] = match;
  try {
    execSync(`${TMUX} send-keys -t ${TMUX_PANE} "/model ${model}" Enter`, { timeout: 3000 });
    execSync("sleep 2");
    execSync(`${TMUX} send-keys -t ${TMUX_PANE} "/effort ${effort}" Enter`, { timeout: 3000 });
    execSync("sleep 1");
    log("info", "Model switched", { model, effort });
  } catch (err) {
    log("warn", "Model switch failed", { error: err.message });
  }
}

// --- Bridge ---
function callBridge(prompt) {
  return new Promise((resolve, reject) => {
    log("info", "Calling bridge", { promptLength: prompt.length });
    execFile("/bin/bash", [BRIDGE, prompt], {
      timeout: TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    }, (err, stdout) => {
      if (err) { log("error", "Bridge error", { error: err.message }); reject(err); return; }
      resolve(stdout.trim());
    });
  });
}

// --- Telegram Delivery ---
function deliverViaTelegram(text, mediaUrls) {
  const idempotencyKey = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!mediaUrls) {
    mediaUrls = [];
    const matches = text.match(/(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf))/gi);
    if (matches) mediaUrls.push(...matches);
  }

  const params = { channel: "telegram", to: TELEGRAM_TARGET, message: text, idempotencyKey };
  if (mediaUrls.length === 1) params.mediaUrl = mediaUrls[0];
  else if (mediaUrls.length > 1) params.mediaUrls = mediaUrls;

  execFile(OPENCLAW, ["gateway", "call", "send", "--params", JSON.stringify(params), "--json"], {
    timeout: 30_000,
    env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  }, (err) => {
    if (err) log("error", "Telegram delivery failed", { error: err.message });
    else log("info", "Delivered to Telegram", { chars: text.length, media: mediaUrls.length });
  });
}

// --- Response Builder ---
function buildResponse(content, model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "claude-code",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// --- HTTP Handler ---
async function handleRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live", provider: "claude-code-tmux" }));
    return;
  }

  if (req.url === "/v1/models" && req.method === "GET") {
    const models = ["opus-high","opus-medium","opus-low","sonnet-high","sonnet-medium","sonnet-low","haiku-high","haiku-medium","haiku-low"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: models.map(id => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "claude-code-tmux" })),
    }));
    return;
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
      return;
    }

    const prompt = messagesToPrompt(parsed.messages);
    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No messages" } }));
      return;
    }

    log("info", "Request received", { model: parsed.model, promptLength: prompt.length });

    // Ack immediately
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildResponse("⏳", parsed.model || "claude-code")));

    // Switch model/effort if needed
    switchModel(parsed.model || "");

    // Progress indicator
    const stopProgress = startProgressIndicator(TELEGRAM_TARGET);

    // Process and deliver
    callBridge(prompt).then(async (response) => {
      await stopProgress();
      log("info", "Response ready", { chars: response.length });
      deliverViaTelegram(response);
    }).catch(async (err) => {
      await stopProgress();
      log("error", "Bridge failed", { error: err.message });
      deliverViaTelegram(`❌ Error: ${err.message}`);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}

// --- Start Server ---
const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  log("info", "Claude Code bridge server started", { port: PORT, config: CONFIG_PATHS.find(p => fs.existsSync(p)) || "defaults" });
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
