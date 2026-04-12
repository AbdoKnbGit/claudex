/**
 * Google Gemini native REST provider.
 *
 * Uses the Gemini REST API directly (no SDK dependency).
 * Supports both API key auth (x-goog-api-key) and OAuth Bearer token.
 *
 * Endpoints:
 *   Streaming:     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   Non-streaming: POST /v1beta/models/{model}:generateContent
 *   Model list:    GET  /v1beta/models?key={key}
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
  { id: 'gemini-3.1-pro-preview',              name: 'Gemini 3.1 Pro (preview)' },
  { id: 'gemini-3-pro-preview',                name: 'Gemini 3 Pro (preview)' },
  { id: 'gemini-3.1-pro-preview-customtools',  name: 'Gemini 3.1 Pro · custom tools (preview)' },
  { id: 'gemini-3-flash-preview',              name: 'Gemini 3 Flash (preview)' },
  { id: 'gemini-3.1-flash-lite-preview',       name: 'Gemini 3.1 Flash Lite (preview)' },
  { id: 'gemini-3.1-flash-image-preview',      name: 'Gemini 3.1 Flash · image gen (preview)' },
  { id: 'gemini-3-pro-image-preview',          name: 'Gemini 3 Pro · image gen (preview)' },
  { id: 'gemini-2.5-pro',                      name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash',                    name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite',               name: 'Gemini 2.5 Flash Lite' },
]

/** Models available via the Antigravity OAuth client (pro tier). */
const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro-high',                 name: 'Gemini 3.1 Pro · high thinking' },
  { id: 'gemini-3.1-pro-low',                  name: 'Gemini 3.1 Pro · low thinking' },
  { id: 'gemini-3-pro-high',                   name: 'Gemini 3 Pro · high thinking' },
  { id: 'gemini-3-pro-low',                    name: 'Gemini 3 Pro · low thinking' },
  { id: 'gemini-3-flash',                      name: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-flash-image',              name: 'Gemini 3.1 Flash · image gen' },
]

/**
 * Generative models that live on v1beta/models but are NOT chat-completion
 * capable — image/audio/TTS/video/embedding. The API-key path will surface
 * them with a descriptive suffix so users can tell at a glance they are not
 * candidates for general chat turns. OAuth users never see them because
 * Code Assist does not proxy these endpoints.
 */
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
  }

  /** True if any OAuth token is available. */
  private get hasOAuth(): boolean {
    return !!(this.cliOAuthToken || this.antigravityOAuthToken)
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
    const body = anthropicToGeminiRequest(params)

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? antigravityApiHeaders(oauthToken)
        : geminiCLIApiHeaders(oauthToken, model)

      const url = `${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrapped),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw this._formatGeminiError(response.status, errText)
      }

      if (!response.body) {
        throw new Error('Gemini Code Assist returned no response body for streaming request')
      }

      const geminiChunks = parseCodeAssistSSE(response.body)
      const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
      return buildProviderStreamResult(anthropicEvents)
    }

    // API key path → try to use context caching, then call v1beta.
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      if (cacheName && this._isCacheExpiredError(response.status, errText)) {
        invalidateCache(cacheName)
        return this.stream(params)
      }
      throw this._formatGeminiError(response.status, errText)
    }

    if (!response.body) {
      throw new Error('Gemini returned no response body for streaming request')
    }

    const geminiChunks = parseGeminiSSE(response.body)
    const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
    return buildProviderStreamResult(anthropicEvents)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const model = this.resolveModel(params.model)
    const body = anthropicToGeminiRequest(params)

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? antigravityApiHeaders(oauthToken)
        : geminiCLIApiHeaders(oauthToken, model)

      const url = `${CODE_ASSIST_BASE}:generateContent`
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wrapped),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw this._formatGeminiError(response.status, errText)
      }

      const caData = await response.json()
      const data = unwrapCodeAssistResponse(caData)
      return geminiMessageToAnthropic(data, model)
    }

    // API key path → try to use context caching, then call v1beta.
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:generateContent`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
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

    // API key path — v1beta/models is fine here.
    const url = `${this.baseUrl}/models?key=${this.apiKey}`
    const response = await fetch(url)

    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName: string; supportedGenerationMethods?: string[] }>
    }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
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
        `Gemini API error: Invalid tool schema fields.\n` +
        `The tool parameter schemas contain fields not supported by Gemini.\n` +
        `This is a bug — please report it. Details: ${errorDetail.slice(0, 300)}`,
      )
    }

    if (status === 401 || status === 403) {
      return new Error(
        `Gemini API error: Authentication failed.\n` +
        `Your API key or OAuth token may be invalid. Run /provider to reconfigure.`,
      )
    }

    if (status === 429) {
      return new Error(
        `Gemini API error: Rate limit or quota exceeded.\n` +
        `${errorDetail}\n` +
        `Wait a moment and retry, or check your quota at console.cloud.google.com.`,
      )
    }

    return new Error(`Gemini API error ${status}: ${body}`)
  }

  /** Headers for the API-key path (v1beta direct). */
  private _apiKeyHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
    }
  }
}
