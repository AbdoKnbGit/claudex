/**
 * OpenAI-Compatible Lane — Entry Point
 *
 * Handles: DeepSeek, Groq, NIM, Ollama, OpenRouter, and any other
 * provider that speaks OpenAI Chat Completions format.
 *
 * Each provider is registered with its own API key and base URL.
 * The lane auto-detects which provider config to use based on model name.
 */

export { openaiCompatLane, OpenAICompatLane } from './loop.js'
export { OPENAI_COMPAT_TOOL_REGISTRY, buildOpenAICompatFunctions } from './tools.js'
export { assembleOpenAICompatPrompt } from './prompt.js'

import { openaiCompatLane } from './loop.js'
import { registerLane } from '../dispatcher.js'

/**
 * Initialize the OpenAI-compat lane with all provider configs.
 * Call this once at startup with whatever API keys are available.
 */
export function initOpenAICompatLane(providers?: {
  deepseek?: { apiKey: string; baseUrl?: string }
  groq?: { apiKey: string; baseUrl?: string }
  nim?: { apiKey: string; baseUrl?: string }
  ollama?: { baseUrl?: string }
  openrouter?: { apiKey: string; baseUrl?: string }
}): void {
  // Register each provider that has auth configured
  const p = providers ?? {}

  // DeepSeek
  const dsKey = p.deepseek?.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (dsKey) {
    openaiCompatLane.registerProvider(
      'deepseek', dsKey,
      p.deepseek?.baseUrl ?? 'https://api.deepseek.com/v1',
    )
  }

  // Groq
  const groqKey = p.groq?.apiKey ?? process.env.GROQ_API_KEY
  if (groqKey) {
    openaiCompatLane.registerProvider(
      'groq', groqKey,
      p.groq?.baseUrl ?? 'https://api.groq.com/openai/v1',
    )
  }

  // NVIDIA NIM
  const nimKey = p.nim?.apiKey ?? process.env.NIM_API_KEY
  if (nimKey) {
    openaiCompatLane.registerProvider(
      'nim', nimKey,
      p.nim?.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
    )
  }

  // Ollama (local, no API key needed)
  const ollamaUrl = p.ollama?.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434/v1'
  openaiCompatLane.registerProvider('ollama', '', ollamaUrl)

  // OpenRouter
  const orKey = p.openrouter?.apiKey ?? process.env.OPENROUTER_API_KEY
  if (orKey) {
    openaiCompatLane.registerProvider(
      'openrouter', orKey,
      p.openrouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
    )
  }

  // Register with dispatcher
  registerLane(openaiCompatLane)
}
