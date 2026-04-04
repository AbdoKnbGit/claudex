/**
 * NVIDIA NIM provider — extends OpenAIProvider.
 *
 * NVIDIA NIM provides free hosted inference for top open-source models.
 * Uses OpenAI-compatible API at build.nvidia.com / integrate.api.nvidia.com.
 *
 * Base URL: https://integrate.api.nvidia.com/v1
 * Auth: Bearer token (nvapi-...)
 *
 * Key models (April 2026):
 *   - moonshotai/kimi-k2-thinking  — Reasoning model, supports budget_tokens
 *   - moonshotai/kimi-k2.5         — Latest Kimi, multimodal agentic
 *   - moonshotai/kimi-k2-instruct  — Instruction-tuned Kimi
 *   - minimaxai/minimax-m2.5       — 230B params, Feb 2026
 *   - nvidia/llama-3.1-8b-instruct — Ultra-fast small model
 *
 * Special features:
 *   - Thinking models (kimi-k2-thinking) support budget_tokens
 *     via nvext: { budget_tokens: N } in request body
 *   - Some models may not support streaming — falls back to non-streaming
 */

import { OpenAIProvider } from './openai_provider.js'
import {
  buildProviderStreamResult,
  type AnthropicMessage,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
} from './base_provider.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
} from '../adapters/anthropic_to_openai.js'
import {
  openAIStreamToAnthropicEvents,
  openAIMessageToAnthropic,
  type OpenAIChatCompletion,
} from '../adapters/openai_to_anthropic.js'

/** Models that support reasoning/thinking budget tokens */
const THINKING_MODELS = [
  'moonshotai/kimi-k2-thinking',
  'kimi-k2-thinking',
]

export class NimProvider extends OpenAIProvider {
  readonly name = 'nim'
  private enableThinking: boolean
  private thinkingBudget: number

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
      extraHeaders: config.extraHeaders,
    })
    this.enableThinking = process.env.NIM_ENABLE_THINKING === 'true'
    this.thinkingBudget = parseInt(process.env.NIM_THINKING_BUDGET ?? '8192', 10)
  }

  /**
   * Override stream to handle NIM-specific features:
   * - Inject thinking budget tokens for reasoning models
   * - Fallback to non-streaming if streaming fails
   */
  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)

    // Check if this is a thinking model and inject budget
    if (this._isThinkingModel(model)) {
      return this._streamWithThinking(params, model)
    }

    try {
      return await super.stream(params)
    } catch (err: unknown) {
      // Some NIM models don't support streaming — fall back to create
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('streaming') || errMsg.includes('not supported')) {
        const message = await this.create(params)
        return this._wrapAsStream(message)
      }
      throw err
    }
  }

  /**
   * Stream with NIM thinking extensions (nvext.budget_tokens).
   */
  private async _streamWithThinking(
    params: ProviderRequestParams,
    model: string,
  ): Promise<ProviderStreamResult> {
    const messages = anthropicMessagesToOpenAI(params.messages, params.system)
    const tools = params.tools ? anthropicToolsToOpenAI(params.tools) : undefined

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: params.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.stop_sequences) body.stop = params.stop_sequences

    // Inject NIM thinking extension
    if (this.enableThinking) {
      body.nvext = { budget_tokens: this.thinkingBudget }
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`NIM API error ${response.status}: ${errText}`)
    }

    if (!response.body) {
      throw new Error('NIM returned no response body for streaming request')
    }

    const sseStream = this._parseSSE(response.body)
    const anthropicEvents = openAIStreamToAnthropicEvents(sseStream)
    return buildProviderStreamResult(anthropicEvents)
  }

  private _isThinkingModel(model: string): boolean {
    return THINKING_MODELS.some(tm => model.includes(tm))
  }

  /** Wrap a non-streaming response as a ProviderStreamResult */
  private _wrapAsStream(message: AnthropicMessage): ProviderStreamResult {
    const events = (async function* () {
      yield {
        type: 'message_start' as const,
        message,
      }
      for (let i = 0; i < message.content.length; i++) {
        const block = message.content[i]!
        yield {
          type: 'content_block_start' as const,
          index: i,
          content_block: block,
        }
        yield { type: 'content_block_stop' as const, index: i }
      }
      yield {
        type: 'message_delta' as const,
        delta: {
          stop_reason: message.stop_reason ?? 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: message.usage.output_tokens },
      }
      yield { type: 'message_stop' as const }
    })()

    const result: ProviderStreamResult = {
      [Symbol.asyncIterator]() { return events[Symbol.asyncIterator]() },
      async finalMessage() { return message },
      on(event: string, cb: (msg: AnthropicMessage) => void) {
        if (event === 'message') cb(message)
        return result
      },
      abort() { /* no-op for non-streaming */ },
    }
    return result
  }
}
