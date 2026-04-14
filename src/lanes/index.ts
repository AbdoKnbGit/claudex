/**
 * Lane Architecture — Entry Point
 *
 * Bootstraps all lanes and the dispatcher. Call initLanes() once at
 * startup after provider auth is resolved.
 *
 * After init, the dispatcher auto-routes every model to its native lane.
 * No env vars, no config files needed. User picks a model, it works.
 */

export {
  registerLane,
  getLane,
  getAllLanes,
  dispatch,
  resolveRoute,
  getLaneStatus,
} from './dispatcher.js'

export type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
  LaneToolRegistration,
  SystemPromptParts,
  SharedTool,
  ToolResult,
  LaneEvent,
} from './types.js'

export { shouldUseNativeLane, runNativeLane } from './bridge.js'

import { initGeminiLane } from './gemini/index.js'
import { initCodexLane } from './codex/index.js'
import { initOpenAICompatLane } from './openai-compat/index.js'

/**
 * Initialize all lanes with available auth credentials.
 *
 * Auth resolution: each lane reads from the opts parameter first,
 * then falls back to environment variables, then to stored credentials
 * from /login. If no auth is available, the lane registers but marks
 * itself unhealthy — models that need it fall through to the existing
 * shim path until the user authenticates.
 *
 * Call this once at startup.
 */
export function initLanes(opts?: {
  // Gemini
  geminiApiKey?: string
  geminiOAuthToken?: string
  // OpenAI / Codex
  openaiApiKey?: string
  openaiBaseUrl?: string
  // DeepSeek
  deepseekApiKey?: string
  // Groq
  groqApiKey?: string
  // NVIDIA NIM
  nimApiKey?: string
  // Ollama
  ollamaBaseUrl?: string
  // OpenRouter
  openrouterApiKey?: string
}): void {
  // ── Gemini lane (Gemini models) ──
  initGeminiLane({
    apiKey: opts?.geminiApiKey,
    oauthToken: opts?.geminiOAuthToken,
  })

  // ── Codex lane (OpenAI GPT-5, Codex, o-series) ──
  initCodexLane({
    apiKey: opts?.openaiApiKey,
    baseUrl: opts?.openaiBaseUrl,
  })

  // ── OpenAI-compat lane (DeepSeek, Groq, NIM, Ollama, OpenRouter) ──
  initOpenAICompatLane({
    deepseek: opts?.deepseekApiKey ? { apiKey: opts.deepseekApiKey } : undefined,
    groq: opts?.groqApiKey ? { apiKey: opts.groqApiKey } : undefined,
    nim: opts?.nimApiKey ? { apiKey: opts.nimApiKey } : undefined,
    ollama: opts?.ollamaBaseUrl ? { baseUrl: opts.ollamaBaseUrl } : undefined,
    openrouter: opts?.openrouterApiKey ? { apiKey: opts.openrouterApiKey } : undefined,
  })
}
