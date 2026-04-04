/**
 * Groq provider — extends OpenAIProvider.
 *
 * Groq provides ultra-fast inference for open-source models.
 * All models are free with rate limits.
 *
 * Base URL: https://api.groq.com/openai/v1
 * Auth: Bearer token (gsk_...)
 * API: OpenAI-compatible
 *
 * Available models (April 2026):
 *   - openai/gpt-oss-120b          — Flagship reasoning model
 *   - openai/gpt-oss-20b           — Smaller GPT-OSS variant
 *   - qwen/qwen3-32b               — Strong coding, replaced qwq
 *   - deepseek-r1-distill-llama-70b — DeepSeek R1 reasoning
 *   - deepseek-r1-distill-qwen-32b — DeepSeek R1 Qwen variant
 *   - llama-3.3-70b-versatile      — Proven Llama 3.3 workhorse
 *   - groq/compound                — Agentic system (search + code exec)
 *   - groq/compound-mini           — Lower-latency compound variant
 *
 * Deprecated (removed from Groq):
 *   - llama-3.1-8b-instant (replaced by larger models)
 *   - mixtral-8x7b-32768 (deprecated)
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ProviderConfig } from './base_provider.js'

export class GroqProvider extends OpenAIProvider {
  readonly name = 'groq'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://api.groq.com/openai/v1',
      extraHeaders: config.extraHeaders,
    })
  }

  // Groq uses the standard OpenAI-compatible /models endpoint.
  // Inherited listModels() works correctly.
}
