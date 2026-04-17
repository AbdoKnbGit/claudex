/**
 * Qwen token lifecycle — file-backed, refresh-on-demand, race-safe.
 *
 * Port of reference/qwen-code-main/packages/core/src/qwen/sharedTokenManager.ts
 * adapted for claudex (no Config dependency; smaller API surface).
 *
 * Behavior:
 *   - Load from ~/.qwen/oauth_creds.json on first access.
 *   - Return cached access_token if still valid (>30s until expiry).
 *   - Otherwise refresh via oauth.refreshAccessToken(), persist, return.
 *   - Single in-process mutex so concurrent callers share one refresh.
 *   - Atomic file write (tmp + rename) to avoid torn reads across procs.
 *
 * File format matches the qwen-code reference so existing Qwen Code
 * installations can share credentials if the user opts in.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import {
  type QwenCredentials,
  QwenCredentialsExpiredError,
  refreshAccessToken,
} from './oauth.js'

const QWEN_DIR = join(homedir(), '.qwen')
const QWEN_CRED_FILE = join(QWEN_DIR, 'oauth_creds.json')

/** Cushion before server-side expiry to force refresh. */
const REFRESH_SKEW_MS = 30_000

export class QwenTokenManager {
  private creds: QwenCredentials | null = null
  private loaded = false
  private refreshing: Promise<QwenCredentials> | null = null

  /**
   * Return a valid access token, refreshing if close to expiry.
   * Throws `QwenCredentialsExpiredError` if refresh fails terminally —
   * caller should surface to the user as "run /login qwen again".
   */
  async getAccessToken(): Promise<string> {
    const creds = await this.ensureValid()
    return creds.access_token
  }

  /** Return valid credentials (access_token + resource_url + more). */
  async getCredentials(): Promise<QwenCredentials> {
    return this.ensureValid()
  }

  /**
   * Persist fresh credentials (called after `/login qwen` completes).
   * Overwrites the file atomically.
   */
  async setCredentials(creds: QwenCredentials): Promise<void> {
    this.creds = creds
    this.loaded = true
    await this.persist(creds)
  }

  /** Clear credentials (called on permanent refresh failure). */
  async clear(): Promise<void> {
    this.creds = null
    this.loaded = true
    try {
      await writeFile(QWEN_CRED_FILE, '{}', { encoding: 'utf-8', mode: 0o600 })
    } catch {
      // best-effort
    }
  }

  /** Whether a set of credentials is currently loaded. */
  async hasCredentials(): Promise<boolean> {
    if (!this.loaded) await this.load()
    return this.creds != null && !!this.creds.access_token
  }

  // ─── Internals ─────────────────────────────────────────────────

  private async ensureValid(): Promise<QwenCredentials> {
    if (!this.loaded) await this.load()
    if (!this.creds) {
      throw new QwenCredentialsExpiredError('No Qwen credentials; run /login qwen')
    }
    if (this.creds.expiry_date - Date.now() > REFRESH_SKEW_MS) {
      return this.creds
    }
    // Refresh — coalesce concurrent callers onto one request.
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(this.creds).finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(old: QwenCredentials): Promise<QwenCredentials> {
    try {
      const next = await refreshAccessToken(old)
      this.creds = next
      await this.persist(next)
      return next
    } catch (err) {
      if (err instanceof QwenCredentialsExpiredError) {
        await this.clear()
      }
      throw err
    }
  }

  private async load(): Promise<void> {
    this.loaded = true
    if (!existsSync(QWEN_CRED_FILE)) return
    try {
      const raw = await readFile(QWEN_CRED_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as QwenCredentials | Record<string, never>
      if (parsed && typeof parsed === 'object' && 'access_token' in parsed && parsed.access_token) {
        this.creds = parsed as QwenCredentials
      }
    } catch {
      // Corrupt file → ignore; user re-runs /login qwen.
    }
  }

  private async persist(creds: QwenCredentials): Promise<void> {
    try {
      if (!existsSync(QWEN_DIR)) {
        await mkdir(QWEN_DIR, { recursive: true, mode: 0o700 })
      }
      const tmp = QWEN_CRED_FILE + '.tmp'
      await writeFile(tmp, JSON.stringify(creds, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await rename(tmp, QWEN_CRED_FILE)
    } catch {
      // best-effort — in-memory state still works this session.
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _singleton: QwenTokenManager | null = null

export function getQwenTokenManager(): QwenTokenManager {
  if (!_singleton) _singleton = new QwenTokenManager()
  return _singleton
}

export function _resetQwenTokenManagerForTest(): void {
  _singleton = null
}
