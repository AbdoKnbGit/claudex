/**
 * DeepSeek transformer.
 *
 * - Hard-caps `max_tokens` at 8192 (upstream 400s past that).
 * - Supports `function.strict: true` for reasoner-compatible tool calls.
 * - Emits `reasoning_content` on stream deltas — pass through as-is;
 *   loop.ts surfaces it as a thinking_delta.
 * - `thinking: { type: 'enabled' }` when user requested reasoning.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'

export const deepseekTransformer: Transformer = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.isReasoning) {
      body.thinking = { type: 'enabled' }
    }
    return body
  },

  normalizeStreamDelta(_delta, _finishReason): void {
    // DeepSeek already emits reasoning_content; nothing to rename.
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'too long']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    // DeepSeek-Coder was trained heavily on Aider-style SEARCH/REPLACE.
    const m = model.toLowerCase()
    if (m.includes('coder')) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return 'deepseek-chat'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // DeepSeek's OpenAI-compat endpoint doesn't honor Anthropic-style
    // cache_control; strip rather than let it 400 on unknown fields.
    return 'none'
  },
}

// Re-export types for the registry consumer.
export type { OpenAIChatRequest, OpenAIChatMessage }
