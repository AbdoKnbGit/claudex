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
import type { LocalCommandCall } from '../../types/command.js'
import {
  getAPIProvider,
  isThirdPartyProvider,
  clearActiveProvider,
  PROVIDER_DISPLAY_NAMES,
} from '../../utils/model/providers.js'
import {
  deleteAllProviderCredentials,
} from '../../services/api/auth/api_key_manager.js'

/**
 * Perform logout for the current provider only.
 *
 * - For Anthropic (firstParty): wipes OAuth tokens + secure storage (original behavior)
 * - For third-party providers: deletes only that provider's stored keys/tokens
 */
export async function performLogout({
  clearOnboarding = false,
}: { clearOnboarding?: boolean } = {}): Promise<void> {
  const provider = getAPIProvider()

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

export const call: LocalCommandCall = async () => {
  const provider = getAPIProvider()
  const providerName = PROVIDER_DISPLAY_NAMES[provider]

  await performLogout({ clearOnboarding: !isThirdPartyProvider(provider) })

  return {
    type: 'text',
    value: `Successfully logged out from ${providerName}.`,
  }
}
