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
import { storeThoughtSignature } from './gemini_thought_cache.js'

// ─── Gemini response types ─────────────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: { name: string; args: Record<string, unknown> }
        thoughtSignature?: string
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
        thought?: boolean
        functionCall?: { name: string; args: Record<string, unknown> }
        thoughtSignature?: string
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
        if (part.thought) {
          content.push({ type: 'thinking', thinking: part.text })
        } else {
          content.push({ type: 'text', text: part.text })
        }
      }
      if (part.functionCall) {
        const toolId = `toolu_${Math.random().toString(36).slice(2, 14)}`
        const block: AnthropicContentBlock = {
          type: 'tool_use',
          id: toolId,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        }
        if (part.thoughtSignature) {
          block._gemini_thought_signature = part.thoughtSignature
          storeThoughtSignature(toolId, part.thoughtSignature)
        }
        content.push(block)
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
  let thinkingBlockOpen = false
  let hasToolUse = false
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
            input_tokens: inputTokens,
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
          if (part.thought) {
            // Thinking text — close regular text block if open
            if (textBlockOpen) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              textBlockOpen = false
            }
            if (!thinkingBlockOpen) {
              thinkingBlockOpen = true
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            }
          } else {
            // Regular text — close thinking block if open
            if (thinkingBlockOpen) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              thinkingBlockOpen = false
            }
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
        }

        if (part.functionCall) {
          // Close thinking block first if open
          if (thinkingBlockOpen) {
            yield { type: 'content_block_stop', index: blockIndex }
            blockIndex++
            thinkingBlockOpen = false
          }
          // Close text block if open
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: blockIndex }
            blockIndex++
            textBlockOpen = false
          }

          hasToolUse = true
          const toolId = `toolu_${Math.random().toString(36).slice(2, 14)}`
          const currentIndex = blockIndex++

          // Preserve thought_signature for thinking-model round-trip
          const contentBlock: AnthropicContentBlock = {
            type: 'tool_use',
            id: toolId,
            name: part.functionCall.name,
            input: {},
          }
          if (part.thoughtSignature) {
            contentBlock._gemini_thought_signature = part.thoughtSignature
            storeThoughtSignature(toolId, part.thoughtSignature)
          }

          yield {
            type: 'content_block_start',
            index: currentIndex,
            content_block: contentBlock,
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
      // Close any open thinking block
      if (thinkingBlockOpen) {
        yield { type: 'content_block_stop', index: blockIndex }
        thinkingBlockOpen = false
      }
      // Close any open text block
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: blockIndex }
        textBlockOpen = false
      }

      const finishReason = candidate.finishReason
      const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens'
        : hasToolUse ? 'tool_use'
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
    if (thinkingBlockOpen) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    if (textBlockOpen) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }
  }
}

// ─── SSE Parser for Gemini streams ─────────────────────────────────

/**
 * Parse a Gemini SSE stream (ReadableStream<Uint8Array>) into
 * an async iterable of GeminiStreamChunk objects.
 *
 * SSE events are delimited by double newlines. Each event is a
 * "data: {json}" line. JSON payloads can be split across TCP chunks
 * so we keep a buffer and only commit lines that end with a blank line.
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

      // SSE events are separated by "\n\n". Only process complete events;
      // keep the trailing partial in `buffer` for the next read.
      const segments = buffer.split('\n\n')
      buffer = segments.pop() ?? ''  // last segment is incomplete

      for (const segment of segments) {
        for (const rawLine of segment.split('\n')) {
          const line = rawLine.trim()
          if (!line.startsWith('data: ')) continue

          const jsonStr = line.slice(6)
          if (jsonStr === '[DONE]') return

          try {
            const chunk = JSON.parse(jsonStr) as GeminiStreamChunk
            yield chunk
          } catch {
            // Malformed JSON in a complete SSE event — skip it.
          }
        }
      }
    }

    // Flush any trailing data left in the buffer at end-of-stream.
    if (buffer.trim()) {
      for (const rawLine of buffer.split('\n')) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6)
        if (jsonStr === '[DONE]') return
        try {
          yield JSON.parse(jsonStr) as GeminiStreamChunk
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
