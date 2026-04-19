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
  chatgptAccountId?: string
  chatgptIdToken?: string
}): void {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY
  const baseUrl = opts?.baseUrl ?? process.env.OPENAI_BASE_URL
  const chatgptAccessToken = opts?.chatgptAccessToken ?? process.env.OPENAI_CHATGPT_ACCESS_TOKEN
  // Optional org slug matching codex-rs's `ChatGPT-Account-ID` header.
  // When unset, the lane auto-decodes it from the id_token / access_token
  // JWT (native codex behavior). If extraction also fails, the header is
  // simply omitted — same as codex-rs when the token lacks the claim.
  const chatgptAccountId = opts?.chatgptAccountId ?? process.env.OPENAI_CHATGPT_ACCOUNT_ID
  // Prefer the id_token for claim extraction — it's the token native
  // codex reads. Fall back to the access_token (some deployments carry
  // the same claim there).
  const chatgptIdToken = opts?.chatgptIdToken ?? process.env.OPENAI_CHATGPT_ID_TOKEN
  codexLane.configure({ apiKey, baseUrl, chatgptAccessToken, chatgptAccountId, chatgptIdToken })
  registerLane(codexLane)
  codexLane.setHealthy(!!(apiKey || chatgptAccessToken))
}
