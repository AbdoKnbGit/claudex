/**
 * Ollama transformer.
 *
 * - Local / self-hosted; no API key is typically required.
 * - Strips `stream_options` (Ollama's OpenAI-compat layer doesn't
 *   implement include_usage reliably).
 * - Strict mode supported on newer builds; stripped from schemas
 *   to stay compatible with older local installations.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const ollamaTransformer: Transformer = {
  id: 'ollama',
  displayName: 'Ollama (local)',
  defaultBaseUrl: 'http://localhost:11434/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    delete body.stream_options
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'prompt is too long', 'too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    // Local models (Llama, Qwen-local, etc.) typically handle
    // SEARCH/REPLACE better than apply_patch.
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // No universal fast model; users typically run one model locally.
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
