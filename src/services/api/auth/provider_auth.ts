/**
 * Unified Provider Authentication
 *
 * Central module for managing auth across all third-party providers.
 * Supports two auth paths per provider (where available):
 *
 *   1. API Key — env var or stored key
 *   2. OAuth   — browser-based account login
 *
 * Auth resolution priority: API key → OAuth token → prompt user
 *
 * Provider auth support matrix:
 *   ┌────────────┬─────────┬───────┬─────────────────────────────────┐
 *   │ Provider   │ API Key │ OAuth │ Notes                           │
 *   ├────────────┼─────────┼───────┼─────────────────────────────────┤
 *   │ OpenAI     │ ✓       │ ✓     │ Bundled Codex CLI client ID     │
 *   │ Gemini     │ ✓       │ ✓     │ Bundled Gemini CLI client ID    │
 *   │ Antigravity│ ✗       │ ✓     │ Google OAuth → Code Assist pool │
 *   │ OpenRouter │ ✓       │ ✗     │ API key only                    │
 *   │ Groq       │ ✓       │ ✗     │ API key only                    │
 *   │ NIM        │ ✓       │ ✗     │ API key only                    │
 *   │ DeepSeek   │ ✓       │ ✗     │ API key only                    │
 *   │ KiloCode   │ ✗       │ ✓     │ Custom device auth              │
 *   │ Cline      │ ✗       │ ✓     │ Authorization-code flow         │
 *   │ iFlow      │ ✗       │ ✓     │ OAuth2 code + Basic Auth        │
 *   │ Copilot    │ ✗       │ ✓     │ GitHub device-code + token mint │
 *   │ Kiro       │ ✗       │ ✓     │ AWS SSO OIDC device-code        │
 *   │ Cursor     │ ✗       │ ✓     │ Manual token import             │
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
import {
  startKiloCodeOAuth, getKiloCodeOAuthToken,
  startClineOAuth, getClineOAuthToken, refreshClineOAuth,
  startIFlowOAuth, getIFlowOAuthToken, refreshIFlowOAuth,
  startCopilotOAuth, getCopilotOAuthToken, refreshCopilotOAuth,
  startKiroOAuth, getKiroOAuthToken, refreshKiroOAuth,
  getCursorOAuthToken,
} from './oauth_services.js'
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
    case 'gemini':
      // Gemini provider = free-tier CLI OAuth only.
      // Antigravity lives under its own provider row.
      return getGeminiOAuthToken('cli').catch(() => null)
    case 'antigravity':
      return getGeminiOAuthToken('antigravity').catch(() => null)
    case 'openai':
      return getOpenAIOAuthToken()
    case 'kilocode':
      return getKiloCodeOAuthToken()
    case 'cline':
      return getClineOAuthToken()
    case 'iflow':
      return getIFlowOAuthToken()
    case 'copilot':
      return getCopilotOAuthToken()
    case 'kiro':
      return getKiroOAuthToken()
    case 'cursor':
      return getCursorOAuthToken()
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
      // Gemini row = free-tier CLI flow (flash/lite models).
      return startGeminiOAuth('cli')
    case 'antigravity':
      // Antigravity row = paid Code Assist pool (gemini-3-flash, 3.1-pro-*).
      return startGeminiOAuth('antigravity')
    case 'openai':
      return startOpenAIOAuthFlow()
    case 'kilocode':
      return startKiloCodeOAuth()
    case 'cline':
      return startClineOAuth()
    case 'iflow':
      return startIFlowOAuth()
    case 'copilot':
      return startCopilotOAuth()
    case 'kiro':
      return startKiroOAuth()
    case 'cursor':
      // Cursor has no public OAuth app — token must be pasted from the IDE.
      // The UI layer (ProviderLoginFlow) renders a paste prompt that calls
      // `saveCursorToken` directly; this branch is only hit if someone wires
      // Cursor into the generic browser-login path.
      throw new Error(
        'Cursor uses manual token entry, not browser OAuth. ' +
        'Open Cursor IDE → Settings → Cursor Auth → copy the access token, ' +
        'then paste it into the Cursor login dialog.',
      )
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
  // Provider → storage key mapping: gemini/antigravity share the same
  // Google OAuth shape but live under different keys.
  const storedKey =
    provider === 'gemini' ? 'gemini_oauth_cli'
    : provider === 'antigravity' ? 'gemini_oauth_antigravity'
    : `${provider}_oauth`
  const stored = loadProviderKey(storedKey)
  if (!stored) throw new Error(`No stored OAuth tokens for ${provider}`)

  const tokens = JSON.parse(stored) as { refreshToken?: string }
  if (!tokens.refreshToken) {
    throw new Error(`No refresh token stored for ${provider}. Re-authenticate with \`/login\`.`)
  }

  switch (provider) {
    case 'gemini':
    case 'antigravity':
      return refreshGoogleToken(tokens.refreshToken)
    case 'openai':
      return refreshOpenAIToken(tokens.refreshToken)
    case 'cline':
      return refreshClineOAuth(tokens.refreshToken)
    case 'iflow':
      return refreshIFlowOAuth(tokens.refreshToken)
    case 'copilot':
      // Copilot's "refresh token" slot stores the GitHub long-lived token,
      // which is re-exchanged for a fresh Copilot internal token.
      return refreshCopilotOAuth(tokens.refreshToken)
    case 'kiro':
      return refreshKiroOAuth(tokens.refreshToken)
    case 'kilocode':
      // KiloCode issues long-lived tokens with no refresh endpoint.
      throw new Error('KiloCode has no refresh endpoint — re-login via `/login`.')
    case 'cursor':
      // Cursor tokens are manually pasted; user must re-paste on expiry.
      throw new Error('Cursor tokens are not auto-refreshable — re-paste via `/login`.')
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
  if (provider === 'gemini') {
    // Gemini provider = CLI tier only. Clear legacy dual-key too.
    deleteProviderKey('gemini_oauth_cli')
    deleteProviderKey('gemini_oauth')
  }
  if (provider === 'antigravity') {
    deleteProviderKey('gemini_oauth_antigravity')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function _envVarName(provider: APIProvider): string {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    antigravity: '(OAuth only)',
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    nim: 'NIM_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    kilocode: '(OAuth only)',
    cline: '(OAuth only)',
    iflow: '(OAuth only)',
    copilot: '(OAuth only)',
    kiro: '(OAuth only)',
    cursor: '(OAuth only — paste token)',
  }
  return map[provider] ?? 'API_KEY'
}
