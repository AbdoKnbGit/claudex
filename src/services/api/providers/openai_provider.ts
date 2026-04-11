/**
 * OpenAI-compatible provider.
 *
 * Base class for all providers that implement the OpenAI Chat Completions API:
 * OpenAI, OpenRouter, Groq, NVIDIA NIM, DeepSeek, Ollama.
 *
 * Uses native fetch (no openai SDK dependency) for maximum portability.
 *
 * Payload optimization (enabled for all 3P providers):
 * Claudex sends a massive system prompt (~8K tokens) + 40+ tool definitions
 * (~5K tokens) designed for Claude. Smaller open-source models choke on this,
 * causing 2-3 minute response times for trivial messages.
 *
 * This base class trims the payload:
 *   - Caps system prompt length
 *   - Limits tools to core essentials
 *   - Caps max_tokens to avoid over-reservation
 *
 * Configure via env vars:
 *   PROVIDER_MAX_TOKENS=4096      — max output tokens (default: 4096)
 *   PROVIDER_MAX_SYSTEM_CHARS=6000 — max system prompt chars (default: 6000)
 *   PROVIDER_NO_OPTIMIZE=true      — disable optimization (send full payload)
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
  type ProviderTool,
  type SystemBlock,
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

// ─── Payload optimization constants ─────────────────────────────

/**
 * Core tools that 3P models actually need for coding assistance.
 * All other tools (Agent, MCP, TaskCreate, NotebookEdit, etc.) add
 * thousands of tokens to the payload without being useful to smaller models.
 */
const CORE_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoRead',
  'TodoWrite',
  'ToolSearch',
])

const DEFAULT_3P_MAX_TOKENS = 4096
const DEFAULT_3P_MAX_SYSTEM_CHARS = 6000

export class OpenAIProvider extends BaseProvider {
  readonly name: string = 'openai'
  protected apiKey: string
  protected baseUrl: string
  protected extraHeaders: Record<string, string>

  /** Whether to optimize payload for smaller models */
  protected optimizePayload: boolean
  protected maxTokensCap: number
  protected maxSystemChars: number

  constructor(config: ProviderConfig) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
    this.extraHeaders = config.extraHeaders ?? {}

    // Payload optimization — on by default for all 3P providers
    this.optimizePayload = process.env.PROVIDER_NO_OPTIMIZE !== 'true'
    this.maxTokensCap = parseInt(
      process.env.PROVIDER_MAX_TOKENS ?? String(DEFAULT_3P_MAX_TOKENS), 10,
    )
    this.maxSystemChars = parseInt(
      process.env.PROVIDER_MAX_SYSTEM_CHARS ?? String(DEFAULT_3P_MAX_SYSTEM_CHARS), 10,
    )
  }

  /** Override in subclasses to enable message coalescing for strict models */
  protected needsMessageCoalescing(model: string): boolean {
    // o1-series models require strictly alternating roles
    return /^o1(-|$)/.test(model)
  }

  // ─── Payload optimization ───────────────────────────────────────

  /**
   * Optimize request params for third-party models:
   * 1. Trim system prompt to essential instructions
   * 2. Filter tools to core set
   * 3. Cap max_tokens
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (!this.optimizePayload) return params

    return {
      ...params,
      system: this._trimSystem(params.system),
      tools: this._filterTools(params.tools),
      max_tokens: Math.min(params.max_tokens, this.maxTokensCap),
    }
  }

  private _trimSystem(
    system?: string | SystemBlock[],
  ): string | SystemBlock[] | undefined {
    if (!system) return system

    const fullText = typeof system === 'string'
      ? system
      : system.map(s => s.text).join('\n\n')

    if (fullText.length <= this.maxSystemChars) {
      return typeof system === 'string' ? system : system
    }

    // Find a clean cut point at a paragraph break
    let cutPoint = this.maxSystemChars
    const lastBreak = fullText.lastIndexOf('\n\n', cutPoint)
    if (lastBreak > this.maxSystemChars * 0.7) {
      cutPoint = lastBreak
    }

    const trimmed = fullText.slice(0, cutPoint) +
      '\n\n[System instructions trimmed for performance. Core tools available: Bash, Read, Write, Edit, Glob, Grep.]'

    if (typeof system === 'string') return trimmed
    return [{ type: 'text' as const, text: trimmed }]
  }

  private _filterTools(tools?: ProviderTool[]): ProviderTool[] | undefined {
    if (!tools || tools.length === 0) return tools

    const filtered = tools.filter(t => CORE_TOOL_NAMES.has(t.name))
    return filtered.length > 0 ? filtered : tools
  }

  // ─── API methods ───────────────────────────────────────────────

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const optimized = this.optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    let messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system)
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: optimized.max_tokens,
      stream: true,
      // Request usage in stream for token counting
      stream_options: { include_usage: true },
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
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
    const optimized = this.optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    let messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system)
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: optimized.max_tokens,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
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

  // ─── Error Handling ─────────────────────────────────────────────

  /**
   * Format API errors with user-friendly messages for common billing/quota issues.
   * Detects 402 (payment required), 429 (quota exceeded), and other billing errors.
   */
  protected formatAPIError(status: number, body: string): Error {
    // Try to extract the error message from JSON response
    let errorDetail = ''
    try {
      const parsed = JSON.parse(body)
      errorDetail = parsed?.error?.message ?? parsed?.error?.type ?? ''
    } catch {
      errorDetail = body
    }

    // 402 — Insufficient balance (DeepSeek, etc.)
    if (status === 402 || errorDetail.toLowerCase().includes('insufficient balance')) {
      return new Error(
        `${this.name} API error: Insufficient account balance.\n` +
        `Your ${this.name} account has no remaining credits.\n` +
        `Please add funds at your provider's billing page and try again.`,
      )
    }

    // 429 — Quota exceeded / rate limit
    if (status === 429) {
      if (errorDetail.toLowerCase().includes('insufficient_quota') ||
          errorDetail.toLowerCase().includes('exceeded your current quota')) {
        return new Error(
          `${this.name} API error: Quota exceeded.\n` +
          `Your ${this.name} API key has exceeded its usage quota.\n` +
          `Check your plan and billing details at your provider's dashboard.`,
        )
      }
      // Rate limit (TPM/RPM) — include the original message for limit details
      return new Error(
        `${this.name} API error: Rate limit exceeded.\n` +
        `${errorDetail}\n` +
        `Tip: Wait a moment and retry, or use a model with higher rate limits.`,
      )
    }

    // 401 — Invalid auth
    if (status === 401) {
      return new Error(
        `${this.name} API error: Authentication failed.\n` +
        `Your API key may be invalid or expired. Run /login to reconfigure.`,
      )
    }

    // 413 — Request too large (Groq TPM, etc.)
    if (status === 413) {
      return new Error(
        `${this.name} API error: Request too large.\n` +
        `${errorDetail}\n` +
        `The message + tools exceeded the model's token limit.\n` +
        `Try a shorter message or switch to a model with a higher token limit.`,
      )
    }

    // Default — include status and body
    return new Error(`${this.name} API error ${status}: ${body}`)
  }

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
