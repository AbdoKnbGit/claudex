/**
 * Codex Lane — Entry Point
 *
 * Handles OpenAI models: GPT-5, Codex, o-series.
 * Uses native Codex patterns (apply_patch, shell, Chat Completions/Responses API).
 */

export { codexLane, CodexLane } from './loop.js'
export {
  CODEX_TOOL_REGISTRY,
  buildCodexFunctionDeclarations,
  buildCodexResponsesTools,
  getCodexRegistrationByNativeName,
} from './tools.js'
export { assembleCodexSystemPrompt } from './prompt.js'
export { codexApi, CodexApiClient, CodexApiError } from './api.js'

import { codexLane } from './loop.js'
import { registerLane } from '../dispatcher.js'

export function initCodexLane(opts?: {
  apiKey?: string
  baseUrl?: string
  chatgptAccessToken?: string
}): void {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY
  const baseUrl = opts?.baseUrl ?? process.env.OPENAI_BASE_URL
  const chatgptAccessToken = opts?.chatgptAccessToken ?? process.env.OPENAI_CHATGPT_ACCESS_TOKEN
  codexLane.configure({ apiKey, baseUrl, chatgptAccessToken })
  registerLane(codexLane)
  codexLane.setHealthy(!!(apiKey || chatgptAccessToken))
}
