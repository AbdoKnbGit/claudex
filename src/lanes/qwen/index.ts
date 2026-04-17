/**
 * Qwen Lane entry point.
 *
 * Two auth paths, auto-detected at init:
 *   1. OAuth (default): credentials loaded from ~/.qwen/oauth_creds.json
 *      — populated by the device-code flow in `oauth.ts` via `/login qwen`.
 *   2. API key: DASHSCOPE_API_KEY or QWEN_API_KEY env var.
 *
 * If BOTH are present we prefer OAuth (the user's Qwen account is
 * typically the capability the user wants; the API key is the static
 * fallback).
 */

export { qwenLane, QwenLane } from './loop.js'
export {
  QWEN_TOOL_REGISTRY,
  buildQwenTools,
  getQwenRegistrationByNativeName,
} from './tools.js'
export { assembleQwenSystemPrompt } from './prompt.js'
export { qwenApi, QwenApiClient, QwenApiError } from './api.js'
export {
  generatePKCE,
  requestDeviceAuthorization,
  awaitDeviceToken,
  refreshAccessToken,
  QwenCredentialsExpiredError,
  type QwenCredentials,
  type DeviceAuthorization,
} from './oauth.js'
export { getQwenTokenManager, QwenTokenManager } from './token_manager.js'

import { qwenLane } from './loop.js'
import { qwenApi } from './api.js'
import { getQwenTokenManager } from './token_manager.js'
import { registerLane } from '../dispatcher.js'

export function initQwenLane(opts?: {
  apiKey?: string
  baseUrl?: string
  preferOAuth?: boolean
}): void {
  const apiKey = opts?.apiKey
    ?? process.env.DASHSCOPE_API_KEY
    ?? process.env.QWEN_API_KEY
  const preferOAuth = opts?.preferOAuth !== false

  // Decide auth mode at boot. If OAuth creds exist on disk, prefer them
  // (getCredentials is async; we gate via hasCredentials + a fire-and-forget
  // configure call). If no OAuth creds and no API key, the lane registers
  // unhealthy and waits for /login qwen.
  const mgr = getQwenTokenManager()
  void mgr.hasCredentials().then(hasOAuth => {
    if (hasOAuth && preferOAuth) {
      qwenApi.configure({ kind: 'oauth' })
      qwenLane.setHealthy(true)
      return
    }
    if (apiKey) {
      qwenApi.configure({ kind: 'api_key', apiKey, baseUrl: opts?.baseUrl })
      qwenLane.setHealthy(true)
      return
    }
    // Nothing available — still register so `/models` can show entries and
    // `/login qwen` can enroll credentials into this lane later.
    qwenLane.setHealthy(false)
  })

  registerLane(qwenLane)
}
