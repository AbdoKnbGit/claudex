/**
 * Codex Lane — Responses API Client
 *
 * Codex (GPT-5, o-series, codex-*) is post-trained against OpenAI's
 * Responses API (POST /v1/responses), NOT Chat Completions. Using the
 * wrong endpoint produces measurable quality regressions on tool-heavy
 * agent workloads.
 *
 * Key differences from Chat Completions:
 *   - Request shape: { model, instructions, input, tools, reasoning, store, stream, previous_response_id }
 *   - SSE event types: response.created, response.output_item.{added,done},
 *     response.output_text.delta, response.reasoning_summary_text.delta,
 *     response.reasoning_text.delta, response.completed, response.failed
 *   - previous_response_id chains turns so the server caches prior context
 *   - `store: true` persists responses for replay / sticky routing
 *
 * Reference: codex-rs/codex-api/src/endpoint/responses.rs
 *            codex-rs/codex-api/src/sse/responses.rs
 */

// ─── Types ───────────────────────────────────────────────────────

export type CodexInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer' | 'system'; content: CodexContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'custom_tool_call'; call_id: string; name: string; input: string }
  | { type: 'custom_tool_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id?: string; summary?: Array<{ type: 'summary_text'; text: string }>; content?: Array<{ type: 'reasoning_text'; text: string }> }

export type CodexContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

export interface CodexReasoningConfig {
  /** "minimal" | "low" | "medium" | "high" — controls thinking intensity. */
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  /** "auto" | "concise" | "detailed" — controls summary verbosity. */
  summary?: 'auto' | 'concise' | 'detailed'
}

export type CodexToolSpec =
  | {
      type: 'function'
      name: string
      description: string
      parameters: Record<string, unknown>
      strict?: boolean
    }
  | {
      // Codex's freeform tool variant — used by apply_patch. Payload is raw
      // text, not JSON-wrapped arguments.
      type: 'custom'
      name: string
      description: string
      format: { type: 'text' }
    }

export interface CodexResponsesRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexToolSpec[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
  parallel_tool_calls?: boolean
  reasoning?: CodexReasoningConfig
  store?: boolean
  stream?: boolean
  include?: string[]
  previous_response_id?: string
  prompt_cache_key?: string
  text?: { format?: 'markdown' | 'plaintext' }
  max_output_tokens?: number
  temperature?: number
}

// ─── SSE Event Types ─────────────────────────────────────────────

export type CodexStreamEvent =
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.in_progress'; response: { id: string } }
  | { type: 'response.output_item.added'; output_index: number; item: CodexOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: CodexOutputItem }
  | { type: 'response.output_text.delta'; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; item_id: string; output_index: number; content_index: number; text: string }
  | { type: 'response.reasoning_summary_text.delta'; item_id: string; output_index: number; summary_index: number; delta: string }
  | { type: 'response.reasoning_text.delta'; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.reasoning_summary_part.added'; item_id: string; output_index: number; summary_index: number; part: { type: 'summary_text'; text: string } }
  | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string }
  | { type: 'response.custom_tool_call_input.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.custom_tool_call_input.done'; item_id: string; output_index: number; input: string }
  | { type: 'response.completed'; response: { id: string; usage: CodexUsage } }
  | { type: 'response.failed'; response: { id: string; error: { code: string; message: string } } }
  | { type: 'response.incomplete'; response: { id: string; incomplete_details?: { reason: string } } }
  | { type: string; [key: string]: unknown }

export type CodexOutputItem =
  | { type: 'message'; id: string; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations?: unknown[] }> }
  | { type: 'reasoning'; id: string; summary?: Array<{ type: 'summary_text'; text: string }>; content?: Array<{ type: 'reasoning_text'; text: string }> }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'custom_tool_call'; id: string; call_id: string; name: string; input: string }

export interface CodexUsage {
  input_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens: number
}

// ─── Client ──────────────────────────────────────────────────────

// Signal prefix for claudex reactive-compact (must match the string in
// services/api/errors.ts — duplicated to avoid the transitive import
// issue with utils/messages.ts).
const CODEX_PROMPT_TOO_LONG_PREFIX = 'Prompt is too long'

