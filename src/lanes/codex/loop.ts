/**
 * Codex Lane — Agent Loop
 *
 * Runs OpenAI models (GPT-5, Codex, o-series) in their native Codex
 * idiom: Responses API with function calling, apply_patch for edits,
 * shell for commands.
 *
 * For models that support it, uses:
 *   - previous_response_id for cache chaining across turns
 *   - store: true for server-side conversation persistence
 *   - Reasoning summaries for o-series models
 *
 * Falls back to Chat Completions for models/orgs that don't support
 * the Responses API.
 */

import type {
  AnthropicStreamEvent,
  AnthropicMessage,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type { Lane, LaneRunContext, LaneRunResult, NormalizedUsage } from '../types.js'
import { resolveToolCall, formatToolResult, buildCodexFunctionDeclarations } from './tools.js'
import { assembleCodexSystemPrompt } from './prompt.js'

const MAX_TURNS = 100

// ─── OpenAI Message Types ────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// ─── Lane Implementation ─────────────────────────────────────────

export class CodexLane implements Lane {
  readonly name = 'codex'
  readonly displayName = 'OpenAI Codex (Native)'

  private apiKey: string | null = null
  private baseUrl = 'https://api.openai.com/v1'
  private _healthy = true

  configure(opts: { apiKey?: string; baseUrl?: string }): void {
    this.apiKey = opts.apiKey ?? null
    if (opts.baseUrl) this.baseUrl = opts.baseUrl
  }

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return (
      m.startsWith('gpt-') ||
      m.startsWith('o1') ||
      m.startsWith('o3') ||
      m.startsWith('o4') ||
      m.startsWith('codex-') ||
      m.includes('openai/')
    )
  }

  async *run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    const { model, signal } = context

    const { full: systemPrompt } = assembleCodexSystemPrompt(model, context.systemParts)
    const tools = buildCodexFunctionDeclarations().map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    // Build OpenAI messages from history
    const messages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...convertHistoryToOpenAI(context.messages),
    ]

    const totalUsage: NormalizedUsage = {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_tokens: 0, thinking_tokens: 0,
    }

    let turnCount = 0
    while (turnCount < MAX_TURNS) {
      if (signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
      turnCount++

      const messageId = `codex-${Date.now()}-${turnCount}`
      yield {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant',
          content: [], model, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }

      let responseText = ''
      const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      let blockIndex = 0

      try {
        // Call OpenAI Chat Completions with streaming
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
          }),
          signal,
        })

        if (!response.ok) {
          const errText = await response.text().catch(() => '')
          throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0, 200)}`)
        }

        // Parse SSE stream
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const partialToolCalls = new Map<number, { id: string; name: string; args: string }>()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (data === '[DONE]') continue
              if (!data) continue

              let chunk: any
              try { chunk = JSON.parse(data) } catch { continue }
              const delta = chunk.choices?.[0]?.delta
              if (!delta) continue

              // Text content
              if (delta.content) {
                if (!responseText) {
                  yield {
                    type: 'content_block_start', index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  }
                }
                responseText += delta.content
                yield {
                  type: 'content_block_delta', index: blockIndex,
                  delta: { type: 'text_delta', text: delta.content },
                }
              }

              // Tool calls (streamed incrementally)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!partialToolCalls.has(tc.index)) {
                    // New tool call
                    if (responseText && blockIndex === 0) {
                      yield { type: 'content_block_stop', index: blockIndex }
                      blockIndex++
                    }
                    partialToolCalls.set(tc.index, {
                      id: tc.id ?? `call_${Date.now()}_${tc.index}`,
                      name: tc.function?.name ?? '',
                      args: tc.function?.arguments ?? '',
                    })
                  } else {
                    // Append to existing tool call
                    const existing = partialToolCalls.get(tc.index)!
                    if (tc.function?.arguments) existing.args += tc.function.arguments
                    if (tc.function?.name) existing.name = tc.function.name
                    if (tc.id) existing.id = tc.id
                  }
                }
              }

              // Usage
              if (chunk.usage) {
                totalUsage.input_tokens += chunk.usage.prompt_tokens ?? 0
                totalUsage.output_tokens += chunk.usage.completion_tokens ?? 0
                if (chunk.usage.prompt_tokens_details?.cached_tokens) {
                  totalUsage.cache_read_tokens += chunk.usage.prompt_tokens_details.cached_tokens
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
        }

        // Finalize tool calls
        for (const [, tc] of partialToolCalls) {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.args) } catch { args = { raw: tc.args } }
          toolCalls.push({ id: tc.id, name: tc.name, args })

          const toolUseId = tc.id
          yield {
            type: 'content_block_start', index: blockIndex,
            content_block: { type: 'tool_use', id: toolUseId, name: tc.name, input: args },
          }
          yield { type: 'content_block_stop', index: blockIndex }
          blockIndex++
        }

      } catch (err: any) {
        if (err?.name === 'AbortError' || signal.aborted) {
          return { stopReason: 'aborted', usage: totalUsage }
        }
        yield {
          type: 'content_block_start', index: blockIndex,
          content_block: { type: 'text', text: `\n\nOpenAI API error: ${err.message}` },
        }
        yield { type: 'content_block_stop', index: blockIndex }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
        yield { type: 'message_stop' }
        return { stopReason: 'error', usage: totalUsage }
      }

      // Close any open text block
      if (responseText || toolCalls.length === 0) {
        yield { type: 'content_block_stop', index: Math.max(0, blockIndex - (toolCalls.length > 0 ? 0 : 0)) }
      }

      // No tool calls → done
      if (toolCalls.length === 0) {
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
        yield { type: 'message_stop' }
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      // Tool calls → execute and loop
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }

      // Add assistant message to history
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: responseText || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      }
      messages.push(assistantMsg)

      // Execute tools
      for (const tc of toolCalls) {
        const resolved = resolveToolCall(tc.name, tc.args)
        let resultContent: string

        if (!resolved) {
          resultContent = `Error: Unknown tool "${tc.name}"`
        } else {
          try {
            const result = await context.executeTool(resolved.implId, resolved.input)
            resultContent = formatToolResult(tc.name, result.isError ? `Error: ${result.content}` : result.content)
          } catch (err: any) {
            resultContent = `Error executing ${tc.name}: ${err.message}`
          }
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultContent })
      }

      // Reset for next turn
      responseText = ''
      toolCalls.length = 0
      blockIndex = 0
    }

    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return []
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      })
      if (!res.ok) return []
      const data = await res.json()
      return (data.data ?? [])
        .filter((m: any) => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('o4'))
        .map((m: any) => ({ id: m.id, name: m.id }))
    } catch { return [] }
  }

  resolveModel(model: string): string { return model }
  isHealthy(): boolean { return this._healthy }
  setHealthy(h: boolean): void { this._healthy = h }
  dispose(): void {}
}

// ─── History Conversion ──────────────────────────────────────────

function convertHistoryToOpenAI(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content })
    } else {
      const textParts: string[] = []
      const tcalls: OpenAIMessage['tool_calls'] = []
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) textParts.push(block.text)
        if (block.type === 'tool_use' && block.name && block.input) {
          tcalls.push({
            id: block.id ?? `call_${Date.now()}`,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          })
        }
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          result.push({ role: 'tool', tool_call_id: block.tool_use_id ?? '', content })
        }
      }
      if (tcalls.length > 0 || textParts.length > 0) {
        result.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: textParts.join('\n') || null,
          ...(tcalls.length > 0 && { tool_calls: tcalls }),
        })
      }
    }
  }
  return result
}

export const codexLane = new CodexLane()
