/**
 * Qwen API client — OpenAI Chat Completions shape, dual auth paths.
 *
 * Auth:
 *   - OAuth via QwenTokenManager (account-specific resource_url)
 *   - API key via DashScope compatible-mode endpoint
 *
 * Both endpoints speak OpenAI's /v1/chat/completions wire format; the
 * tool surface Qwen was post-trained on is OpenAI function-calling.
 * Reference: reference/qwen-code-main/packages/core/src/qwen/qwenContentGenerator.ts
 */

import { getQwenTokenManager } from './token_manager.js'
import { QwenCredentialsExpiredError } from './oauth.js'

// Duplicated from services/api/errors.ts to avoid pulling the rest of
// that module into the test runtime (errors.ts transitively imports
// utils/messages.ts which has build-time-only module resolution).
const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

// DashScope compatible-mode base URL (OpenAI-shape proxy over Qwen).
const DASHSCOPE_DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export type QwenAuth =
  | { kind: 'oauth' }                            // uses token_manager
  | { kind: 'api_key'; apiKey: string; baseUrl?: string }

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface QwenTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    /**
     * Server-side schema enforcement — the OpenAI Chat Completions
     * analogue of Gemini's VALIDATED mode. DashScope honors it for
     * reasoning + function-capable Qwen families; upstream models that
     * don't support it ignore the field rather than error, so it's
     * always safe to include.
     */
    strict?: boolean
  }
}

export interface QwenChatRequest {
  model: string
  messages: QwenChatMessage[]
  stream: boolean
  stream_options?: { include_usage?: boolean }
  tools?: QwenTool[]
  tool_choice?: 'auto' | 'required' | 'none'
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
}

export interface QwenStreamChunk {
  id?: string
  choices?: Array<{
    index: number
    delta?: {
      content?: string
      role?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

// ─── Error ───────────────────────────────────────────────────────

export class QwenApiError extends Error {
  readonly isPromptTooLong: boolean

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    const ptl = /prompt is too long|context length|token limit/i.test(body)
    const head = ptl
      ? `${PROMPT_TOO_LONG_ERROR_MESSAGE} (Qwen ${status})`
      : `Qwen API error ${status}`
    super(`${head}: ${body.slice(0, 200)}`)
    this.name = 'QwenApiError'
    this.isPromptTooLong = ptl
  }

  get isRetryable(): boolean {
    if (this.status === 400) return false
    return this.status === 429 || this.status === 499 || (this.status >= 500 && this.status < 600)
  }
}

// ─── Client ──────────────────────────────────────────────────────

export class QwenApiClient {
  private auth: QwenAuth = { kind: 'oauth' }

  configure(auth: QwenAuth): void {
    this.auth = auth
  }

  /** Has valid credentials available. */
  async isConfigured(): Promise<boolean> {
    if (this.auth.kind === 'api_key') return !!this.auth.apiKey
    return await getQwenTokenManager().hasCredentials()
  }

  async *streamChat(
    request: QwenChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<QwenStreamChunk> {
    const { url, headers } = await this.resolveTarget()
    const resp = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
      signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
      throw new QwenApiError(resp.status, text, retryAfterMs)
    }
    if (!resp.body) throw new QwenApiError(0, 'No response body')

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') return
            continue
          }
          try {
            yield JSON.parse(data) as QwenStreamChunk
          } catch {
            // skip malformed chunk
          }
        }
      }
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim()
        if (data && data !== '[DONE]') {
          try {
            yield JSON.parse(data) as QwenStreamChunk
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** Resolve target URL + headers per current auth mode. */
  private async resolveTarget(): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.auth.kind === 'api_key') {
      return {
        url: this.auth.baseUrl ?? DASHSCOPE_DEFAULT_BASE,
        headers: { Authorization: `Bearer ${this.auth.apiKey}` },
      }
    }
    // OAuth path
    const mgr = getQwenTokenManager()
    const creds = await mgr.getCredentials().catch(e => {
      if (e instanceof QwenCredentialsExpiredError) throw e
      throw e
    })
    // resource_url from the token is the authoritative API endpoint
    // for this account — fall back to DashScope default when absent.
    const base = creds.resource_url
      ? normalizeBase(creds.resource_url)
      : DASHSCOPE_DEFAULT_BASE
    return {
      url: base,
      headers: { Authorization: `Bearer ${creds.access_token}` },
    }
  }
}

function normalizeBase(url: string): string {
  let u = url.trim()
  if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u
  if (u.endsWith('/')) u = u.slice(0, -1)
  if (!u.endsWith('/v1')) u += '/v1'
  return u
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const asSec = Number(v)
  if (!isNaN(asSec)) return Math.max(0, asSec * 1000)
  const asDate = Date.parse(v)
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

// ─── Singleton ──────────────────────────────────────────────────

export const qwenApi = new QwenApiClient()
