/**
 * `/surf status` — snapshot of the current router state.
 *
 * Reads non-React surf state via getters (no subscriptions — the panel
 * is mounted once and then closed, so there's nothing to reactively
 * update). Shows:
 *   - on/off
 *   - current phase + per-phase provider/model target
 *   - per-phase usage stats (turns, tokens, cache hit %)
 */

import chalk from 'chalk'
import type { CommandResultDisplay } from '../../commands.js'
import { getGlobalConfig } from '../../utils/config.js'
import { PROVIDER_DISPLAY_NAMES, type APIProvider } from '../../utils/model/providers.js'
import {
  getCurrentSurfPhase,
  getSurfStats,
  isSurfEnabled,
  SURF_PHASES,
  type PhaseStats,
  type SurfPhase,
} from '../../utils/surf/state.js'

const PHASE_LABEL: Record<SurfPhase, string> = {
  planning: 'Planning',
  building: 'Building',
  reviewing: 'Reviewing',
  thinking: 'Thinking',
  subagent: 'Subagent',
  longContext: 'Long Context',
  background: 'Background',
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function cacheHitPct(stats: PhaseStats): string {
  if (stats.inputTokens === 0) return '—'
  const pct = (stats.cacheReadTokens / stats.inputTokens) * 100
  return `${pct.toFixed(0)}%`
}

/**
 * Emit the /surf status view as a system message via onDone.
 * Non-JSX because nothing is interactive.
 */
export function showSurfStatus(
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void,
): void {
  const enabled = isSurfEnabled()
  const config = getGlobalConfig()
  const targets = config.surfPhaseTargets
  const current = getCurrentSurfPhase()
  const stats = getSurfStats()

  const header = enabled
    ? `${chalk.bold('🌊 Surf: on')}${current ? chalk.dim(` · current phase: ${chalk.bold(PHASE_LABEL[current])}`) : ''}`
    : chalk.bold('🌊 Surf: off')

  const lines: string[] = [header, '']

  if (!targets) {
    lines.push(
      chalk.dim('No phase targets configured yet. Run /surf to set them up.'),
    )
    onDone(lines.join('\n'), { display: 'system' })
    return
  }

  lines.push(chalk.bold('Phase routing:'))
  for (const phase of SURF_PHASES) {
    const target = targets[phase]
    const isCurrent = phase === current
    const marker = isCurrent ? chalk.cyan('▶ ') : '  '
    const label = PHASE_LABEL[phase].padEnd(13)
    if (!target) {
      lines.push(
        `${marker}${label} ${chalk.yellow('(skipped — keeps current model)')}`,
      )
      continue
    }
    const providerName = PROVIDER_DISPLAY_NAMES[target.provider as APIProvider] ?? target.provider
    const effortSuffix =
      target.effort !== undefined ? chalk.dim(` · ${target.effort}`) : ''
    lines.push(
      `${marker}${isCurrent ? chalk.bold(label) : label} ${chalk.dim(providerName)} · ${target.model}${effortSuffix}`,
    )
  }

  const hasAnyUsage = SURF_PHASES.some(p => stats[p].turns > 0)
  if (hasAnyUsage) {
    lines.push('')
    lines.push(chalk.bold('Usage this session:'))
    for (const phase of SURF_PHASES) {
      const s = stats[phase]
      if (s.turns === 0) continue
      lines.push(
        `  ${chalk.cyan(PHASE_LABEL[phase].padEnd(13))} ${s.turns} turn${s.turns === 1 ? '' : 's'} · ${formatTokens(s.inputTokens)} in / ${formatTokens(s.outputTokens)} out · cache ${cacheHitPct(s)}`,
      )
    }
  }

  lines.push('')
  lines.push(
    chalk.dim(
      enabled
        ? 'Run /surf to toggle off, /surf config to re-pick models.'
        : 'Run /surf to toggle on.',
    ),
  )

  onDone(lines.join('\n'), { display: 'system' })
}
