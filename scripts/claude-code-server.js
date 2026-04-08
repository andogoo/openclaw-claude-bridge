#!/usr/bin/env node
/**
 * claude-code-server.js v2 — Robust bridge with SQLite queue + Stop hook POST
 *
 * Key improvements over v1:
 *   1. /internal/claude-stop POST endpoint (instant response from Stop hook)
 *   2. SQLite WAL queue with state machine (no lock files, durable)
 *   3. Reply adapters: OpenClaw gateway + Telegram Bot API
 *   4. Bridge-owned idle detection (active-job.json, no screen scraping)
 *   5. Queue processor loop (dequeues + dispatches sequentially)
 *   6. Channel routing via message source detection
 *   7. Delivery ACK — immediate Telegram confirmation for every message
 *   8. SSE /events endpoint — live status stream for dashboards
 *   9. /status JSON endpoint — full system state
 *  10. Telegram webhook endpoint — instant message delivery (<1s)
 *  11. Busy retry — re-enqueue 3x at 5s intervals instead of dropping
 *  12. Progress indicator — live Telegram updates with activity, tokens, elapsed time
 *
 * Requirements: Node.js 22.5+ (for built-in node:sqlite used by job-queue.js)
 * Configuration: reads from ../config.json or ~/.openclaw/config.json
 */

