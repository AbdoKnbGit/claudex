/**
 * Surf JSONL logger — one line per API response while /surf is on.
 *
 * Goal: let you verify which model actually served each turn, whether the
 * prompt cache is warming (reading tokens), or whether every phase switch
 * is cold. File location: ~/.claudex/logs/surf-YYYY-MM-DD.jsonl, append
 * only, one JSON object per line — tail with `tail -f`, grep by phase or
 * provider, pipe into jq.
 *
 * Surf off ⇒ zero I/O: the single entry point bails before touching disk
 * if isSurfEnabled() is false. No log files created, no handles opened.
 *
 * Errors are swallowed by design: a failed log write must never break a
 * user turn. We log to stderr only on truly unexpected failures.
 */

import { appendFile, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { isSurfEnabled } from './state.js'
import type { SurfPhase } from './state.js'

export interface SurfLogEntry {
  phase: SurfPhase
  provider: string
  model: string
  effort?: string | number
  /** Phase before this turn — useful for measuring "switch cost" (cold
   * cache reads on the turn right after a phase change). */
  previousPhase?: SurfPhase | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUSD?: number
}

let _logDirEnsured: string | null = null

/** Idempotently create the log directory. Cached per-process so we don't
 *  stat on every turn. */
async function ensureLogDir(): Promise<string> {
  if (_logDirEnsured) return _logDirEnsured
  const dir = join(homedir(), '.claudex', 'logs')
  await mkdir(dir, { recursive: true })
  _logDirEnsured = dir
  return dir
}

function todayFile(dir: string): string {
  // Local-time YYYY-MM-DD is fine — the user reads this interactively,
  // not across timezones. Avoids importing a date library.
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return join(dir, `surf-${yyyy}-${mm}-${dd}.jsonl`)
}

/**
 * Append a single JSONL record describing one API response attributed to
 * a surf phase. Cheap enough to call from cost-tracker's hot path because
 * appendFile is buffered by the OS — but still short-circuits when surf
 * is off so we don't even format the payload.
 *
 * Fire-and-forget: we kick off the write and discard the promise. The
 * caller never awaits this; if the process exits before the write
 * flushes, worst case we lose the last line, which is acceptable for a
 * debug-style log.
 */
export function logSurfEntry(entry: SurfLogEntry): void {
  if (!isSurfEnabled()) return

  const totalInput =
    entry.inputTokens + entry.cacheReadTokens + entry.cacheCreationTokens
  const cacheHitPct =
    totalInput > 0
      ? Math.round((entry.cacheReadTokens / totalInput) * 100)
      : 0

  const record = {
    ts: new Date().toISOString(),
    phase: entry.phase,
    provider: entry.provider,
    model: entry.model,
    effort: entry.effort ?? null,
    previousPhase: entry.previousPhase ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheRead: entry.cacheReadTokens,
    cacheCreate: entry.cacheCreationTokens,
    cacheHitPct,
    costUsd: entry.costUSD ?? null,
  }

  const line = JSON.stringify(record) + '\n'

  // Intentional floating promise — see function doc. Errors land in the
  // catch and we stay silent; tail of a corrupt log is easier to debug
  // than a crashed turn.
  void (async () => {
    try {
      const dir = await ensureLogDir()
      await appendFile(todayFile(dir), line, 'utf8')
    } catch (err) {
      // Last-resort stderr — not user-visible, shows up in debug logs.
      // eslint-disable-next-line no-console
      console.error('[surf] log write failed:', err)
    }
  })()
}
