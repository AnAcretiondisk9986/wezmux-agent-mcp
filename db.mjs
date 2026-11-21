import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.WEZMUX_AGENT_DATA_DIR || path.join(os.homedir(), ".wezmux-agent-mcp");
const DB_PATH = path.join(DATA_DIR, "broker.db");

let dbInstance = null;

export function getDbPath() {
  return DB_PATH;
}

function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [col, def] of columns) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
}

export function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      pane_id INTEGER,
      window_id INTEGER,
      workspace TEXT DEFAULT '',
      role TEXT DEFAULT '',
      cwd TEXT DEFAULT '',
      status TEXT DEFAULT 'idle',
      status_message TEXT DEFAULT '',
      last_seen INTEGER NOT NULL,
      socket TEXT DEFAULT '',
      instance_pid INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agents_pane_id ON agents(pane_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      thread_id TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      body TEXT NOT NULL,
      reply_to INTEGER,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read_at, id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

    CREATE TABLE IF NOT EXISTS file_locks (
      file_path TEXT PRIMARY KEY,
      owner_agent TEXT NOT NULL,
      reason TEXT DEFAULT '',
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  ensureColumns(db, "agents", [
    ["socket", "TEXT DEFAULT ''"],
    ["instance_pid", "INTEGER"],
  ]);

  dbInstance = db;
  return db;
}

export function nowMs() {
  return Date.now();
}

export function defaultPaneAgentName(paneId, instancePid = null) {
  return instancePid ? `pane-${instancePid}-${paneId}` : `pane-${paneId}`;
}

export function registerAgent({
  name,
  pane_id = null,
  window_id = null,
  workspace = "",
  role = "",
  cwd = "",
  status = "idle",
  status_message = "",
  socket = "",
  instance_pid = null,
}) {
  const db = getDb();
  const ts = nowMs();

  if (pane_id !== null && pane_id !== undefined) {
    // Clean up auto-generated placeholder names for the same pane (+ instance)
    const legacyAuto = `pane-${pane_id}`;
    const scopedAuto = instance_pid ? `pane-${instance_pid}-${pane_id}` : null;
    for (const candidate of [legacyAuto, scopedAuto].filter(Boolean)) {
      if (name !== candidate) {
        if (socket) {
          db.prepare("DELETE FROM agents WHERE name = ? AND pane_id = ? AND (socket = '' OR socket = ?)").run(
            candidate,
            pane_id,
            socket
          );
        } else {
          db.prepare("DELETE FROM agents WHERE name = ? AND pane_id = ?").run(candidate, pane_id);
        }
        db.prepare("UPDATE messages SET to_agent = ? WHERE to_agent = ?").run(name, candidate);
        db.prepare("UPDATE messages SET from_agent = ? WHERE from_agent = ?").run(name, candidate);
      }
    }
  }

  db.prepare(`
    INSERT INTO agents (name, pane_id, window_id, workspace, role, cwd, status, status_message, last_seen, socket, instance_pid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      pane_id = COALESCE(excluded.pane_id, agents.pane_id),
      window_id = COALESCE(excluded.window_id, agents.window_id),
      workspace = CASE WHEN excluded.workspace != '' THEN excluded.workspace ELSE agents.workspace END,
      role = CASE WHEN excluded.role != '' THEN excluded.role ELSE agents.role END,
      cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE agents.cwd END,
      status = excluded.status,
      status_message = CASE WHEN excluded.status_message != '' THEN excluded.status_message ELSE agents.status_message END,
      last_seen = excluded.last_seen,
      socket = CASE WHEN excluded.socket != '' THEN excluded.socket ELSE agents.socket END,
      instance_pid = COALESCE(excluded.instance_pid, agents.instance_pid)
  `).run(name, pane_id, window_id, workspace, role, cwd, status, status_message, ts, socket || "", instance_pid);

  return getAgentByName(name);
}

export function updateAgentStatusByPane(
  paneId,
  { status = null, status_message = null, cwd = null, window_id = null, workspace = "", socket = "", instance_pid = null }
) {
  const db = getDb();
  const ts = nowMs();
  const existing = getAgentByPaneId(paneId, socket || null);
  if (existing) {
    db.prepare(`
      UPDATE agents
      SET status = COALESCE(?, status),
          status_message = COALESCE(?, status_message),
          cwd = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE cwd END,
          window_id = COALESCE(?, window_id),
          workspace = CASE WHEN ? != '' THEN ? ELSE workspace END,
          socket = CASE WHEN ? != '' THEN ? ELSE socket END,
          instance_pid = COALESCE(?, instance_pid),
          last_seen = ?
      WHERE name = ?
    `).run(
      status ?? null,
      status_message ?? null,
      cwd ?? null,
      cwd ?? null,
      cwd ?? null,
      window_id ?? null,
      workspace || "",
      workspace || "",
      socket || "",
      socket || "",
      instance_pid ?? null,
      ts,
      existing.name
    );
    return getAgentByName(existing.name);
  }
  const autoName = defaultPaneAgentName(paneId, instance_pid);
  return registerAgent({
    name: autoName,
    pane_id: paneId,
    window_id,
    workspace,
    cwd: cwd || "",
    status: status || "idle",
    status_message: status_message || "",
    socket,
    instance_pid,
  });
}

export function getAgentByName(name) {
  const db = getDb();
  return db.prepare("SELECT * FROM agents WHERE name = ?").get(name) || null;
}

export function getAgentByPaneId(paneId, socket = null) {
  const db = getDb();
  if (socket) {
    const exact = db.prepare("SELECT * FROM agents WHERE pane_id = ? AND socket = ? ORDER BY last_seen DESC LIMIT 1").get(paneId, socket);
    if (exact) return exact;
  }
  return db.prepare("SELECT * FROM agents WHERE pane_id = ? ORDER BY last_seen DESC LIMIT 1").get(paneId) || null;
}

export function resolveAgent(identifier, socket = null) {
  if (identifier === null || identifier === undefined) return null;
  const str = String(identifier).trim();
  const byName = getAgentByName(str);
  if (byName) return byName;
  if (/^\d+$/.test(str)) {
    return getAgentByPaneId(Number(str), socket);
  }
  const paneMatch = str.match(/^pane-(?:\d+-)?(\d+)$/);
  if (paneMatch) {
    return getAgentByPaneId(Number(paneMatch[1]), socket);
  }
  return null;
}

export function listAgents() {
  const db = getDb();
  return db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM messages m
       WHERE (m.to_agent = a.name OR m.to_agent = '*')
         AND m.from_agent != a.name
         AND m.read_at IS NULL) AS unread_count
    FROM agents a
    ORDER BY a.last_seen DESC
  `).all();
}

export function getUnreadCount(agentName) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE (to_agent = ? OR to_agent = '*') AND from_agent != ? AND read_at IS NULL"
    )
    .get(agentName, agentName);
  return row ? row.c : 0;
}

export function sendMessage({ from_agent, to_agent, subject = "", body, thread_id = "", reply_to = null }) {
  const db = getDb();
  const ts = nowMs();
  const effectiveThread = thread_id || (reply_to ? `reply-${reply_to}` : `thread-${ts}`);
  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, thread_id, subject, body, reply_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(from_agent, to_agent, effectiveThread, subject, body, reply_to, ts);

  db.prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(ts, from_agent);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(result.lastInsertRowid);
}

export function readMessages({ agent_name, unread_only = true, thread_id = "", from_agent = "", limit = 20, mark_read = true }) {
  const db = getDb();
  const clauses = ["(to_agent = ? OR to_agent = '*')", "from_agent != ?"];
  const params = [agent_name, agent_name];

  if (unread_only) {
    clauses.push("read_at IS NULL");
  }
  if (thread_id) {
    clauses.push("thread_id = ?");
    params.push(thread_id);
  }
  if (from_agent) {
    clauses.push("from_agent = ?");
    params.push(from_agent);
  }
  params.push(limit);

  const sql = `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`;
  const messages = db.prepare(sql).all(...params);

  if (mark_read && messages.length > 0) {
    const ts = nowMs();
    const markStmt = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND to_agent = ?");
    for (const msg of messages) {
      if (msg.to_agent === agent_name && !msg.read_at) {
        markStmt.run(ts, msg.id, agent_name);
      }
    }
  }
  return messages;
}

export function acquireFileLock({ file_path, owner_agent, reason = "", ttl_seconds = 300 }) {
  const db = getDb();
  const normalized = path.resolve(file_path);
  const ts = nowMs();
  const expiresAt = ts + ttl_seconds * 1000;

  db.prepare("DELETE FROM file_locks WHERE expires_at <= ?").run(ts);
  const existing = db.prepare("SELECT * FROM file_locks WHERE file_path = ?").get(normalized);
  if (existing && existing.owner_agent !== owner_agent) {
    return { acquired: false, conflict: existing };
  }
  db.prepare(`
    INSERT INTO file_locks (file_path, owner_agent, reason, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      reason = excluded.reason,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
  `).run(normalized, owner_agent, reason, ts, expiresAt);

  return {
    acquired: true,
    lock: db.prepare("SELECT * FROM file_locks WHERE file_path = ?").get(normalized),
  };
}

export function releaseFileLock({ file_path, owner_agent }) {
  const db = getDb();
  const normalized = path.resolve(file_path);
  const res = db.prepare("DELETE FROM file_locks WHERE file_path = ? AND owner_agent = ?").run(normalized, owner_agent);
  return { released: res.changes > 0, file_path: normalized };
}

export function listFileLocks() {
  const db = getDb();
  db.prepare("DELETE FROM file_locks WHERE expires_at <= ?").run(nowMs());
  return db.prepare("SELECT * FROM file_locks ORDER BY acquired_at DESC").all();
}
