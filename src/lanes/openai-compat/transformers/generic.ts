/**
 * Generic OpenAI-compatible transformer.
 *
 * Fallback for xAI, Together, Fireworks, DeepInfra, Cerebras, and
 * anything else that speaks OpenAI Chat Completions without a
 * claudex-specific transformer. Conservative defaults that work
 * across the long tail; users can point `baseUrl` at any such
 * endpoint and get a working lane entry.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const genericTransformer: Transformer = {
  id: 'generic',
  displayName: 'OpenAI-compatible (generic)',
  defaultBaseUrl: 'https://api.openai.com/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    return body
  },

  schemaDropList(): Set<string> {
    // Conservative drop list — pattern + format + default can trip
    // stricter validators on long-tail providers.
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'pattern', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'token limit', 'too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
