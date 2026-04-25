/**
 * DeepSeek transformer.
 *
 * - Hard-caps `max_tokens` at 8192 (upstream 400s past that).
 * - Supports `function.strict: true` for reasoner-compatible tool calls.
 * - Emits `reasoning_content` on stream deltas — pass through as-is;
 *   loop.ts surfaces it as a thinking_delta.
 * - `thinking: { type: 'enabled' }` only when user/model requested reasoning.
 *   DeepSeek V4 defaults thinking on, so non-reasoning turns must send an
 *   explicit disabled toggle or later tool turns can 400 on missing
 *   `reasoning_content`. The V4 toggle lives in the model picker (see
 *   `utils/model/deepseekThinking.ts`); the hidden `/thinking` command
 *   does not drive V4 — picker is authoritative.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
import {
  getDeepSeekV4Thinking,
  isDeepSeekV4ThinkingModel,
} from '../../../utils/model/deepseekThinking.js'

export const deepseekTransformer: Transformer = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    const thinkingEnabled = resolveDeepSeekThinking(ctx.model, ctx.isReasoning)

    if (thinkingEnabled) {
      body.thinking = { type: 'enabled' }
      return body
    }

    body.thinking = { type: 'disabled' }
    body.messages = body.messages.map(stripDeepSeekReasoningContent)
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

function isDeepSeekReasoningModel(model: string): boolean {
  return /\bdeepseek-reasoner\b/i.test(model)
}

function resolveDeepSeekThinking(model: string, isReasoning: boolean): boolean {
  // V4 picker toggle is authoritative — the hidden /thinking command and
  // the global thinkingConfig do not drive deepseek-v4-flash / -pro.
  if (isDeepSeekV4ThinkingModel(model)) return getDeepSeekV4Thinking()
  return isReasoning || isDeepSeekReasoningModel(model)
}

function stripDeepSeekReasoningContent(message: OpenAIChatMessage): OpenAIChatMessage {
  if (message.reasoning_content === undefined) return message
  const { reasoning_content: _reasoningContent, ...rest } = message
  return rest
}

// Re-export types for the registry consumer.
export type { OpenAIChatRequest, OpenAIChatMessage }
