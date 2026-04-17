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
 * - Magistral models want a specific thinking-template injected.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'

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

    body.messages = body.messages.map(m => {
      if (m.role === 'tool') return m
      const { name: _name, ...rest } = m as OpenAIChatMessage & { name?: string }
      return rest as OpenAIChatMessage
    })

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
    if (m.includes('codestral')) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return 'mistral-small-latest'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}
