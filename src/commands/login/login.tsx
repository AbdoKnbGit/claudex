import { feature } from 'bun:bundle'
import * as React from 'react'
import { useState } from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { ProviderLoginFlow } from '../../components/ProviderLoginFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text, useInput } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  getAPIProvider,
  setActiveProvider,
  PROVIDER_DISPLAY_NAMES,
  SELECTABLE_PROVIDERS,
  type APIProvider,
} from '../../utils/model/providers.js'
import { hasStoredKey } from '../../services/api/auth/api_key_manager.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

// ─── Post-login refresh (shared between Anthropic and 3P flows) ──

function runPostLoginRefresh(context: LocalJSXCommandContext) {
  resetCostState()
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()
  clearTrustedDeviceToken()
  void enrollTrustedDevice()
  resetBypassPermissionsCheck()
  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }
  context.setAppState((prev) => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
}

// ─── Main login entry point ──────────────────────────────────────

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const currentProvider = getAPIProvider()
  return (
    <ProviderPickerLogin
      initialProvider={currentProvider}
      onDone={(success) => {
        if (success) {
          context.onChangeAPIKey()
          context.setMessages(stripSignatureBlocks)
          runPostLoginRefresh(context)
        }
        onDone(success ? 'Login successful' : 'Login interrupted')
      }}
    />
  )
}

// ─── Provider picker for first-time login ────────────────────────

function ProviderPickerLogin({
  initialProvider,
  onDone,
}: {
  initialProvider: APIProvider
  onDone: (success: boolean) => void
}) {
  const [selectedProvider, setSelectedProvider] = useState<APIProvider | null>(null)
  const initialIndex = Math.max(0, SELECTABLE_PROVIDERS.indexOf(initialProvider))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)

  useInput((_input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (selectedProvider) return // Already picked, let child handle input

    if (key.escape) {
      onDone(false)
      return
    }
    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : SELECTABLE_PROVIDERS.length - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i < SELECTABLE_PROVIDERS.length - 1 ? i + 1 : 0))
      return
    }
    if (key.return) {
      const provider = SELECTABLE_PROVIDERS[selectedIndex]
      if (provider) {
        setSelectedProvider(provider)
      }
    }
  })

  // Once a provider is selected, render its login flow
  if (selectedProvider) {
    const providerForLogin = selectedProvider
    const handleProviderDone = (success: boolean) => {
      if (success) {
        setActiveProvider(providerForLogin)
        onDone(true)
        return
      }
      // Cancel/error in provider flow should return to provider picker.
      setSelectedProvider(null)
    }

    if (providerForLogin === 'firstParty') {
      return <AnthropicLogin onDone={handleProviderDone} />
    }
    return (
      <ThirdPartyLogin
        provider={providerForLogin}
        onDone={handleProviderDone}
      />
    )
  }

  return (
    <Dialog
      title="Login - Choose Provider"
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold color="claude">
            Select a provider to sign in with:
          </Text>
        </Box>
        {SELECTABLE_PROVIDERS.map((p, i) => {
          const isSelected = i === selectedIndex
          const name = PROVIDER_DISPLAY_NAMES[p]
          const isOAuth = p === 'openai' || p === 'gemini'
          const isFirstParty = p === 'firstParty'
          const isAntigravity = p === 'antigravity'
          const authType = isFirstParty ? 'OAuth'
            : isAntigravity ? 'Google login'
            : p === 'gemini' ? 'Google / API Key'
            : isOAuth ? 'OAuth / API Key'
            : 'API Key'
          const configured = isFirstParty || hasStoredKey(p) || hasStoredKey(`${p}_oauth`)
            || (p === 'gemini' && hasStoredKey('gemini_oauth_cli'))
            || (p === 'antigravity' && hasStoredKey('gemini_oauth_antigravity'))
          const status = configured ? ' [configured]' : ''

          return (
            <Box key={p}>
              <Text
                bold={isSelected}
                color={isSelected ? 'claude' : undefined}
                dimColor={!isSelected}
              >
                {isSelected ? '> ' : '  '}
                {name}
              </Text>
              <Text dimColor>
                {' '}({authType}){status}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text dimColor>Use arrow keys, Enter to select, Esc to cancel</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

// ─── Anthropic (first-party) login ───────────────────────────────

function AnthropicLogin({
  onDone,
  startingMessage,
}: {
  onDone: (success: boolean) => void
  startingMessage?: string
}) {
  const mainLoopModel = useMainLoopModel()

  return (
    <Dialog
      title="Login - Anthropic"
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => onDone(true)}
        startingMessage={startingMessage}
      />
    </Dialog>
  )
}

// ─── Third-party provider login ──────────────────────────────────

function ThirdPartyLogin({
  provider,
  onDone,
}: {
  provider: APIProvider
  onDone: (success: boolean) => void
}) {
  const name = PROVIDER_DISPLAY_NAMES[provider]

  return (
    <Dialog
      title={`Login - ${name}`}
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ProviderLoginFlow provider={provider} onDone={onDone} />
    </Dialog>
  )
}

// Re-export for backward compatibility
export { AnthropicLogin as Login }
