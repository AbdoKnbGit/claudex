/**
 * Provider Shim Factory
 *
 * Returns a duck-typed object that matches the Anthropic SDK interface
 * so that claude.ts, withRetry.ts, and the full agent loop work unchanged.
 *
 * Critical call patterns from claude.ts that we must support:
 *
 *   // Streaming (line ~1822):
 *   const result = await anthropic.beta.messages
 *     .create({ ...params, stream: true }, { signal, headers })
 *     .withResponse()
 *   // result = { data: AsyncIterable<StreamEvent>, request_id, response }
 *   stream = result.data
 *   for await (const part of stream) { ... }
 *
 *   // Non-streaming (line ~864):
 *   return await anthropic.beta.messages.create(params, { signal, timeout })
 *
 * The withRetry wrapper expects getClient() → Promise<Anthropic>.
 */

import type { APIProvider } from '../../../utils/model/providers.js'
import {
  getProviderApiKey,
  getProviderBaseUrl,
  getProviderAuthMethod,
  getProviderOAuthToken,
} from '../../../utils/auth.js'
import { loadProviderKey } from '../auth/api_key_manager.js'
import type {
  BaseProvider,
  AnthropicStreamEvent,
  AnthropicMessage,
  ProviderStreamResult,
} from './base_provider.js'
import { OpenAIProvider } from './openai_provider.js'
import { GeminiProvider } from './gemini_provider.js'
import { OpenRouterProvider } from './openrouter_provider.js'
import { GroqProvider } from './groq_provider.js'
import { NimProvider } from './nim_provider.js'
import { DeepSeekProvider } from './deepseek_provider.js'
import { OllamaProvider } from './ollama_provider.js'

/**
 * Create a provider instance for the given provider type.
 * Resolves auth method (API key vs OAuth) and injects the right credentials.
 */
function createProvider(provider: APIProvider): BaseProvider {
  const authMethod = getProviderAuthMethod(provider)
  const apiKey = getProviderApiKey(provider) ?? ''
  const baseUrl = getProviderBaseUrl(provider)

  switch (provider) {
    case 'openai': {
      if (authMethod === 'oauth') {
        const oauthToken = getProviderOAuthToken('openai') ?? ''
        return new OpenAIProvider({ apiKey: oauthToken, baseUrl })
      }
      return new OpenAIProvider({ apiKey, baseUrl })
    }
    case 'gemini': {
      if (authMethod === 'oauth') {
        // Dual OAuth: load both stored tokens synchronously.
        // Async refresh already happened in client.ts pre-flight
        // (resolveProviderAuth → _getValidOAuthToken).
        const cliToken = _readStoredGeminiToken('gemini_oauth_cli')
        const antigravityToken = _readStoredGeminiToken('gemini_oauth_antigravity')
        return new GeminiProvider({
          apiKey: apiKey ?? '',
          baseUrl,
          cliOAuthToken: cliToken ?? undefined,
          antigravityOAuthToken: antigravityToken ?? undefined,
        })
      }
      return new GeminiProvider({ apiKey, baseUrl })
    }
    case 'openrouter':
      return new OpenRouterProvider({ apiKey })
    case 'groq':
      return new GroqProvider({ apiKey })
    case 'nim':
      return new NimProvider({ apiKey, baseUrl })
    case 'deepseek':
      return new DeepSeekProvider({ apiKey, baseUrl })
    case 'ollama':
      return new OllamaProvider({ apiKey, baseUrl })
    default:
      throw new Error(`Unknown third-party provider: ${provider}`)
  }
}

/**
 * Wraps a ProviderStreamResult so that it looks like an Anthropic SDK
 * `Stream<BetaRawMessageStreamEvent>`, which is what claude.ts iterates.
 */
function wrapAsAnthropicStream(
  providerStream: ProviderStreamResult,
): AsyncIterable<AnthropicStreamEvent> & { controller: AbortController } {
  const controller = new AbortController()
  const iterable = providerStream[Symbol.asyncIterator]()

  return {
    controller,
    [Symbol.asyncIterator]() {
      return iterable
    },
  }
}

/**
 * Creates a `.create()` method that returns a "thenable" matching the
 * Anthropic SDK pattern: `create(params, opts).withResponse()`.
 *
 * - If params.stream === true → returns an async iterable of stream events
 *   with `.withResponse()` returning `{ data, request_id, response }`
 * - If params.stream is falsy → returns an AnthropicMessage directly
 *   with `.withResponse()` returning `{ data, request_id, response }`
 */
function createMethod(p: BaseProvider) {
  return function create(params: Record<string, unknown>, _opts?: Record<string, unknown>) {
    const isStreaming = params.stream === true

    // Build the base promise
    const basePromise = isStreaming
      ? p.stream(params as any)
      : p.create(params as any)

    // Attach .withResponse() to the promise
    const enhanced = basePromise.then((result: any) => {
      if (isStreaming) {
        // result is a ProviderStreamResult → wrap as Anthropic Stream
        return wrapAsAnthropicStream(result as ProviderStreamResult)
      }
      // result is an AnthropicMessage
      return result
    }) as Promise<any> & {
      withResponse: () => Promise<{ data: any; request_id: string | null; response: Response | null }>
    }

    // .withResponse() wraps the result in { data, request_id, response }
    enhanced.withResponse = () => {
      return basePromise.then((result: any) => {
        if (isStreaming) {
          const stream = wrapAsAnthropicStream(result as ProviderStreamResult)
          return {
            data: stream,
            request_id: null as string | null,
            response: null as Response | null,
          }
        }
        return {
          data: result,
          request_id: null as string | null,
          response: null as Response | null,
        }
      })
    }

    return enhanced
  }
}

/**
 * Creates a duck-typed object that matches enough of the Anthropic SDK
 * interface for claude.ts, withRetry.ts, and the agent loop to use
 * transparently.
 *
 * Supports:
 *   anthropic.beta.messages.create(params).withResponse()
 *   anthropic.beta.messages.create(params)  (plain)
 *   anthropic.messages.create(params)
 *   for await (const part of stream) { ... }
 */
export function createProviderShim(provider: APIProvider): unknown {
  const p = createProvider(provider)
  const create = createMethod(p)

  return {
    beta: {
      messages: {
        create,
        stream: (params: Record<string, unknown>) =>
          p.stream({ ...params, stream: true } as any),
      },
    },
    messages: {
      create,
      stream: (params: Record<string, unknown>) =>
        p.stream({ ...params, stream: true } as any),
    },
    // Expose provider metadata for diagnostics
    _provider: p,
    _providerName: p.name,
  }
}

/**
 * Get a provider instance directly (for listModels, etc.).
 */
export function getProvider(provider: APIProvider): BaseProvider {
  return createProvider(provider)
}

/**
 * Synchronously read a stored Gemini OAuth token from provider-keys.json.
 * Returns the accessToken if stored and not expired, null otherwise.
 * No async refresh — that's handled by the client.ts pre-flight.
 */
function _readStoredGeminiToken(storageKey: string): string | null {
  try {
    const raw = loadProviderKey(storageKey)
    if (!raw) return null
    const tokens = JSON.parse(raw) as { accessToken?: string; expiresAt?: number }
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      return null  // expired
    }
    return tokens.accessToken ?? null
  } catch {
    return null
  }
}
