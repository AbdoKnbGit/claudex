/**
 * Build a Cursor ConnectRPC chat request body from Anthropic-IR inputs.
 *
 * Tool-output representation follows 9router's stable pattern from
 * `reference/9router-master/open-sse/translator/request/openai-to-cursor.js`:
 * tool outputs are emitted as `<tool_result>…</tool_result>` XML blocks
 * inside user messages, NOT via the protobuf tool_results field. The
 * comment in the reference spells out why — partial-schema mismatches in
 * the protobuf tool_results path have been observed to loop the model.
 *
 * Mapping summary:
 *   - System prompt → prepended as its own "[System Instructions]" user turn.
 *   - User text blocks  → joined verbatim.
 *   - User tool_result  → <tool_result> XML (with cached tool-name lookup).
 *   - Assistant text    → joined verbatim.
 *   - Assistant tool_use→ dropped (the paired user-side XML result narrates
 *                         the call context for the model implicitly).
 *   - Images            → dropped (claudex's tool stack doesn't emit them
 *                         on provider messages).
 */

import type {
  ProviderMessage,
  ProviderTool,
  ProviderContentBlock,
} from '../../services/api/providers/base_provider.js'
import {
  generateCursorBody,
  type NormalizedCursorMessage,
  type EncodeMcpToolInput,
} from './protobuf.js'

export interface BuildCursorBodyParams {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  reasoningEffort?: 'medium' | 'high' | null
}

export function buildCursorBody(params: BuildCursorBodyParams): Uint8Array {
  const { model, system, messages, tools, reasoningEffort } = params
  const encodedTools = _encodeTools(tools)
  const converted = _convertMessages(messages, system)
  return generateCursorBody(converted, model, encodedTools, reasoningEffort ?? null)
}

function _encodeTools(tools: ProviderTool[]): EncodeMcpToolInput[] {
  return tools.map(t => ({
    name: t.name,
    description: (t.description && t.description.trim()) || `Tool: ${t.name}`,
    parameters: (t.input_schema ?? {}) as Record<string, unknown>,
  }))
}

function _buildToolNameMap(messages: ProviderMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

function _convertMessages(
  messages: ProviderMessage[],
  systemText: string,
): NormalizedCursorMessage[] {
  const out: NormalizedCursorMessage[] = []
  const toolNames = _buildToolNameMap(messages)

  if (systemText) {
    out.push({ role: 'user', content: `[System Instructions]\n${systemText}` })
  }

  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'

    if (role === 'user') {
      const parts: string[] = []
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push(msg.content)
      } else {
        for (const block of msg.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            parts.push(block.text)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const name = toolNames.get(block.tool_use_id) || 'tool'
            parts.push(_buildToolResultBlock(
              name,
              block.tool_use_id,
              _stringifyToolResult(block.content),
            ))
          }
        }
      }
      const content = parts.join('\n')
      if (content) out.push({ role: 'user', content })
      continue
    }

    const texts: string[] = []
    if (typeof msg.content === 'string') {
      if (msg.content) texts.push(msg.content)
    } else {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          texts.push(block.text)
        }
      }
    }
    const content = texts.join('\n').trim()
    if (content) out.push({ role: 'assistant', content })
  }

  return out
}

function _buildToolResultBlock(name: string, id: string, result: string): string {
  const cleanResult = _sanitize(result)
  return [
    '<tool_result>',
    `<tool_name>${_escapeXml(name)}</tool_name>`,
    `<tool_call_id>${_escapeXml(id)}</tool_call_id>`,
    `<result>${_escapeXml(cleanResult)}</result>`,
    '</tool_result>',
  ].join('\n')
}

function _stringifyToolResult(
  content: string | ProviderContentBlock[] | undefined,
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block === 'object' && block) {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

function _sanitize(text: string): string {
  // Strip non-printable control chars — the Cursor backend errors on them.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function _escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
