import chalk from 'chalk'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getAPIProvider,
  setActiveProvider,
  PROVIDER_DISPLAY_NAMES,
  SELECTABLE_PROVIDERS,
  type APIProvider,
} from '../../utils/model/providers.js'
import { getProviderAuthStatus } from '../../services/api/auth/provider_auth.js'
import { hasStoredKey } from '../../services/api/auth/api_key_manager.js'

type ProviderOption = {
  label: string
  value: APIProvider
  authMethod: string
  configured: boolean
}

function getProviderOptions(): ProviderOption[] {
  const current = getAPIProvider()
  return SELECTABLE_PROVIDERS.map((p) => {
    const name = PROVIDER_DISPLAY_NAMES[p]
    const isOAuth = p === 'openai' || p === 'gemini'
    const isFirstParty = p === 'firstParty'
    const authMethod = isFirstParty
      ? 'OAuth'
      : isOAuth
        ? 'OAuth / API Key'
        : 'API Key'

    let configured = false
    if (isFirstParty) {
      configured = true // Anthropic auth is handled separately
    } else {
      configured = hasStoredKey(p) || hasStoredKey(`${p}_oauth`)
    }

    return {
      label: name,
      value: p,
      authMethod,
      configured,
    }
  })
}

function ProviderPicker({
  onDone,
}: {
  onDone: (message: string, options?: CommandResultDisplay) => void
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const options = getProviderOptions()
  const current = getAPIProvider()

  // Find the current provider index for initial highlight
  const currentIdx = options.findIndex((o) => o.value === current)

  const { useInput } = require('../../ink.js')
  useInput((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) => {
    if (key.escape) {
      onDone(`Kept provider as ${chalk.bold(PROVIDER_DISPLAY_NAMES[current])}`, {
        display: 'system',
      })
      return
    }
    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : options.length - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i < options.length - 1 ? i + 1 : 0))
      return
    }
    if (key.return) {
      const selected = options[selectedIndex]
      if (!selected) return

      if (selected.value === current) {
        onDone(
          `Already using ${chalk.bold(PROVIDER_DISPLAY_NAMES[current])}`,
          { display: 'system' },
        )
        return
      }

      setActiveProvider(selected.value)

      if (!selected.configured && selected.value !== 'firstParty') {
        onDone(
          `Switched to ${chalk.bold(selected.label)}. Run ${chalk.cyan('/login')} to set up credentials.`,
          { display: 'system' },
        )
      } else {
        onDone(
          `Switched to ${chalk.bold(selected.label)}`,
          { display: 'system' },
        )
      }
    }
  })

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          Select AI Provider
        </Text>
      </Box>
      {options.map((opt, i) => {
        const isSelected = i === selectedIndex
        const isCurrent = opt.value === current
        const prefix = isSelected ? '>' : ' '
        const status = opt.configured ? chalk.green(' [configured]') : chalk.yellow(' [not configured]')
        const currentBadge = isCurrent ? chalk.cyan(' (active)') : ''

        return (
          <Box key={opt.value}>
            <Text
              bold={isSelected}
              color={isSelected ? 'claude' : undefined}
              dimColor={!isSelected}
            >
              {prefix} {opt.label}
            </Text>
            <Text dimColor>
              {' '}({opt.authMethod}){status}{currentBadge}
            </Text>
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>
          Use arrow keys to navigate, Enter to select, Esc to cancel
        </Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async ({
  onDone,
}) => {
  return {
    component: <ProviderPicker onDone={onDone} />,
  }
}
