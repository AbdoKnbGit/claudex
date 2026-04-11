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
import { getProviderModelSet } from '../../../utils/model/configs.js'

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini'
  private apiKey: string
  private baseUrl: string
  private oauthToken?: string

  constructor(config: ProviderConfig & { oauthToken?: string }) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    this.oauthToken = config.oauthToken
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const model = this.resolveModel(params.model)
    const body = anthropicToGeminiRequest(params)

    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
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

    const url = `${this.baseUrl}/models/${model}:generateContent`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this._formatGeminiError(response.status, errText)
    }

    const data = (await response.json()) as GeminiGenerateContentResponse
    return geminiMessageToAnthropic(data, model)
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = this.oauthToken
      ? `${this.baseUrl}/models`
      : `${this.baseUrl}/models?key=${this.apiKey}`

    const response = await fetch(url, {
      headers: this.oauthToken
        ? { 'Authorization': `Bearer ${this.oauthToken}` }
        : {},
    })

    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName: string; supportedGenerationMethods?: string[] }>
    }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({
        id: m.name.replace('models/', ''),
        name: m.displayName,
      }))
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
        `Your API key or OAuth token may be invalid. Run /login to reconfigure.`,
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

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.oauthToken) {
      headers['Authorization'] = `Bearer ${this.oauthToken}`
    } else {
      headers['x-goog-api-key'] = this.apiKey
    }
    return headers
  }
}
