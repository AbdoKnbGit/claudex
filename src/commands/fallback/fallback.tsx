import chalk from 'chalk'
import * as React from 'react'
import { useEffect, useRef } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { applyFallbackTargetToRuntime } from '../../utils/fallback/apply.js'
import {
  clearFallbackProcess,
  FALLBACK_TARGET_COUNT,
  formatFallbackTarget,
  getConfiguredFallbackTargets,
  getPendingFallback,
  rejectPendingFallback,
  startFallbackProcess,
  type FallbackAttempt,
  type PendingFallback,
} from '../../utils/fallback/state.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getDefaultBrowsableProvider } from '../../utils/model/providerCatalog.js'
import { FallbackWizard } from './FallbackWizard.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function buildContinuePrompt(attempt: FallbackAttempt): string {
  return [
    'The previous model failed before completing the user request.',
    `Continue the same work using fallback model ${attempt.index + 1}/${attempt.total}: ${formatFallbackTarget(attempt.target)}.`,
    'Do not restart from scratch, do not summarize the failure, and do not cut scope. Use the existing transcript and complete the user request.',
  ].join('\n')
}

function FallbackContinueRunner({
  attempt,
  onDone,
  setMessages,
}: {
  attempt: FallbackAttempt
  onDone: OnDone
  setMessages: Parameters<LocalJSXCommandCall>[1]['setMessages']
}) {
  const setAppState = useSetAppState()
  const didRun = useRef(false)

  useEffect(() => {
    if (didRun.current) {
      return
    }
    didRun.current = true

    const effort = applyFallbackTargetToRuntime(attempt.target)
    setAppState(prev => ({
      ...prev,
      mainLoopModel: attempt.target.model,
      mainLoopModelForSession: null,
      ...(effort !== undefined ? { effortValue: effort } : {}),
    }))

    if (attempt.target.provider === 'firstParty') {
      setMessages(stripSignatureBlocks)
    }

    enqueue({
      value: buildContinuePrompt(attempt),
      mode: 'prompt',
      priority: 'next',
      isMeta: true,
      skipSlashCommands: true,
    })

    onDone(
      `${chalk.bold('Fallback approved.')} Continuing with ${chalk.cyan(formatFallbackTarget(attempt.target))}.`,
      { display: 'system' },
    )
  }, [attempt, onDone, setAppState, setMessages])

  return null
}

function showHelp(onDone: OnDone) {
  const lines = [
    `${chalk.bold('/fallback')} - fallback model chain`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/fallback')}          Configure three models on first run, otherwise show status`,
    `  ${chalk.cyan('/fallback config')}   Pick the three fallback models again`,
    `  ${chalk.cyan('/fallback status')}   Show configured priority order`,
    `  ${chalk.cyan('/fallback yes')}      Continue the failed work with fallback models`,
    `  ${chalk.cyan('/fallback no')}       Cancel a pending fallback prompt`,
    `  ${chalk.cyan('/fallback reset')}    Clear fallback configuration`,
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function showStatus(onDone: OnDone) {
  const targets = getConfiguredFallbackTargets()
  const pending = getPendingFallback()
  const lines: string[] = [`${chalk.bold('/fallback status')}`]

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
  }

  if (pending) {
    lines.push('', chalk.bold('Pending confirmation:'))
    lines.push(
      `  ${pending.originalProvider}/${pending.originalModel} failed: ${pending.errorMessage}`,
    )
    lines.push(
      `  Run ${chalk.cyan('/fallback yes')} to continue or ${chalk.cyan('/fallback no')} to cancel.`,
    )
  }

  onDone(lines.join('\n'), { display: 'system' })
}

function showPendingPrompt(onDone: OnDone, pending: PendingFallback) {
  const targets = getConfiguredFallbackTargets()
  const lines = [
    `${chalk.bold('Fallback confirmation pending.')}`,
    `${pending.originalProvider}/${pending.originalModel} failed: ${pending.errorMessage}`,
    '',
    'Fallback priority:',
    ...targets.map(
      (target, index) =>
        `  ${index + 1}. ${chalk.cyan(formatFallbackTarget(target))}`,
    ),
    '',
    `Run ${chalk.cyan('/fallback yes')} to continue or ${chalk.cyan('/fallback no')} to cancel.`,
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function resetFallback(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    fallbackTargets: undefined,
  }))
  rejectPendingFallback()
  clearFallbackProcess()
  onDone(`${chalk.bold('Fallback reset.')} Targets cleared.`, {
    display: 'system',
  })
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
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

    case 'reset':
    case 'off':
      resetFallback(onDone)
      return

    case 'no':
    case 'n':
      rejectPendingFallback()
      onDone('Fallback cancelled. No fallback model will be used.', {
        display: 'system',
      })
      return

    case 'yes':
    case 'y': {
      const pending = getPendingFallback()
      if (!pending) {
        onDone('No fallback confirmation is pending.', { display: 'system' })
        return
      }

      const targets = getConfiguredFallbackTargets()
      if (targets.length === 0) {
        onDone(
          'Fallback has no configured models. Run /fallback config first.',
          { display: 'system' },
        )
        return
      }

      const attempt = startFallbackProcess()
      if (!attempt) {
        onDone('Fallback could not start because no models are configured.', {
          display: 'system',
        })
        return
      }

      return (
        <FallbackContinueRunner
          attempt={attempt}
          onDone={onDone}
          setMessages={context.setMessages}
        />
      )
    }

    case '': {
      const pending = getPendingFallback()
      if (pending) {
        showPendingPrompt(onDone, pending)
        return
      }

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
