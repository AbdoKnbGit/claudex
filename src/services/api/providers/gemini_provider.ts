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
  type SystemBlock,
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
  clearCodeAssistCache,
} from './gemini_code_assist.js'
import { getOrCreateCache, invalidateCache } from './gemini_cache.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'

// ─── Rate Limiter ───────────────────────────────────────────────────
// Simple sliding-window rate limiter. Tracks request timestamps and
// enforces a maximum RPM (requests per minute). When the limit is
// approached, inserts a short delay to spread requests evenly instead
// of bursting and getting 429'd.

// Free-tier RPM limits per model family (as of 2026-04):
//   flash-lite: 5 RPM, flash: 10 RPM, pro: 5 RPM
// OAuth (Code Assist) tier is higher — 30+ RPM.
// Default to a safe free-tier value. OAuth users get auto-upgraded
// in the constructor when we detect they have a token.
const DEFAULT_RPM_FREE = 5     // Safe for all free-tier models
const DEFAULT_RPM_OAUTH = 30   // Code Assist / Antigravity tier
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
async function _throttle(rpm: number = DEFAULT_RPM_FREE): Promise<void> {
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

/**
 * Models available via the Antigravity OAuth client (pro/premium tier).
 * These use the Antigravity quota pool with higher rate limits.
 * MUST stay in sync with ANTIGRAVITY_MODEL_SET in gemini_code_assist.ts.
 */
const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro-high',                 name: 'Gemini 3.1 Pro · high thinking' },
  { id: 'gemini-3.1-pro-low',                  name: 'Gemini 3.1 Pro · low thinking' },
  { id: 'gemini-3-pro-high',                   name: 'Gemini 3 Pro · high thinking' },
  { id: 'gemini-3-pro-low',                    name: 'Gemini 3 Pro · low thinking' },
  { id: 'gemini-3-flash',                      name: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-flash-image',              name: 'Gemini 3.1 Flash · image' },
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

// ─── Gemini Payload Optimization ─────────────────────────────────
//
// Token usage is the #1 cost driver. The full Claude Code payload
// (system prompt + 40 tools + growing history) can hit 100K+ input
// tokens per request — burning free-tier quotas in minutes.
//
// Optimization tiers:
//   Pro:        No modification. Full payload, all tools. 1M context.
//   Flash:      Trimmed system prompt, all tools, capped output.
//   Flash-Lite: Aggressive — short prompt, core tools ONLY, truncated
//               history, capped tool results. Every token counts.

const GEMINI_MAX_SYSTEM_CHARS_FLASH = 6000
const GEMINI_MAX_SYSTEM_CHARS_LITE = 3000
const GEMINI_MAX_OUTPUT_TOKENS_FLASH = 8192
const GEMINI_MAX_OUTPUT_TOKENS_LITE = 4096
const GEMINI_MAX_HISTORY_MESSAGES_LITE = 10  // Keep only last N messages for lite
const GEMINI_MAX_TOOL_RESULT_CHARS = 4000    // Cap individual tool results in history

// Core tools that lite models get — everything else is stripped.
// These are enough for basic coding tasks without burning tokens.
const CORE_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
])

// ─── System Instruction Splitter ─────────────────────────────────
// The system prompt contains a boundary marker that separates static
// content (instructions, tool descriptions, CLAUDE.md) from volatile
// per-turn content (git status, current date, working dir, env info).
//
// For caching to work, we MUST hash only the stable part. Otherwise
// the SHA-256 key changes every turn and the cache never hits.

