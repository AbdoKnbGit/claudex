import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getAPIProvider,
  isThirdPartyProvider,
  clearActiveProvider,
  PROVIDER_DISPLAY_NAMES,
  SELECTABLE_PROVIDERS,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  deleteAllProviderCredentials,
  hasStoredKey,
} from '../../services/api/auth/api_key_manager.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'

/**
 * Perform logout for a single provider.
 *
 * - For Anthropic (firstParty): wipes OAuth tokens + secure storage (original behavior).
 * - For third-party providers: deletes only that provider's stored keys/tokens.
 *
 * If no provider is passed, defaults to the currently active provider — this
 * keeps the legacy CLI subcommand (`claude auth logout`) working unchanged.
 */
export async function performLogout({
  clearOnboarding = false,
  provider: providerOverride,
}: {
  clearOnboarding?: boolean
  provider?: APIProvider
} = {}): Promise<void> {
  const provider = providerOverride ?? getAPIProvider()

  // Flush telemetry BEFORE clearing credentials
  const { flushTelemetry } = await import(
    '../../utils/telemetry/instrumentation.js'
  )
  await flushTelemetry()

  if (isThirdPartyProvider(provider)) {
    // Third-party: only delete this provider's credentials
    deleteAllProviderCredentials(provider)
    // Clear the active provider so it falls back to env vars or firstParty
    clearActiveProvider()
  } else {
    // Anthropic: full logout (original behavior)
    await removeApiKey()
    const secureStorage = getSecureStorage()
    secureStorage.delete()
  }

  await clearAuthRelatedCaches()
  saveGlobalConfig((current) => {
    const updated = { ...current }
    if (clearOnboarding && !isThirdPartyProvider(provider)) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }
    if (!isThirdPartyProvider(provider)) {
      updated.oauthAccount = undefined
    }
    // Clear the active provider on logout
    updated.activeProvider = undefined
    return updated
  })
}

// Clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearTrustedDeviceTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()
  getGroveNoticeConfig.cache?.clear?.()
  getGroveSettings.cache?.clear?.()
  await clearRemoteManagedSettingsCache()
  await clearPolicyLimitsCache()
}

// ─── /logout command entry point ─────────────────────────────────

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <ProviderPickerLogout
      onDone={(message) => {
        if (message) {
          // Nudge the main loop to re-check auth state after logout.
          context.onChangeAPIKey()
          context.setAppState((prev) => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }
        onDone(message ?? 'Logout cancelled')
      }}
    />
  )
}

// ─── Provider picker UI ──────────────────────────────────────────

/**
 * Returns true when the given provider has some credential we can clear
 * (stored API key, stored OAuth tokens, or — for firstParty — whatever
 * the Anthropic logout path cleans up).
 */
function providerIsConfigured(p: APIProvider): boolean {
  if (p === 'firstParty') return true // Anthropic path always does something
  return hasStoredKey(p) || hasStoredKey(`${p}_oauth`)
}

function ProviderPickerLogout({
  onDone,
}: {
  onDone: (message: string | null) => void
}) {
  const activeProvider = getAPIProvider()

  // Only show providers that actually have something to sign out from.
  const eligibleProviders = useMemo(
    () => SELECTABLE_PROVIDERS.filter(providerIsConfigured),
    [],
  )

  const initialIndex = useMemo(() => {
    const idx = eligibleProviders.indexOf(activeProvider)
    return idx >= 0 ? idx : 0
  }, [eligibleProviders, activeProvider])

  const [selectedIndex, setSelectedIndex] = useState(initialIndex)
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'working'; provider: APIProvider }
    | { kind: 'done'; provider: APIProvider }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  useInput((_input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (status.kind === 'working' || status.kind === 'done') return

    if (key.escape) {
      onDone(null)
      return
    }

    if (eligibleProviders.length === 0) {
      if (key.return) onDone(null)
      return
    }

    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : eligibleProviders.length - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i < eligibleProviders.length - 1 ? i + 1 : 0))
      return
    }
    if (key.return) {
      const provider = eligibleProviders[selectedIndex]
      if (!provider) return
      setStatus({ kind: 'working', provider })
      performLogout({
        clearOnboarding: !isThirdPartyProvider(provider),
        provider,
      })
        .then(() => {
          setStatus({ kind: 'done', provider })
          const name = PROVIDER_DISPLAY_NAMES[provider]
          setTimeout(() => onDone(`Signed out from ${name}.`), 900)
        })
        .catch((err) => {
          setStatus({
            kind: 'error',
            message: err?.message ?? 'Logout failed',
          })
        })
    }
  })

  return (
    <Dialog
      title="Logout - Choose Provider"
      onCancel={() => onDone(null)}
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
            Select a provider to sign out from:
          </Text>
        </Box>

        {eligibleProviders.length === 0 && status.kind === 'idle' && (
          <Box flexDirection="column">
            <Text color="warning">No providers are currently signed in.</Text>
            <Box marginTop={1}>
              <Text dimColor>Press Esc or Enter to close.</Text>
            </Box>
          </Box>
        )}

        {eligibleProviders.length > 0 && status.kind === 'idle' && (
          <>
            {eligibleProviders.map((p, i) => {
              const isSelected = i === selectedIndex
              const name = PROVIDER_DISPLAY_NAMES[p]
              const isActive = p === activeProvider
              const hasApi = p !== 'firstParty' && hasStoredKey(p)
              const hasOauth =
                p !== 'firstParty' && hasStoredKey(`${p}_oauth`)
              const credLabel =
                p === 'firstParty'
                  ? 'Anthropic account'
                  : hasApi && hasOauth
                    ? 'OAuth + API key'
                    : hasOauth
                      ? 'OAuth'
                      : hasApi
                        ? 'API key'
                        : ''
              return (
                <Box key={p}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? 'claude' : undefined}
                    dimColor={!isSelected}
                  >
                    {isSelected ? '> ' : '  '}
                    {name}
                    {isActive ? ' (active)' : ''}
                  </Text>
                  {credLabel && (
                    <Text dimColor> [{credLabel}]</Text>
                  )}
                </Box>
              )
            })}
            <Box marginTop={1}>
              <Text dimColor>
                Use arrow keys, Enter to sign out, Esc to cancel
              </Text>
            </Box>
          </>
        )}

        {status.kind === 'working' && (
          <Text color="warning">
            Signing out from {PROVIDER_DISPLAY_NAMES[status.provider]}…
          </Text>
        )}

        {status.kind === 'done' && (
          <Text color="success">
            Signed out from {PROVIDER_DISPLAY_NAMES[status.provider]}.
          </Text>
        )}

        {status.kind === 'error' && (
          <Box flexDirection="column">
            <Text color="error">Logout failed: {status.message}</Text>
            <Text dimColor>Press Esc to dismiss.</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
