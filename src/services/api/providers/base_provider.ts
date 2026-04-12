/**
 * Abstract base class for all third-party LLM providers.
 *
 * Each provider must normalize its responses into Anthropic-compatible
 * BetaRawMessageStreamEvent / BetaMessage format so the existing agent
 * loop, MCP tools, and streaming renderer work unchanged.
 */

export interface ProviderStreamResult {
  [Symbol.asyncIterator](): AsyncIterator<AnthropicStreamEvent>
  /** Collect all events and return the final assembled message */
  finalMessage(): Promise<AnthropicMessage>
  /** Register a callback for the final message */
  on(event: 'message', cb: (msg: AnthropicMessage) => void): this
  /** Abort the in-flight request */
  abort(): void
}

// ─── Anthropic-compatible types (subset we need for normalization) ──

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking'
  // text block
  text?: string
  // tool_use block
  id?: string
  name?: string
  input?: Record<string, unknown>
  // thinking block (Gemini thought / Anthropic thinking)
  thinking?: string
  signature?: string
  // Gemini round-trip: thought_signature on functionCall parts
  _gemini_thought_signature?: string
}

export interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    /**
     * Optional cache accounting fields. Third-party providers that
     * support prompt caching (currently Gemini 2.5+ via cachedContents)
     * populate these so ClaudeX's existing cost tracker treats them
     * like Anthropic cache hits.
     */
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface AnthropicStreamEvent {
  type: string
  // message_start
  message?: AnthropicMessage
  // content_block_start
  index?: number
  content_block?: AnthropicContentBlock
  // content_block_delta
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    stop_reason?: string
    stop_sequence?: string | null
  }
  // message_delta
  usage?: { output_tokens: number }
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  extraHeaders?: Record<string, string>
}

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
  supportsToolCalling?: boolean
}

export abstract class BaseProvider {
  abstract readonly name: string

  /**
   * Send a streaming request and return an async iterator of
   * Anthropic-normalized stream events.
   */
  abstract stream(params: ProviderRequestParams): Promise<ProviderStreamResult>

  /**
   * Send a non-streaming request and return a single
   * Anthropic-normalized message.
   */
  abstract create(params: ProviderRequestParams): Promise<AnthropicMessage>

  /**
   * List available models from this provider.
   */
  abstract listModels(): Promise<ModelInfo[]>

  /**
   * Map a Claude model name (e.g. 'claude-opus-4-6') to the
   * provider's equivalent model ID.
   */
  abstract resolveModel(claudeModel: string): string
}

// ─── Common request params (Anthropic-format, pre-adapter) ──────────

export interface ProviderRequestParams {
  model: string
  messages: ProviderMessage[]
  system?: string | SystemBlock[]
  tools?: ProviderTool[]
  max_tokens: number
  temperature?: number
  stop_sequences?: string[]
  stream?: boolean
  /**
   * Anthropic-format thinking param. Individual providers translate this
   * into their native reasoning/thinking flag (OpenAI `reasoning_effort`,
   * Gemini `thinkingConfig`, NIM `nvext.budget_tokens`, OpenRouter
   * `reasoning`, Ollama `enable_thinking`, etc.). When absent, no thinking
   * is requested.
   */
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'adaptive' }
    | { type: 'disabled' }
}

export interface SystemBlock {
  type: 'text'
  text: string
}

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string | ProviderContentBlock[]
}

export interface ProviderContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'redacted_thinking'
  // text
  text?: string
  // tool_use
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result
  tool_use_id?: string
  content?: string | ProviderContentBlock[]
  is_error?: boolean
  // image
  source?: { type: string; media_type: string; data: string }
  // thinking block
  thinking?: string
  signature?: string
  // Gemini round-trip: thought_signature on tool_use blocks
  _gemini_thought_signature?: string
}

export interface ProviderTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

// ─── Helper: Build a ProviderStreamResult from an async iterable ────

export function buildProviderStreamResult(
  events: AsyncIterable<AnthropicStreamEvent>,
): ProviderStreamResult {
  let finalMsg: AnthropicMessage | null = null
  const messageCallbacks: Array<(msg: AnthropicMessage) => void> = []
  let aborted = false
  let abortController: AbortController | undefined

  const collected: AnthropicStreamEvent[] = []

  const iteratorPromise = (async function* () {
    for await (const event of events) {
      if (aborted) break
      collected.push(event)
      if (event.type === 'message_start' && event.message) {
        finalMsg = event.message
      }
      if (event.type === 'message_stop' && finalMsg) {
        messageCallbacks.forEach(cb => cb(finalMsg!))
      }
      yield event
    }
  })()

  const result: ProviderStreamResult = {
    [Symbol.asyncIterator]() {
      return iteratorPromise[Symbol.asyncIterator]()
    },
    async finalMessage() {
      // Drain the iterator if not yet consumed
      if (!finalMsg) {
        for await (const _ of iteratorPromise) {
          if (aborted) break
        }
      }
      if (!finalMsg) {
        throw new Error('Stream ended without producing a message')
      }
      return finalMsg
    },
    on(event: string, cb: (msg: AnthropicMessage) => void) {
      if (event === 'message') messageCallbacks.push(cb)
      return result
    },
    abort() {
      aborted = true
      abortController?.abort()
    },
  }

  return result
}