export class CodexApiError extends Error {
  readonly isPromptTooLong: boolean

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    // Recognize the signals OpenAI emits for context-window overflow.
    // The Responses API surfaces 400 "context_length_exceeded" (structured
    // error.code) plus a free-text message. Also match the Chat-Completions
    // variant in case the gateway translates.
    const ptl = /context_length_exceeded|maximum context length|prompt is too long|token limit/i
      .test(body)
    const head = ptl
      ? `${CODEX_PROMPT_TOO_LONG_PREFIX} (Codex ${status})`
      : `OpenAI Responses API error ${status}`
    super(`${head}: ${body.slice(0, 200)}`)
    this.name = 'CodexApiError'
    this.isPromptTooLong = ptl
  }

  get isRateLimited(): boolean { return this.status === 429 }
  get isAuth(): boolean { return this.status === 401 || this.status === 403 }
  get isRetryable(): boolean {
    if (this.status === 400) return false
    return this.status === 429 || this.status === 499 || (this.status >= 500 && this.status < 600)
  }
}

export class CodexApiClient {
  private apiKey: string | null = null
  private baseUrl = 'https://api.openai.com/v1'
  /** Org/project ChatGPT OAuth token for subscribers. Overrides apiKey when set. */
  private chatgptAccessToken: string | null = null
  /**
   * previous_response_id threaded across turns so the server sees a
   * contiguous conversation and the prompt cache hits every turn.
   * Keyed by session-ish model+baseUrl. Cleared when the user starts
   * a fresh conversation (handled externally via clearChainForSession).
   */
  private chainedResponseId: string | null = null
  /**
   * Stable per-session identifier used as the Responses API
   * `prompt_cache_key`. Per codex-rs/core/src/client.rs, the cache key
   * must be *stable* across turns of the same conversation — it's the
   * server-side routing hint that lets identical prefixes land on a
   * node with the KV cache warm. Using the previous_response_id here
   * (which changes every turn) defeats caching entirely.
   *
   * Generated lazily on first use; rotated by clearChain() when the
   * caller starts a fresh conversation.
   */
  private cacheSessionId: string | null = null

  configure(opts: { apiKey?: string; baseUrl?: string; chatgptAccessToken?: string }): void {
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey
    if (opts.baseUrl) this.baseUrl = opts.baseUrl
    if (opts.chatgptAccessToken !== undefined) this.chatgptAccessToken = opts.chatgptAccessToken
  }

  get isConfigured(): boolean {
    return !!(this.apiKey || this.chatgptAccessToken)
  }

  /** Reset the previous_response_id chain (new conversation). */
  clearChain(): void {
    this.chainedResponseId = null
    // Rotate the cache session id too — a fresh conversation should not
    // share a prompt_cache_key with the prior one, otherwise stale cache
    // entries can get routed to this request and the server may serve a
    // prefix that no longer matches our actual input.
    this.cacheSessionId = null
  }

  /** Current chained response id (for debugging). */
  get currentChain(): string | null {
    return this.chainedResponseId
  }