const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// Fallback patterns for volatile content when the boundary marker
// is absent (e.g. older system prompt versions, custom prompts).
const VOLATILE_PATTERNS = [
  /# currentDate\n[^\n]+/,          // Today's date is 2026-04-13
  /gitStatus:.*?(?=\n\n|\n#|$)/s,   // Git status block
  /<env>[\s\S]*?<\/env>/,           // Environment block
  /Current branch:.*(?:\n.*){0,10}/, // Branch + recent commits
]

/**
 * Split system instruction text into stable (cacheable) and volatile
 * (per-turn) portions. Uses the SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker
 * when present, falls back to pattern matching.
 */
function splitSystemInstruction(text: string): {
  stable: string
  volatile: string
} {
  // Primary: split at the explicit boundary marker
  const idx = text.indexOf(DYNAMIC_BOUNDARY)
  if (idx !== -1) {
    const stable = text.slice(0, idx).trimEnd()
    const volatile = text.slice(idx + DYNAMIC_BOUNDARY.length).trimStart()
    return { stable, volatile }
  }

  // Fallback: extract known volatile patterns from the end of the prompt
  let volatile = ''
  let remaining = text
  for (const pattern of VOLATILE_PATTERNS) {
    const match = remaining.match(pattern)
    if (match && match.index !== undefined) {
      // Only extract if it's in the last 30% of the text (volatile content
      // is always near the end — don't strip tool descriptions mid-prompt)
      if (match.index > remaining.length * 0.7) {
        volatile += (volatile ? '\n\n' : '') + match[0]
        remaining = remaining.slice(0, match.index) + remaining.slice(match.index + match[0].length)
      }
    }
  }

  return {
    stable: remaining.trimEnd(),
    volatile: volatile.trim(),
  }
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
    // Rate limit: env override > auto-detect from auth tier > safe default.
    // OAuth users (Code Assist / Antigravity) get higher RPM than API key free tier.
    const defaultRpm = this.hasOAuth ? DEFAULT_RPM_OAUTH : DEFAULT_RPM_FREE
    this.rpm = parseInt(process.env.GEMINI_RPM ?? '', 10) || defaultRpm
  }

  /**
   * Optimize request params to control token usage.
   *
   * Antigravity (pro, flash, etc.): No modification. Full payload.
   *   These have good quota through Antigravity — don't trim.
   * Free-tier Flash:  Trimmed system prompt, capped output.
   * Free-tier Lite:   Aggressive — short prompt, core tools only,
   *                   truncated history, capped tool results.
   */
  private _optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (process.env.PROVIDER_NO_OPTIMIZE === 'true') return params
    const model = this.resolveModel(params.model)
    const lower = model.toLowerCase()

    // Antigravity models: full payload, no modification.
    // These go through the Antigravity quota pool with high rate limits.
    // Includes pro, flash, and image models on Antigravity.
    if (lower.includes('pro')) return params
    if (executorForModel(model) === 'antigravity') return params

    const isLite = lower.includes('lite')
    const maxSystemChars = isLite ? GEMINI_MAX_SYSTEM_CHARS_LITE : GEMINI_MAX_SYSTEM_CHARS_FLASH
    const maxOutputTokens = isLite ? GEMINI_MAX_OUTPUT_TOKENS_LITE : GEMINI_MAX_OUTPUT_TOKENS_FLASH

    let result: ProviderRequestParams = {
      ...params,
      system: this._trimSystem(params.system, maxSystemChars),
      max_tokens: Math.min(params.max_tokens, maxOutputTokens),
    }

    // Lite models: filter to core tools only (saves ~20K tokens)
    if (isLite && result.tools) {
      result = {
        ...result,
        tools: result.tools.filter(t => CORE_TOOL_NAMES.has(t.name)),
      }
    }

    // Lite models: truncate conversation history (saves 10-80K tokens)
    if (isLite && result.messages.length > GEMINI_MAX_HISTORY_MESSAGES_LITE) {
      result = {
        ...result,
        messages: result.messages.slice(-GEMINI_MAX_HISTORY_MESSAGES_LITE),
      }
    }

    // All flash/lite: cap tool result sizes in history
    result = {
      ...result,
      messages: this._truncateToolResults(result.messages),
    }

    return result
  }

  /** Trim system prompt to maxChars, breaking at paragraph boundaries. */
  private _trimSystem(
    system: string | SystemBlock[] | undefined,
    maxChars: number,
  ): string | SystemBlock[] | undefined {
    if (!system) return system
    const fullText = typeof system === 'string'
      ? system
      : system.map(s => s.text).join('\n\n')
    if (fullText.length <= maxChars) return system
    let cutPoint = maxChars
    const lastBreak = fullText.lastIndexOf('\n\n', cutPoint)
    if (lastBreak > maxChars * 0.7) cutPoint = lastBreak
    const trimmed = fullText.slice(0, cutPoint)
    if (typeof system === 'string') return trimmed
    return [{ type: 'text' as const, text: trimmed }]
  }

  /**
   * Truncate large tool results in conversation history.
   * A single `cat` of a big file can add 20K+ tokens to every
   * subsequent request. Cap each result to keep history lean.
   */
  private _truncateToolResults(
    messages: ProviderRequestParams['messages'],
  ): ProviderRequestParams['messages'] {
    return messages.map(msg => {
      if (typeof msg.content === 'string') return msg
      const newContent = msg.content.map(block => {
        if (block.type !== 'tool_result') return block
        const text = typeof block.content === 'string' ? block.content : ''
        if (text.length <= GEMINI_MAX_TOOL_RESULT_CHARS) return block
        return {
          ...block,
          content: text.slice(0, GEMINI_MAX_TOOL_RESULT_CHARS) +
            `\n\n[... truncated ${text.length - GEMINI_MAX_TOOL_RESULT_CHARS} chars to save tokens]`,
        }
      })
      return { ...msg, content: newContent }
    })
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
    const optimized = this._optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    this._lastModelUsed = model
    const body = anthropicToGeminiRequest({ ...optimized, model })

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

        // Auto-recover from stale project ID: if Code Assist returns 403
        // with a permission error, the cached project is invalid. Clear it
        // and retry once — the retry will re-onboard and get a fresh project.
        if (response.status === 403 && this._isStaleProjectError(errText) && this._staleRetryCount < this._maxStaleRetries) {
          this._staleRetryCount++
          clearCodeAssistCache(executor)
          return this.stream(params)
        }

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
      // Auto-retry on per-minute 429 rate limits (NOT quota exhaustion).
      // Quota exhaustion (weekly cap) should fail immediately — retrying
      // just wastes requests against a limit that won't reset for days.
      const isQuotaExhausted = /exhaust|quota will reset after \d+h/i.test(errText)
      if (response.status === 429 && !isQuotaExhausted && this._retryCount429 < 2) {
        this._retryCount429++
        const delay = this._parseRetryDelay(errText)
        if (delay > 0 && delay <= 60_000) {
          await _sleep(delay)
          return this.stream(params)
        }
      }
      this._retryCount429 = 0
      throw this._formatGeminiError(response.status, errText)
    }
    this._retryCount429 = 0

    const geminiChunks = parseGeminiSSE(response.body!)
    const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const optimized = this._optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    const body = anthropicToGeminiRequest({ ...optimized, model })

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

        // Auto-recover from stale project ID (same as streaming path).
        if (response.status === 403 && this._isStaleProjectError(errText) && this._staleRetryCount < this._maxStaleRetries) {
          this._staleRetryCount++
          clearCodeAssistCache(executor)
          return this.create(params)
        }

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
   * CRITICAL FIX: The system prompt contains volatile per-turn data
   * (git status, current date, working dir). If we hash the full
   * systemInstruction, the key changes every turn → cache NEVER hits.
   *
   * Solution: split systemInstruction at the SYSTEM_PROMPT_DYNAMIC_BOUNDARY
   * marker. Cache only the stable prefix (instructions + tool schemas).
   * Inject the volatile suffix as a user message in contents[].
   *
   * API-key path only. OAuth (Code Assist) is skipped because the
   * proxy's cachedContents endpoint is not verified.
   */
  private async _applyContextCache(
    model: string,
    body: ReturnType<typeof anthropicToGeminiRequest>,
  ): Promise<string | null> {
    if (!this.apiKey) return null
    if (!body.systemInstruction) return null

    // Split system instruction into stable (cacheable) and volatile (per-turn).
    const fullText = body.systemInstruction.parts.map(p => p.text).join('\n\n')
    const { stable, volatile } = splitSystemInstruction(fullText)

    // Only cache the stable portion — its hash is consistent across turns.
    const stableInstruction = stable
      ? { parts: [{ text: stable }] }
      : null

    const cacheName = await getOrCreateCache({
      model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      systemInstruction: stableInstruction,
      tools: body.tools,
    })
    if (!cacheName) return null

    // Cache hit: replace systemInstruction + tools with cache reference.
    delete body.systemInstruction
    delete body.tools
    body.cachedContent = cacheName

    // Inject volatile context (git status, date, env) as a leading user
    // message. Gemini doesn't allow systemInstruction + cachedContent
    // together, but leading user parts work fine for context injection.
    if (volatile) {
      body.contents.unshift({
        role: 'user',
        parts: [{ text: volatile }],
      })
    }

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
   * Detect stale Code Assist project errors. These happen when the cached
   * project ID has lost permissions or was deleted server-side. The fix is
   * to clear the cache and re-onboard.
   */
  private _isStaleProjectError(errText: string): boolean {
    return errText.includes('cloudaicompanion') ||
      errText.includes('does not have permission') ||
      errText.includes('project might not exist')
  }

  /** Guard against infinite retry loops on stale project recovery. */
  private _staleRetryCount = 0
  private _maxStaleRetries = 1

  /** Guard against infinite 429 retry loops. */
  private _retryCount429 = 0

  /** Last model used — for error messages. */
  private _lastModelUsed: string | null = null

  /** Parse retry delay from Gemini 429 error body (e.g., "retry in 16.35s"). */
  private _parseRetryDelay(body: string): number {
    const match = body.match(/retry in ([\d.]+)s/i)
    if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500 // +500ms margin
    return 20_000 // Default: 20s if we can't parse
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
      // Distinguish quota exhaustion (weekly/daily cap) from per-minute rate limit.
      // Quota exhaustion: "exhausted your capacity" / "quota will reset after Xh"
      // Rate limit: "retry in Xs" / short cooldown
      const isQuotaExhausted = /exhaust|quota will reset after \d+h/i.test(body)
      if (isQuotaExhausted) {
        const resetMatch = body.match(/reset after (\d+h\d+m\d+s|\d+h\d+m|\d+h)/i)
        const resetHint = resetMatch ? ` Resets in ${resetMatch[1]}.` : ''
        return new Error(
          `Gemini quota exhausted for ${this._lastModelUsed ?? 'this model'}.${resetHint}\n` +
          `${errorDetail}\n` +
          `This is a Google-side limit, not a ClaudeX issue. Options:\n` +
          `  - Switch to a different model via /models\n` +
          `  - Wait for quota to reset\n` +
          `  - Use a different provider via /provider`,
        )
      }
      // Per-minute rate limit — retryable
      const retryMatch = body.match(/retry in ([\d.]+)s/i)
      const retryHint = retryMatch ? `\nRetry in ~${Math.ceil(parseFloat(retryMatch[1]))}s.` : ''
      const tierHint = this.hasOAuth
        ? ''
        : '\nTip: Use /login to authenticate with Google for higher rate limits (free).'
      return new Error(
        `Gemini rate limit hit (${this.rpm} RPM).${retryHint}${tierHint}\n` +
        `${errorDetail}`,
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
