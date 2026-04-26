import React, { useEffect } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text, useTheme } from '../ink.js'
import type { ThemeSetting } from '../utils/theme.js'
import { ThemePicker } from './ThemePicker.js'

type Props = {
  onDone(): void
}

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [, setTheme] = useTheme()
  const exitState = useExitOnCtrlCDWithKeybindings()

  useEffect(() => {
    logEvent('tengu_began_setup', {
      oauthEnabled: false,
    })
  }, [])

  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme)
    onDone()
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginX={1} marginBottom={1} gap={1}>
        <Text bold color="claude">
          Claudex setup
        </Text>
        <Box width={70}>
          <Text dimColor>
            Choose the terminal theme for Claudex. You can connect an AI
            provider later with /login or /provider.
          </Text>
        </Box>
      </Box>

      <Box marginX={1}>
        <ThemePicker
          onThemeSelect={handleThemeSelection}
          showIntroText={true}
          helpText="To change this later, run /theme"
          hideEscToCancel={true}
          skipExitHandling={true}
          showPreview={false}
        />
      </Box>

      {exitState.pending && (
        <Box padding={1}>
          <Text dimColor>Press {exitState.keyName} again to exit</Text>
        </Box>
      )}
    </Box>
  )
}
