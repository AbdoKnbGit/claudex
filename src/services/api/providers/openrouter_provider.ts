/**
 * OpenRouter provider — extends OpenAIProvider with OpenRouter-specific headers.
 *
 * OpenRouter is an API aggregator that routes to multiple model providers.
 * It uses the OpenAI-compatible API with extra headers for ranking/attribution.
 *
 * Base URL: https://openrouter.ai/api/v1
 * Auth: Bearer token (sk-or-...)
 * Extra headers: HTTP-Referer, X-Title (for model rankings)
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'

export class OpenRouterProvider extends OpenAIProvider {
  readonly name = 'openrouter'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: {
        // OpenRouter uses these for model rankings and attribution
        'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://github.com/claude-code-multi-provider',
        'X-Title': process.env.OPENROUTER_TITLE ?? 'Claudex (Multi-Provider)',
        ...(config.extraHeaders ?? {}),
      },
    })
  }

  /**
   * OpenRouter exposes a unified `reasoning` field that every upstream
   * provider (Anthropic, OpenAI, Google, DeepSeek, etc.) respects via
   * their native reasoning surface. We always map the /thinking toggle
   * through this, rather than overriding reasoning_effort, so every
   * thinking-capable model routed via OpenRouter behaves consistently.
   */
  protected modelSupportsReasoningEffort(_model: string): boolean {
    // We return true so the base OpenAIProvider branch runs and
    // `reasoning_effort` is set. OpenRouter accepts both
    // `reasoning_effort` and `reasoning: { effort }`; models that don't
    // reason quietly ignore the flag.
    return true
  }

  /**
   * OpenRouter has its own model list endpoint with richer metadata
   * including pricing, context length, and provider info.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    })

    if (!response.ok) return []

    const data = (await response.json()) as {
      data: Array<{
        id: string
        name: string
        context_length?: number
        pricing?: { prompt: string; completion: string }
      }>
    }

    return (data.data ?? []).map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.context_length,
    }))
  }
}