  /**
   * Stable `prompt_cache_key` for the current conversation. Generated
   * lazily on first access and held until `clearChain()` rotates it.
   * Uses `crypto.randomUUID()` when available (Node ≥ 14.17, browsers);
   * falls back to a timestamp+random id otherwise.
   */
  get sessionCacheKey(): string {
    if (!this.cacheSessionId) {
      // Lazy require keeps this module importable from contexts without
      // node:crypto (tests, edge runtimes).
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const crypto = require('crypto') as typeof import('crypto')
      this.cacheSessionId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
    return this.cacheSessionId
  }

  /**
   * Stream a Responses API call. Yields parsed SSE events. The caller is
   * responsible for translating them into its own IR and for executing
   * any tool calls the model emits.
   *
   * Retry: initial request retried on 429/5xx with exponential backoff
   * and Retry-After support. Mid-stream errors surface to the caller.
   */
  async *streamResponses(
    request: CodexResponsesRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<CodexStreamEvent> {
    // Thread previous_response_id if the caller didn't set one explicitly.
    const body: CodexResponsesRequest = {
      ...request,
      stream: true,
      store: request.store ?? true,
      previous_response_id: request.previous_response_id ?? this.chainedResponseId ?? undefined,
    }

    const response = await retryWithBackoff(
      async () => {
        const resp = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new CodexApiError(resp.status, errText, retryAfterMs)
        }
        if (!resp.body) throw new CodexApiError(0, 'No response body')
        return resp
      },
      { signal },
    )

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          // SSE: `event: <name>` lines set the event type; `data: <payload>`
          // lines are the JSON body for the current event.
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') {
              currentEvent = null
              return
            }
            if (!payload) continue
            try {
              const parsed = JSON.parse(payload)
              // The event field is authoritative; fall back to parsed.type
              // if the server omitted an explicit `event:` line.
              const type = currentEvent ?? parsed.type ?? 'unknown'
              const ev = { ...parsed, type } as CodexStreamEvent
              // Remember the terminal response id for chaining.
              if (ev.type === 'response.completed' || ev.type === 'response.created') {
                const id = (ev as any).response?.id
                if (id) this.chainedResponseId = id
              }
              yield ev
            } catch {
              // Skip malformed JSON payloads rather than crashing the stream.
            }
          } else if (line.trim() === '') {
            currentEvent = null
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Non-streaming responses call. Returns the final response body.
   * Rarely used — the agent loop always streams. Present for parity.
   */
  async createResponse(request: CodexResponsesRequest, signal?: AbortSignal): Promise<unknown> {
    const body = { ...request, stream: false, store: request.store ?? true }
    return retryWithBackoff(
      async () => {
        const resp = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new CodexApiError(resp.status, errText, retryAfterMs)
        }
        return resp.json()
      },
      { signal },
    )
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      // codex-rs sends the conversation id as an HTTP header (not just
      // a body field). The ChatGPT backend uses this header for sticky
      // cache routing — without it, every turn lands on a different
      // backend node and the prompt cache never hits. Mirror its shape.
      // Ref: codex-rs/codex-api/src/requests/headers.rs build_conversation_headers.
      'session_id': this.sessionCacheKey,
      // codex-rs also sends `originator` so the server segments cache
      // per-client. We mirror codex-cli's value so the backend treats
      // us as the same client family.
      'originator': 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
    }
    if (this.chatgptAccessToken) {
      headers['Authorization'] = `Bearer ${this.chatgptAccessToken}`
      // codex-rs sends the account id from the OAuth token. We don't
      // have the account-id decoded here; send empty to preserve the
      // header name (some gateways require the header even if blank).
      headers['chatgpt-account-id'] = ''
    } else if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    return headers
  }
}

// ─── Retry Helpers (shared shape with Gemini lane's api.ts) ──────

const DEFAULT_MAX_ATTEMPTS = 5
const INITIAL_DELAY_MS = 2000
const MAX_DELAY_MS = 30_000

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPROTO',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
])

function getNetworkErrorCode(error: unknown): string | undefined {
  let cur: unknown = error
  for (let d = 0; d < 5; d++) {
    if (typeof cur !== 'object' || cur === null) return undefined
    if ('code' in cur && typeof (cur as any).code === 'string') return (cur as any).code
    if (!('cause' in cur)) return undefined
    cur = (cur as any).cause
  }
  return undefined
}

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof CodexApiError) return error.isRetryable
  const code = getNetworkErrorCode(error)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if (error instanceof Error && error.message.toLowerCase().includes('fetch failed')) return true
  return false
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const asSec = Number(value)
  if (!isNaN(asSec)) return Math.max(0, asSec * 1000)
  const asDate = Date.parse(value)
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = opts
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  let attempt = 0
  let currentDelay = INITIAL_DELAY_MS

  while (attempt < DEFAULT_MAX_ATTEMPTS) {
    attempt++
    try {
      return await fn()
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err
      if (!isRetryableTransport(err) || attempt >= DEFAULT_MAX_ATTEMPTS) throw err

      const retryAfter = err instanceof CodexApiError ? err.retryAfterMs : undefined
      let waitMs: number
      if (retryAfter != null && retryAfter > 0) {
        waitMs = retryAfter + retryAfter * 0.2 * Math.random()
      } else {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1)
        waitMs = Math.max(0, currentDelay + jitter)
      }

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, waitMs)
        const onAbort = (): void => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })

      currentDelay = Math.min(MAX_DELAY_MS, currentDelay * 2)
    }
  }
  throw new Error('Retry attempts exhausted')
}

// ─── Singleton ───────────────────────────────────────────────────

export const codexApi = new CodexApiClient()
