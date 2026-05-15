/**
 * Mistral transformer.
 *
 * - Rejects `function.strict: true` + extra top-level fields
 *   (`extra_forbidden` error) — strict mode is OFF.
 * - `tool_choice: "required"` → `"any"` (Mistral's name for the same).
 * - Strips `$id`/`$schema`/`additionalProperties`/`strict`/`format`/
 *   `examples`/`default` from tool parameter schemas.
 * - Strips `name` from non-tool messages (Mistral rejects it on
 *   system/user/assistant).
 * - Enforces Mistral's strict assistant-tool-call -> tool-result ordering
 *   on replayed history.
 * - Prompt caching uses top-level `prompt_cache_key`; Anthropic
 *   `cache_control` markers stay stripped by the shared compat loop.
 * - Magistral models want a specific thinking-template injected.
 */

import type { Transformer, TransformContext } from './base.js'
import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'

const MISTRAL_CHAT_CATALOG: readonly ModelInfo[] = [
  { id: 'devstral-latest', name: 'Devstral 2', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'devstral-medium-latest', name: 'Devstral Medium', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'devstral-small-latest', name: 'Devstral Small', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools', 'fast'] },
  { id: 'devstral-2512', name: 'Devstral 2 (25.12)', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'mistral-medium-3-5', name: 'Mistral Medium 3.5', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools', 'reasoning'] },
  { id: 'mistral-medium-latest', name: 'Mistral Medium', supportsToolCalling: true, tags: ['tools', 'reasoning'] },
  { id: 'codestral-latest', name: 'Codestral', contextWindow: 128_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'codestral-2508', name: 'Codestral (25.08)', contextWindow: 128_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'mistral-large-latest', name: 'Mistral Large 3', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'mistral-large-2512', name: 'Mistral Large 3 (25.12)', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools'] },
  { id: 'mistral-small-latest', name: 'Mistral Small 4', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools', 'reasoning', 'fast'] },
  { id: 'mistral-small-2603', name: 'Mistral Small 4 (26.03)', contextWindow: 256_000, supportsToolCalling: true, tags: ['tools', 'reasoning', 'fast'] },
]

const MAGISTRAL_SYSTEM_PREFIX = `A user will ask you to solve a task. You should first draft your thinking process (inner monologue) until you have derived the final answer. Afterwards, write a self-contained summary of your thoughts. Return your plan + answer in the chat directly — do not use tags.`

export const mistralTransformer: Transformer = {
  id: 'mistral',
  displayName: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (body.tool_choice === 'required') body.tool_choice = 'any'
    const bag = body as unknown as Record<string, unknown>
    if (ctx.sessionId) body.prompt_cache_key = ctx.sessionId
    else delete bag.prompt_cache_key

    body.messages = sanitizeMistralToolCallAdjacency(body.messages).map(m => {
      if (m.role === 'tool') return m
      const { name: _name, ...rest } = m as OpenAIChatMessage & { name?: string }
      return rest as OpenAIChatMessage
    })

    if (ctx.isReasoning && isMistralReasoningModel(body.model)) {
      body.reasoning_effort = 'high'
    }

    if (ctx.isReasoning && body.model.toLowerCase().includes('magistral')) {
      const already = body.messages.some(m => m.role === 'system'
        && typeof m.content === 'string'
        && m.content.includes('draft your thinking process'))
      if (!already) {
        body.messages = [
          { role: 'system', content: MAGISTRAL_SYSTEM_PREFIX },
          ...body.messages,
        ]
      }
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set([
      '$schema', '$id', '$ref', '$comment',
      'strict', 'additionalProperties',
      'format', 'examples', 'default',
    ])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'prompt too long', 'tokens exceeds', 'context_window']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (
      m.includes('codestral')
      || m.includes('devstral')
      || m.includes('magistral')
      || m === 'mistral-medium-3-5'
    ) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return 'mistral-small-latest'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  staticCatalog(): ModelInfo[] {
    return [...MISTRAL_CHAT_CATALOG]
  },

  filterModelCatalog(models: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
    const kept = models.filter(model => isMistralCodingCatalogModel(model.id))
    return kept.length > 0 ? kept : models
  },

  preferLiveModelCatalog(): boolean {
    return true
  },
}

type PendingToolCalls = {
  assistantIndex: number
  pendingIds: Set<string>
  answeredIds: Set<string>
  namesById: Map<string, string>
}

function finalizePendingToolCalls(messages: OpenAIChatMessage[], pending: PendingToolCalls): void {
  const assistant = messages[pending.assistantIndex]
  if (!assistant?.tool_calls?.length) return

  const seen = new Set<string>()
  const keptToolCalls = assistant.tool_calls.filter(call => {
    if (!isValidMistralToolCall(call) || !pending.answeredIds.has(call.id) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (keptToolCalls.length > 0) {
    assistant.tool_calls = keptToolCalls
  } else {
    delete assistant.tool_calls
    if (assistant.content == null) assistant.content = ''
  }
}

function dedupeToolCalls(message: OpenAIChatMessage): OpenAIChatMessage {
  if (!message.tool_calls?.length) return message

  const seen = new Set<string>()
  const toolCalls = message.tool_calls.filter(call => {
    if (!isValidMistralToolCall(call) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (toolCalls.length > 0) return { ...message, tool_calls: toolCalls }

  const next = { ...message }
  delete next.tool_calls
  if (next.content == null) next.content = ''
  return next
}

function isValidMistralToolCall(call: NonNullable<OpenAIChatMessage['tool_calls']>[number] | undefined): boolean {
  return !!(
    call?.id
    && call.function
    && typeof call.function.name === 'string'
    && call.function.name.length > 0
  )
}

function hasMistralRenderableAssistantContent(message: OpenAIChatMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.tool_calls?.some(isValidMistralToolCall)) return true
  if (typeof message.content === 'string') return message.content.trim().length > 0
  if (Array.isArray(message.content)) {
    return message.content.some(part =>
      part
      && typeof part === 'object'
      && (part.type !== 'text' || (typeof part.text === 'string' && part.text.trim().length > 0)),
    )
  }
  return false
}

function sanitizeMistralToolCallAdjacency(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let pending: PendingToolCalls | null = null

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (pending && toolCallId && pending.pendingIds.has(toolCallId)) {
        out.push({
          ...message,
          content: message.content == null ? '' : message.content,
          name: message.name ?? pending.namesById.get(toolCallId),
        })
        pending.pendingIds.delete(toolCallId)
        pending.answeredIds.add(toolCallId)
        if (pending.pendingIds.size === 0) pending = null
      }
      continue
    }

    if (pending) {
      finalizePendingToolCalls(out, pending)
      pending = null
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const assistant = dedupeToolCalls(message)
      out.push(assistant)

      if (assistant.tool_calls?.length) {
        pending = {
          assistantIndex: out.length - 1,
          pendingIds: new Set(assistant.tool_calls.map(call => call.id)),
          answeredIds: new Set<string>(),
          namesById: new Map(assistant.tool_calls.map(call => [call.id, call.function.name])),
        }
      }
      continue
    }

    out.push(message)
  }

  if (pending) finalizePendingToolCalls(out, pending)
  return out.filter(hasMistralRenderableAssistantContent)
}

function isMistralCodingCatalogModel(model: string): boolean {
  const m = model.toLowerCase()
  return m === 'devstral-latest'
    || m === 'devstral-medium-latest'
    || m === 'devstral-small-latest'
    || m === 'devstral-2512'
    || m === 'mistral-medium-3-5'
    || m === 'mistral-medium-latest'
    || m === 'codestral-latest'
    || m === 'codestral-2508'
    || m === 'mistral-large-latest'
    || m === 'mistral-large-2512'
    || m === 'mistral-small-latest'
    || m === 'mistral-small-2603'
}

function isMistralReasoningModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('magistral')
    || m.startsWith('mistral-small')
    || m === 'mistral-medium-3-5'
    || m === 'mistral-medium-latest'
}