const http = require("http");
const { execFile, execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const { JobQueue } = require("./job-queue");

// --- Load Config ---
const CONFIG_PATHS = [
  path.join(__dirname, "..", "config.json"),
  path.join(process.env.HOME || "", ".openclaw", "config.json"),
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
const TIMEOUT = config.timeout_ms || 900_000;
const OPENCLAW = (config.openclaw_bin || "openclaw").replace("~", process.env.HOME);
const TELEGRAM_TARGET = config.telegram_chat_id || "";
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token || "";
const TMUX_SESSION = config.tmux_session || "claude-code";
const TMUX_BIN = process.env.TMUX_PATH || config.tmux_bin || "tmux";
const UID = process.getuid ? process.getuid() : 501;
const TMUX_SOCKET = `/private/tmp/tmux-${UID}/default`;
const TMUX_ARGS = fs.existsSync(TMUX_SOCKET) ? ["-S", TMUX_SOCKET] : [];
const TMUX_PANE = `${TMUX_SESSION}:0.0`;
const ACTIVE_JOB_FILE = config.active_job_file || "/tmp/claude-bridge-active-job.json";

const SPINNERS = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const SERVER_START = Date.now();

// --- Initialize Queue ---
const queue = new JobQueue();

// --- Pending Stop hook resolvers ---
let stopHookResolver = null;

// --- SSE clients ---
const sseClients = new Set();
let lastResponseTime = null;
let currentJobMeta = null;

function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// --- Message log (last 20) ---
const messageLog = [];
function logMessage(direction, text, source) {
  messageLog.push({ direction, text: text.slice(0, 500), source, ts: new Date().toISOString() });
  if (messageLog.length > 20) messageLog.shift();
}

// --- Logging ---
function log(level, msg, data) {
  const entry = JSON.stringify({ time: new Date().toISOString(), level, msg, ...data });
  console.log(entry);
}

// --- Safe tmux command execution ---
function tmuxSync(args, opts = {}) {
  return execFileSync(TMUX_BIN, [...TMUX_ARGS, ...args], { timeout: 3000, ...opts });
}

// --- System Message Detection ---
function isSystemMessage(prompt) {
  if (!prompt) return false;
  return /^HEALTHCHECK_PING/i.test(prompt) ||
         /\[CRON-ALERT\]/i.test(prompt) ||
         /HEALTHCHECK/i.test(prompt) ||
         /system-healthcheck/i.test(prompt);
}

function isHealthcheck(prompt) {
  return /^HEALTHCHECK_PING/i.test(prompt);
}

// --- Source Detection ---
// Customize the tag to match your Telegram bot's name
function detectSource(prompt) {
  if (prompt.includes("[Telegram @")) return "telegram";
  if (isSystemMessage(prompt)) return "system";
  return "openclaw";
}

// --- Claude Code Status (reads tmux pane for live activity) ---
function getClaudeStatus() {
  try {
    const pane = tmuxSync(["capture-pane", "-t", TMUX_PANE, "-p", "-S", "-30"], { timeout: 2000 }).toString();
    const lines = pane.split("\n").filter(l => l.trim());

    let activity = "\uD83E\uDDE0 Thinking...";
    let workTime = "";
    let liveStatus = "";
    let toolUses = "";

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const line = lines[i].trim();

      // Match Claude Code spinner patterns like: ✳ Working... (3s)
      const thinkMatch = line.match(/[\u2733\u273B\u2606\u2605\u26A1]\s*(\w+[\.]+)\s*\(([^)]+)\)/);
      if (thinkMatch && !liveStatus) liveStatus = `${thinkMatch[1]} (${thinkMatch[2]})`;

      const toolMatch = line.match(/\+(\d+)\s+more tool use/);
      if (toolMatch && !toolUses) toolUses = `\uD83D\uDD27 ${toolMatch[1]} tools`;

      if (activity === "\uD83E\uDDE0 Thinking...") {
        if (line.match(/^\u23FA\s*Read/i)) activity = "\uD83D\uDCD6 Reading file...";
        else if (line.match(/^\u23FA\s*Write/i)) activity = "\u270F\uFE0F Writing file...";
        else if (line.match(/^\u23FA\s*Edit/i)) activity = "\u270F\uFE0F Editing...";
        else if (line.match(/^\u23FA\s*Bash/i) || line.match(/^\u23FA.*\$/)) activity = "\u2699\uFE0F Running command...";
        else if (line.match(/^\u23FA\s*Glob/i) || line.match(/^\u23FA\s*Grep/i)) activity = "\uD83D\uDD0D Searching...";
        else if (line.match(/^\u23FA\s*WebSearch/i) || line.match(/^\u23FA\s*WebFetch/i)) activity = "\uD83C\uDF10 Web search...";
        else if (line.match(/^\u23FA\s*Agent/i)) activity = "\uD83E\uDD16 Running agent...";
        else if (line.match(/Read \d+ file/)) activity = "\uD83D\uDCD6 Reading files...";
      }

      const timeMatch = line.match(/[\u273B]\s*(Worked|Cooked|Saut\u00E9ed|Simmered)\s+for\s+(.+)/);
      if (timeMatch && !workTime) workTime = timeMatch[2];
    }

    if (liveStatus) activity = `\u26A1 ${liveStatus}`;
    else if (pane.includes("esc to interrupt")) {
      if (activity === "\uD83E\uDDE0 Thinking...") activity = "\u270D\uFE0F Generating response...";
    }
    if (toolUses && !activity.includes("tool")) activity += ` | ${toolUses}`;

    // Token usage from session JSONL (optional — reads Claude Code's session file)
    let tokens = null;
    try {
      const homeDir = process.env.HOME || "";
      const userName = path.basename(homeDir);
      const projectDir = `${homeDir}/.claude/projects/-Users-${userName}`;
      const latestSession = execFileSync("/bin/bash", ["-c", `ls -t "${projectDir}"/*.jsonl 2>/dev/null | head -1`], { timeout: 1000 }).toString().trim();
      if (latestSession) {
        const lastAssistant = execFileSync("/bin/bash", ["-c", `grep '"type":"assistant"' "${latestSession}" | tail -1`], { timeout: 1000 }).toString().trim();
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
  } catch {
    return { activity: "\uD83E\uDDE0 Processing...", workTime: "", tokens: null, toolUses: "" };
  }
}

// --- Telegram Helpers ---
async function sendStatusMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
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
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
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
// Shows live progress in Telegram: spinner, activity, elapsed time, token usage
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
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const barLen = 10;
    const filled = Math.min(barLen, Math.floor(elapsed / 3));
    const bar = "\u2593".repeat(filled) + "\u2591".repeat(barLen - filled);

    let text = `${spinner} ${activity}\n${bar} ${timeStr}`;
    if (workTime) text += ` (${workTime})`;

    if (tokens) {
      const fmt = (n) => n > 1000 ? `${(n/1000).toFixed(1)}k` : `${n}`;
      text += `\n\uD83D\uDCCA in:${fmt(tokens.input)} out:${fmt(tokens.output)}`;
      if (tokens.cacheRead > 0) text += ` cache:${fmt(tokens.cacheRead)}`;
      text += `\n\uD83D\uDCCA total: ${fmt(tokens.input + tokens.output)} tokens`;
      if (toolUses) text += ` | ${toolUses}`;
    } else if (toolUses) {
      text += `\n${toolUses}`;
    }

    // Send typing indicator
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

// --- Reply Adapters ---
// Customize these for your messaging setup

function replyViaOpenClaw(text) {
  const idempotencyKey = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const params = { channel: "telegram", to: TELEGRAM_TARGET, message: text, idempotencyKey };

  // Detect media URLs in response
  const mediaUrls = [];
  const matches = text.match(/(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf))/gi);
  if (matches) mediaUrls.push(...matches);
  if (mediaUrls.length === 1) params.mediaUrl = mediaUrls[0];
  else if (mediaUrls.length > 1) params.mediaUrls = mediaUrls;

  execFile(OPENCLAW, ["gateway", "call", "send", "--params", JSON.stringify(params), "--json"], {
    timeout: 30_000,
    env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  }, (err) => {
    if (err) log("error", "OpenClaw delivery failed", { error: err.message });
    else log("info", "Delivered via OpenClaw", { chars: text.length });
  });
}

function replyViaTelegram(chatId, text) {
  // When using webhook mode, Claude Code handles the reply via its MCP Telegram plugin.
  // Override this function if you want direct Bot API delivery instead.
  log("info", "Telegram reply — handled by Claude Code MCP plugin", { chars: text.length });
}

// --- Message Parsing ---
// Extracts the user's actual message from OpenAI-compatible chat format
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

      // Clean up OpenClaw wrapper metadata
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
// Claude Code supports /model and /effort slash commands — this injects them via tmux
let currentModel = "";
let currentEffort = "";

function switchModel(modelId) {
  const match = modelId.match(/^(opus|sonnet|haiku)-(high|medium|low)$/);
  if (!match) return;
  const [, model, effort] = match;

  if (model === currentModel && effort === currentEffort) {
    log("info", "Model already set, skipping switch", { model, effort });
    return;
  }

  try {
    const tmpFile = "/tmp/claude-bridge-model-cmd.txt";
    if (model !== currentModel) {
      fs.writeFileSync(tmpFile, `/model ${model}`);
      tmuxSync(["load-buffer", "-b", "modelcmd", tmpFile]);
      tmuxSync(["paste-buffer", "-b", "modelcmd", "-t", TMUX_PANE]);
      tmuxSync(["send-keys", "-t", TMUX_PANE, "Enter"]);
      execFileSync("/bin/sleep", ["2"]);
    }
    if (effort !== currentEffort) {
      fs.writeFileSync(tmpFile, `/effort ${effort}`);
      tmuxSync(["load-buffer", "-b", "modelcmd", tmpFile]);
      tmuxSync(["paste-buffer", "-b", "modelcmd", "-t", TMUX_PANE]);
      tmuxSync(["send-keys", "-t", TMUX_PANE, "Enter"]);
      execFileSync("/bin/sleep", ["1"]);
    }
    try { fs.unlinkSync(tmpFile); } catch {}
    try { tmuxSync(["delete-buffer", "-b", "modelcmd"]); } catch {}
    currentModel = model;
    currentEffort = effort;
    log("info", "Model switched", { model, effort });
  } catch (err) {
    log("warn", "Model switch failed", { error: err.message });
  }
}

// --- Bridge Execution ---
// Calls claude-code-bridge.sh and races Stop hook POST vs file-based response
function callBridge(prompt, jobId) {
  return new Promise((resolve, reject) => {
    log("info", "Calling bridge", { promptLength: prompt.length, jobId });

    const stopHookPromise = new Promise((res) => {
      stopHookResolver = res;
    });

    const bridgePromise = new Promise((res, rej) => {
      const args = [BRIDGE];
      if (jobId) args.push("--job-id", jobId);
      args.push(prompt);

      execFile("/bin/bash", args, {
        timeout: TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      }, (err, stdout) => {
        if (err) { rej(err); return; }
        res(stdout.trim());
      });
    });

    // First response wins — Stop hook POST is usually faster than file polling
    Promise.race([
      stopHookPromise.then(msg => ({ source: "stop-hook-post", message: msg })),
      bridgePromise.then(msg => ({ source: "bridge-file", message: msg })),
    ]).then(result => {
      stopHookResolver = null;
      log("info", "Response received", { source: result.source, chars: result.message.length });

      try {
        const parsed = JSON.parse(result.message);
        if (parsed.status === "busy") {
          reject(new Error("Bridge busy"));
          return;
        }
      } catch {}

      resolve(result.message);
    }).catch(err => {
      stopHookResolver = null;
      reject(err);
    });
  });
}

// --- Build OpenAI-compatible Response ---
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

// ═══════════════════════════════════════════════════════════
// HTTP Handler
// ═══════════════════════════════════════════════════════════

async function handleRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // --- /health ---
  if (req.url === "/health" || req.url === "/") {
    const stats = queue.stats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      status: "live",
      provider: "claude-code-tmux-v2",
      queue: stats,
      busy: queue.isBusy(),
    }));
    return;
  }

  // --- /internal/queue-stats ---
  if (req.url === "/internal/queue-stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(queue.stats()));
    return;
  }

  // --- /internal/claude-stop — Stop hook POST delivery (instant) ---
  if (req.url === "/internal/claude-stop" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const data = JSON.parse(body);
      const message = data.message || "";

      log("info", "Stop hook POST received", { chars: message.length });

      if (stopHookResolver && message) {
        stopHookResolver(message);
      }

      const waitingJob = queue.getWaitingJob();
      if (waitingJob && message) {
        queue.deliverResponse(waitingJob.id, message);
        log("info", "Job response delivered via Stop hook", { jobId: waitingJob.id });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    return;
  }

  // --- /telegram/webhook — Instant Telegram message delivery ---
  if (req.url === "/telegram/webhook" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    // Telegram requires response within 5 seconds — respond immediately
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    try {
      const update = JSON.parse(body);
      const msg = update.message;
      if (!msg || !msg.text) return;

      const chatId = String(msg.chat?.id || "");
      const userId = String(msg.from?.id || "");
      const username = msg.from?.username || userId;
      const text = msg.text;

      // Access check — only allow whitelisted user IDs
      const ACCESS_FILE = config.telegram_access_file ||
        path.join(process.env.HOME || "", ".claude", "channels", "telegram", "access.json");
      let allowed = [];
      try { allowed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf-8")).allowFrom || []; } catch {}

      if (!allowed.includes(userId)) {
        log("warn", "Webhook: unauthorized user", { userId, username });
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: "Access denied." }),
        }).catch(() => {});
        return;
      }

      log("info", "Webhook message received", { userId, username, text: text.slice(0, 80) });

      // Enqueue as telegram source
      const botName = config.telegram_bot_name || "YourBot";
      const prompt = `[Telegram @${botName}] ${text}`;
      const source = "telegram";

      if (isHealthcheck(prompt)) {
        log("info", "Webhook healthcheck, skipping bridge");
        return;
      }

      const jobId = queue.enqueue(prompt, source);
      const pending = queue.pendingCount();
      log("info", "Webhook job enqueued", { jobId, pending });

      // ACK — immediate confirmation
      logMessage("in", text, source);
      if (pending > 1) {
        sendStatusMessage(chatId, `\u2705 Received: "${text.slice(0, 50)}..." \u2014 ${pending - 1} ahead in queue`);
      }
      sseEmit("ack", { jobId, prompt_preview: text.slice(0, 50), pending });

      processNextJob();
    } catch (err) {
      log("error", "Webhook parse error", { error: err.message });
    }
    return;
  }

  // --- /status — Full JSON status ---
  if (req.url === "/status" && req.method === "GET") {
    const stats = queue.stats();
    const busy = queue.isBusy();
    const { activity, workTime, tokens, toolUses } = busy
      ? getClaudeStatus()
      : { activity: "\u2705 Idle", workTime: "", tokens: null, toolUses: "" };
    const uptimeMs = Date.now() - SERVER_START;
    const uptimeH = Math.floor(uptimeMs / 3600000);
    const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      alive: true,
      busy,
      activity,
      workTime: workTime || null,
      tokens: tokens || null,
      toolUses: toolUses || null,
      queue: stats,
      uptime: `${uptimeH}h ${uptimeM}m`,
      last_response: lastResponseTime,
      current_job: currentJobMeta,
      messages: messageLog.slice(-10),
    }));
    return;
  }

  // --- /events — Server-Sent Events for live status ---
  if (req.url === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial status snapshot
    const stats = queue.stats();
    const busy = queue.isBusy();
    const status = busy
      ? getClaudeStatus()
      : { activity: "\u2705 Idle", workTime: "", tokens: null, toolUses: "" };
    res.write(`event: status\ndata: ${JSON.stringify({ busy, ...status, queue: stats })}\n\n`);

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));

    // Heartbeat every 15s keeps connection alive
    const hb = setInterval(() => {
      try {
        const uptimeMs = Date.now() - SERVER_START;
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString(), uptime: Math.floor(uptimeMs / 1000) })}\n\n`);
      } catch { clearInterval(hb); sseClients.delete(res); }
    }, 15000);
    req.on("close", () => clearInterval(hb));
    return;
  }

  // --- /v1/models — OpenAI-compatible model list ---
  if (req.url === "/v1/models" && req.method === "GET") {
    const models = ["opus-high","opus-medium","opus-low","sonnet-high","sonnet-medium","sonnet-low","haiku-high","haiku-medium","haiku-low"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: models.map(id => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "claude-code-tmux-v2" })),
    }));
    return;
  }

  // --- /v1/chat/completions — Main endpoint (OpenAI-compatible) ---
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

    const source = detectSource(prompt);
    log("info", "Request received", { model: parsed.model, source, promptLength: prompt.length });

    // Respond immediately with placeholder (async processing)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildResponse("\u231B", parsed.model || "claude-code")));

    if (isHealthcheck(prompt)) {
      log("info", "Healthcheck handled without bridge");
      return;
    }

    const jobId = queue.enqueue(prompt, source);
    const pending = queue.pendingCount();
    log("info", "Job enqueued", { jobId, source, pending });

    // --- Delivery ACK ---
    if (source === "telegram" && !isSystemMessage(prompt)) {
      logMessage("in", prompt, source);
      const preview = prompt.replace(/\[Telegram @\w+\]\s*/i, "").slice(0, 50);
      if (pending > 1) {
        sendStatusMessage(TELEGRAM_TARGET, `\u2705 Received: "${preview}..." \u2014 ${pending - 1} ahead in queue`);
      }
      sseEmit("ack", { jobId, prompt_preview: preview, pending });
    } else if (source === "openclaw" && !isSystemMessage(prompt)) {
      logMessage("in", prompt, source);
      sseEmit("ack", { jobId, prompt_preview: prompt.slice(0, 50), pending });
    }

    switchModel(parsed.model || "");
    processNextJob();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}

// ═══════════════════════════════════════════════════════════
// Queue Processor
// ═══════════════════════════════════════════════════════════

let processing = false;

async function processNextJob() {
  if (processing) return;
  processing = true;

  try {
    while (true) {
      const job = queue.claim();
      if (!job) break;

      log("info", "Processing job", { jobId: job.id, source: job.source });

      const isSystem = isSystemMessage(job.prompt);

      // Track current job for /status endpoint
      if (!isSystem) {
        const preview = job.prompt.replace(/\[Telegram @\w+\]\s*/i, "").slice(0, 80);
        currentJobMeta = { id: job.id, prompt_preview: preview, started: Date.now() };
        sseEmit("status", { busy: true, activity: "\u2699\uFE0F Processing...", queue: queue.stats() });
      }

      // Start progress indicator in Telegram (live updates every 3s)
      const stopProgress = isSystem ? (async () => {}) : startProgressIndicator(TELEGRAM_TARGET);

      // SSE status updates during processing
      let sseStatusInterval = null;
      if (!isSystem) {
        sseStatusInterval = setInterval(() => {
          const s = getClaudeStatus();
          const elapsed = currentJobMeta ? Math.floor((Date.now() - currentJobMeta.started) / 1000) : 0;
          sseEmit("status", { busy: true, ...s, elapsed, queue: queue.stats() });
        }, 3000);
      }

      try {
        const response = await callBridge(job.prompt, job.id);
        await stopProgress();
        if (sseStatusInterval) clearInterval(sseStatusInterval);

        if (response && response.length > 0) {
          queue.deliverResponse(job.id, response);
          lastResponseTime = new Date().toISOString();
          logMessage("out", response, job.source);

          // Route response to the correct channel
          switch (job.source) {
            case "telegram":
              replyViaTelegram(job.chat_id, response);
              break;
            case "system":
              log("info", "System message processed", { chars: response.length });
              break;
            case "openclaw":
            default:
              replyViaOpenClaw(response);
              break;
          }

          queue.complete(job.id);
          log("info", "Job completed", { jobId: job.id, chars: response.length });

          sseEmit("response", { jobId: job.id, text_preview: response.slice(0, 200) });
        } else {
          queue.fail(job.id, "Empty response");
          log("warn", "Empty response", { jobId: job.id });
        }
      } catch (err) {
        await stopProgress();
        if (sseStatusInterval) clearInterval(sseStatusInterval);

        if (err.message === "Bridge busy") {
          // --- RETRY: re-enqueue instead of dropping ---
          const retryCount = (job._retries || 0) + 1;
          if (retryCount <= 3) {
            log("info", "Bridge busy, retry " + retryCount + "/3", { jobId: job.id });
            queue.fail(job.id, "Bridge busy (retry scheduled)");
            setTimeout(() => {
              const newId = queue.enqueue(job.prompt, job.source);
              log("info", "Re-enqueued after busy", { oldJobId: job.id, newJobId: newId, retry: retryCount });
              processNextJob();
            }, 5000);
            if (retryCount === 1 && job.source !== "system") {
              sendStatusMessage(TELEGRAM_TARGET, "\u23F3 Busy \u2014 will process shortly...");
            }
          } else {
            queue.fail(job.id, "Bridge busy after 3 retries");
            log("error", "Bridge busy, exhausted retries", { jobId: job.id });
            if (job.source !== "system") {
              await sendStatusMessage(TELEGRAM_TARGET, "\u274C Cannot process \u2014 try again in a minute");
            }
          }
        } else {
          queue.fail(job.id, err.message);
          log("error", "Job failed", { jobId: job.id, error: err.message });

          if (job.source === "openclaw") {
            replyViaOpenClaw(`\u274C Error: ${err.message}`);
          } else if (job.source !== "system") {
            await sendStatusMessage(TELEGRAM_TARGET, `\u274C Bridge error: ${err.message}`);
          }
        }
      }

      // Clear current job tracking
      currentJobMeta = null;
      sseEmit("status", { busy: false, activity: "\u2705 Idle", queue: queue.stats() });
    }
  } finally {
    processing = false;
  }

  queue.cleanup();
}

// Periodic queue check in case of missed events
setInterval(() => {
  if (!processing && queue.pendingCount() > 0) {
    log("info", "Periodic queue check found pending jobs");
    processNextJob();
  }
}, 10_000);

// --- Start Server ---
const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  log("info", "Claude Code bridge v2 started", {
    port: PORT,
    features: [
      "sqlite-queue", "stop-hook-post", "load-buffer",
      "reply-adapters", "ack", "sse-events",
      "status-endpoint", "busy-retry", "telegram-webhook",
      "progress-indicator", "model-switching",
    ],
  });
});

process.on("SIGINT", () => { queue.close(); process.exit(0); });
process.on("SIGTERM", () => { queue.close(); process.exit(0); });
