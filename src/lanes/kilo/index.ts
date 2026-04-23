/**
 * Kilo lane entry point.
 *
 * Registration-only — the provider shim routes `kilocode` to this lane by
 * name. supportsModel() intentionally returns false: Kilo's catalog is
 * made of OpenRouter-style namespaced ids that overlap anthropic/ openai/
 * google/ on other native lanes, so model-heuristic dispatch would
 * collide.
 */

export { kiloLane, KiloLane } from './loop.js'

import { registerLane } from '../dispatcher.js'
import { kiloLane } from './loop.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

interface StoredKiloOAuthBlob {
  accessToken?: string
  meta?: {
    orgId?: string | null
  }
}

function readStoredKiloAuth(): { accessToken?: string; orgId?: string | null } {
  try {
    const raw = loadProviderKey('kilocode_oauth')
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoredKiloOAuthBlob
    return {
      accessToken: parsed.accessToken,
      orgId: parsed.meta?.orgId ?? null,
    }
  } catch {
    return {}
  }
}

export function initKiloLane(opts?: {
  accessToken?: string
  orgId?: string | null
}): void {
  const stored = readStoredKiloAuth()
  kiloLane.configure({
    accessToken: opts?.accessToken ?? stored.accessToken ?? null,
    orgId: opts?.orgId ?? stored.orgId ?? null,
  })
  registerLane(kiloLane)
}
