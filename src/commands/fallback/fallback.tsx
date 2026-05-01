import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  clearFallbackProcess,
  FALLBACK_TARGET_COUNT,
  formatFallbackTarget,
  getConfiguredFallbackTargets,
  isFallbackEnabled,
} from '../../utils/fallback/state.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getDefaultBrowsableProvider } from '../../utils/model/providerCatalog.js'
import { FallbackWizard } from './FallbackWizard.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function showHelp(onDone: OnDone) {
  const lines = [
    `${chalk.bold('/fallback')} - automatic fallback model chain`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/fallback')}          Configure three models on first run, otherwise show status`,
    `  ${chalk.cyan('/fallback on')}       Turn on automatic fallback`,
    `  ${chalk.cyan('/fallback off')}      Turn off automatic fallback but keep the configured chain`,
    `  ${chalk.cyan('/fallback config')}   Pick the three fallback models again`,
    `  ${chalk.cyan('/fallback status')}   Show toggle state and configured priority order`,
    `  ${chalk.cyan('/fallback reset')}    Clear fallback configuration`,
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function showStatus(onDone: OnDone) {
  const targets = getConfiguredFallbackTargets()
  const enabled = isFallbackEnabled()
  const lines: string[] = [`${chalk.bold('/fallback status')}`]

  lines.push(
    '',
    `${chalk.bold('Mode:')} ${enabled ? chalk.green('on') : chalk.dim('off')}`,
  )

  if (targets.length === 0) {
    lines.push('', 'No fallback models configured.')
    lines.push(chalk.dim('Run /fallback config to choose three models.'))
  } else {
    lines.push('', chalk.bold('Priority:'))
    lines.push(
      ...targets.map(
        (target, index) =>
          `  ${index + 1}. ${chalk.cyan(formatFallbackTarget(target))}`,
      ),
    )
    if (targets.length < FALLBACK_TARGET_COUNT) {
      lines.push(
        chalk.dim(
          `Only ${targets.length}/${FALLBACK_TARGET_COUNT} targets are configured. Run /fallback config to complete the chain.`,
        ),
      )
    }
    if (!enabled) {
      lines.push('', chalk.dim('Run /fallback on to enable automatic fallback.'))
    }
  }

  onDone(lines.join('\n'), { display: 'system' })
}

function resetFallback(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    fallbackEnabled: undefined,
    fallbackTargets: undefined,
  }))
  clearFallbackProcess()
  onDone(`${chalk.bold('Fallback reset.')} Targets cleared.`, {
    display: 'system',
  })
}

function turnFallbackOff(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    fallbackEnabled: false,
  }))
  clearFallbackProcess()
  onDone(`${chalk.bold('Fallback off.')} Configured targets were kept.`, {
    display: 'system',
  })
}

function turnFallbackOn(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    fallbackEnabled: true,
  }))
  onDone(
    `${chalk.bold('Fallback on.')} Eligible provider failures will automatically use the configured fallback chain.`,
    { display: 'system' },
  )
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
      showStatus(onDone)
      return

    case 'config':
    case 'setup':
      return (
        <FallbackWizard
          onDone={onDone}
          initialProvider={getDefaultBrowsableProvider(getAPIProvider())}
        />
      )

    case 'on': {
      const targets = getConfiguredFallbackTargets()
      if (targets.length === 0) {
        return (
          <FallbackWizard
            onDone={onDone}
            initialProvider={getDefaultBrowsableProvider(getAPIProvider())}
          />
        )
      }
      turnFallbackOn(onDone)
      return
    }

    case 'off':
      turnFallbackOff(onDone)
      return

    case 'reset':
      resetFallback(onDone)
      return

    case '': {
      const targets = getConfiguredFallbackTargets()
      if (targets.length === 0) {
        return (
          <FallbackWizard
            onDone={onDone}
            initialProvider={getDefaultBrowsableProvider(getAPIProvider())}
          />
        )
      }

      showStatus(onDone)
      return
    }

    default:
      showHelp(onDone)
      return
  }
}
