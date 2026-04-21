/**
 * Cursor Lane — ConnectRPC protobuf streaming.
 *
 * Wire: POST https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools
 *   Content-Type: application/connect+proto
 *   Authorization: Bearer <accessToken>
 *   x-cursor-checksum: <jyh(now/1e6) ^ rolling-key(165) base64 || machineId>
 *
 * The response body is a stream of 5-byte-prefixed protobuf frames. Each
 * frame carries text, thinking content, a tool-call delta, a JSON error
 * envelope, or trailer metadata. We normalize each frame's payload into
 * Anthropic-IR events so claude.ts renders a Cursor turn identically to
 * every other lane.
 *
 * Frame → IR mapping:
 *   RESPONSE_TEXT          → text_delta
 *   RESPONSE.THINKING.TEXT → thinking_delta
 *   TOOL_CALL              → tool_use block (input_json_delta accumulation)
 *   JSON {"error": …}      → surfaces as an error text block pre-content;
 *                            dropped silently post-content (9router pattern).
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import { buildCursorBody } from './request.js'
import {
  parseConnectFrame,
  extractFromResponsePayload,
} from './protobuf.js'
import { buildCursorHeaders } from './checksum.js'
import { CURSOR_MODELS, isCursorModel } from './catalog.js'

const CURSOR_ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools'

export class CursorLane implements Lane {
  readonly name = 'cursor'
  readonly displayName = 'Cursor (ConnectRPC)'

  private accessToken: string | null = null
  private machineId: string | null = null

  configure(opts: { accessToken?: string | null; machineId?: string | null }): void {
    if (opts.accessToken !== undefined) this.accessToken = opts.accessToken || null
    if (opts.machineId !== undefined) this.machineId = opts.machineId || null
  }

  supportsModel(model: string): boolean {
    // Cursor's dotted/slashed ids (`claude-4.5-sonnet`, `gpt-5.2-codex`…)
    // don't collide with Anthropic-canonical (`claude-sonnet-4-20250514`)
    // or OpenAI-canonical (`gpt-5-codex`), so strict match is safe.
    return isCursorModel(model)
  }

  isHealthy(): boolean {
    return !!this.accessToken
  }

  resolveModel(model: string): string {
    return model
  }

  async listModels(_providerFilter?: string): Promise<ModelInfo[]> {
    // Cursor's GetDefaultModelNudgeData endpoint is noisy + includes
    // retired aliases. The static catalog is what Cursor's own IDE ships.
    return CURSOR_MODELS
  }

  dispose(): void {}

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error(
      'CursorLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.',
    )
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, signal, thinking } = params

    if (!this.accessToken) {
      throw new Error(
        'Cursor lane: not authenticated. Run `/login cursor` to import your Cursor token.',
      )
    }

    const systemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    // Cursor only exposes UNSPECIFIED / MEDIUM / HIGH, not a continuous
    // thinking budget — bucket the caller's budget_tokens into those.
    const reasoningEffort: 'medium' | 'high' | null =
      thinking?.type === 'enabled'
        ? ((thinking.budget_tokens ?? 0) >= 16_000 ? 'high' : 'medium')
        : null

    const body = buildCursorBody({
      model: this.resolveModel(model),
      system: systemText,
      messages,
      tools,
      reasoningEffort,
    })

    const headers = buildCursorHeaders({
      accessToken: this.accessToken,
      machineId: this.machineId,
    })

    const messageId = `cursor-${Date.now()}`
    let messageStartEmitted = false
    let outputTokens = 0
    let totalContentChars = 0

    // Content-block state.
    let currentIndex = 0
    let openBlock: 'text' | 'thinking' | null = null

    // Per-tool accumulation. Cursor re-emits the same toolCallId across
    // frames and appends raw-args chunks; we open the block once, push
    // input_json_delta per chunk, and close at stream end.
    interface ToolEntry {
      anthropicIndex: number
      emittedStart: boolean
      name: string
    }
    const toolBlocks = new Map<string, ToolEntry>()

    const emitMessageStart = (): AnthropicStreamEvent | undefined => {
      if (messageStartEmitted) return undefined
      messageStartEmitted = true
      return {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }
    }

    let response: Response
    try {
      response = await fetch(CURSOR_ENDPOINT, {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
        signal,
      })
    } catch (err: unknown) {
      const mst = emitMessageStart()
      if (mst) yield mst
      const message = err instanceof Error ? err.message : String(err)
      yield* _emitErrorText(`cursor API connection error: ${message}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const mst = emitMessageStart()
      if (mst) yield mst
      yield* _emitErrorText(`cursor API error ${response.status}: ${errText.slice(0, 500)}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response.body) throw new Error('Cursor: empty response body')

    const reader = response.body.getReader()
    // Residual buffer for partial frames that straddle fetch() chunks.
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    let deferredError: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          const merged = new Uint8Array(buffer.length + value.length)
          merged.set(buffer)
          merged.set(value, buffer.length)
          buffer = merged
        }

        // Drain every complete frame from the buffer.
        while (true) {
          const frame = parseConnectFrame(buffer)
          if (!frame) break
          buffer = buffer.slice(frame.consumed)

          const result = extractFromResponsePayload(frame.payload)

          if (result.error) {
            // 9router's pattern: if the turn already produced content,
            // swallow a trailing error frame (usually a soft rate-limit
            // notice). Otherwise surface it.
            const hadContent = messageStartEmitted && (totalContentChars > 0 || toolBlocks.size > 0)
            if (!hadContent) deferredError = result.error
            continue
          }

          if (result.text) {
            totalContentChars += result.text.length
            const mst = emitMessageStart()
            if (mst) yield mst
            if (openBlock === 'thinking') {
              yield { type: 'content_block_stop', index: currentIndex }
              currentIndex++
              openBlock = null
            }
            if (openBlock !== 'text') {
              yield {
                type: 'content_block_start',
                index: currentIndex,
                content_block: { type: 'text', text: '' },
              }
              openBlock = 'text'
            }
            yield {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'text_delta', text: result.text },
            }
          }

          if (result.thinking) {
            const mst = emitMessageStart()
            if (mst) yield mst
            if (openBlock === 'text') {
              yield { type: 'content_block_stop', index: currentIndex }
              currentIndex++
              openBlock = null
            }
            if (openBlock !== 'thinking') {
              yield {
                type: 'content_block_start',
                index: currentIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
              openBlock = 'thinking'
            }
            yield {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'thinking_delta', thinking: result.thinking },
            }
          }

          if (result.toolCall) {
            const tc = result.toolCall
            const mst = emitMessageStart()
            if (mst) yield mst

            let entry = toolBlocks.get(tc.id)
            if (!entry) {
              // First slice of this tool — close any open text/thinking
              // block, claim the next block index.
              if (openBlock !== null) {
                yield { type: 'content_block_stop', index: currentIndex }
                currentIndex++
                openBlock = null
              }
              entry = {
                anthropicIndex: currentIndex,
                emittedStart: false,
                name: tc.name,
              }
              toolBlocks.set(tc.id, entry)
              currentIndex++
            }

            if (!entry.emittedStart) {
              yield {
                type: 'content_block_start',
                index: entry.anthropicIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: {},
                },
              }
              entry.emittedStart = true
            }

            if (tc.argumentsDelta) {
              yield {
                type: 'content_block_delta',
                index: entry.anthropicIndex,
                delta: { type: 'input_json_delta', partial_json: tc.argumentsDelta },
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // If a pre-content error was deferred, surface it now.
    if (deferredError !== null && !messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
      yield* _emitErrorText(deferredError)
    }

    // Close any still-open text/thinking block.
    if (openBlock !== null) {
      yield { type: 'content_block_stop', index: currentIndex }
      openBlock = null
    }

    // Close in-flight tool_use blocks.
    for (const [, entry] of toolBlocks) {
      if (entry.emittedStart) {
        yield { type: 'content_block_stop', index: entry.anthropicIndex }
      }
    }

    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    // Cursor doesn't emit token counts — estimate output from char count.
    if (outputTokens === 0 && totalContentChars > 0) {
      outputTokens = Math.max(1, Math.floor(totalContentChars / 4))
    }

    const hadToolUse = toolBlocks.size > 0
    yield {
      type: 'message_delta',
      delta: { stop_reason: hadToolUse ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: 0,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }
  }
}

function _blankUsage(): NormalizedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    thinking_tokens: 0,
  }
}

function* _emitErrorText(text: string): Generator<AnthropicStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
}

export const cursorLane = new CursorLane()
