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
import {
  buildProviderStreamResult,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
  type AnthropicMessage,
  type ModelInfo,
} from './base_provider.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
} from '../adapters/anthropic_to_openai.js'
import {
  openAIStreamToAnthropicEvents,
} from '../adapters/openai_to_anthropic.js'
import {
  getOllamaThinkingEnabled,
  modelSupportsThinkingToggle,
} from '../../../utils/model/ollamaCatalog.js'

// Ollama-specific latency-optimised defaults. Smaller local models (7B/14B)
// spend significant prefill time processing a 6 KB Claude-style system prompt
// plus 11 tool schemas, so for every "simple stuff" reply we'd wait 10–30s
// before the first token. Tightening these cuts TTFT dramatically with no
// visible quality loss for short interactive prompts.
//
// Respects the standard PROVIDER_* env vars so power users can still opt in
// to bigger prompts/budgets via env. Only applied when the Ollama-specific
// OLLAMA_* vars aren't set.
const OLLAMA_DEFAULT_MAX_TOKENS = 2048
const OLLAMA_DEFAULT_MAX_SYSTEM_CHARS = 2400

export class OllamaProvider extends OpenAIProvider {
  readonly name = 'ollama'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey || 'ollama', // Ollama doesn't require auth
      baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
      extraHeaders: config.extraHeaders,
    })

    // Tighten payload defaults for local Ollama — dramatically reduces TTFT
    // for short prompts on small models. The base class already reads
    // PROVIDER_MAX_TOKENS / PROVIDER_MAX_SYSTEM_CHARS; we only override when
    // the user hasn't set Ollama-specific overrides or the generic ones.
    if (!process.env.OLLAMA_MAX_TOKENS && !process.env.PROVIDER_MAX_TOKENS) {
      this.maxTokensCap = OLLAMA_DEFAULT_MAX_TOKENS
    } else if (process.env.OLLAMA_MAX_TOKENS) {
      this.maxTokensCap = parseInt(process.env.OLLAMA_MAX_TOKENS, 10)
    }

    if (!process.env.OLLAMA_MAX_SYSTEM_CHARS && !process.env.PROVIDER_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = OLLAMA_DEFAULT_MAX_SYSTEM_CHARS
    } else if (process.env.OLLAMA_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = parseInt(process.env.OLLAMA_MAX_SYSTEM_CHARS, 10)
    }

    if (process.env.OLLAMA_NO_OPTIMIZE === 'true') {
      this.optimizePayload = false
    }
  }

  /**
   * Ollama runs locally — no TPM limits, no reason to strip tools.
   * Send the full tool set so agents, MCP servers, plan mode, and
   * tasks all work. Users with small models can set
   * OLLAMA_NO_OPTIMIZE=false or PROVIDER_MAX_SYSTEM_CHARS to tune.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    return params
  }

  /**
   * Override to handle Ollama-specific behavior:
   *   - Pre-flight health check on /api/tags so we fail fast (< 5s) with
   *     an actionable error message when the daemon isn't running,
   *     instead of hanging on a dead socket for minutes.
   *   - Some models don't support max_tokens → retry without
   *   - Cloud thinking models get an `enable_thinking` parameter when the
   *     user's thinking toggle is on (otherwise we omit the field entirely,
   *     since non-thinking models 400 on unknown params).
   */
  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    await this._assertDaemonReachable()

    if (modelSupportsThinkingToggle(params.model)) {
      return this._streamWithThinkingToggle(params)
    }

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

  /**
   * Probe the Ollama daemon's /api/tags endpoint with a short timeout
   * (configurable via OLLAMA_CONNECT_TIMEOUT_MS, default 4 s). Throws
   * a user-friendly error if the daemon is unreachable — the previous
   * behaviour was to let the chat-completions fetch hang for minutes on
   * a dead TCP socket before failing with an unhelpful network error.
   */
  private async _assertDaemonReachable(): Promise<void> {
    const timeoutMs = parseInt(
      process.env.OLLAMA_CONNECT_TIMEOUT_MS ?? '4000',
      10,
    )
    // /api/tags lives at the daemon root, NOT under the OpenAI /v1 path.
    const rootUrl = this.baseUrl.replace(/\/v1\/?$/i, '').replace(/\/+$/, '')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${rootUrl}/api/tags`, {
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(
          `Ollama daemon at ${rootUrl} answered with HTTP ${res.status}. ` +
            `Check the daemon log.`,
        )
      }
    } catch (err: unknown) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err)
      throw new Error(
        `Ollama is not responding at ${rootUrl} (${reason}).\n` +
          `  • Start the daemon: \`ollama serve\`\n` +
          `  • Or change the base URL from /provider → Ollama → Set custom base URL\n` +
          `  • Or set OLLAMA_BASE_URL to the host you want to use.`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Build the chat-completions request manually so we can inject the
   * `enable_thinking` flag for Ollama Cloud thinking models. The flag is
   * read from the shared bridge in ollamaCatalog so React AppState is the
   * single source of truth.
   */
  private async _streamWithThinkingToggle(
    params: ProviderRequestParams,
  ): Promise<ProviderStreamResult> {
    const optimized = this.optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    const messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system)
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    // Per-request thinking toggle — prefer the explicit params.thinking
    // field (set by claude.ts from AppState.thinkingEnabled). Fall back to
    // the shared bridge for legacy call sites that don't pass it.
    const thinkingFromParams =
      optimized.thinking === undefined
        ? undefined
        : optimized.thinking.type !== 'disabled'
    const enableThinking =
      thinkingFromParams ?? getOllamaThinkingEnabled()

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: optimized.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      // Ollama cloud thinking models honour this field; we only send it
      // for models in the allowlist so non-thinking providers never break.
      enable_thinking: enableThinking,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    const ac = new AbortController()
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      // Retry with max_tokens stripped if that's what blew up
      if (errText.includes('max_tokens')) {
        return super.stream({ ...params, max_tokens: -1 })
      }
      throw new Error(`Ollama API error ${response.status}: ${errText}`)
    }

    if (!response.body) {
      throw new Error('Ollama returned no response body for streaming request')
    }

    const sseStream = this._parseSSE(response.body)
    const anthropicEvents = openAIStreamToAnthropicEvents(sseStream)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    await this._assertDaemonReachable()
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
