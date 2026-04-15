/**
 * Gemini Lane — Native REST API Client
 *
 * Direct HTTP client for Gemini's REST API. No SDK dependency.
 * Supports both API key and OAuth token auth.
 *
 * Endpoints:
 *   Streaming:     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   Non-streaming: POST /v1beta/models/{model}:generateContent
 *   Model list:    GET  /v1beta/models
 *
 * Auth:
 *   API key:  x-goog-api-key header
 *   OAuth:    Authorization: Bearer <token> (routed through Code Assist proxy)
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  CODE_ASSIST_BASE,
  ensureCodeAssistReady,
  executorForModel,
  parseCodeAssistSSE,
  unwrapCodeAssistResponse,
  wrapForCodeAssist,
  wrapForGeminiCLI,
  geminiCLIApiHeaders,
  antigravityApiHeaders,
  clearCodeAssistCache,
  warmupCodeAssist,
} from '../../services/api/providers/gemini_code_assist.js'

// ─── Types ───────────────────────────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role: string
      parts: Array<Record<string, unknown>>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

// ─── API Client ──────────────────────────────────────────────────

const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta'

class GeminiApiClient {
  private apiKey: string | null = null
  /** OAuth token for the Gemini CLI executor (free-tier flash/lite models). */
  private cliOAuthToken: string | null = null
  /** OAuth token for the Antigravity executor (Gemini 3.x pro/flash models). */
  private antigravityOAuthToken: string | null = null

  /** Configure auth. Call this before making requests. */
  configure(opts: {
    apiKey?: string
    oauthToken?: string
    cliOAuthToken?: string
    antigravityOAuthToken?: string
    oauthMode?: 'cli' | 'antigravity'
  }): void {
    this.apiKey = opts.apiKey ?? null
    this.cliOAuthToken = opts.cliOAuthToken ?? null
    this.antigravityOAuthToken = opts.antigravityOAuthToken ?? null
    // Legacy single-token path: route per oauthMode ('cli' default).
    if (opts.oauthToken) {
      if (opts.oauthMode === 'antigravity') {
        this.antigravityOAuthToken ??= opts.oauthToken
      } else {
        this.cliOAuthToken ??= opts.oauthToken
      }
    }
    // Pre-warm Code Assist onboarding to avoid a cold-start round trip on
    // the first real request. Non-blocking — fires in the background.
    if (this.cliOAuthToken || this.antigravityOAuthToken) {
      warmupCodeAssist(
        this.cliOAuthToken ?? undefined,
        this.antigravityOAuthToken ?? undefined,
      )
    }
  }

  /** Whether any auth is configured */
  get isConfigured(): boolean {
    return !!(this.apiKey || this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /** Whether any OAuth token is configured (for routing decisions). */
  get hasOAuth(): boolean {
    return !!(this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /** Get the current API key (if configured). For cache integration. */
  getApiKey(): string | null {
    return this.apiKey
  }

  /** Whether the current auth path supports Google's cachedContents API. */
  supportsServerCache(): boolean {
    // Google's cachedContents API is API-key-path only. The Code Assist
    // OAuth proxy doesn't expose it. If we ever find a verified path via
    // the proxy, flip this.
    return !!this.apiKey && !this.hasOAuth
  }

  /** Base URL for cache API calls. */
  readonly cacheBaseUrl = AI_STUDIO_BASE

  /**
   * Pick the OAuth token appropriate for a model. Antigravity models
   * route through the Antigravity executor (Gemini 3.x pro/flash pool),
   * everything else goes through the CLI executor (Code Assist free tier).
   * Falls back to the other token when the preferred one is absent.
   */
  private _tokenForModel(model: string): { token: string; executor: 'cli' | 'antigravity' } | null {
    const executor = executorForModel(model)
    if (executor === 'antigravity') {
      const t = this.antigravityOAuthToken ?? this.cliOAuthToken
      return t ? { token: t, executor: this.antigravityOAuthToken ? 'antigravity' : 'cli' } : null
    }
    const t = this.cliOAuthToken ?? this.antigravityOAuthToken
    return t ? { token: t, executor: this.cliOAuthToken ? 'cli' : 'antigravity' } : null
  }

  /**
   * Stream a generateContent request. Returns an async iterable of chunks.
   * Uses Server-Sent Events (SSE) format.
   *
   * Retry behavior: the INITIAL request is retried on 429/5xx/network errors
   * with exponential backoff + jitter, mirroring gemini-cli's retry.ts.
   * Once the stream starts yielding chunks we can't rewind, so mid-stream
   * errors surface to the caller.
   */
  async *streamGenerateContent(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<GeminiStreamChunk> {
    const model = (request as any).model ?? 'gemini-2.5-pro'
    const body = { ...request }
    delete body.model

    // OAuth path → Code Assist proxy (cloudcode-pa.googleapis.com). Uses the
    // same request envelopes and header sets that CLIProxyAPI emits so quota
    // routes to the right pool (free Code Assist vs Antigravity).
    const oauthRouting = this._tokenForModel(model)
    if (oauthRouting) {
      const { token, executor } = oauthRouting
      const projectId = await ensureCodeAssistReady(token, executor)
      const wrappedBody = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body)
        : wrapForGeminiCLI(model, projectId, body)
      const headers = executor === 'antigravity'
        ? { ...antigravityApiHeaders(token), 'Connection': 'keep-alive' }
        : { ...geminiCLIApiHeaders(token, model), 'Connection': 'keep-alive' }

      const url = `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`
      const response = await retryWithBackoff(
        async () => {
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(wrappedBody),
            signal,
          })
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '')
            // 403 with stale-project signature → clear and let the next
            // attempt re-onboard with a fresh projectId. Mirrors the legacy
            // provider's self-heal; without it the lane wedges on account
            // switches.
            if (resp.status === 403 && /cloudaicompanion|does not have permission|project might not exist/i.test(errText)) {
              clearCodeAssistCache(executor)
            }
            const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
            throw new GeminiApiError(resp.status, errText, retryAfterMs)
          }
          if (!resp.body) throw new GeminiApiError(0, 'No response body')
          return resp
        },
        { signal },
      )

      // Code Assist SSE frames are wrapped as `{ response: <chunk> }`.
      // Lane's GeminiStreamChunk is structurally compatible with the
      // adapter's; cast to sidestep the type identity gap between copies.
      for await (const chunk of parseCodeAssistSSE(response.body!)) {
        yield chunk as GeminiStreamChunk
      }
      return
    }

    // API-key path — generativelanguage.googleapis.com direct.
    const url = `${AI_STUDIO_BASE}/models/${model}:streamGenerateContent?alt=sse`
    const headers = this.getHeaders()

    const response = await retryWithBackoff(
      async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new GeminiApiError(resp.status, errText, retryAfterMs)
        }
        if (!resp.body) throw new GeminiApiError(0, 'No response body')
        return resp
      },
      { signal },
    )

    // Parse SSE stream
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE events
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // Keep incomplete last line

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') return
            if (!data) continue

            try {
              const chunk: GeminiStreamChunk = JSON.parse(data)
              yield chunk
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
      }

      // Process any remaining data in buffer
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim()
        if (data && data !== '[DONE]') {
          try {
            yield JSON.parse(data)
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Non-streaming generateContent request.
   */
  async generateContent(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeminiStreamChunk> {
    const model = (request as any).model ?? 'gemini-2.5-pro'
    const body = { ...request }
    delete body.model

    // OAuth → Code Assist (unwraps the `{ response: ... }` envelope).
    const oauthRouting = this._tokenForModel(model)
    if (oauthRouting) {
      const { token, executor } = oauthRouting
      const projectId = await ensureCodeAssistReady(token, executor)
      const wrappedBody = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body)
        : wrapForGeminiCLI(model, projectId, body)
      const headers = executor === 'antigravity'
        ? { ...antigravityApiHeaders(token), 'Connection': 'keep-alive' }
        : { ...geminiCLIApiHeaders(token, model), 'Connection': 'keep-alive' }

      const url = `${CODE_ASSIST_BASE}:generateContent`
      const data = await retryWithBackoff(
        async () => {
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(wrappedBody),
            signal,
          })
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '')
            if (resp.status === 403 && /cloudaicompanion|does not have permission|project might not exist/i.test(errText)) {
              clearCodeAssistCache(executor)
            }
            const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
            throw new GeminiApiError(resp.status, errText, retryAfterMs)
          }
          return resp.json()
        },
        { signal },
      )
      return unwrapCodeAssistResponse(data) as GeminiStreamChunk
    }

    // API-key path — generativelanguage.googleapis.com direct.
    const url = `${AI_STUDIO_BASE}/models/${model}:generateContent`
    const headers = this.getHeaders()

    return retryWithBackoff(
      async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
          throw new GeminiApiError(resp.status, errText, retryAfterMs)
        }
        return resp.json()
      },
      { signal },
    )
  }

  /**
   * List available models. Returns a curated list for OAuth paths (Code
   * Assist doesn't expose /v1beta/models and cloud-platform tokens are
   * rejected as restricted_client), or the live API-key catalog otherwise.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (this.hasOAuth) {
      const models: ModelInfo[] = []
      if (this.cliOAuthToken) {
        models.push(
          { id: 'gemini-3-flash-preview',        name: 'Gemini 3 Flash (preview)' },
          { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (preview)' },
          { id: 'gemini-2.5-flash',              name: 'Gemini 2.5 Flash' },
          { id: 'gemini-2.5-flash-lite',         name: 'Gemini 2.5 Flash Lite' },
        )
      }
      if (this.antigravityOAuthToken) {
        models.push(
          { id: 'gemini-3.1-pro-high',    name: 'Gemini 3.1 Pro · high thinking' },
          { id: 'gemini-3.1-pro-low',     name: 'Gemini 3.1 Pro · low thinking' },
          { id: 'gemini-3-pro-high',      name: 'Gemini 3 Pro · high thinking' },
          { id: 'gemini-3-pro-low',       name: 'Gemini 3 Pro · low thinking' },
          { id: 'gemini-3-flash',         name: 'Gemini 3 Flash' },
          { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash · image' },
        )
      }
      return models
    }

    const url = `${AI_STUDIO_BASE}/models`
    const headers = this.getHeaders()

    const response = await fetch(url, {
      method: 'GET',
      headers,
    })

    if (!response.ok) return []

    const data = await response.json()
    return (data.models ?? [])
      .filter((m: any) => m.name?.includes('gemini'))
      .map((m: any) => ({
        id: m.name?.replace('models/', '') ?? m.name,
        name: m.displayName ?? m.name,
        contextWindow: m.inputTokenLimit,
        supportsToolCalling: m.supportedGenerationMethods?.includes('generateContent'),
      }))
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Connection: 'keep-alive',
    }

    if (this.apiKey) {
      headers['x-goog-api-key'] = this.apiKey
    }
    // OAuth is never used on the direct AI Studio endpoint — it's routed
    // through Code Assist above. This header path only runs on API-key
    // listModels / cache calls.
    return headers
  }
}

// ─── Error Type ──────────────────────────────────────────────────

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Gemini API error ${status}: ${body.slice(0, 200)}`)
    this.name = 'GeminiApiError'
  }

  get isRateLimited(): boolean {
    return this.status === 429
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }

  get isRetryable(): boolean {
    // 429 (rate limit), 499 (client closed), 5xx (server errors). 400 is
    // explicitly NOT retryable — it's a malformed request that won't
    // succeed regardless of retry. Mirrors gemini-cli's isRetryableError.
    if (this.status === 400) return false
    return this.status === 429 || this.status === 499 || (this.status >= 500 && this.status < 600)
  }
}

// ─── Retry / Backoff ─────────────────────────────────────────────
//
// Ported from gemini-cli packages/core/src/utils/retry.ts. Handles:
//   - 429, 499, 5xx HTTP errors
//   - Transient network errors (ECONNRESET, ETIMEDOUT, EPIPE, ENOTFOUND,
//     EAI_AGAIN, ECONNREFUSED, EPROTO, SSL-alert errors)
//   - Retry-After header (with +20% jitter to avoid thundering herd)
//   - Exponential backoff with ±30% jitter for non-quota errors
//   - AbortSignal propagation

const DEFAULT_MAX_ATTEMPTS = 5
const INITIAL_DELAY_MS = 2000
const MAX_DELAY_MS = 30_000

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPROTO',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
])

function getNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    if ('code' in current && typeof (current as any).code === 'string') {
      return (current as any).code
    }
    if (!('cause' in current)) return undefined
    current = (current as any).cause
  }
  return undefined
}

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof GeminiApiError) return error.isRetryable
  const code = getNetworkErrorCode(error)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if (error instanceof Error && error.message.toLowerCase().includes('fetch failed')) return true
  return false
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  // Retry-After is either seconds or an HTTP date.
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

      // Server-specified Retry-After wins if present.
      const retryAfter = err instanceof GeminiApiError ? err.retryAfterMs : undefined
      let waitMs: number
      if (retryAfter != null && retryAfter > 0) {
        const jitter = retryAfter * 0.2 * Math.random() // 0 to +20%
        waitMs = retryAfter + jitter
      } else {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1) // ±30%
        waitMs = Math.max(0, currentDelay + jitter)
      }

      await delayWithAbort(waitMs, signal)
      currentDelay = Math.min(MAX_DELAY_MS, currentDelay * 2)
    }
  }

  throw new Error('Retry attempts exhausted')
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── Singleton ───────────────────────────────────────────────────

export const geminiApi = new GeminiApiClient()
