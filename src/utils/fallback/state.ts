import { getGlobalConfig } from '../config.js'
import {
  isAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../model/providers.js'
import { getProviderModelDisplayName } from '../model/display.js'

export const FALLBACK_TARGET_COUNT = 3

export type FallbackTarget = {
  provider: APIProvider
  model: string
  effort?: string | number
}

export type FallbackAttempt = {
  target: FallbackTarget
  index: number
  total: number
}

export type PendingFallback = {
  originalProvider: APIProvider
  originalModel: string
  errorMessage: string
  createdAt: number
}

let pendingFallback: PendingFallback | null = null
let activeFallback:
  | {
      current: FallbackAttempt
      nextIndex: number
    }
  | null = null

export function getConfiguredFallbackTargets(): FallbackTarget[] {
  const rawTargets = getGlobalConfig().fallbackTargets
  if (!Array.isArray(rawTargets)) {
    return []
  }

  const targets: FallbackTarget[] = []
  for (const rawTarget of rawTargets) {
    if (
      rawTarget &&
      typeof rawTarget.provider === 'string' &&
      isAPIProvider(rawTarget.provider) &&
      typeof rawTarget.model === 'string' &&
      rawTarget.model.trim()
    ) {
      targets.push({
        provider: rawTarget.provider,
        model: rawTarget.model.trim(),
        effort: rawTarget.effort,
      })
    }

    if (targets.length >= FALLBACK_TARGET_COUNT) {
      break
    }
  }

  return targets
}

export function hasConfiguredFallbackTargets(): boolean {
  return getConfiguredFallbackTargets().length > 0
}

export function requestFallbackConfirmation(details: {
  originalProvider: APIProvider
  originalModel: string
  errorMessage: string
}): PendingFallback {
  pendingFallback = {
    ...details,
    createdAt: Date.now(),
  }
  activeFallback = null
  return pendingFallback
}

export function getPendingFallback(): PendingFallback | null {
  return pendingFallback
}

export function rejectPendingFallback(): void {
  pendingFallback = null
  activeFallback = null
}

export function startFallbackProcess(): FallbackAttempt | null {
  const targets = getConfiguredFallbackTargets()
  if (targets.length === 0) {
    return null
  }

  const attempt: FallbackAttempt = {
    target: targets[0]!,
    index: 0,
    total: targets.length,
  }
  pendingFallback = null
  activeFallback = {
    current: attempt,
    nextIndex: 1,
  }
  return attempt
}

export function getActiveFallbackAttempt(): FallbackAttempt | null {
  return activeFallback?.current ?? null
}

export function getNextFallbackAttempt(): FallbackAttempt | null {
  if (!activeFallback) {
    return null
  }

  const targets = getConfiguredFallbackTargets()
  const nextTarget = targets[activeFallback.nextIndex]
  if (!nextTarget) {
    return null
  }

  const attempt: FallbackAttempt = {
    target: nextTarget,
    index: activeFallback.nextIndex,
    total: targets.length,
  }
  activeFallback = {
    current: attempt,
    nextIndex: activeFallback.nextIndex + 1,
  }
  return attempt
}

export function clearFallbackProcess(): void {
  activeFallback = null
}

export function formatFallbackTarget(target: FallbackTarget): string {
  const provider = PROVIDER_DISPLAY_NAMES[target.provider]
  const model =
    getProviderModelDisplayName(target.provider, target.model) ?? target.model
  const effort =
    target.effort !== undefined ? `, effort=${String(target.effort)}` : ''
  return `${provider} / ${model}${effort}`
}
