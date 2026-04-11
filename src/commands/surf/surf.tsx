/**
 * /surf — smart phase router command.
 *
 * Subcommand dispatch:
 *   /surf            first-run: walk the wizard. Subsequent: toggle on/off.
 *   /surf on         force-enable (requires targets already configured).
 *   /surf off        force-disable.
 *   /surf status     show current phase/targets/stats.
 *   /surf config     re-run the wizard.
 *   /surf reset      clear targets and disable.
 *   /surf help       usage.
 */

import * as React from 'react'
import chalk from 'chalk'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'
import { getDefaultBrowsableProvider } from '../../utils/model/providerCatalog.js'
import {
  isSurfEnabled,
  setSurfEnabled,
  setCurrentSurfPhase,
  resetSurfStats,
  SURF_PHASES,
} from '../../utils/surf/state.js'
import { SurfWizard } from './SurfWizard.js'
import { showSurfStatus } from './SurfStatus.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function hasAllTargets(
  targets:
    | Record<string, { provider: string; model: string }>
    | undefined,
): boolean {
  if (!targets) return false
  return SURF_PHASES.every(phase => {
    const t = targets[phase]
    return !!t && !!t.provider && !!t.model
  })
}

function toggleOn(onDone: OnDone) {
  const targets = getGlobalConfig().surfPhaseTargets
  if (!hasAllTargets(targets)) {
    onDone(
      'Surf has no phase targets yet. Run /surf to pick a model for each phase.',
      { display: 'system' },
    )
    return
  }
  setSurfEnabled(true)
  setCurrentSurfPhase(null)
  const lines = [
    `${chalk.bold('🌊 Surf enabled.')} Phase router will switch models each turn.`,
    chalk.dim('Run /surf status to inspect, /surf to toggle off.'),
  ]
  onDone(lines.join('\n'))
}

function toggleOff(onDone: OnDone) {
  setSurfEnabled(false)
  onDone(`${chalk.bold('🌊 Surf disabled.')} Model stays wherever you last set it.`)
}

function showHelp(onDone: OnDone) {
  const lines = [
    `${chalk.bold('/surf')} - smart phase router`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/surf')}           First run: pick models. Subsequent: toggle on/off.`,
    `  ${chalk.cyan('/surf on')}        Enable (requires configured targets)`,
    `  ${chalk.cyan('/surf off')}       Disable`,
    `  ${chalk.cyan('/surf status')}    Show phase routing and usage stats`,
    `  ${chalk.cyan('/surf config')}    Re-pick models for each phase`,
    `  ${chalk.cyan('/surf reset')}     Clear targets and disable`,
    '',
    chalk.bold('Phases:'),
    `  ${chalk.cyan('planning'.padEnd(12))} strongest reasoning — planning, architecture`,
    `  ${chalk.cyan('building'.padEnd(12))} fast code writer — edits, file creation`,
    `  ${chalk.cyan('reviewing'.padEnd(12))} critical eye — review/audit passes`,
    `  ${chalk.cyan('background'.padEnd(12))} quick & cheap — short questions`,
    '',
    chalk.dim(
      'Phase detection is automatic (plan mode, tool history, keywords, message shape).',
    ),
    chalk.dim('Surf prints the active phase banner on every switch.'),
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const subcommand = (args?.trim() || '').toLowerCase()

  switch (subcommand) {
    case 'help':
    case '-h':
    case '--help':
    case '?':
      showHelp(onDone)
      return

    case 'status':
      showSurfStatus(onDone)
      return

    case 'on':
      toggleOn(onDone)
      return

    case 'off':
      toggleOff(onDone)
      return

    case 'reset':
      saveGlobalConfig(current => ({ ...current, surfPhaseTargets: undefined }))
      setSurfEnabled(false)
      setCurrentSurfPhase(null)
      resetSurfStats()
      onDone(
        `${chalk.bold('🌊 Surf reset.')} Targets cleared and router disabled.`,
      )
      return

    case 'config': {
      const initialProvider = getDefaultBrowsableProvider(getAPIProvider())
      return <SurfWizard onDone={onDone} initialProvider={initialProvider} />
    }

    case '':
    default: {
      // No-arg path: first run → wizard; after configured → toggle.
      const targets = getGlobalConfig().surfPhaseTargets
      if (!hasAllTargets(targets)) {
        const initialProvider = getDefaultBrowsableProvider(getAPIProvider())
        return <SurfWizard onDone={onDone} initialProvider={initialProvider} />
      }

      // Targets exist — treat /surf as a toggle.
      if (isSurfEnabled()) {
        toggleOff(onDone)
      } else {
        toggleOn(onDone)
      }
      return
    }
  }
}
