/**
 * NVIDIA NIM transformer.
 *
 * - Strips `stream_options` (NIM's validator rejects the field on
 *   some model deployments).
 * - Honors `function.strict: true`.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const nimTransformer: Transformer = {
  id: 'nim',
  displayName: 'NVIDIA NIM',
  defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    delete body.stream_options
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'token limit', 'prompt is too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // NIM's catalog varies per deployment — no reliable small model.
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
