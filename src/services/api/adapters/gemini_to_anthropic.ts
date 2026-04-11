/**
 * Inbound adapter: Converts Google Gemini streaming responses → Anthropic format.
 *
 * Gemini streams newline-delimited JSON via SSE when using ?alt=sse.
 * Each chunk contains candidates[].content.parts[] with text or functionCall.
 *
 * Emits the standard Anthropic event sequence:
 *   message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
 */

import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicContentBlock,
} from '../providers/base_provider.js'

// ─── Gemini response types ─────────────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        functionCall?: { name: string; args: Record<string, unknown> }
      }>
    }
    finishReason?: string
    safetyRatings?: Array<{ category: string; probability: string }>
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    /**
     * Subset of `promptTokenCount` that was served from a cached content
     * reference. Present when the request included `cachedContent: "..."`
     * and Gemini 2.5+ cache was hit. We fold this into Anthropic's
     * `cache_read_input_tokens` for accounting parity.
     */
    cachedContentTokenCount?: number
  }
  modelVersion?: string
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        functionCall?: { name: string; args: Record<string, unknown> }
      }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
}

// ─── Non-Streaming Conversion ──────────────────────────────────────

export function geminiMessageToAnthropic(
  response: GeminiGenerateContentResponse,
  model: string,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []
  const candidate = response.candidates?.[0]

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        content.push({ type: 'text', text: part.text })
      }
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        })
      }
    }
  }

  const finishReason = candidate?.finishReason
  const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens'
    : content.some(c => c.type === 'tool_use') ? 'tool_use'
    : 'end_turn'

  const cachedTokens = response.usageMetadata?.cachedContentTokenCount
  return {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason as AnthropicMessage['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      // Gemini's `cachedContentTokenCount` is the subset of prompt tokens
      // served from a `cachedContents/...` reference — maps cleanly onto
      // Anthropic's cache_read accounting. cache_creation is always 0
      // from our side because cache creation happens in a separate
      // request, not as a side effect of generateContent.
      ...(cachedTokens !== undefined && cachedTokens > 0
        ? {
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0,
          }
        : {}),
    },
  }
}

// ─── Streaming Conversion ──────────────────────────────────────────

export async function* geminiStreamToAnthropicEvents(
  geminiStream: AsyncIterable<GeminiStreamChunk>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  let messageStarted = false
  let blockIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  // Track open blocks for proper closing
  let textBlockOpen = false
  const openToolBlocks: Set<number> = new Set()

  for await (const chunk of geminiStream) {
    // Update usage
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
      if (chunk.usageMetadata.cachedContentTokenCount !== undefined) {
        cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount
      }
    }

    const candidate = chunk.candidates?.[0]
    if (!candidate?.content?.parts) {
      // Check for finish without content
      if (candidate?.finishReason) {
        // Will be handled below
      } else {
        continue
      }
    }

    // Emit message_start on first meaningful chunk
    if (!messageStarted) {
      messageStarted = true
      yield {
        type: 'message_start',
        message: {
          id: `msg_gemini_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            ...(cacheReadTokens > 0
              ? {
                  cache_read_input_tokens: cacheReadTokens,
                  cache_creation_input_tokens: 0,
                }
              : {}),
          },
        },
      }
    }

    // Process parts
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text !== undefined) {
          if (!textBlockOpen) {
            textBlockOpen = true
            yield {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            }
          }
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: part.text },
          }
        }

        if (part.functionCall) {
          // Close text block first if open
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: blockIndex }
            blockIndex++
            textBlockOpen = false
          }

          const toolId = `toolu_${Math.random().toString(36).slice(2, 14)}`
          const currentIndex = blockIndex++

          // Emit tool_use block as a single start + delta + stop
          yield {
            type: 'content_block_start',
            index: currentIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: part.functionCall.name,
              input: {},
            },
          }

          // Emit the full args as a single JSON delta
          const argsJson = JSON.stringify(part.functionCall.args ?? {})
          yield {
            type: 'content_block_delta',
            index: currentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argsJson,
            },
          }

          yield { type: 'content_block_stop', index: currentIndex }
        }
      }
    }

    // Handle finish reason
    if (candidate?.finishReason) {
      // Close any open text block
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: blockIndex }
        textBlockOpen = false
      }

      const finishReason = candidate.finishReason
      const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens'
        : finishReason === 'SAFETY' ? 'end_turn'
        : 'end_turn'

      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }

      yield { type: 'message_stop' }
      return
    }
  }

  // Safety: close gracefully if stream ended without finishReason
  if (messageStarted) {
    if (textBlockOpen) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }
  }
}

// ─── SSE Parser for Gemini streams ─────────────────────────────────

/**
 * Parse a Gemini SSE stream (ReadableStream<Uint8Array>) into
 * an async iterable of GeminiStreamChunk objects.
 */
export async function* parseGeminiSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GeminiStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE format: "data: {json}\n\n"
      const lines = buffer.split('\n')
      buffer = ''

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim()

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6)
          if (jsonStr === '[DONE]') return

          try {
            const chunk = JSON.parse(jsonStr) as GeminiStreamChunk
            yield chunk
          } catch {
            // Incomplete JSON — push back to buffer
            buffer = lines.slice(i).join('\n')
            break
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
