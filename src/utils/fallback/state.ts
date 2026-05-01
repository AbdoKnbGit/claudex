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

let activeFallback: { current: FallbackAttempt; nextIndex: number } | null =
  null

export function getConfiguredFallbackTargets(): FallbackTarget[] {
  const raw = getGlobalConfig().fallbackTargets
  if (!Array.isArray(raw)) {
    return []
  }

  const out: FallbackTarget[] = []
  for (const entry of raw) {
    if (
      entry &&
      typeof entry.provider === 'string' &&
      isAPIProvider(entry.provider) &&
      typeof entry.model === 'string' &&
      entry.model.trim()
    ) {
      out.push({
        provider: entry.provider,
        model: entry.model.trim(),
        effort: entry.effort,
      })
    }
    if (out.length >= FALLBACK_TARGET_COUNT) {
      break
    }
  }
  return out
}

export function hasConfiguredFallbackTargets(): boolean {
  return getConfiguredFallbackTargets().length > 0
}

export function isFallbackEnabled(): boolean {
  return getGlobalConfig().fallbackEnabled === true
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
  activeFallback = { current: attempt, nextIndex: 1 }
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
  const next = targets[activeFallback.nextIndex]
  if (!next) {
    return null
  }
  const attempt: FallbackAttempt = {
    target: next,
    index: activeFallback.nextIndex,
    total: targets.length,
  }
  activeFallback = { current: attempt, nextIndex: activeFallback.nextIndex + 1 }
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
