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
  private oauthToken: string | null = null

  /** Configure auth. Call this before making requests. */
  configure(opts: { apiKey?: string; oauthToken?: string }): void {
    this.apiKey = opts.apiKey ?? null
    this.oauthToken = opts.oauthToken ?? null
  }

  /** Whether any auth is configured */
  get isConfigured(): boolean {
    return !!(this.apiKey || this.oauthToken)
  }

  /**
   * Stream a generateContent request. Returns an async iterable of chunks.
   * Uses Server-Sent Events (SSE) format.
   */
  async *streamGenerateContent(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<GeminiStreamChunk> {
    const model = (request as any).model ?? 'gemini-2.5-pro'
    // Model goes in the URL, not the body
    const body = { ...request }
    delete body.model

    const url = `${AI_STUDIO_BASE}/models/${model}:streamGenerateContent?alt=sse`
    const headers = this.getHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new GeminiApiError(response.status, errText)
    }

    if (!response.body) {
      throw new GeminiApiError(0, 'No response body')
    }

    // Parse SSE stream
    const reader = response.body.getReader()
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

    const url = `${AI_STUDIO_BASE}/models/${model}:generateContent`
    const headers = this.getHeaders()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new GeminiApiError(response.status, errText)
    }

    return response.json()
  }

  /**
   * List available models.
   */
  async listModels(): Promise<ModelInfo[]> {
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
    } else if (this.oauthToken) {
      headers['Authorization'] = `Bearer ${this.oauthToken}`
    }

    return headers
  }
}

// ─── Error Type ──────────────────────────────────────────────────

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
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
    return this.status === 429 || this.status === 500 || this.status === 503
  }
}

// ─── Singleton ───────────────────────────────────────────────────

export const geminiApi = new GeminiApiClient()
