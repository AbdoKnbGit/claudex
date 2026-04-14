/**
 * Codex Lane — Entry Point
 *
 * Handles OpenAI models: GPT-5, Codex, o-series.
 * Uses native Codex patterns (apply_patch, shell, Chat Completions/Responses API).
 */

export { codexLane, CodexLane } from './loop.js'
export { CODEX_TOOL_REGISTRY, buildCodexFunctionDeclarations } from './tools.js'
export { assembleCodexSystemPrompt } from './prompt.js'

import { codexLane } from './loop.js'
import { registerLane } from '../dispatcher.js'

export function initCodexLane(opts?: { apiKey?: string; baseUrl?: string }): void {
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY
  codexLane.configure({ apiKey, baseUrl: opts?.baseUrl })
  registerLane(codexLane)
  codexLane.setHealthy(!!apiKey)
}
