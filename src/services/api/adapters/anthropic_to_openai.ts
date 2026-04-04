/**
 * Outbound adapter: Converts Anthropic-format messages → OpenAI Chat Completions format.
 *
 * Used by OpenAI-compatible providers (OpenAI, OpenRouter, Groq, NVIDIA NIM).
 */

import type {
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  SystemBlock,
} from '../providers/base_provider.js'

// ─── OpenAI types (minimal, no SDK dependency) ─────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

// ─── Anthropic-field stripping ─────────────────────────────────────

/**
 * Remove Anthropic-specific fields (cache_control, citations, etc.)
 * from content blocks before sending to third-party providers.
 * These fields are not part of the OpenAI API and may cause errors
 * or leak internal implementation details (#276, #268, #258).
 */
function stripAnthropicFields(block: ProviderContentBlock): ProviderContentBlock {
  // Destructure known Anthropic-only fields and return the rest
  const { cache_control, citations, ...clean } = block as ProviderContentBlock & {
    cache_control?: unknown
    citations?: unknown
  }
  return clean
}

// ─── Message Conversion ────────────────────────────────────────────

export function anthropicMessagesToOpenAI(
  messages: ProviderMessage[],
  system?: string | SystemBlock[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  // System prompt → system message (strip cache_control from system blocks)
  if (system) {
    const systemText = typeof system === 'string'
      ? system
      : system.map(s => {
          const { cache_control, ...rest } = s as SystemBlock & { cache_control?: unknown }
          return rest.text
        }).join('\n\n')
    if (systemText) {
      result.push({ role: 'system', content: systemText })
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
      continue
    }

    // Content is an array of blocks — strip Anthropic-specific fields
    const blocks = (msg.content as ProviderContentBlock[]).map(stripAnthropicFields)

    if (msg.role === 'assistant') {
      // Check for tool_use blocks
      const textParts = blocks.filter(b => b.type === 'text')
      const toolUses = blocks.filter(b => b.type === 'tool_use')

      const openAIMsg: OpenAIMessage = { role: 'assistant' }

      if (textParts.length > 0) {
        openAIMsg.content = textParts.map(t => t.text ?? '').join('')
      } else {
        openAIMsg.content = null
      }

      if (toolUses.length > 0) {
        openAIMsg.tool_calls = toolUses.map(t => ({
          id: t.id ?? `call_${Math.random().toString(36).slice(2, 11)}`,
          type: 'function' as const,
          function: {
            name: t.name ?? '',
            arguments: JSON.stringify(t.input ?? {}),
          },
        }))
      }

      result.push(openAIMsg)
    } else {
      // User message — may contain text, tool_results, or images
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      const otherBlocks = blocks.filter(b => b.type !== 'tool_result')

      // Emit tool results as separate 'tool' role messages
      for (const tr of toolResults) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.map(c => c.text ?? '').join('')
            : ''
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id ?? '',
          content,
        })
      }

      // Emit remaining content as user message
      if (otherBlocks.length > 0) {
        const hasImages = otherBlocks.some(b => b.type === 'image')
        if (hasImages) {
          // Use OpenAI content parts format for mixed text+images
          const parts: OpenAIContentPart[] = otherBlocks.map(b => {
            if (b.type === 'image' && b.source) {
              return {
                type: 'image_url' as const,
                image_url: {
                  url: `data:${b.source.media_type};base64,${b.source.data}`,
                },
              }
            }
            return { type: 'text' as const, text: b.text ?? '' }
          })
          result.push({ role: 'user', content: parts })
        } else {
          const text = otherBlocks.map(b => b.text ?? '').join('')
          if (text) {
            result.push({ role: 'user', content: text })
          }
        }
      }
    }
  }

  return result
}

/**
 * Coalesce consecutive same-role messages for strict models (e.g. o1-series)
 * that require strictly alternating user/assistant roles.
 * Merges consecutive messages with the same role by joining their text content.
 */
export function coalesceConsecutiveMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= 1) return messages

  const result: OpenAIMessage[] = [messages[0]!]

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]!
    const prev = result[result.length - 1]!

    // Only coalesce if same role AND neither has tool_calls/tool_call_id
    if (
      current.role === prev.role &&
      !current.tool_calls && !prev.tool_calls &&
      !current.tool_call_id && !prev.tool_call_id
    ) {
      // Merge text content
      const prevText = typeof prev.content === 'string' ? prev.content : ''
      const currText = typeof current.content === 'string' ? current.content : ''
      prev.content = [prevText, currText].filter(Boolean).join('\n\n')
    } else {
      result.push(current)
    }
  }

  return result
}

// ─── Tool Conversion ───────────────────────────────────────────────

export function anthropicToolsToOpenAI(tools: ProviderTool[]): OpenAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}
