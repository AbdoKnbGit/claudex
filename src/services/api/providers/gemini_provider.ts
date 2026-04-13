/**
 * Google Gemini native REST provider.
 *
 * Uses the Gemini REST API directly (no SDK dependency).
 * Supports both API key auth (x-goog-api-key header) and OAuth Bearer token.
 *
 * Endpoints:
 *   Streaming:     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   Non-streaming: POST /v1beta/models/{model}:generateContent
 *   Model list:    GET  /v1beta/models
 *
 * Optimizations:
 *   - API key sent via x-goog-api-key header (not URL param) for security
 *   - Connection: keep-alive on all requests for connection reuse
 *   - Sliding-window rate limiter to avoid hitting 429s
 *   - Context caching with proactive background refresh
 */

import {
  BaseProvider,
  buildProviderStreamResult,
  type AnthropicMessage,
  type ModelInfo,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
} from './base_provider.js'
import { anthropicToGeminiRequest } from '../adapters/anthropic_to_gemini.js'
import {
  geminiStreamToAnthropicEvents,
  geminiMessageToAnthropic,
  parseGeminiSSE,
  type GeminiGenerateContentResponse,
} from '../adapters/gemini_to_anthropic.js'
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
} from './gemini_code_assist.js'
import { getOrCreateCache, invalidateCache } from './gemini_cache.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'

// ─── Rate Limiter ───────────────────────────────────────────────────
// Simple sliding-window rate limiter. Tracks request timestamps and
// enforces a maximum RPM (requests per minute). When the limit is
// approached, inserts a short delay to spread requests evenly instead
// of bursting and getting 429'd.

const DEFAULT_RPM = 30  // Conservative default; Gemini free tier is 15 RPM
const _requestTimestamps: number[] = []

/** Sleep for ms. */
function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Wait if needed to stay under the RPM limit. Returns immediately
 * if the window has capacity. Otherwise waits until the oldest
 * request in the window expires.
 */
async function _throttle(rpm: number = DEFAULT_RPM): Promise<void> {
  const now = Date.now()
  const windowMs = 60_000

  // Prune old entries outside the window.
  while (_requestTimestamps.length > 0 && _requestTimestamps[0]! < now - windowMs) {
    _requestTimestamps.shift()
  }

  if (_requestTimestamps.length >= rpm) {
    // Wait until the oldest request leaves the window.
    const waitMs = _requestTimestamps[0]! + windowMs - now + 50 // +50ms margin
    if (waitMs > 0) {
      await _sleep(waitMs)
    }
  }

  _requestTimestamps.push(Date.now())
}

// Models reachable via the two OAuth executors:
//
// 1. Gemini CLI executor (google_oauth 'cli' token) — free-tier flash/lite
//    models with good rate limits. Needs User-Agent=GeminiCLI/...
//
// 2. Antigravity executor (google_oauth 'antigravity' token) — pro models
//    with Antigravity quota pool. Needs body.userAgent="antigravity".
//
// Both route through the Code Assist proxy at cloudcode-pa.googleapis.com.
// The curated lists below are split by executor so the provider can show
// only the models the user actually has tokens for.

/** Models available via the Gemini CLI OAuth client (free tier). */
const GEMINI_CLI_MODELS: ModelInfo[] = [
  { id: 'gemini-3-flash-preview',              name: 'Gemini 3 Flash (preview)' },
  { id: 'gemini-3.1-flash-lite-preview',       name: 'Gemini 3.1 Flash Lite (preview)' },
  { id: 'gemini-2.5-flash',                    name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite',               name: 'Gemini 2.5 Flash Lite' },
]

/** Models available via the Antigravity OAuth client (pro tier). */
const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro-high',                 name: 'Gemini 3.1 Pro · high thinking' },
  { id: 'gemini-3.1-pro-low',                  name: 'Gemini 3.1 Pro · low thinking' },
]

/**
 * Generative models that live on v1beta/models but are NOT chat-completion
 * capable — image/audio/TTS/video/embedding. The API-key path will surface
 * them with a descriptive suffix so users can tell at a glance they are not
 * candidates for general chat turns. OAuth users never see them because
 * Code Assist does not proxy these endpoints.
 */
/** Check if a Gemini model is a text/chat model (not image gen, TTS, etc.). */
function _isGeminiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.includes('-tts')) return false
  if (lower.includes('-image')) return false
  if (lower.includes('-live') || lower.includes('-native-audio')) return false
  if (lower.startsWith('veo-')) return false
  if (lower.startsWith('lyria-')) return false
  if (lower.includes('embedding')) return false
  if (lower.includes('robotics')) return false
  return true
}

