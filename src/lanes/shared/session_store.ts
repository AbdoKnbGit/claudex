/**
 * SQLite-backed session storage.
 *
 * Modeled on OpenCode's Drizzle schema (packages/opencode/src/session/session.sql.ts).
 * Kept dependency-free by using Bun's built-in bun:sqlite (which is the
 * target runtime for ClaudeX). On non-Bun runtimes the module no-ops
 * gracefully — callers treat write failures as non-fatal.
 *
 * Tables (normalized for fast per-session lookup):
 *
 *   sessions   (id, parent_id, directory, title, time_created, time_updated)
 *   messages   (id, session_id, role, model, provider, time_created, data)
 *   parts      (id, message_id, session_id, type, time_created, data)
 *   todos      (session_id, position, content, status, priority, time_created, time_updated)
 *   usage      (message_id, input_tokens, output_tokens, cache_read, cache_write, reasoning, cost)
 *
 * Denormalized `session_id` on `parts` mirrors OpenCode's choice — it
 * lets the UI filter parts by session without joining through messages.
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

// bun:sqlite is only present when running under Bun. We probe at import
// time and expose a no-op shim when unavailable so the rest of the code
// can call store methods without guarding every call site.
let BunDatabase: any = null
try {
  // @ts-ignore — bun:sqlite only resolves under Bun runtime.
  BunDatabase = (await import('bun:sqlite')).Database
} catch {
  BunDatabase = null
}

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT,
  directory      TEXT NOT NULL,
  title          TEXT,
  time_created   INTEGER NOT NULL,
  time_updated   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(time_updated DESC);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  role           TEXT NOT NULL,
  model          TEXT,
  provider       TEXT,
  time_created   INTEGER NOT NULL,
  data           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, time_created, id);

CREATE TABLE IF NOT EXISTS parts (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  type           TEXT NOT NULL,
  time_created   INTEGER NOT NULL,
  data           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parts_message ON parts(message_id, id);
CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(session_id);

CREATE TABLE IF NOT EXISTS todos (
  session_id     TEXT NOT NULL,
  position       INTEGER NOT NULL,
  content        TEXT NOT NULL,
  status         TEXT NOT NULL,
  priority       TEXT,
  time_created   INTEGER NOT NULL,
  time_updated   INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);

CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);

CREATE TABLE IF NOT EXISTS usage (
  message_id     TEXT PRIMARY KEY,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  cache_write    INTEGER NOT NULL DEFAULT 0,
  reasoning      INTEGER NOT NULL DEFAULT 0,
  cost           REAL    NOT NULL DEFAULT 0
);
`.trim()

// ─── Types ──────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  parentId?: string
  directory: string
  title?: string
  timeCreated: number
  timeUpdated: number
}

export interface MessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  model?: string
  provider?: string
  timeCreated: number
  data: unknown
}

export interface PartRow {
  id: string
  messageId: string
  sessionId: string
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'file' | string
  timeCreated: number
  data: unknown
}

export interface UsageRow {
  messageId: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
}

// ─── Store ──────────────────────────────────────────────────────

export class SessionStore {
  private db: any = null

  constructor(private readonly path: string) {
    if (!BunDatabase) return
    this.db = new BunDatabase(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`PRAGMA cache_size = -${64 * 1024}`) // 64 MB page cache
    this.db.exec(SCHEMA_SQL)
  }

  /** True when persistent storage is available (we're running under Bun). */
  get enabled(): boolean { return this.db !== null }

  // ── Sessions ────────────────────────────────────────────────

  upsertSession(s: SessionRow): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT INTO sessions (id, parent_id, directory, title, time_created, time_updated)
      VALUES ($id, $parent_id, $directory, $title, $time_created, $time_updated)
      ON CONFLICT(id) DO UPDATE SET
        directory = excluded.directory,
        title = excluded.title,
        time_updated = excluded.time_updated
    `).run({
      $id: s.id,
      $parent_id: s.parentId ?? null,
      $directory: s.directory,
      $title: s.title ?? null,
      $time_created: s.timeCreated,
      $time_updated: s.timeUpdated,
    })
  }

  getSession(id: string): SessionRow | null {
    if (!this.db) return null
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? this.rowToSession(row) : null
  }

  listSessions(limit = 50): SessionRow[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      'SELECT * FROM sessions ORDER BY time_updated DESC LIMIT ?',
    ).all(limit)
    return rows.map((r: any) => this.rowToSession(r))
  }

  private rowToSession(row: any): SessionRow {
    return {
      id: row.id,
      parentId: row.parent_id ?? undefined,
      directory: row.directory,
      title: row.title ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }
  }

  // ── Messages ────────────────────────────────────────────────

  appendMessage(m: MessageRow): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, session_id, role, model, provider, time_created, data)
      VALUES ($id, $session_id, $role, $model, $provider, $time_created, $data)
    `).run({
      $id: m.id,
      $session_id: m.sessionId,
      $role: m.role,
      $model: m.model ?? null,
      $provider: m.provider ?? null,
      $time_created: m.timeCreated,
      $data: JSON.stringify(m.data),
    })
  }

  getMessages(sessionId: string, limit = 1000): MessageRow[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ?',
    ).all(sessionId, limit)
    return rows.map((r: any) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      model: r.model ?? undefined,
      provider: r.provider ?? undefined,
      timeCreated: r.time_created,
      data: tryParse(r.data),
    }))
  }

  // ── Parts ───────────────────────────────────────────────────

  appendPart(p: PartRow): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO parts
        (id, message_id, session_id, type, time_created, data)
      VALUES ($id, $message_id, $session_id, $type, $time_created, $data)
    `).run({
      $id: p.id,
      $message_id: p.messageId,
      $session_id: p.sessionId,
      $type: p.type,
      $time_created: p.timeCreated,
      $data: JSON.stringify(p.data),
    })
  }

  getParts(messageId: string): PartRow[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      'SELECT * FROM parts WHERE message_id = ? ORDER BY id ASC',
    ).all(messageId)
    return rows.map((r: any) => ({
      id: r.id,
      messageId: r.message_id,
      sessionId: r.session_id,
      type: r.type,
      timeCreated: r.time_created,
      data: tryParse(r.data),
    }))
  }

  // ── Usage ───────────────────────────────────────────────────

  recordUsage(u: UsageRow): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO usage
        (message_id, input_tokens, output_tokens, cache_read, cache_write, reasoning, cost)
      VALUES ($m, $i, $o, $cr, $cw, $r, $c)
    `).run({
      $m: u.messageId,
      $i: u.inputTokens,
      $o: u.outputTokens,
      $cr: u.cacheRead,
      $cw: u.cacheWrite,
      $r: u.reasoning,
      $c: u.cost,
    })
  }

  getUsage(messageId: string): UsageRow | null {
    if (!this.db) return null
    const r = this.db.prepare('SELECT * FROM usage WHERE message_id = ?').get(messageId)
    if (!r) return null
    return {
      messageId: r.message_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
      cost: r.cost,
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    if (this.db) {
      try { this.db.close() } catch { /* already closed */ }
      this.db = null
    }
  }
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

// ─── Singleton ──────────────────────────────────────────────────

let _default: SessionStore | null = null

export function getDefaultSessionStore(): SessionStore {
  if (_default) return _default
  const dir = join(homedir(), '.claudex')
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* continue */ }
  }
  _default = new SessionStore(join(dir, 'sessions.db'))
  return _default
}
