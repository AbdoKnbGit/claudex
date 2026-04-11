/**
 * Surf — smart phase router state.
 *
 * /surf auto-switches the main-loop model based on what phase of work the
 * user is in (planning, building, reviewing, background). This module
 * holds the non-React runtime state: whether surf is enabled, which
 * phase we're currently in, and per-phase usage statistics.
 *
 * The persistent piece (which provider+model the user picked per phase)
 * lives in GlobalConfig as `surfPhaseTargets`. This split is deliberate:
 * the user's picks persist across sessions, but the toggle and stats
 * reset on restart.
 *
 * This module is intentionally non-React — the /surf command flow and
 * phase-switch side effects never need to drive re-renders. The status
 * UI reads the snapshot on-demand when the user runs `/surf status`.
 */

import type { APIProvider } from '../model/providers.js'

export type SurfPhase = 'planning' | 'building' | 'reviewing' | 'background'

export const SURF_PHASES: readonly SurfPhase[] = [
  'planning',
  'building',
  'reviewing',
  'background',
] as const

export interface PhaseTarget {
  provider: APIProvider
  model: string
}

export interface PhaseStats {
  /** Number of assistant turns executed while in this phase. */
  turns: number
  /** Total input tokens (including cache reads). */
  inputTokens: number
  /** Total output tokens. */
  outputTokens: number
  /** Tokens served from the provider's context cache. */
  cacheReadTokens: number
  /** Tokens written into the provider's context cache. */
  cacheCreationTokens: number
}

function emptyStats(): PhaseStats {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function emptyTurnUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

interface SurfState {
  enabled: boolean
  currentPhase: SurfPhase | null
  /** Phase that was active at the start of the current turn — used by the
   * after-turn accounting hook to attribute usage correctly. */
  pendingTurnPhase: SurfPhase | null
  stats: Record<SurfPhase, PhaseStats>
  /** Per-turn usage delta — resets at recordSurfTurnStart, accumulates on
   * recordSurfUsage. Consumed by the post-turn cache-hit-rate banner. */
  lastTurnUsage: TurnUsage
}

const _state: SurfState = {
  enabled: false,
  currentPhase: null,
  pendingTurnPhase: null,
  stats: {
    planning: emptyStats(),
    building: emptyStats(),
    reviewing: emptyStats(),
    background: emptyStats(),
  },
  lastTurnUsage: emptyTurnUsage(),
}

// ─── Enabled / disabled ──────────────────────────────────────────────

export function isSurfEnabled(): boolean {
  return _state.enabled
}

export function setSurfEnabled(value: boolean): void {
  _state.enabled = value
  if (!value) {
    _state.currentPhase = null
    _state.pendingTurnPhase = null
  }
}

// ─── Current phase ───────────────────────────────────────────────────

export function getCurrentSurfPhase(): SurfPhase | null {
  return _state.currentPhase
}

export function setCurrentSurfPhase(phase: SurfPhase | null): void {
  _state.currentPhase = phase
}

export function getPendingTurnPhase(): SurfPhase | null {
  return _state.pendingTurnPhase
}

export function setPendingTurnPhase(phase: SurfPhase | null): void {
  _state.pendingTurnPhase = phase
}

// ─── Stats ───────────────────────────────────────────────────────────

export function getSurfStats(): Readonly<Record<SurfPhase, PhaseStats>> {
  return _state.stats
}

/**
 * Increment the turn count for a phase. Call once when the phase for
 * the upcoming turn is picked — turn count stays 1-per-logical-turn
 * even if the turn makes multiple API calls (e.g., advisor recursion,
 * streaming retries).
 *
 * Also resets the lastTurnUsage delta tracker so the post-turn banner
 * shows only what THIS turn used, not accumulated session totals.
 */
export function recordSurfTurnStart(phase: SurfPhase): void {
  _state.stats[phase].turns += 1
  _state.lastTurnUsage = emptyTurnUsage()
}

/** Snapshot of the current turn's accumulated usage delta. */
export function getLastTurnUsage(): Readonly<TurnUsage> {
  return _state.lastTurnUsage
}

/**
 * Accumulate token usage for a phase. Called from the cost-tracker
 * every time an API response lands; may fire multiple times per
 * logical turn (advisor recursion, multi-step agents). Tokens are
 * additive so over-counting is impossible — just count each response.
 */
export function recordSurfUsage(
  phase: SurfPhase,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  },
): void {
  const s = _state.stats[phase]
  s.inputTokens += usage.inputTokens ?? 0
  s.outputTokens += usage.outputTokens ?? 0
  s.cacheReadTokens += usage.cacheReadTokens ?? 0
  s.cacheCreationTokens += usage.cacheCreationTokens ?? 0

  // Also bump the per-turn delta so the post-turn banner can read it.
  const l = _state.lastTurnUsage
  l.inputTokens += usage.inputTokens ?? 0
  l.outputTokens += usage.outputTokens ?? 0
  l.cacheReadTokens += usage.cacheReadTokens ?? 0
  l.cacheCreationTokens += usage.cacheCreationTokens ?? 0
}

/**
 * @deprecated Use recordSurfTurnStart + recordSurfUsage instead.
 * Kept only as a thin compatibility wrapper for any call site that
 * wants the old "turn + usage in one call" shape.
 */
export function recordSurfTurn(
  phase: SurfPhase,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  },
): void {
  recordSurfTurnStart(phase)
  recordSurfUsage(phase, usage)
}

export function resetSurfStats(): void {
  _state.stats.planning = emptyStats()
  _state.stats.building = emptyStats()
  _state.stats.reviewing = emptyStats()
  _state.stats.background = emptyStats()
  _state.lastTurnUsage = emptyTurnUsage()
}

/**
 * Overall cache-hit ratio across all phases. Returns 0 when no turns
 * have run yet. Used by the post-turn cache hit rate line.
 */
export function getOverallCacheHitRate(): number {
  let cached = 0
  let total = 0
  for (const phase of SURF_PHASES) {
    const s = _state.stats[phase]
    cached += s.cacheReadTokens
    total += s.inputTokens
  }
  if (total === 0) return 0
  return cached / total
}

/** Test hook — wipe all state. Not used in prod. */
export function _resetSurfStateForTests(): void {
  _state.enabled = false
  _state.currentPhase = null
  _state.pendingTurnPhase = null
  resetSurfStats()
}