function _enrichGeminiModelName(id: string, displayName: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('-tts')) return `${displayName} · TTS`
  if (lower.includes('-image')) return `${displayName} · image gen`
  if (lower.includes('-live') || lower.includes('-native-audio')) return `${displayName} · realtime audio`
  if (lower.startsWith('veo-')) return `${displayName} · video gen`
  if (lower.startsWith('lyria-')) return `${displayName} · music gen`
  if (lower.includes('embedding')) return `${displayName} · embeddings`
  if (lower.includes('robotics')) return `${displayName} · robotics`
  return displayName
}

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini'
  private apiKey: string
  private baseUrl: string
  /** OAuth token from the Gemini CLI client (flash/lite models). */
  private cliOAuthToken?: string
  /** OAuth token from the Antigravity client (pro models). */
  private antigravityOAuthToken?: string
  /** RPM limit — auto-detected from rate limit headers or env override. */
  private rpm: number

  constructor(config: ProviderConfig & {
    cliOAuthToken?: string
    antigravityOAuthToken?: string
    /** @deprecated Use cliOAuthToken / antigravityOAuthToken */
    oauthToken?: string
  }) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    this.cliOAuthToken = config.cliOAuthToken
    this.antigravityOAuthToken = config.antigravityOAuthToken
    // Backwards compat: old single oauthToken → treat as antigravity
    if (config.oauthToken && !config.antigravityOAuthToken) {
      this.antigravityOAuthToken = config.oauthToken
    }
    // Allow env override for rate limit (useful for paid tiers).
    this.rpm = parseInt(process.env.GEMINI_RPM ?? '', 10) || DEFAULT_RPM
  }

  /** True if any OAuth token is available. */
  private get hasOAuth(): boolean {
    return !!(this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /**
   * Build headers for API-key-path requests. Uses x-goog-api-key header
   * instead of URL query param — avoids key appearing in server access
   * logs, proxy caches, and browser history.
   */
  private _apiKeyHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
      'Connection': 'keep-alive',
    }
  }

  /**
   * Pick the right OAuth token for a model. Falls back to the other
   * token if the preferred one is missing (the API will reject if the
   * model isn't available on that executor — better than a client error).
   * Returns null if no OAuth tokens are stored at all.
   */
  private _tokenForModel(model: string): string | null {
    const executor = executorForModel(model)
    if (executor === 'antigravity') {
      return this.antigravityOAuthToken ?? this.cliOAuthToken ?? null
    }
    return this.cliOAuthToken ?? this.antigravityOAuthToken ?? null
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)
    const body = anthropicToGeminiRequest({ ...params, model })

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      await _throttle(this.rpm)
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken, executor)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? { ...antigravityApiHeaders(oauthToken), 'Connection': 'keep-alive' }
        : { ...geminiCLIApiHeaders(oauthToken, model), 'Connection': 'keep-alive' }

      const url = `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`
      const ac = new AbortController()
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrapped),
        signal: ac.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        this._adjustRpmFromError(response.status, response.headers)
        throw this._formatGeminiError(response.status, errText)
      }

      if (!response.body) {
        throw new Error('Gemini Code Assist returned no response body for streaming request')
      }

      const geminiChunks = parseCodeAssistSSE(response.body)
      const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
      return buildProviderStreamResult(anthropicEvents, ac)
    }

    // API key path → rate-limit, then try context caching, then call v1beta.
    if (!this.apiKey) {
      throw new Error(
        'Gemini API error 401: No credentials available.\n' +
        'Your OAuth session may have expired and no API key is configured.\n' +
        'Run /login to sign in again.',
      )
    }
    await _throttle(this.rpm)
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
    const ac = new AbortController()
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      this._adjustRpmFromError(response.status, response.headers)
      if (cacheName && this._isCacheExpiredError(response.status, errText)) {
        invalidateCache(cacheName)
        return this.stream(params)
      }
      throw this._formatGeminiError(response.status, errText)
    }

    const geminiChunks = parseGeminiSSE(response.body!)
    const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const model = this.resolveModel(params.model)
    const body = anthropicToGeminiRequest({ ...params, model })

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      await _throttle(this.rpm)
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken, executor)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? { ...antigravityApiHeaders(oauthToken), 'Connection': 'keep-alive' }
        : { ...geminiCLIApiHeaders(oauthToken, model), 'Connection': 'keep-alive' }

      const url = `${CODE_ASSIST_BASE}:generateContent`
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrapped),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        this._adjustRpmFromError(response.status, response.headers)
        throw this._formatGeminiError(response.status, errText)
      }

      const caData = await response.json()
      const data = unwrapCodeAssistResponse(caData)
      return geminiMessageToAnthropic(data, model)
    }

    // API key path → rate-limit, then try context caching, then call v1beta.
    if (!this.apiKey) {
      throw new Error(
        'Gemini API error 401: No credentials available.\n' +
        'Your OAuth session may have expired and no API key is configured.\n' +
        'Run /login to sign in again.',
      )
    }
    await _throttle(this.rpm)
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:generateContent`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      this._adjustRpmFromError(response.status, response.headers)
      if (cacheName && this._isCacheExpiredError(response.status, errText)) {
        invalidateCache(cacheName)
        return this.create(params)
      }
      throw this._formatGeminiError(response.status, errText)
    }

    const data = (await response.json()) as GeminiGenerateContentResponse
    return geminiMessageToAnthropic(data, model)
  }

  /**
   * Attempt to attach a `cachedContents/...` reference to the outgoing
   * request body. Mutates `body` in place: on a cache hit, clears
   * `systemInstruction` and `tools` and sets `cachedContent`. Returns
   * the cache name so the caller can invalidate it on 404/expired.
   *
   * API-key path only. OAuth (Code Assist) is skipped because the
   * proxy's cachedContents endpoint is not verified.
   */
  private async _applyContextCache(
    model: string,
    body: ReturnType<typeof anthropicToGeminiRequest>,
  ): Promise<string | null> {
    if (!this.apiKey) return null
    const cacheName = await getOrCreateCache({
      model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      systemInstruction: body.systemInstruction,
      tools: body.tools,
    })
    if (!cacheName) return null
    delete body.systemInstruction
    delete body.tools
    body.cachedContent = cacheName
    return cacheName
  }

  private _isCacheExpiredError(status: number, body: string): boolean {
    if (status === 404) return true
    if (status === 400 && /cached.?content/i.test(body)) return true
    return false
  }

  async listModels(): Promise<ModelInfo[]> {
    // OAuth path: return only the models the user has tokens for.
    // Code Assist doesn't expose a listModels endpoint and v1beta/models
    // rejects cloud-platform tokens (403 restricted_client).
    if (this.hasOAuth) {
      const models: ModelInfo[] = []
      if (this.cliOAuthToken) models.push(...GEMINI_CLI_MODELS)
      if (this.antigravityOAuthToken) models.push(...ANTIGRAVITY_MODELS)
      return models
    }

    // API key path — use header auth.
    const url = `${this.baseUrl}/models`
    const response = await fetch(url, {
      headers: this._apiKeyHeaders(),
    })

    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName: string; supportedGenerationMethods?: string[] }>
    }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .filter(m => _isGeminiChatModel(m.name.replace('models/', '')))
      .map(m => {
        const id = m.name.replace('models/', '')
        return {
          id,
          name: _enrichGeminiModelName(id, m.displayName || id),
        }
      })
  }

  resolveModel(claudeModel: string): string {
    if (!claudeModel.includes('claude')) return claudeModel

    const models = getProviderModelSet(this.name)
    if (claudeModel.includes('opus'))  return models.opus
    if (claudeModel.includes('haiku')) return models.haiku
    return models.sonnet
  }

  /**
   * Format Gemini API errors. All error messages include the numeric status
   * code in the format "Gemini API error NNN: ..." so the app's withRetry
   * logic (which matches /API error (\d{3})/) can detect retryable errors.
   */
  private _formatGeminiError(status: number, body: string): Error {
    let errorDetail = ''
    try {
      const parsed = JSON.parse(body)
      errorDetail = parsed?.error?.message ?? ''
    } catch {
      errorDetail = body
    }

    if (status === 400 && errorDetail.includes('Unknown name')) {
      return new Error(
        `Gemini API error ${status}: Invalid tool schema fields.\n` +
        `The tool parameter schemas contain fields not supported by Gemini.\n` +
        `This is a bug — please report it. Details: ${errorDetail.slice(0, 300)}`,
      )
    }

    if (status === 401 || status === 403) {
      return new Error(
        `Gemini API error ${status}: Authentication failed.\n` +
        `${errorDetail || 'Your API key or OAuth token may be invalid.'}\n` +
        `Run /login to reconfigure.`,
      )
    }

    if (status === 429) {
      return new Error(
        `Gemini API error ${status}: Rate limit or quota exceeded.\n` +
        `${errorDetail}\n` +
        `Current rate limit: ${this.rpm} RPM. Set GEMINI_RPM env var to adjust.\n` +
        `Wait a moment and retry, or check your quota at console.cloud.google.com.`,
      )
    }

    return new Error(`Gemini API error ${status}: ${body}`)
  }

  /**
   * Dynamically lower the RPM when we hit 429 errors. This prevents
   * hammering the API and wasting requests on retries. The RPM recovers
   * on the next provider construction (each turn creates a fresh provider).
   */
  private _adjustRpmFromError(status: number, headers: Headers): void {
    if (status === 429) {
      // Halve RPM (floor at 5) to back off aggressively.
      this.rpm = Math.max(5, Math.floor(this.rpm / 2))
    }
    // Try to learn the actual limit from response headers.
    const limitHeader = headers.get('x-ratelimit-limit-requests')
      ?? headers.get('x-ratelimit-limit')
    if (limitHeader) {
      const parsed = parseInt(limitHeader, 10)
      if (!isNaN(parsed) && parsed > 0) {
        // Use 80% of the advertised limit as our ceiling.
        this.rpm = Math.max(5, Math.floor(parsed * 0.8))
      }
    }
  }

}
