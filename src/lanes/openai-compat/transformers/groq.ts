/**
 * Groq transformer.
 *
 * - Strips cache_control from messages (Groq validator rejects).
 * - Strips `$schema`/`strict`/`additionalProperties` from tool params.
 * - Strips null `function_call` fields from assistant messages.
 * - Accepts `reasoning_effort` on reasoning-capable models.
 * - Emits `reasoning` on delta — normalize to `reasoning_content`.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'

export const groqTransformer: Transformer = {
  id: 'groq',
  displayName: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.isReasoning && ctx.reasoningEffort) {
      body.reasoning_effort = ctx.reasoningEffort
    }
    // Strip null tool_calls field that Groq's validator rejects.
    body.messages = body.messages.map(m => {
      const tc = (m as { tool_calls?: unknown }).tool_calls
      if (tc === null) {
        const { tool_calls: _tool_calls, ...rest } = m as OpenAIChatMessage & { tool_calls?: unknown }
        return rest as OpenAIChatMessage
      }
      return m
    })
    return body
  },

  normalizeStreamDelta(delta, _finishReason): void {
    // Groq uses `reasoning` where most providers use `reasoning_content`.
    const d = delta as { reasoning?: string; reasoning_content?: string }
    if (typeof d.reasoning === 'string' && !d.reasoning_content) {
      d.reasoning_content = d.reasoning
    }
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties'])
  },

  contextExceededMarkers(): string[] {
    return ['context_length_exceeded', 'prompt is too long', 'too many tokens', 'context window']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    // Llama-3.3+ and Kimi K2 handle edit_block reasonably.
    if (m.includes('llama') || m.includes('kimi')) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return 'llama-3.1-8b-instant'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
