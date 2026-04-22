/**
 * Cursor Lane entry point.
 *
 * Auth source: the blob written by `/login cursor` at
 * `~/.config/claude-code/provider-keys.json:cursor_oauth`. `/login cursor`
 * now uses Cursor's native browser login (`loginDeepControl` → `auth/poll`)
 * and stores the resulting access/refresh tokens here. Legacy manual token
 * imports may still include a machineId; otherwise `buildCursorHeaders`
 * derives one from the token (same SHA-256 scheme the reference uses).
 */

export { cursorLane, CursorLane } from './loop.js'
export {
  CURSOR_AUTO_MODEL_ID,
  CURSOR_AUTO_WIRE_MODEL_ID,
  CURSOR_MODEL_GROUPS,
  CURSOR_MODELS,
  isCursorModel,
  resolveCursorModelId,
} from './catalog.js'
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
