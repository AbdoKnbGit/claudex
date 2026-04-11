/**
 * Surf phase application — the glue between detection and side effects.
 *
 * `computeSurfPhaseSwitch` is pure: given the current context, it decides
 * whether surf wants to change the active model and returns the target to
 * apply (or null if no change). The caller is responsible for invoking
 * `applySurfPhaseSwitch` on the result, which does the actual mutation
 * (provider swap, AppState update, banner print).
 *
 * Splitting pure from effects lets the pure half stay easy to test and
 * keeps the side-effect half (which depends on React setAppState) at the
 * edge where it belongs.
 */

import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../config.js'
import type { APIProvider } from '../model/providers.js'
import { getAPIProvider, setActiveProvider } from '../model/providers.js'
import { detectPhase, type PhaseDetectionContext } from './detectPhase.js'
import {
  getCurrentSurfPhase,
  getLastTurnUsage,
  isSurfEnabled,
  recordSurfTurnStart,
  setCurrentSurfPhase,
  setPendingTurnPhase,
  type PhaseTarget,
  type SurfPhase,
} from './state.js'

export interface SurfPhaseSwitch {
  /** The phase that was active before this turn (null on first turn). */
  previousPhase: SurfPhase | null
  /** The phase the detector picked for this turn. */
  newPhase: SurfPhase
  /** Whether the phase actually changed (false = same phase, target-only sync). */
  changed: boolean
  /** The provider+model the new phase should route to. */
  target: PhaseTarget
}

/**
 * Compute the surf phase for the upcoming turn and whether a switch is
 * required. Returns null when surf is disabled or when no valid target
 * is configured for the detected phase (the caller should then fall back
 * to whatever the user had set manually — don't touch anything).
 *
 * Pure function: no mutations, no I/O besides reading global config.
 */
export function computeSurfPhaseSwitch(
  ctx: PhaseDetectionContext,
): SurfPhaseSwitch | null {
  if (!isSurfEnabled()) return null

  const config = getGlobalConfig()
  const targets = config.surfPhaseTargets
  if (!targets) return null

  const newPhase = detectPhase(ctx)
  const rawTarget = targets[newPhase]
  if (!rawTarget || !rawTarget.provider || !rawTarget.model) return null

  const previousPhase = getCurrentSurfPhase()

  return {
    previousPhase,
    newPhase,
    changed: previousPhase !== newPhase,
    target: {
      provider: rawTarget.provider as APIProvider,
      model: rawTarget.model,
    },
  }
}

/**
 * Apply the computed switch: persist the surf phase, flip the active
 * provider if needed, and return a human-readable banner string the
 * caller can append to the conversation as a system message.
 *
 * Does NOT touch AppState.mainLoopModel directly — that must be done by
 * the caller with their setAppState because the AppState store is
 * context-scoped. The return value carries the model id so the caller
 * can apply it in the same tick.
 */
export function applySurfPhaseSwitch(
  result: SurfPhaseSwitch,
): { bannerLine: string; modelToApply: string; providerToApply: APIProvider } {
  const { newPhase, target } = result

  // Only touch activeProvider when it actually differs — saveGlobalConfig
  // takes a file lock and running it every turn is wasteful.
  if (getAPIProvider() !== target.provider) {
    setActiveProvider(target.provider)
  }

  setCurrentSurfPhase(newPhase)
  setPendingTurnPhase(newPhase)
  // Bump the logical turn counter exactly once per phase apply — token
  // accounting happens separately in the cost-tracker sink (which may
  // fire multiple times for the same logical turn on advisor recursion).
  recordSurfTurnStart(newPhase)

  const bannerLine = result.changed
    ? `🌊 surf → ${newPhase} · ${target.provider}/${target.model}`
    : `🌊 surf · ${newPhase} · ${target.provider}/${target.model}`

  return {
    bannerLine,
    modelToApply: target.model,
    providerToApply: target.provider,
  }
}

/**
 * Convenience wrapper — computes, applies, and reports the surf phase
 * switch for the upcoming turn. Returns the model to use (or `null` if
 * surf is off / no config / no change needed) along with a banner string
 * to display to the user.
 *
 * Side effects when a switch fires:
 *   - setActiveProvider(target.provider) if different
 *   - setMainLoopModelOverride(target.model) — consumed by getMainLoopModel()
 *   - setCurrentSurfPhase / setPendingTurnPhase for accounting
 */
export function runSurfPhaseHook(
  ctx: PhaseDetectionContext,
): {
  bannerLine: string
  modelToApply: string
  changed: boolean
  newPhase: SurfPhase
} | null {
  const result = computeSurfPhaseSwitch(ctx)
  if (!result) return null

  const { bannerLine, modelToApply } = applySurfPhaseSwitch(result)

  // Push the surf target into bootstrap-state so getMainLoopModel()
  // reads it on the next query (the param passed to onQuery is the raw
  // string, but other consumers — subagents, StatusLine — go through
  // getMainLoopModel() and must see the same value).
  setMainLoopModelOverride(modelToApply)

  return {
    bannerLine,
    modelToApply,
    changed: result.changed,
    newPhase: result.newPhase,
  }
}

/**
 * Format a short post-turn banner summarizing cache performance and
 * token usage for the turn that just completed.
 *
 * Returns `null` when the turn recorded no usage (first tick, errored
 * turn, tool-only turn with no API response) — the caller should then
 * skip printing entirely.
 *
 * Shape: `💾 cache: 72% · phase: planning (12.3k in / 4.1k out)`
 *   - `cache: X%` — cached input / total input (cache + new + created)
 *   - `phase: Y` — the phase this turn ran under
 *   - `(Nk in / Mk out)` — tokens attributed to THIS turn only
 */
export function buildSurfCacheBanner(phase: SurfPhase): string | null {
  const last = getLastTurnUsage()
  const totalInput =
    last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens
  if (totalInput === 0 && last.outputTokens === 0) return null

  const cachePct =
    totalInput > 0
      ? Math.round((last.cacheReadTokens / totalInput) * 100)
      : 0

  const inLabel = formatTokensCompact(totalInput)
  const outLabel = formatTokensCompact(last.outputTokens)

  return `💾 cache: ${cachePct}% · phase: ${phase} (${inLabel} in / ${outLabel} out)`
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}
