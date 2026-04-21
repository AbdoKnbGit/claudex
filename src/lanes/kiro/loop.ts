/**
 * Kiro Lane — CodeWhisperer streaming (AWS EventStream binary frames).
 *
 * Wire: POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
 *   Headers:
 *     Content-Type: application/json
 *     Accept: application/vnd.amazon.eventstream
 *     X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
 *     Authorization: Bearer <accessToken>
 *     X-Amz-User-Agent / User-Agent: aws-sdk-js/3.0.0 kiro-ide/1.0.0
 *     Amz-Sdk-Invocation-Id: <uuid>
 *
 * The response body is a sequence of binary EventStream frames; we
 * normalize each frame's JSON payload into Anthropic-IR events so
 * claude.ts renders Kiro turns identically to every other lane.
 *
 * Event type → Anthropic-IR mapping:
 *   assistantResponseEvent  → text_delta
 *   codeEvent               → text_delta (appended as code block)
 *   reasoningContentEvent   → thinking_delta (wrapped)
 *   toolUseEvent            → tool_use block (input_json_delta accumulation)
 *   messageStopEvent        → closes open blocks, emits message_delta
 *   metricsEvent            → folds usage into final message_delta
 *   contextUsageEvent       → estimates input tokens when metrics absent
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
import { parseFrames, type KiroEvent } from './eventstream.js'
import { buildKiroPayload } from './request.js'
import { KIRO_MODELS, isKiroModel } from './catalog.js'
import { randomUUID } from 'crypto'

const KIRO_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse'
// Default when the stored token blob lacks a profileArn (Builder-ID
// users don't get one back from the device-code exchange). Matches the
// reference DEFAULT_PROFILE_ARN in 9router-master/open-sse/services/usage.js.
const DEFAULT_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
// Kiro context window used when we have to estimate prompt tokens from
// contextUsagePercentage (no metricsEvent was emitted). Claude/Kiro pairs
// all use a 200k window.
const KIRO_CONTEXT_WINDOW = 200_000

export class KiroLane implements Lane {
  readonly name = 'kiro'
  readonly displayName = 'Kiro (AWS CodeWhisperer)'

  private accessToken: string | null = null
  private profileArn: string | null = null

  configure(opts: { accessToken?: string; profileArn?: string | null }): void {
    if (opts.accessToken !== undefined) this.accessToken = opts.accessToken || null
    if (opts.profileArn !== undefined) this.profileArn = opts.profileArn || null
  }

  supportsModel(model: string): boolean {
    // Kiro catalog uses dot-versioned aliases (`claude-sonnet-4.5`,
    // `deepseek-3.2`…) that DON'T collide with Anthropic-canonical ids
    // like `claude-sonnet-4-20250514`. Route strictly on the static
    // list so the dispatcher doesn't accidentally steal a canonical
    // Claude id away from the Anthropic path.
    return isKiroModel(model)
  }

  isHealthy(): boolean {
    return !!this.accessToken
  }

  resolveModel(model: string): string {
    return model
  }

  async listModels(_providerFilter?: string): Promise<ModelInfo[]> {
    return KIRO_MODELS
  }

  dispose(): void {}

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error('KiroLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.')
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, temperature, signal } = params

    if (!this.accessToken) {
      throw new Error(
        'Kiro lane: not authenticated. Run `/login kiro` to sign in with AWS Builder ID.',
      )
    }

    const systemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    const body = buildKiroPayload({
      model,
      system: systemText,
      messages,
      tools,
      // CodeWhisperer caps at 32k output; the caller's max_tokens is
      // usually 8192 already, but clamp for safety.
      maxTokens: Math.min(max_tokens ?? 8192, 32_000),
      temperature,
      profileArn: this.profileArn ?? DEFAULT_PROFILE_ARN,
    })

    const messageId = `kiro-${Date.now()}`
    let messageStartEmitted = false
    let outputTokens = 0
    let inputTokens = 0
    let reasoningTokens = 0

    // Content-block state. Kiro interleaves text + code + tool_use freely,
    // so we track what's currently open and switch cleanly.
    let currentIndex = 0
    let openBlock: 'text' | 'thinking' | null = null
    // Per-tool accumulation. Kiro's toolUseEvent fires once per tool with
    // the input already resolved (no argument-streaming), but the same
    // toolUseId may repeat if the model extends its input mid-stream, so
    // we reuse the block index and accumulate partial_json into it.
    const toolBlocks = new Map<string, { anthropicIndex: number; emittedStart: boolean }>()

    // Track stop-state. Kiro sometimes emits messageStopEvent BEFORE
    // metricsEvent, sometimes after; we only close out once per turn.
    let streamClosed = false
    let totalContentChars = 0
    let contextUsagePercentage = 0

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

    const closeOpenBlock = function* (): Generator<AnthropicStreamEvent> {
      if (openBlock !== null) {
        yield { type: 'content_block_stop', index: currentIndex }
        currentIndex++
        openBlock = null
      }
    }

    let response: Response
    try {
      response = await fetch(KIRO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.amazon.eventstream',
          'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
          'Authorization': `Bearer ${this.accessToken}`,
          'User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
          'X-Amz-User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
          'Amz-Sdk-Invocation-Id': randomUUID(),
          'Amz-Sdk-Request': 'attempt=1; max=3',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err: unknown) {
      const mst = emitMessageStart()
      if (mst) yield mst
      const message = err instanceof Error ? err.message : String(err)
      yield* _emitErrorText(`kiro API connection error: ${message}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const mst = emitMessageStart()
      if (mst) yield mst
      const lowered = errText.toLowerCase()
      const isPromptTooLong =
        lowered.includes('context length')
        || lowered.includes('context window')
        || lowered.includes('too long')
        || lowered.includes('inputtokens')
      const headline = isPromptTooLong
        ? `Prompt is too long (kiro ${response.status})`
        : `kiro API error ${response.status}`
      yield* _emitErrorText(`${headline}: ${errText.slice(0, 500)}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response.body) throw new Error('Kiro: empty response body')

    const reader = response.body.getReader()
    // Explicit widen from ArrayBuffer → ArrayBufferLike so the remainder
    // returned by parseFrames() (which starts from a fetch() chunk whose
    // underlying buffer is ArrayBufferLike) assigns back without a cast.
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

    try {
      while (!streamClosed) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          // Append incoming chunk to the residual buffer from the last
          // parse pass (frames can straddle chunk boundaries).
          const merged = new Uint8Array(buffer.length + value.length)
          merged.set(buffer)
          merged.set(value, buffer.length)
          buffer = merged
        }

        const { events, remainder } = parseFrames(buffer)
        buffer = remainder

        for (const ev of events) {
          // Track how much content the model has produced so we can
          // estimate output_tokens when metricsEvent is absent.
          if (ev.eventType === 'assistantResponseEvent' || ev.eventType === 'codeEvent') {
            const c = ev.payload && typeof ev.payload.content === 'string' ? ev.payload.content : ''
            totalContentChars += c.length
          }

          const emissions = _handleKiroEvent(ev, {
            model,
            messageId,
            toolBlocks,
            getCurrentIndex: () => currentIndex,
            setCurrentIndex: v => { currentIndex = v },
            getOpenBlock: () => openBlock,
            setOpenBlock: v => { openBlock = v },
          })
          for (const ev2 of emissions) {
            if (!messageStartEmitted && _shouldTriggerMessageStart(ev2)) {
              const mst = emitMessageStart()
              if (mst) yield mst
            }
            yield ev2
          }

          if (ev.eventType === 'metricsEvent') {
            const m = (ev.payload?.metricsEvent as Record<string, unknown> | undefined)
              ?? ev.payload
              ?? {}
            const it = typeof (m as { inputTokens?: unknown }).inputTokens === 'number'
              ? (m as { inputTokens: number }).inputTokens : 0
            const ot = typeof (m as { outputTokens?: unknown }).outputTokens === 'number'
              ? (m as { outputTokens: number }).outputTokens : 0
            if (it > 0) inputTokens = it
            if (ot > 0) outputTokens = ot
          }

          if (ev.eventType === 'contextUsageEvent') {
            const pct = (ev.payload?.contextUsagePercentage as number | undefined) ?? 0
            if (pct > 0) contextUsagePercentage = pct
          }

          if (ev.eventType === 'messageStopEvent') {
            streamClosed = true
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Close any still-open block. The messageStopEvent path above does
    // this for "clean" stream ends; this handles mid-stream aborts.
    for (const emit of closeOpenBlock()) yield emit

    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    // Backfill usage from text length when metricsEvent was missing.
    if (outputTokens === 0 && totalContentChars > 0) {
      outputTokens = Math.max(1, Math.floor(totalContentChars / 4))
    }
    if (inputTokens === 0 && contextUsagePercentage > 0) {
      inputTokens = Math.floor(contextUsagePercentage * KIRO_CONTEXT_WINDOW / 100)
    }

    const hadToolUse = toolBlocks.size > 0
    const stopReason: 'tool_use' | 'end_turn' = hadToolUse ? 'tool_use' : 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens, input_tokens: inputTokens },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: reasoningTokens,
    }
  }
}

// ─── Event → IR translation ──────────────────────────────────────

interface EventHandlerState {
  model: string
  messageId: string
  toolBlocks: Map<string, { anthropicIndex: number; emittedStart: boolean }>
  getCurrentIndex: () => number
  setCurrentIndex: (v: number) => void
  getOpenBlock: () => 'text' | 'thinking' | null
  setOpenBlock: (v: 'text' | 'thinking' | null) => void
}

function _handleKiroEvent(
  ev: KiroEvent,
  state: EventHandlerState,
): AnthropicStreamEvent[] {
  const out: AnthropicStreamEvent[] = []

  const closeOpen = (): void => {
    const ob = state.getOpenBlock()
    if (ob !== null) {
      out.push({ type: 'content_block_stop', index: state.getCurrentIndex() })
      state.setCurrentIndex(state.getCurrentIndex() + 1)
      state.setOpenBlock(null)
    }
  }

  const emitText = (text: string): void => {
    if (state.getOpenBlock() === 'thinking') closeOpen()
    if (state.getOpenBlock() !== 'text') {
      out.push({
        type: 'content_block_start',
        index: state.getCurrentIndex(),
        content_block: { type: 'text', text: '' },
      })
      state.setOpenBlock('text')
    }
    out.push({
      type: 'content_block_delta',
      index: state.getCurrentIndex(),
      delta: { type: 'text_delta', text },
    })
  }

  const emitThinking = (text: string): void => {
    if (state.getOpenBlock() === 'text') closeOpen()
    if (state.getOpenBlock() !== 'thinking') {
      out.push({
        type: 'content_block_start',
        index: state.getCurrentIndex(),
        content_block: { type: 'thinking', thinking: '' },
      })
      state.setOpenBlock('thinking')
    }
    out.push({
      type: 'content_block_delta',
      index: state.getCurrentIndex(),
      delta: { type: 'thinking_delta', thinking: text },
    })
  }

  const payload = ev.payload ?? {}

  switch (ev.eventType) {
    case 'assistantResponseEvent': {
      const content = typeof payload.content === 'string' ? payload.content : ''
      if (content) emitText(content)
      break
    }
    case 'codeEvent': {
      const content = typeof payload.content === 'string' ? payload.content : ''
      if (content) emitText(content)
      break
    }
    case 'reasoningContentEvent': {
      const content = typeof payload.content === 'string' ? payload.content : ''
      if (content) emitThinking(content)
      break
    }
    case 'toolUseEvent': {
      // Payload can be a single tool or an array — normalize.
      const raw = payload as Record<string, unknown>
      const items: Array<Record<string, unknown>> = Array.isArray(raw)
        ? (raw as unknown as Array<Record<string, unknown>>)
        : [raw]
      for (const tu of items) {
        const toolUseId = (typeof tu.toolUseId === 'string' && tu.toolUseId)
          || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const toolName = typeof tu.name === 'string' ? tu.name : ''
        const input = tu.input

        let entry = state.toolBlocks.get(toolUseId)
        if (!entry) {
          // First slice of this tool — close any open text/thinking
          // block, claim the next block index.
          closeOpen()
          entry = { anthropicIndex: state.getCurrentIndex(), emittedStart: false }
          state.toolBlocks.set(toolUseId, entry)
          state.setCurrentIndex(state.getCurrentIndex() + 1)
        }

        if (!entry.emittedStart) {
          out.push({
            type: 'content_block_start',
            index: entry.anthropicIndex,
            content_block: {
              type: 'tool_use',
              id: toolUseId,
              name: toolName,
              input: {},
            },
          })
          entry.emittedStart = true
        }

        if (input !== undefined) {
          const json = typeof input === 'string' ? input : JSON.stringify(input)
          out.push({
            type: 'content_block_delta',
            index: entry.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: json },
          })
        }
      }
      break
    }
    case 'messageStopEvent': {
      closeOpen()
      // Finalize any in-flight tool_use blocks.
      for (const [, entry] of state.toolBlocks) {
        if (entry.emittedStart) {
          out.push({ type: 'content_block_stop', index: entry.anthropicIndex })
        }
      }
      state.toolBlocks.clear()
      break
    }
    // meteringEvent / metricsEvent / contextUsageEvent / supplementaryWebLinksEvent:
    // metrics are consumed in the outer loop; other bookkeeping events
    // don't map to Anthropic IR.
  }

  return out
}

function _shouldTriggerMessageStart(ev: AnthropicStreamEvent): boolean {
  return ev.type === 'content_block_start' || ev.type === 'content_block_delta'
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

// ─── Singleton ───────────────────────────────────────────────────

export const kiroLane = new KiroLane()
