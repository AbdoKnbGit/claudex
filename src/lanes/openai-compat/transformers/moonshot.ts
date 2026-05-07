/**
 * Moonshot AI / Kimi transformer.
 *
 * Moonshot is OpenAI-compatible but rejects several OpenAI/Responses-only
 * extensions. Kimi K2 thinking models emit reasoning_content directly on
 * stream deltas, which the shared compat loop renders as thinking blocks.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatMessage, OpenAIChatRequest } from './shared_types.js'
import {
  MOONSHOT_MODELS,
  cloneMoonshotModelInfo,
  isMoonshotChatModelId,
  isMoonshotThinkingModel,
  normalizeMoonshotModelId,
  toMoonshotModelInfo,
} from '../../../utils/model/moonshotCatalog.js'

export const moonshotTransformer: Transformer = {
  id: 'moonshot',
  displayName: 'Moonshot AI',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',

  supportsStrictMode: () => false,

  staticCatalog() {
    return MOONSHOT_MODELS.map(cloneMoonshotModelInfo)
  },

  preferLiveModelCatalog() {
    return true
  },

  filterModelCatalog(models) {
    const seen = new Set<string>()
    const out = []
    for (const model of models) {
      if (!isMoonshotChatModelId(model.id) || seen.has(model.id)) continue
      seen.add(model.id)
      out.push(toMoonshotModelInfo(model))
    }
    return out.length > 0 ? out : MOONSHOT_MODELS.map(cloneMoonshotModelInfo)
  },

  clampMaxTokens(requested: number): number {
    return requested > 262_144 ? 262_144 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    body.model = normalizeMoonshotModelId(body.model)
    const bag = body as unknown as Record<string, unknown>
    delete bag.reasoning_effort
    delete bag.reasoning
    delete bag.store
    delete bag.prompt_cache_key
    delete bag.prompt_cache_retention

    if (supportsMoonshotThinkingToggle(body.model)) {
      body.thinking = { type: ctx.isReasoning ? 'enabled' : 'disabled' }
      if (!ctx.isReasoning) {
        body.messages = body.messages.map(stripMoonshotReasoningContent)
      }
    } else if (!isMoonshotThinkingModel(body.model)) {
      delete bag.thinking
      body.messages = body.messages.map(stripMoonshotReasoningContent)
    }

    return body
  },

  normalizeStreamDelta(): void {
    // Kimi reasoning models already emit reasoning_content.
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceeded model token limit',
      'request exceeded model token limit',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'kimi-k2-turbo-preview'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}

function supportsMoonshotThinkingToggle(model: string): boolean {
  const normalized = normalizeMoonshotModelId(model)
  return normalized === 'kimi-k2.5' || normalized === 'kimi-k2.6'
}

function stripMoonshotReasoningContent(message: OpenAIChatMessage): OpenAIChatMessage {
  if (message.reasoning_content === undefined) return message
  const { reasoning_content: _reasoningContent, ...rest } = message
  return rest
}
