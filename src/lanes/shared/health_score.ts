/**
 * Domain-free health-score tracker for any rotating credential pool.
 *
 * Tracks success / rate-limit / failure / abort / recovery for a set of
 * identities, computing a 0..1 score used by a rotation strategy to
 * pick the next-best credential. Used by:
 *
 *   - Gemini lane (Antigravity account pool, Gemini CLI pool)
 *   - Claude lane (multi-org API-key rotation)
 *   - Qwen lane (OAuth multi-account rotation)
 *
 * Design borrowed from reference/opencode-antigravity-auth-main/src/plugin/
 * but generalized — no knowledge of model families, endpoint pools, or
 * specific error shapes. The lane wraps this with its own classifier.
 *
 * Scoring:
 *   - Recent success raises the score (EMA toward 1.0)
 *   - Rate-limit lowers temporarily (score recovers when cooldown expires)
 *   - Hard failure lowers permanently-ish (stronger decay)
 *   - Abort is neutral (user-initiated; not the credential's fault)
 */

export interface HealthSnapshot {
  id: string
  score: number
  recentSuccesses: number
  recentFailures: number
  /** Wall-clock ms until this credential is usable again. */
  cooldownRemaining: number
  /** Whether the tracker marked this credential definitively dead. */
  disabled: boolean
  lastUsedAt: number
}

export interface TrackerOptions {
  /**
   * Exponential-moving-average alpha for successes.
   * 0.3 = last call weighs 30%; history weighs 70%.
   */
  successAlpha?: number
  /** EMA alpha for failures. Higher = faster decay on failure. */
  failureAlpha?: number
  /** Default cooldown applied on rate-limit when server doesn't specify. */
  defaultRateLimitMs?: number
  /**
   * Number of consecutive hard failures before a credential is disabled.
   * 0 to never auto-disable.
   */
  hardFailureDisableAfter?: number
}

interface Entry {
  id: string
  score: number
  lastUsedAt: number
  cooldownUntil: number
  consecutiveHardFailures: number
  disabled: boolean
  recentSuccesses: number
  recentFailures: number
}

export class HealthScoreTracker {
  private entries = new Map<string, Entry>()
  private opts: Required<TrackerOptions>

  constructor(opts: TrackerOptions = {}) {
    this.opts = {
      successAlpha: opts.successAlpha ?? 0.3,
      failureAlpha: opts.failureAlpha ?? 0.5,
      defaultRateLimitMs: opts.defaultRateLimitMs ?? 60_000,
      hardFailureDisableAfter: opts.hardFailureDisableAfter ?? 5,
    }
  }

  /** Ensure an entry exists; creates with a neutral score. */
  register(id: string): void {
    if (!this.entries.has(id)) {
      this.entries.set(id, {
        id,
        score: 0.5,
        lastUsedAt: 0,
        cooldownUntil: 0,
        consecutiveHardFailures: 0,
        disabled: false,
        recentSuccesses: 0,
        recentFailures: 0,
      })
    }
  }

  /** Remove tracking for a credential (e.g. user deleted it). */
  unregister(id: string): void {
    this.entries.delete(id)
  }

  /** Is the tracker currently tracking this id? */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  recordSuccess(id: string): void {
    const e = this.ensure(id)
    e.score = mixEMA(e.score, 1, this.opts.successAlpha)
    e.consecutiveHardFailures = 0
    e.recentSuccesses++
    e.lastUsedAt = Date.now()
  }

  /**
   * Record a rate-limit hit with optional server-specified cooldown.
   * The cooldown keeps the credential ineligible for `cooldownMs` before
   * it can be picked again, even if its score is highest.
   */
  recordRateLimit(id: string, cooldownMs?: number): void {
    const e = this.ensure(id)
    const wait = cooldownMs && cooldownMs > 0 ? cooldownMs : this.opts.defaultRateLimitMs
    e.cooldownUntil = Math.max(e.cooldownUntil, Date.now() + wait)
    // Rate limits are not a quality signal by themselves — small nudge only.
    e.score = mixEMA(e.score, 0.3, 0.15)
    e.lastUsedAt = Date.now()
  }

  recordFailure(id: string): void {
    const e = this.ensure(id)
    e.score = mixEMA(e.score, 0, this.opts.failureAlpha)
    e.consecutiveHardFailures++
    e.recentFailures++
    e.lastUsedAt = Date.now()
    if (
      this.opts.hardFailureDisableAfter > 0
      && e.consecutiveHardFailures >= this.opts.hardFailureDisableAfter
    ) {
      e.disabled = true
    }
  }

  /** Reset a disabled credential (user clicked "re-enable" or auth refreshed). */
  reenable(id: string): void {
    const e = this.ensure(id)
    e.disabled = false
    e.consecutiveHardFailures = 0
    e.cooldownUntil = 0
  }

  /** Disable a credential explicitly. */
  disable(id: string): void {
    const e = this.ensure(id)
    e.disabled = true
  }

  /**
   * Pick the best available credential from `ids`. Returns null when
   * every candidate is disabled or in cooldown.
   */
  pickBest(ids: string[]): string | null {
    const now = Date.now()
    let best: { id: string; score: number; lastUsedAt: number } | null = null
    for (const id of ids) {
      const e = this.entries.get(id)
      if (!e) {
        // Unregistered — neutral; prefer over known-bad.
        if (!best || 0.5 > best.score) best = { id, score: 0.5, lastUsedAt: 0 }
        continue
      }
      if (e.disabled) continue
      if (e.cooldownUntil > now) continue
      if (!best || e.score > best.score
        || (e.score === best.score && e.lastUsedAt < best.lastUsedAt)) {
        best = { id, score: e.score, lastUsedAt: e.lastUsedAt }
      }
    }
    return best ? best.id : null
  }

  /**
   * When every candidate is in cooldown, return the one with the
   * earliest cooldown-exit so the caller can sleep until then.
   */
  earliestRecovery(ids: string[]): { id: string; at: number } | null {
    let soonest: { id: string; at: number } | null = null
    for (const id of ids) {
      const e = this.entries.get(id)
      if (!e || e.disabled) continue
      if (e.cooldownUntil <= 0) return { id, at: 0 }
      if (!soonest || e.cooldownUntil < soonest.at) {
        soonest = { id, at: e.cooldownUntil }
      }
    }
    return soonest
  }

  snapshot(id: string): HealthSnapshot | null {
    const e = this.entries.get(id)
    if (!e) return null
    const now = Date.now()
    return {
      id: e.id,
      score: e.score,
      recentSuccesses: e.recentSuccesses,
      recentFailures: e.recentFailures,
      cooldownRemaining: Math.max(0, e.cooldownUntil - now),
      disabled: e.disabled,
      lastUsedAt: e.lastUsedAt,
    }
  }

  snapshotAll(): HealthSnapshot[] {
    const now = Date.now()
    const out: HealthSnapshot[] = []
    this.entries.forEach(e => {
      out.push({
        id: e.id,
        score: e.score,
        recentSuccesses: e.recentSuccesses,
        recentFailures: e.recentFailures,
        cooldownRemaining: Math.max(0, e.cooldownUntil - now),
        disabled: e.disabled,
        lastUsedAt: e.lastUsedAt,
      })
    })
    return out
  }

  private ensure(id: string): Entry {
    this.register(id)
    return this.entries.get(id)!
  }
}

function mixEMA(prev: number, target: number, alpha: number): number {
  const v = prev * (1 - alpha) + target * alpha
  return Math.max(0, Math.min(1, v))
}
