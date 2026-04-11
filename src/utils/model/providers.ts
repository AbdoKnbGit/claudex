import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'

export type APIProvider =
  | 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
  | 'openai' | 'gemini' | 'openrouter' | 'groq' | 'nim' | 'deepseek' | 'ollama'

const VALID_PROVIDERS: readonly APIProvider[] = [
  'firstParty', 'bedrock', 'vertex', 'foundry',
  'openai', 'gemini', 'openrouter', 'groq', 'nim', 'deepseek', 'ollama',
]

export function getAPIProvider(): APIProvider {
  // 1. Check persistent config first (set by /provider command)
  const configured = getGlobalConfig().activeProvider
  if (configured && VALID_PROVIDERS.includes(configured as APIProvider)) {
    return configured as APIProvider
  }
  // 2. Fall back to environment variables
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK))    return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX))     return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY))    return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI))     return 'openai'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI))     return 'gemini'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENROUTER)) return 'openrouter'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_GROQ))       return 'groq'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_NIM))        return 'nim'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_DEEPSEEK))   return 'deepseek'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OLLAMA))    return 'ollama'
  return 'firstParty'
}

/**
 * Persist the active provider selection to global config.
 * This takes priority over environment variables on next getAPIProvider() call.
 */
export function setActiveProvider(provider: APIProvider): void {
  saveGlobalConfig(current => ({
    ...current,
    activeProvider: provider,
  }))
}

/**
 * Clear the active provider from config, reverting to env-var detection.
 */
export function clearActiveProvider(): void {
  saveGlobalConfig(current => ({
    ...current,
    activeProvider: undefined,
  }))
}

/** User-friendly display names for providers */
export const PROVIDER_DISPLAY_NAMES: Record<APIProvider, string> = {
  firstParty: 'Anthropic',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure Foundry',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  nim: 'NVIDIA NIM',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
}

/** Providers available for user selection in /provider and /login */
export const SELECTABLE_PROVIDERS: readonly APIProvider[] = [
  'firstParty', 'openai', 'gemini', 'openrouter', 'groq', 'nim', 'deepseek', 'ollama',
]

/** Providers that use OpenAI-compatible chat completions API */
export function isOpenAICompatibleProvider(p: APIProvider): boolean {
  return ['openai', 'openrouter', 'groq', 'nim', 'deepseek', 'ollama'].includes(p)
}

/** All non-Anthropic third-party LLM providers */
export function isThirdPartyProvider(p: APIProvider): boolean {
  return ['openai', 'gemini', 'openrouter', 'groq', 'nim', 'deepseek', 'ollama'].includes(p)
}

/** Original Anthropic-native providers (firstParty + cloud partners) */
export function isAnthropicNativeProvider(p: APIProvider): boolean {
  return ['firstParty', 'bedrock', 'vertex', 'foundry'].includes(p)
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
