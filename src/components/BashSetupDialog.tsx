import React, { useState } from 'react'
import { Box, Newline, Text } from '../ink.js'
import { saveGlobalConfig } from '../utils/config.js'
import {
  detectBash,
  resetBashAvailabilityCache,
  type BashStatus,
} from '../utils/shell/bashAvailability.js'
import {
  planBashInstall,
  runBashInstall,
  type InstallPlan,
} from '../utils/shell/bashInstaller.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  initialStatus: BashStatus
  onDone(): void
}

type Decision = 'satisfied' | 'installed' | 'declined' | 'manual'

/**
 * First-launch prompt offering to install (or upgrade) bash. Only shown
 * when:
 *   - bash is missing entirely (Windows without git-bash, exotic Linux), or
 *   - the only bash available is Apple's stock 3.2 on macOS.
 *
 * The result (approved/declined/manual) is stored in GlobalConfig so we
 * don't re-prompt on subsequent launches.
 */
export function BashSetupDialog({ initialStatus, onDone }: Props): React.ReactNode {
  const [plan] = useState<InstallPlan>(() => planBashInstall())
  const [phase, setPhase] = useState<'ask' | 'installing' | 'done'>('ask')
  const [resultMessage, setResultMessage] = useState<string | null>(null)
  const [resultOk, setResultOk] = useState<boolean | null>(null)

  const why = describeReason(initialStatus)

  function persist(decision: Decision): void {
    saveGlobalConfig(current => ({
      ...current,
      bashSetupResponse: {
        decision,
        at: new Date().toISOString(),
        source: initialStatus.source ?? undefined,
      },
    }))
  }

  function finish(decision: Decision): void {
    persist(decision)
    onDone()
  }

  function onAnswer(value: 'install' | 'skip'): void {
    if (value === 'skip') {
      finish('declined')
      return
    }

    if (!plan.canInstall) {
      // Can't auto-install; surface the manual instructions and treat
      // this as the user accepting the manual path.
      setResultOk(false)
      setResultMessage(plan.manualNote ?? 'Manual install required.')
      setPhase('done')
      // Persisted only after the user dismisses the result screen.
      return
    }

    setPhase('installing')
    // Deferred to next tick so React paints the "installing" state before
    // we hand the terminal over to the installer's inherited stdio.
    setTimeout(() => {
      const result = runBashInstall(plan)
      resetBashAvailabilityCache()
      setResultOk(result.ok)
      setResultMessage(result.message)
      setPhase('done')
    }, 0)
  }

  function onDismissResult(): void {
    if (resultOk) {
      finish('installed')
    } else if (!plan.canInstall) {
      finish('manual')
    } else {
      finish('declined')
    }
  }

  if (phase === 'installing') {
    return (
      <Dialog title="Installing bash…" onCancel={() => undefined}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Running: <Text bold>{plan.command}</Text>
          </Text>
          <Text dimColor>
            The installer's output is printed below. This may take a minute.
          </Text>
        </Box>
      </Dialog>
    )
  }

  if (phase === 'done') {
    return (
      <Dialog
        title={resultOk ? 'Bash setup complete' : 'Bash setup'}
        color={resultOk ? 'success' : 'warning'}
        onCancel={onDismissResult}
      >
        <Box flexDirection="column" gap={1}>
          <Text>{resultMessage}</Text>
          {plan.manualUrl ? (
            <Text dimColor>{plan.manualUrl}</Text>
          ) : null}
        </Box>
        <Select
          options={[{ label: 'Continue', value: 'ok' }]}
          onChange={onDismissResult}
          onCancel={onDismissResult}
        />
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Set up bash for claudex"
      onCancel={() => finish('declined')}
    >
      <Box flexDirection="column" gap={1}>
        <Text>{why}</Text>
        <Text>
          claudex works best with bash. I can install it for you using{' '}
          <Text bold>{plan.canInstall ? plan.label : 'a manual download'}</Text>.
          <Newline />
          Command:{' '}
          <Text bold>{plan.canInstall ? plan.command : (plan.manualUrl ?? 'n/a')}</Text>
        </Text>
        {!plan.canInstall && plan.manualNote ? (
          <Text dimColor>{plan.manualNote}</Text>
        ) : null}
      </Box>
      <Select
        defaultValue="install"
        defaultFocusValue="install"
        options={[
          {
            label: plan.canInstall ? 'Yes, install bash' : 'Show me the manual steps',
            value: 'install',
          },
          { label: 'No, skip and continue', value: 'skip' },
        ]}
        onChange={(value: string) => onAnswer(value as 'install' | 'skip')}
        onCancel={() => finish('declined')}
      />
    </Dialog>
  )
}

/**
 * Decide whether this dialog should run. Returns the current bash status
 * if we should prompt, or null to skip.
 */
export function shouldShowBashSetup(opts: {
  alreadyAcknowledged: boolean
  resetRequested: boolean
}): BashStatus | null {
  if (opts.alreadyAcknowledged && !opts.resetRequested) return null
  const status = detectBash()
  if (!status.ok) return status
  // macOS stock bash 3.2 is functional but ancient — offer a brew upgrade.
  if (status.isAppleStock) return status
  return null
}

function describeReason(status: BashStatus): string {
  if (!status.ok) {
    if (process.platform === 'win32') {
      return 'No bash detected on this machine (no Git for Windows, no WSL).'
    }
    if (process.platform === 'linux') {
      return 'No bash detected on this Linux machine (very rare — most distros preinstall it).'
    }
    return 'No bash detected.'
  }
  if (status.isAppleStock) {
    return `macOS only ships bash ${status.versionLine ?? '3.2'} at /bin/bash. claudex still works, but a current bash via Homebrew is recommended for full feature support.`
  }
  return 'bash is available, but an upgrade is recommended.'
}
