/**
 * Antigravity gray-area TOS disclosure.
 *
 * Non-negotiable per the ClaudeX spec: before the first Antigravity
 * OAuth flow on any machine, the user sees the six-line TOS risk
 * banner and has to explicitly acknowledge it. The ack is persisted
 * at ~/.claudex/antigravity-acknowledged.json with the SHA-256 of
 * the banner text; if the text changes (TOS update, scope expansion,
 * etc.) the SHA shifts and the user re-acks.
 *
 * This is not a UI module — it's a headless helper the Ink banner
 * component (or any CLI prompt) calls to:
 *   - check current ack state
 *   - render the canonical banner text
 *   - record an ack
 *   - list known acks (for troubleshooting)
 *
 * Interactive prompting belongs in whichever host invokes it
 * (`/login antigravity`, a plain-prompt fallback for headless sessions,
 * etc.). This module exports the data, hash, and store only.
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Banner text ────────────────────────────────────────────────
//
// Six lines, plain text. Deliberately short and specific:
//  - what Antigravity is
//  - what the risk is
//  - the acknowledgement
//  - where to read more

export const ANTIGRAVITY_BANNER_VERSION = 1

export const ANTIGRAVITY_BANNER_TEXT = `
Antigravity OAuth — Terms-of-Service disclosure

Antigravity is Google's IDE OAuth that resells Gemini 3.x Pro and Claude 4.6
through a single token. Using this credential from a non-IDE client
(including ClaudeX) is a GRAY-AREA use of Google's Terms of Service.
Google has suspended accounts that rely on this pathway in the past.

By continuing you acknowledge:
 • This is not an endorsed or supported integration.
 • Your Google account may be rate-limited, suspended, or permanently banned
   without prior notice.
 • You assume all risk. ClaudeX has no recourse and no refund channel.

If you do not accept this risk, cancel now and use a Gemini API key instead.
See https://antigravity.google.com/terms for Google's current position.
`.trim()

/** Stable hash of the banner text — re-ack required when this changes. */
export function antigravityBannerHash(): string {
  return createHash('sha256').update(ANTIGRAVITY_BANNER_TEXT).digest('hex')
}

// ─── Storage ────────────────────────────────────────────────────

interface AckRecord {
  /** SHA-256 of the banner text the user acked. */
  sha: string
  /** Banner version number at ack time (for future forward-compat). */
  version: number
  /** ISO timestamp. */
  acknowledgedAt: string
  /** "session" (local only) | "persistent" (apply across all sessions). */
  scope: 'session' | 'persistent'
}

interface AckStore {
  version: 1
  records: AckRecord[]
}

const ACK_DIR = join(homedir(), '.claudex')
const ACK_FILE = join(ACK_DIR, 'antigravity-acknowledged.json')

let _sessionAck: AckRecord | null = null

function readAckStore(): AckStore {
  if (!existsSync(ACK_FILE)) return { version: 1, records: [] }
  try {
    const raw = readFileSync(ACK_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as AckStore
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      return { version: 1, records: [] }
    }
    return parsed
  } catch {
    return { version: 1, records: [] }
  }
}

function writeAckStore(store: AckStore): void {
  try {
    if (!existsSync(ACK_DIR)) mkdirSync(ACK_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(ACK_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
  } catch {
    // Best-effort: session-scope ack still works even if disk save fails.
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Has the user already acked the CURRENT banner version?
 * Checks session scope first, then persistent (on-disk).
 */
export function isAntigravityAcknowledged(): boolean {
  const sha = antigravityBannerHash()
  if (_sessionAck?.sha === sha) return true
  const store = readAckStore()
  return store.records.some(r => r.sha === sha)
}

/**
 * Record an ack for this session only (not persisted to disk).
 */
export function acknowledgeAntigravitySession(): void {
  _sessionAck = {
    sha: antigravityBannerHash(),
    version: ANTIGRAVITY_BANNER_VERSION,
    acknowledgedAt: new Date().toISOString(),
    scope: 'session',
  }
}

/**
 * Record an ack to disk so the banner never re-appears on this machine
 * (until the banner text itself changes, at which point the SHA shifts
 * and the user re-acks).
 */
export function acknowledgeAntigravityPersistent(): void {
  const record: AckRecord = {
    sha: antigravityBannerHash(),
    version: ANTIGRAVITY_BANNER_VERSION,
    acknowledgedAt: new Date().toISOString(),
    scope: 'persistent',
  }
  _sessionAck = record
  const store = readAckStore()
  // Replace any existing record with the same sha so the timestamp is current.
  const filtered = store.records.filter(r => r.sha !== record.sha)
  filtered.push(record)
  writeAckStore({ version: 1, records: filtered })
}

/** Diagnostic: list all stored acks. */
export function listAntigravityAcknowledgements(): AckRecord[] {
  const store = readAckStore()
  return store.records
}

/** Test hook — clears in-memory session ack. */
export function _clearSessionAckForTest(): void {
  _sessionAck = null
}
