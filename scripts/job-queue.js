/**
 * job-queue.js — SQLite WAL job queue for Claude Code bridge
 *
 * State machine: pending -> running -> waiting_stop -> delivering -> done | failed
 *
 * Uses Node.js built-in node:sqlite (v22.5+) — zero dependencies.
 * WAL mode for concurrent reads + single writer.
 */

const { DatabaseSync } = require("node:sqlite");

const DB_PATH = "/tmp/claude-bridge-queue.db";

class JobQueue {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this._init();
  }

  _init() {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'openclaw',
        chat_id TEXT DEFAULT '',
        message_id TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        response TEXT DEFAULT '',
        error TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER DEFAULT 0,
        completed_at INTEGER DEFAULT 0,
        lease_pid INTEGER DEFAULT 0
      )
    `);

    this._cleanStaleJobs();
  }

  _now() {
    return Math.floor(Date.now() / 1000);
  }

  _cleanStaleJobs() {
    const stale = this.db.prepare(
      "SELECT id, lease_pid FROM jobs WHERE status IN ('running', 'waiting_stop') AND lease_pid > 0"
    ).all();

    for (const job of stale) {
      try {
        process.kill(job.lease_pid, 0);
      } catch {
        this.db.prepare(
          "UPDATE jobs SET status = 'failed', error = 'stale lease (PID dead)', updated_at = ? WHERE id = ?"
        ).run(this._now(), job.id);
      }
    }
  }

  enqueue(prompt, source = "openclaw", meta = {}) {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = this._now();
    this.db.prepare(`
      INSERT INTO jobs (id, prompt, source, chat_id, message_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, prompt, source, meta.chat_id || "", meta.message_id || "", now, now);
    return id;
  }

  claim() {
    const job = this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    ).get();

    if (!job) return null;

    const now = this._now();
    this.db.prepare(
      "UPDATE jobs SET status = 'running', started_at = ?, updated_at = ?, lease_pid = ? WHERE id = ? AND status = 'pending'"
    ).run(now, now, process.pid, job.id);

    return this.db.prepare(
      "SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lease_pid = ?"
    ).get(job.id, process.pid) || null;
  }

  markWaitingStop(jobId) {
    this.db.prepare(
      "UPDATE jobs SET status = 'waiting_stop', updated_at = ? WHERE id = ? AND status = 'running'"
    ).run(this._now(), jobId);
  }

  getWaitingJob() {
    return this.db.prepare(
      "SELECT * FROM jobs WHERE status = 'waiting_stop' ORDER BY updated_at DESC LIMIT 1"
    ).get() || null;
  }

  deliverResponse(jobId, response) {
    this.db.prepare(
      "UPDATE jobs SET status = 'delivering', response = ?, updated_at = ? WHERE id = ?"
    ).run(response, this._now(), jobId);
  }

  complete(jobId) {
    this.db.prepare(
      "UPDATE jobs SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(this._now(), this._now(), jobId);
  }

  fail(jobId, error) {
    this.db.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?"
    ).run(error, this._now(), this._now(), jobId);
  }

  get(jobId) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) || null;
  }

  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'pending'").get().cnt;
  }

  isBusy() {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM jobs WHERE status IN ('running', 'waiting_stop', 'delivering')"
    ).get();
    return row.cnt > 0;
  }

  getActiveJob() {
    return this.db.prepare(
      "SELECT * FROM jobs WHERE status IN ('running', 'waiting_stop') ORDER BY updated_at DESC LIMIT 1"
    ).get() || null;
  }

  cleanup() {
    this.db.prepare(`
      DELETE FROM jobs WHERE status IN ('done', 'failed')
      AND id NOT IN (
        SELECT id FROM jobs WHERE status IN ('done', 'failed')
        ORDER BY completed_at DESC LIMIT 100
      )
    `).run();
  }

  stats() {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status"
    ).all();
    const stats = {};
    for (const r of rows) stats[r.status] = r.cnt;
    return stats;
  }

  close() {
    this.db.close();
  }
}

module.exports = { JobQueue, DB_PATH };
