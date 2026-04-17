/**
 * OpenRouter transformer.
 *
 * - Injects `HTTP-Referer` + `X-Title` headers so OpenRouter's
 *   analytics credit ClaudeX.
 * - cache_control is PASSED THROUGH for Anthropic/Gemini models (they
 *   natively support it); stripped for everything else so OpenRouter
 *   doesn't surface it as an unknown-field warning.
 * - Accepts `reasoning: { effort }` for reasoning-capable upstreams.
 * - Honors `function.strict: true` for the underlying model.
 * - `transforms`/`route`/`models` are OpenRouter-specific fields that
 *   pass through as-is.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const openrouterTransformer: Transformer = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested
  },

  buildHeaders(_apiKey: string): Record<string, string> {
    return {
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/claudex',
      'X-Title': 'ClaudeX',
    }
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.isReasoning && ctx.reasoningEffort) {
      body.reasoning = { effort: ctx.reasoningEffort }
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    // Frontier models routed via OpenRouter: keep apply_patch.
    if (m.includes('anthropic/') || m.includes('claude-')) return 'apply_patch'
    if (m.includes('openai/gpt-5') || m.includes('openai/o1') || m.includes('openai/o3')) return 'apply_patch'
    if (m.includes('google/gemini-3') || m.includes('google/gemini-2.5')) return 'apply_patch'
    // Everything else on OpenRouter → SEARCH/REPLACE (safer for non-frontier).
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    const m = model.toLowerCase()
    if (m.startsWith('anthropic/')) return 'anthropic/claude-haiku-4-5'
    if (m.startsWith('openai/')) return 'openai/gpt-4o-mini'
    if (m.startsWith('google/')) return 'google/gemini-2.5-flash-lite'
    if (m.startsWith('meta-llama/') || m.startsWith('meta/')) return 'meta-llama/llama-3.3-8b-instruct'
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    // OpenRouter enforces Anthropic's 4-breakpoint cap by relocating
    // cache_control to the last text block. For other underlying
    // providers the field is silently ignored.
    const m = model.toLowerCase()
    if (m.includes('anthropic/') || m.includes('claude-')) return 'last-only'
    if (m.includes('google/gemini')) return 'last-only'
    return 'none'
  },
}
