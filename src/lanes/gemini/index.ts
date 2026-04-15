/**
 * Gemini Lane — Entry Point
 *
 * Exports the Gemini lane instance and handles initialization.
 * Call initGeminiLane() at startup to configure auth and register
 * with the dispatcher.
 */

export { geminiLane, GeminiLane } from './loop.js'
export { GEMINI_TOOL_REGISTRY, buildGeminiFunctionDeclarations } from './tools.js'
export { assembleGeminiSystemPrompt, buildGeminiSystemInstruction } from './prompt.js'
export { geminiApi, GeminiApiError } from './api.js'

import { geminiLane } from './loop.js'
import { geminiApi } from './api.js'
import { registerLane } from '../dispatcher.js'

/**
 * Initialize the Gemini lane.
 *
 * Configures the API client with available auth credentials and
 * registers the lane with the dispatcher.
 *
 * Auth resolution order:
 * 1. GEMINI_API_KEY env var
 * 2. Stored API key from /login
 * 3. OAuth token from gemini-cli or Antigravity login
 *
 * Call this once at startup, after auth is resolved.
 */
export function initGeminiLane(opts?: {
  apiKey?: string
  /** Deprecated single-token path. Use cliOAuthToken / antigravityOAuthToken. */
  oauthToken?: string
  oauthMode?: 'cli' | 'antigravity'
  /** OAuth token from Gemini CLI flow (free-tier flash/lite models). */
  cliOAuthToken?: string
  /** OAuth token from Antigravity flow (Gemini 3.x pro/flash/image models). */
  antigravityOAuthToken?: string
}): void {
  // Configure API client with auth. OAuth tokens can come from the Code
  // Assist CLI flow (free tier) or the Antigravity flow (gray-area). The
  // lane routes per-model to the right executor via executorForModel.
  const apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY

  geminiApi.configure({
    apiKey,
    oauthToken: opts?.oauthToken,
    oauthMode: opts?.oauthMode,
    cliOAuthToken: opts?.cliOAuthToken,
    antigravityOAuthToken: opts?.antigravityOAuthToken,
  })

  // Register with the dispatcher
  registerLane(geminiLane)

  // Mark healthy if auth is available
  geminiLane.setHealthy(geminiApi.isConfigured)
}
