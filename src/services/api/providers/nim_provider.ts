/**
 * NVIDIA NIM provider — extends OpenAIProvider.
 *
 * NVIDIA NIM provides free hosted inference for top open-source models.
 * Uses OpenAI-compatible API at build.nvidia.com / integrate.api.nvidia.com.
 *
 * Base URL: https://integrate.api.nvidia.com/v1
 * Auth: Bearer token (nvapi-...)
 *
 * Payload optimization is handled by the base OpenAIProvider class.
 * NIM-specific env vars (NIM_MAX_TOKENS, NIM_MAX_SYSTEM_CHARS, NIM_NO_OPTIMIZE)
 * override the generic PROVIDER_* vars when set.
 *
 * This subclass adds:
 *   - Thinking model support (kimi-k2-thinking) with nvext.budget_tokens
 *   - Streaming fallback for models that don't support SSE
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
} from '../adapters/openai_to_anthropic.js'

/** Models that support reasoning/thinking budget tokens */
const THINKING_MODELS = [
  'moonshotai/kimi-k2-thinking',
  'kimi-k2-thinking',
]

export class NimProvider extends OpenAIProvider {
  readonly name = 'nim'
  /** Env-var fallback for users who want thinking on without the /thinking toggle */
  private envEnableThinking: boolean
  /** Default budget used when no explicit request budget is supplied */
  private defaultThinkingBudget: number

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
      extraHeaders: config.extraHeaders,
    })

    // NIM-specific env vars override base class defaults
    if (process.env.NIM_MAX_TOKENS) {
      this.maxTokensCap = parseInt(process.env.NIM_MAX_TOKENS, 10)
    }
    if (process.env.NIM_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = parseInt(process.env.NIM_MAX_SYSTEM_CHARS, 10)
    }
    if (process.env.NIM_NO_OPTIMIZE === 'true') {
      this.optimizePayload = false
    }

    // Kept as a fallback: if the user has NIM_ENABLE_THINKING=true in their
    // env, thinking is forced on for kimi-k2-thinking even without /thinking.
    this.envEnableThinking = process.env.NIM_ENABLE_THINKING === 'true'
    this.defaultThinkingBudget = parseInt(
      process.env.NIM_THINKING_BUDGET ?? '8192',
      10,
    )
  }

  /**
   * Override stream to handle NIM-specific features:
   * - Thinking model budget tokens injection
   * - Streaming fallback for models that don't support SSE
   *
   * Payload optimization is handled by the base class's stream() method.
   */
  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)

    // Thinking models need special handling (nvext.budget_tokens)
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

  // ─── Thinking Models ───────────────────────────────────────────

  /**
   * Stream with NIM thinking extensions (nvext.budget_tokens).
   * Builds the request manually to inject the nvext field.
   */
  private async _streamWithThinking(
    params: ProviderRequestParams,
    model: string,
  ): Promise<ProviderStreamResult> {
    // Apply base class optimization before building the custom request
    const optimized = this.optimizeParams(params)
    const messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system)
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    // Kimi K2 Thinking can spend 4–8k tokens in `reasoning_content` before
    // it starts emitting the final answer. If `max_tokens` is the generic
    // optimized cap (often 4096), the model hits the ceiling mid-thought
    // and the user sees "nothing happened" even though the request
    // succeeded. Raise the floor for thinking-capable NIM models so there
    // is always room for reasoning + answer.
    //
    // Tunable: NIM_THINKING_MIN_MAX_TOKENS, NIM_MAX_TOKENS.
    const thinkingMinMaxTokens = parseInt(
      process.env.NIM_THINKING_MIN_MAX_TOKENS ?? '16384',
      10,
    )
    const effectiveMaxTokens = Math.max(
      optimized.max_tokens ?? 0,
      thinkingMinMaxTokens,
    )

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: effectiveMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    // Resolve thinking budget. Precedence:
    //   1. params.thinking.budget_tokens (from /thinking toggle via claude.ts)
    //   2. NIM_ENABLE_THINKING env var (uses NIM_THINKING_BUDGET)
    // If thinking is explicitly 'disabled' on params, skip entirely even
    // if the env var is set — the user just turned it off via /thinking.
    const reqThinking = optimized.thinking
    let budget: number | undefined
    if (reqThinking && reqThinking.type === 'enabled') {
      budget = reqThinking.budget_tokens
    } else if (reqThinking && reqThinking.type === 'adaptive') {
      budget = this.defaultThinkingBudget
    } else if (
      (!reqThinking || reqThinking.type !== 'disabled') &&
      this.envEnableThinking
    ) {
      budget = this.defaultThinkingBudget
    }
    if (budget !== undefined) {
      body.nvext = { budget_tokens: budget }
    }

    const ac = new AbortController()
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: ac.signal,
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
    return buildProviderStreamResult(anthropicEvents, ac)
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
