/**
 * Unified Provider Authentication
 *
 * Central module for managing auth across all third-party providers.
 * Supports two auth paths per provider (where available):
 *
 *   1. API Key — env var or stored key (all providers)
 *   2. OAuth   — browser-based account login (Gemini, OpenAI)
 *
 * Auth resolution priority: API key → OAuth token → prompt user
 *
 * Provider auth support matrix:
 *   ┌────────────┬─────────┬───────┬─────────────────────────────────┐
 *   │ Provider   │ API Key │ OAuth │ Notes                           │
 *   ├────────────┼─────────┼───────┼─────────────────────────────────┤
 *   │ OpenAI     │ ✓       │ ✓     │ Bundled Codex CLI client ID     │
 *   │ Gemini     │ ✓       │ ✓     │ Bundled Gemini CLI client ID    │
 *   │ OpenRouter │ ✓       │ ✗     │ API key only                    │
 *   │ Groq       │ ✓       │ ✗     │ API key only                    │
 *   │ NIM        │ ✓       │ ✗     │ API key only                    │
 *   │ DeepSeek   │ ✓       │ ✗     │ API key only                    │
 *   └────────────┴─────────┴───────┴─────────────────────────────────┘
 */

import type { APIProvider } from '../../../utils/model/providers.js'
import {
  getProviderAuthMethod,
  getProviderApiKey,
  getProviderOAuthToken,
  PROVIDER_AUTH_SUPPORT,
  type ProviderAuthMethod,
} from '../../../utils/auth.js'
import {
  getGeminiOAuthToken,
  startGeminiOAuth,
  refreshGeminiOAuth,
  type GeminiOAuthType,
  // Backwards-compat wrappers (still used by some callers)
  getGoogleOAuthToken,
  startGoogleOAuthFlow,
  refreshGoogleToken,
} from './google_oauth.js'
import { getOpenAIOAuthToken, startOpenAIOAuthFlow, refreshOpenAIToken } from './openai_oauth.js'
import { loadProviderKey, deleteProviderKey } from './api_key_manager.js'

// ─── Token Resolution ─────────────────────────────────────────────

/**
 * Get a valid access token for a provider, handling refresh automatically.
 * This is the main entry point for getting auth credentials at request time.
 *
 * For API key providers: returns the key directly.
 * For OAuth providers: checks token validity and refreshes if needed.
 *
 * Returns { token, method } or throws if no valid auth is available.
 */
export async function resolveProviderAuth(provider: APIProvider): Promise<{
  token: string
  method: ProviderAuthMethod
}> {
  // Try API key first (always preferred — no refresh needed)
  const apiKey = getProviderApiKey(provider)
  if (apiKey) {
    return { token: apiKey, method: 'api_key' }
  }

  // Try OAuth for supported providers
  const supported = PROVIDER_AUTH_SUPPORT[provider]
  if (supported?.includes('oauth')) {
    const oauthToken = await _getValidOAuthToken(provider)
    if (oauthToken) {
      return { token: oauthToken, method: 'oauth' }
    }
  }

  throw new Error(
    `No valid credentials for ${provider}. ` +
    `Set ${_envVarName(provider)} or run \`/login\` to configure it.`,
  )
}

/**
 * Get a valid OAuth token for a provider, refreshing if expired.
 * Returns null if no OAuth tokens are stored or refresh fails.
 *
 * For Gemini: refreshes BOTH CLI and Antigravity tokens if stored.
 * Returns any valid token to signal "OAuth is working".
 */
async function _getValidOAuthToken(provider: APIProvider): Promise<string | null> {
  switch (provider) {
    case 'gemini': {
      // Refresh both Gemini OAuth types independently.
      // Either may be null (user didn't login with that flow).
      const [cli, antigravity] = await Promise.all([
        getGeminiOAuthToken('cli').catch(() => null),
        getGeminiOAuthToken('antigravity').catch(() => null),
      ])
      return cli ?? antigravity
    }
    case 'openai':
      return getOpenAIOAuthToken()
    default:
      return null
  }
}

// ─── OAuth Flow Initiation ────────────────────────────────────────

/**
 * Start an OAuth flow for a provider.
 * Opens the browser and waits for the user to complete authentication.
 *
 * Throws if the provider doesn't support OAuth.
 */
export async function startProviderOAuth(provider: APIProvider): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const supported = PROVIDER_AUTH_SUPPORT[provider]
  if (!supported?.includes('oauth')) {
    throw new Error(
      `${provider} does not support OAuth authentication. Use an API key instead.\n` +
      `Set ${_envVarName(provider)} environment variable.`,
    )
  }

  switch (provider) {
    case 'gemini':
      // Default to antigravity for backwards compat.
      // Use startGeminiOAuthFlow() for type-specific flows.
      return startGeminiOAuth('antigravity')
    case 'openai':
      return startOpenAIOAuthFlow()
    default:
      throw new Error(`OAuth not implemented for ${provider}`)
  }
}

/**
 * Start a specific Gemini OAuth flow (CLI for flash/lite, Antigravity for pro).
 */
export async function startGeminiOAuthFlow(type: GeminiOAuthType): Promise<{
  accessToken: string
  refreshToken: string
}> {
  return startGeminiOAuth(type)
}

/**
 * Refresh an OAuth token for a provider.
 * Returns the new access token, or throws if refresh fails.
 */
export async function refreshProviderOAuth(provider: APIProvider): Promise<string> {
  const storedKey = `${provider}_oauth`
  const stored = loadProviderKey(storedKey)
  if (!stored) throw new Error(`No stored OAuth tokens for ${provider}`)

  const tokens = JSON.parse(stored) as { refreshToken?: string }
  if (!tokens.refreshToken) {
    throw new Error(`No refresh token stored for ${provider}. Re-authenticate with \`/login\`.`)
  }

  switch (provider) {
    case 'gemini':
      return refreshGoogleToken(tokens.refreshToken)
    case 'openai':
      return refreshOpenAIToken(tokens.refreshToken)
    default:
      throw new Error(`OAuth refresh not implemented for ${provider}`)
  }
}

// ─── Auth Status ──────────────────────────────────────────────────

export interface ProviderAuthStatus {
  provider: string
  method: ProviderAuthMethod
  configured: boolean
  supportsOAuth: boolean
  supportsApiKey: boolean
  oauthConfigured: boolean
  apiKeyConfigured: boolean
}

/**
 * Get a full auth status report for a provider.
 * Useful for diagnostics and the `claude auth status` command.
 */
export function getProviderAuthStatus(provider: APIProvider): ProviderAuthStatus {
  const supported = PROVIDER_AUTH_SUPPORT[provider] ?? ['api_key']
  const method = getProviderAuthMethod(provider)
  const hasApiKey = !!getProviderApiKey(provider)
  const hasOAuth = !!getProviderOAuthToken(provider)

  return {
    provider,
    method,
    configured: method !== 'none',
    supportsOAuth: supported.includes('oauth'),
    supportsApiKey: supported.includes('api_key'),
    oauthConfigured: hasOAuth,
    apiKeyConfigured: hasApiKey,
  }
}

/**
 * Clear OAuth tokens for a provider (logout).
 */
export function clearProviderOAuth(provider: APIProvider): void {
  deleteProviderKey(`${provider}_oauth`)
  // Gemini dual OAuth: clear both keys + legacy key.
  if (provider === 'gemini') {
    deleteProviderKey('gemini_oauth_cli')
    deleteProviderKey('gemini_oauth_antigravity')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function _envVarName(provider: APIProvider): string {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    nim: 'NIM_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
  }
  return map[provider] ?? 'API_KEY'
}
