/**
 * Kiro Lane entry point.
 *
 * Wires the Kiro lane into the dispatcher. Auth source: the OAuth token
 * + meta blob written by `/login kiro` at
 * `~/.config/claude-code/provider-keys.json:kiro_oauth`. Builder-ID users
 * don't get a profileArn from the device-code exchange; the lane falls
 * back to a known-public default on first call (social-login users have
 * a real profileArn stored in meta).
 */

export { kiroLane, KiroLane } from './loop.js'
export { KIRO_MODELS, isKiroModel } from './catalog.js'
export { buildKiroPayload } from './request.js'
export { parseFrames } from './eventstream.js'

import { kiroLane } from './loop.js'
import { registerLane } from '../dispatcher.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

export interface KiroLaneOptions {
  accessToken?: string
  /** Optional — social-login users have one, Builder-ID users don't. */
  profileArn?: string
}

export function initKiroLane(opts?: KiroLaneOptions): void {
  let accessToken = opts?.accessToken
  let profileArn = opts?.profileArn ?? null

  // Pull meta.profileArn from the stored token blob when available, so
  // we don't fall back to the hardcoded default unnecessarily.
  if (!profileArn) {
    try {
      const raw = loadProviderKey('kiro_oauth')
      if (raw) {
        const parsed = JSON.parse(raw) as {
          accessToken?: string
          meta?: { profileArn?: string }
        }
        if (!accessToken && parsed.accessToken) accessToken = parsed.accessToken
        if (parsed.meta?.profileArn) profileArn = parsed.meta.profileArn
      }
    } catch {
      // ignore — the lane will start unhealthy and /login kiro repairs it
    }
  }

  kiroLane.configure({ accessToken, profileArn })
  registerLane(kiroLane)
}
