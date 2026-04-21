/**
 * Surf phase application — the glue between detection and side effects.
 *
 * `computeSurfPhaseSwitch` is pure: given the current context, it decides
 * whether surf wants to change the active model and returns the target to
 * apply (or null if no change). The caller is responsible for invoking
 * `applySurfPhaseSwitch` on the result, which does the actual mutation
 * (provider swap, effort apply, banner build).
 *
 * Two invariants callers depend on:
 *   1. Returns `null` when surf is off — zero code-path impact.
 *   2. Returns `null` when the detected phase has no configured target —
 *      we keep whatever model the user had instead of synthesising one,
 *      so partial configs (only 3 of 7 phases set) behave predictably.
 *
 * Also owns the 2-turn debounce: a switch to a new phase only commits
 * when the detector has agreed for two consecutive turns, preventing
 * one-off keywords ("review this") from flushing prompt caches by
 * flipping providers every turn. Plan mode bypasses the debounce.
 */

import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../config.js'
import type { APIProvider } from '../model/providers.js'
import { getAPIProvider, setActiveProvider } from '../model/providers.js'
import {
  modelSupportsReasoning,
  setOpenAIReasoningLevel,
  type OpenAIReasoningLevel,
} from '../model/openaiReasoning.js'
import {
  detectPhase,
  isHardOverridePhase,
  type PhaseDetectionContext,
} from './detectPhase.js'
import {
  getCurrentSurfPhase,
  getLastDetectedPhase,
  getLastTurnUsage,
  isSurfEnabled,
  recordSurfTurnStart,
  setCurrentSurfPhase,
  setLastDetectedPhase,
  setPendingTurnPhase,
  type MainLoopSurfPhase,
  type PhaseEffort,
  type PhaseTarget,
  type SurfPhase,
} from './state.js'

export interface SurfPhaseSwitch {
  /** The phase that was active before this turn (null on first turn). */
  previousPhase: SurfPhase | null
  /** The phase the detector picked for this turn. */
  newPhase: MainLoopSurfPhase
  /** Whether the phase actually changed (false = same phase, target-only sync). */
  changed: boolean
  /** The provider+model+effort the new phase should route to. */
  target: PhaseTarget
}

const OPENAI_REASONING_LEVELS: readonly OpenAIReasoningLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

function isOpenAIReasoningLevel(value: unknown): value is OpenAIReasoningLevel {
  return (
    typeof value === 'string' &&
    (OPENAI_REASONING_LEVELS as readonly string[]).includes(value)
  )
}

/**
 * Compute the surf phase for the upcoming turn and whether a switch is
 * required. Returns null when surf is disabled, when no target is
 * configured for the detected phase, or when the 2-turn debounce hasn't
 * yet agreed on the new phase.
 *
 * Pure function: no mutations, no I/O besides reading global config +
 * module-level surf state.
 */
export function computeSurfPhaseSwitch(
  ctx: PhaseDetectionContext,
): SurfPhaseSwitch | null {
  if (!isSurfEnabled()) return null

  const config = getGlobalConfig()
  const targets = config.surfPhaseTargets
  if (!targets) return null

  const detected = detectPhase(ctx)
  const previousPhase = getCurrentSurfPhase()

  // Debounce: if this isn't a hard-override phase and the new detection
  // disagrees with the previous detection, don't switch yet — just
  // record the detection so the next matching turn commits the change.
  // This keeps one-off keywords from forcing a provider swap.
  const lastDetected = getLastDetectedPhase()
  const isHardOverride = isHardOverridePhase(ctx, detected)
  if (
    !isHardOverride &&
    previousPhase !== null &&
    detected !== previousPhase &&
    detected !== lastDetected
  ) {
    setLastDetectedPhase(detected)
    return null
  }
  setLastDetectedPhase(detected)

  const rawTarget = targets[detected]
  if (!rawTarget || !rawTarget.provider || !rawTarget.model) {
    // No target configured for this phase — leave the user's current
    // provider/model alone. This is what "partial configs work" means.
    return null
  }

  return {
    previousPhase,
    newPhase: detected,
    changed: previousPhase !== detected,
    target: {
      provider: rawTarget.provider as APIProvider,
      model: rawTarget.model,
      effort: rawTarget.effort,
    },
  }
}

/**
 * Apply the computed switch: persist the surf phase, flip the active
 * provider if needed, push the provider-native effort/reasoning level,
 * and return a human-readable banner string.
 *
 * Does NOT touch AppState.mainLoopModel directly — that must be done by
 * the caller with their setAppState because the AppState store is
 * context-scoped. The return value carries the model id + any effort
 * value so the caller can apply it in the same tick.
 */
export function applySurfPhaseSwitch(
  result: SurfPhaseSwitch,
): {
  bannerLine: string
  modelToApply: string
  providerToApply: APIProvider
  effortToApply: PhaseEffort | undefined
} {
  const { newPhase, target } = result

  // Only touch activeProvider when it actually differs — saveGlobalConfig
  // takes a file lock and running it every turn is wasteful.
  if (getAPIProvider() !== target.provider) {
    setActiveProvider(target.provider)
  }

  // Apply OpenAI reasoning level eagerly — it has its own global store,
  // so we push it here rather than forcing the caller to know which
  // provider has which effort mechanism. Anthropic-style effort
  // (AppState.effortValue) is context-scoped and must go through the
  // caller's setAppState; we surface it in the return value instead.
  if (
    target.effort !== undefined &&
    modelSupportsReasoning(target.model) &&
    isOpenAIReasoningLevel(target.effort)
  ) {
    setOpenAIReasoningLevel(target.effort)
  }

  setCurrentSurfPhase(newPhase)
  setPendingTurnPhase(newPhase)
  // Bump the logical turn counter exactly once per phase apply — token
  // accounting happens separately in the cost-tracker sink (which may
  // fire multiple times for the same logical turn on advisor recursion).
  recordSurfTurnStart(newPhase)

  const effortSuffix =
    target.effort !== undefined ? ` · effort=${target.effort}` : ''
  const bannerLine = result.changed
    ? `🌊 surf → ${newPhase} · ${target.provider}/${target.model}${effortSuffix}`
    : `🌊 surf · ${newPhase} · ${target.provider}/${target.model}${effortSuffix}`

  return {
    bannerLine,
    modelToApply: target.model,
    providerToApply: target.provider,
    effortToApply: target.effort,
  }
}

/**
 * Convenience wrapper — computes, applies, and reports the surf phase
 * switch for the upcoming turn. Returns the model to use (or `null` if
 * surf is off / no config / debounced / no target for this phase) along
 * with a banner string and any effort value the caller needs to apply
 * via AppState.
 *
 * Side effects when a switch fires:
 *   - setActiveProvider(target.provider) if different
 *   - setMainLoopModelOverride(target.model) — consumed by getMainLoopModel()
 *   - setOpenAIReasoningLevel(target.effort) for OpenAI reasoning models
 *   - setCurrentSurfPhase / setPendingTurnPhase for accounting
 */
export function runSurfPhaseHook(
  ctx: PhaseDetectionContext,
): {
  bannerLine: string
  modelToApply: string
  changed: boolean
  newPhase: MainLoopSurfPhase
  effortToApply: PhaseEffort | undefined
} | null {
  const result = computeSurfPhaseSwitch(ctx)
  if (!result) return null

  const { bannerLine, modelToApply, effortToApply } =
    applySurfPhaseSwitch(result)

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
    effortToApply,
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
