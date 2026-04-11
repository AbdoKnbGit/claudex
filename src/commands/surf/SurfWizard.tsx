/**
 * Surf first-run wizard — walks the user through picking a
 * provider+model for each of the four phases.
 *
 * The flow is deliberately sequential: one ProviderModelPicker per phase,
 * in the order planning → building → reviewing → background. After the
 * last pick is saved, surf flips on and routes through detectPhase from
 * that turn onwards.
 *
 * Re-run /surf config to re-walk the wizard without toggling.
 */

import * as React from 'react'
import { useState } from 'react'
import chalk from 'chalk'
import { Box, Text } from '../../ink.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import type { CommandResultDisplay } from '../../commands.js'
import { saveGlobalConfig } from '../../utils/config.js'
import type { BrowsableModelProvider } from '../../utils/model/providerCatalog.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  SURF_PHASES,
  setCurrentSurfPhase,
  setSurfEnabled,
  type SurfPhase,
} from '../../utils/surf/state.js'

const PHASE_LABEL: Record<SurfPhase, string> = {
  planning: 'Planning',
  building: 'Building',
  reviewing: 'Reviewing',
  background: 'Background',
}

const PHASE_DESCRIPTION: Record<SurfPhase, string> = {
  planning: 'strongest reasoning — planning, architecting, open-ended problems',
  building: 'fast code writer — edits, file creation, tool-heavy turns',
  reviewing: 'critical eye — review/audit/verification passes',
  background: 'quick & cheap — short questions, confirmations, idle chat',
}

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  initialProvider: BrowsableModelProvider
}

type Picks = Partial<Record<SurfPhase, { provider: APIProvider; model: string }>>

export function SurfWizard({ onDone, initialProvider }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [picks, setPicks] = useState<Picks>({})

  const currentPhase = SURF_PHASES[stepIndex]

  if (!currentPhase) {
    // Should never render — finalization happens on the last Enter.
    return null
  }

  function handleSelect(provider: BrowsableModelProvider, modelId: string) {
    const nextPicks: Picks = {
      ...picks,
      [currentPhase!]: { provider, model: modelId },
    }
    setPicks(nextPicks)

    if (stepIndex < SURF_PHASES.length - 1) {
      setStepIndex(stepIndex + 1)
      return
    }

    // Last phase — persist everything, enable surf, report the summary.
    const fullTargets = SURF_PHASES.reduce<
      Record<SurfPhase, { provider: string; model: string }>
    >(
      (acc, phase) => {
        const pick = nextPicks[phase]
        if (pick) acc[phase] = pick
        return acc
      },
      {} as Record<SurfPhase, { provider: string; model: string }>,
    )

    saveGlobalConfig(current => ({
      ...current,
      surfPhaseTargets: fullTargets,
    }))
    setSurfEnabled(true)
    // Reset so the first real turn fires detectPhase → applyPhase clean.
    setCurrentSurfPhase(null)

    const lines = [
      `${chalk.bold('🌊 Surf enabled.')} Phase router will switch models each turn.`,
      '',
      ...SURF_PHASES.map(phase => {
        const pick = nextPicks[phase]!
        return `  ${chalk.cyan(PHASE_LABEL[phase].padEnd(11))} ${chalk.bold(
          PROVIDER_DISPLAY_NAMES[pick.provider as APIProvider],
        )} · ${pick.model}`
      }),
      '',
      chalk.dim('Run /surf to toggle off, /surf status to inspect, /surf config to re-pick.'),
    ]
    onDone(lines.join('\n'))
  }

  function handleCancel() {
    onDone('Surf setup cancelled', { display: 'system' })
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="claude">
          🌊 Surf setup — step {stepIndex + 1} of {SURF_PHASES.length}
        </Text>
        <Text>
          Pick the model for <Text bold>{PHASE_LABEL[currentPhase]}</Text>{' '}
          <Text dimColor>({PHASE_DESCRIPTION[currentPhase]})</Text>
        </Text>
      </Box>

      <ProviderModelPicker
        initialProvider={initialProvider}
        onSelect={handleSelect}
        onCancel={handleCancel}
      />
    </Box>
  )
}
