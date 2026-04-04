/**
 * Ollama provider — extends OpenAIProvider.
 *
 * Ollama exposes an OpenAI-compatible API at /v1/chat/completions.
 * Default base URL: http://localhost:11434/v1
 *
 * Key differences from standard OpenAI:
 *   - max_tokens may not be supported by all models; we use num_predict as fallback
 *   - Models are local and may have smaller context windows
 *   - No API key required by default
 *
 * Auth: None by default (local server)
 */

import { OpenAIProvider } from './openai_provider.js'
import type {
  ProviderConfig,
  ProviderRequestParams,
  ProviderStreamResult,
  AnthropicMessage,
  ModelInfo,
} from './base_provider.js'

export class OllamaProvider extends OpenAIProvider {
  readonly name = 'ollama'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey || 'ollama', // Ollama doesn't require auth
      baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
      extraHeaders: config.extraHeaders,
    })
  }

  /**
   * Override to handle Ollama-specific max_tokens behavior.
   * Some Ollama models don't support max_tokens; use num_predict instead.
   */
  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    try {
      return await super.stream(params)
    } catch (err: any) {
      // If max_tokens caused an error, retry without it
      if (err?.message?.includes('max_tokens')) {
        return super.stream({ ...params, max_tokens: -1 })
      }
      throw err
    }
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    try {
      return await super.create(params)
    } catch (err: any) {
      if (err?.message?.includes('max_tokens')) {
        return super.create({ ...params, max_tokens: -1 })
      }
      throw err
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Ollama uses /api/tags for model listing, but also supports OpenAI /v1/models
    try {
      return await super.listModels()
    } catch {
      // Fallback: try Ollama native endpoint
      try {
        const baseUrl = this.baseUrl.replace(/\/v1$/, '')
        const response = await fetch(`${baseUrl}/api/tags`)
        if (!response.ok) return []
        const data = (await response.json()) as { models?: Array<{ name: string }> }
        return (data.models ?? []).map(m => ({ id: m.name, name: m.name }))
      } catch {
        return []
      }
    }
  }

  resolveModel(claudeModel: string): string {
    // If it doesn't look like a Claude model, pass through as-is
    if (!claudeModel.includes('claude')) return claudeModel

    // Default Ollama model mappings (user can override via env vars)
    const models = {
      opus: process.env.OLLAMA_MODEL_OPUS ?? 'llama3.3:latest',
      sonnet: process.env.OLLAMA_MODEL_SONNET ?? 'llama3.1:latest',
      haiku: process.env.OLLAMA_MODEL_HAIKU ?? 'llama3.2:latest',
    }
    if (claudeModel.includes('opus'))  return models.opus
    if (claudeModel.includes('haiku')) return models.haiku
    return models.sonnet
  }

  protected _headers(): Record<string, string> {
    // Ollama may not need auth headers
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey && this.apiKey !== 'ollama'
        ? { 'Authorization': `Bearer ${this.apiKey}` }
        : {}),
      ...this.extraHeaders,
    }
  }
}
