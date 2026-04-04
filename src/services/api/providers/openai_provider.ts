/**
 * OpenAI-compatible provider.
 *
 * Base class for all providers that implement the OpenAI Chat Completions API:
 * OpenAI, OpenRouter, Groq, NVIDIA NIM.
 *
 * Uses native fetch (no openai SDK dependency) for maximum portability.
 */

import {
  BaseProvider,
  buildProviderStreamResult,
  type AnthropicMessage,
  type AnthropicStreamEvent,
  type ModelInfo,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
} from './base_provider.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  coalesceConsecutiveMessages,
} from '../adapters/anthropic_to_openai.js'
import {
  openAIStreamToAnthropicEvents,
  openAIMessageToAnthropic,
  type OpenAIChatCompletion,
  type OpenAIChatCompletionChunk,
} from '../adapters/openai_to_anthropic.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai'
  protected apiKey: string
  protected baseUrl: string
  protected extraHeaders: Record<string, string>

  constructor(config: ProviderConfig) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
    this.extraHeaders = config.extraHeaders ?? {}
  }

  /** Override in subclasses to enable message coalescing for strict models */
  protected needsMessageCoalescing(model: string): boolean {
    // o1-series models require strictly alternating roles
    return /^o1(-|$)/.test(model)
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)
    let messages = anthropicMessagesToOpenAI(params.messages, params.system)
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = params.tools ? anthropicToolsToOpenAI(params.tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_tokens,
      stream: true,
      // Request usage in stream for token counting
      stream_options: { include_usage: true },
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.stop_sequences) body.stop = params.stop_sequences

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`${this.name} API error ${response.status}: ${errText}`)
    }

    if (!response.body) {
      throw new Error(`${this.name} returned no response body for streaming request`)
    }

    // Extract rate limit headers from the response
    this._extractRateLimits(response.headers)

    const sseStream = this._parseSSE(response.body)
    const anthropicEvents = openAIStreamToAnthropicEvents(sseStream)
    return buildProviderStreamResult(anthropicEvents)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const model = this.resolveModel(params.model)
    let messages = anthropicMessagesToOpenAI(params.messages, params.system)
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = params.tools ? anthropicToolsToOpenAI(params.tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_tokens,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.stop_sequences) body.stop = params.stop_sequences

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`${this.name} API error ${response.status}: ${errText}`)
    }

    this._extractRateLimits(response.headers)

    const data = (await response.json()) as OpenAIChatCompletion
    return openAIMessageToAnthropic(data)
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this._headers(),
    })
    if (!response.ok) return []
    const data = (await response.json()) as { data: Array<{ id: string }> }
    return (data.data ?? []).map(m => ({ id: m.id, name: m.id }))
  }

  resolveModel(claudeModel: string): string {
    // If it doesn't look like a Claude model, pass through as-is
    if (!claudeModel.includes('claude')) return claudeModel

    const models = getProviderModelSet(this.name)
    if (claudeModel.includes('opus'))  return models.opus
    if (claudeModel.includes('haiku')) return models.haiku
    return models.sonnet
  }

  /** Last known rate limit info from provider response headers */
  lastRateLimits: {
    requestsLimit?: number
    requestsRemaining?: number
    requestsReset?: string
    tokensLimit?: number
    tokensRemaining?: number
    tokensReset?: string
  } = {}

  // ─── Internal helpers ──────────────────────────────────────────

  /**
   * Extract rate limit information from provider response headers.
   * Supports standard X-RateLimit-* headers used by OpenAI, Groq, etc.
   */
  protected _extractRateLimits(headers: Headers): void {
    const rl = this.lastRateLimits
    const reqLimit = headers.get('x-ratelimit-limit-requests')
    const reqRemaining = headers.get('x-ratelimit-remaining-requests')
    const reqReset = headers.get('x-ratelimit-reset-requests')
    const tokLimit = headers.get('x-ratelimit-limit-tokens')
    const tokRemaining = headers.get('x-ratelimit-remaining-tokens')
    const tokReset = headers.get('x-ratelimit-reset-tokens')
    if (reqLimit) rl.requestsLimit = parseInt(reqLimit, 10)
    if (reqRemaining) rl.requestsRemaining = parseInt(reqRemaining, 10)
    if (reqReset) rl.requestsReset = reqReset
    if (tokLimit) rl.tokensLimit = parseInt(tokLimit, 10)
    if (tokRemaining) rl.tokensRemaining = parseInt(tokRemaining, 10)
    if (tokReset) rl.tokensReset = tokReset
  }

  protected _headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    }
  }

  protected async *_parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<OpenAIChatCompletionChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Split on double newline (SSE event boundary)
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim()
              if (jsonStr === '[DONE]') return
              if (!jsonStr) continue
              try {
                yield JSON.parse(jsonStr) as OpenAIChatCompletionChunk
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim()
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                yield JSON.parse(jsonStr) as OpenAIChatCompletionChunk
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
