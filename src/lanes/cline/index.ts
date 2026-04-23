/**
 * Cline lane entry point.
 *
 * Cline's catalog overlaps Anthropic/OpenAI/Gemini model ids, so model-only
 * dispatch is not authoritative here. The provider shim routes the `cline`
 * provider directly to this lane by name; this lane then resolves auth and
 * talks to Cline's own gateway natively.
 */

export { clineLane, ClineLane } from './loop.js'

import { registerLane } from '../dispatcher.js'
import { clineLane } from './loop.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

function readStoredClineOAuthToken(): string | undefined {
  try {
    const raw = loadProviderKey('cline_oauth')
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { accessToken?: string }
    return parsed.accessToken
  } catch {
    return undefined
  }
}

export function initClineLane(): void {
  clineLane.configure({
    oauthToken: readStoredClineOAuthToken(),
  })
  registerLane(clineLane)
}
