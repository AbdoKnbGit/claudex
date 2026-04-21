/**
 * Cursor Lane entry point.
 *
 * Auth source: the blob written by `/login cursor` at
 * `~/.config/claude-code/provider-keys.json:cursor_oauth`. Cursor has no
 * public OAuth app, so the login flow is a manual paste — users copy the
 * accessToken from their Cursor IDE (Settings → Cursor Auth, or from the
 * SQLite state.vscdb) plus optionally the machineId. When the user didn't
 * supply a machineId, `buildCursorHeaders` derives one from the token
 * (same SHA-256 scheme the reference uses).
 */

export { cursorLane, CursorLane } from './loop.js'
export { CURSOR_MODELS, isCursorModel } from './catalog.js'
export { buildCursorBody } from './request.js'
export { buildCursorHeaders, cursorChecksum } from './checksum.js'

import { cursorLane } from './loop.js'
import { registerLane } from '../dispatcher.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

export interface CursorLaneOptions {
  accessToken?: string
  /** Optional — inferred from the token when absent (see checksum.ts). */
  machineId?: string
}

export function initCursorLane(opts?: CursorLaneOptions): void {
  let accessToken = opts?.accessToken
  let machineId = opts?.machineId

  if (!accessToken || !machineId) {
    try {
      const raw = loadProviderKey('cursor_oauth')
      if (raw) {
        const parsed = JSON.parse(raw) as {
          accessToken?: string
          meta?: { machineId?: string }
        }
        if (!accessToken && parsed.accessToken) accessToken = parsed.accessToken
        if (!machineId && parsed.meta?.machineId) machineId = parsed.meta.machineId
      }
    } catch {
      // ignore — the lane will start unhealthy and /login cursor repairs it
    }
  }

  cursorLane.configure({
    accessToken: accessToken ?? null,
    machineId: machineId ?? null,
  })
  registerLane(cursorLane)
}
