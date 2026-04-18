/**
 * OpenAI-Compatible Lane — Agent Loop + Provider-Shim Entry
 *
 * Handles every provider that speaks OpenAI Chat Completions:
 *   - DeepSeek     (reasoner → `reasoning_content` → thinking; max_tokens 8192 cap)
 *   - Groq         (strip cache_control / $schema / null function_call; `reasoning` → thinking; fake_stream when JSON mode)
 *   - NVIDIA NIM   (strip stream_options; per-model param filtering)
 *   - Ollama       (no API key; Ollama-specific params; strip stream_options)
 *   - OpenRouter   (cache_control only for Claude / Gemini; relocate to last content block for 4-breakpoint Anthropic cap)
 *   - Mistral      (strip $id / $schema / additionalProperties / strict; tool_choice "required" → "any")
 *   - Generic long-tail (Fireworks, Together, Deepinfra, xAI, etc.)
 *
 * Per-provider quirks are consolidated in the transform helpers at the
 * bottom — adding a new provider is ~20 lines. The reference transformer
 * files this mirrors: claude-code-router/packages/core/src/transformer,
 * litellm/llms/<provider>/chat/transformation.py.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import { OPENAI_COMPAT_TOOL_REGISTRY, selectEditToolSet } from './tools.js'
import {
  appendStrictParamsHint,
  OPENAI_COMPAT_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import { getTransformer, type ProviderId } from './transformers/index.js'
import { resolveEditFormat } from './capabilities.js'

// ─── Provider Detection ──────────────────────────────────────────

type ProviderType =
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'nim'
  | 'ollama'
  | 'openrouter'
  | 'generic'

function detectProvider(model: string, baseUrl: string): ProviderType {
  const b = baseUrl.toLowerCase()
  const m = model.toLowerCase()
  if (b.includes('deepseek')) return 'deepseek'
  if (b.includes('groq')) return 'groq'
  if (b.includes('mistral')) return 'mistral'
  if (b.includes('integrate.api.nvidia')) return 'nim'
  if (b.includes('localhost') || b.includes('127.0.0.1') || b.includes('0.0.0.0') || b.includes(':11434')) return 'ollama'
  if (b.includes('openrouter')) return 'openrouter'
  if (m.includes('deepseek')) return 'deepseek'
  if (m.startsWith('llama') || m.startsWith('mixtral') || m.startsWith('gemma')) return 'groq'
  if (m.startsWith('mistral-') || m.startsWith('magistral-') || m.startsWith('codestral-')) return 'mistral'
  // qwen removed — handled by the dedicated Qwen lane (src/lanes/qwen/).
  return 'generic'
}

function isLocalBaseUrl(baseUrl: string): boolean {
  const b = baseUrl.toLowerCase()
  return b.includes('localhost') || b.includes('127.0.0.1') || b.includes('0.0.0.0') || b.includes(':11434')
}

// ─── OpenAI Chat Completions Message Shape ───────────────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null | Array<{ type: string; text?: string; image_url?: unknown }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
  // OpenRouter / DeepSeek reasoning fields come back on the delta; no input field.
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  // Reasoning knobs — provider-specific. Passed through when supported.
  reasoning_effort?: 'low' | 'medium' | 'high'
  reasoning?: { effort?: string }
  thinking?: { type: 'enabled' } | { type: 'disabled' }
  extra_body?: Record<string, unknown>
  // OpenRouter extensions:
  transforms?: string[]
  models?: string[]
  route?: string
  prompt_cache_key?: string
}

// ─── Lane Implementation ─────────────────────────────────────────

export class OpenAICompatLane implements Lane {
  readonly name = 'openai-compat'
  readonly displayName = 'OpenAI-Compatible (DeepSeek, Groq, Mistral, NIM, Ollama, OpenRouter, …)'

  private configs = new Map<string, { apiKey: string; baseUrl: string }>()
  private _healthy = true

  registerProvider(name: string, apiKey: string, baseUrl: string): void {
    this.configs.set(name, { apiKey, baseUrl })
  }

  private getConfigForModel(model: string): { apiKey: string; baseUrl: string; provider: ProviderType } | null {
    const m = model.toLowerCase()

    // Explicit routing: model prefix → provider config
    if (m.includes('deepseek') && this.configs.has('deepseek')) {
      const c = this.configs.get('deepseek')!
      return { ...c, provider: 'deepseek' }
    }
    if ((m.startsWith('llama') || m.startsWith('mixtral') || m.startsWith('gemma')) && this.configs.has('groq')) {
      const c = this.configs.get('groq')!
      return { ...c, provider: 'groq' }
    }
    if ((m.startsWith('mistral-') || m.startsWith('magistral-') || m.startsWith('codestral-')) && this.configs.has('mistral')) {
      const c = this.configs.get('mistral')!
      return { ...c, provider: 'mistral' }
    }
    // Qwen routing moved to the dedicated Qwen lane. Compat never sees qwen-*.
    if (this.configs.has('openrouter') && m.includes('/')) {
      const c = this.configs.get('openrouter')!
      return { ...c, provider: 'openrouter' }
    }
    if (this.configs.has('nim') && this.configs.has('nim')) {
      const c = this.configs.get('nim')!
      return { ...c, provider: 'nim' }
    }
    if (this.configs.has('ollama')) {
      const c = this.configs.get('ollama')!
      return { ...c, provider: 'ollama' }
    }
    // Fallback: first registered config.
    const first = this.configs.values().next().value
    if (!first) return null
    return { ...first, provider: detectProvider(model, first.baseUrl) }
  }

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    // Everything that isn't Claude, Gemini, Qwen, or native OpenAI
    // (each handled by its own dedicated lane).
    return !(
      m.startsWith('claude-') || m.includes('anthropic') ||
      m.startsWith('gemini-') || m.startsWith('gemma-') ||
      m.startsWith('qwen') || m === 'coder-model' ||
      m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') ||
      m.startsWith('o4') || m.startsWith('o5') || m.startsWith('codex-') ||
      m.startsWith('gpt-5-codex')
    )
  }

  // ── Provider-shim-compatible single-turn entry ──────────────────

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, thinking, temperature, stop_sequences, signal } = params

    const cfg = this.getConfigForModel(model)
    if (!cfg) {
      throw new Error(`openai-compat lane: no provider configured for model "${model}". Call registerProvider() or set an env var (e.g. DEEPSEEK_API_KEY).`)
    }

    const provider = cfg.provider
    const isLocal = isLocalBaseUrl(cfg.baseUrl)

    // Assemble system text. We keep it simple for Phase-1 (caller's text).
    const rawSystemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    // Tool conversion → OpenAI function tools with per-provider schema
    // cleanup (strip $schema / $id / additionalProperties / strict etc.).
    // Every function tool gets the STRICT PARAMETERS description hint,
    // plus function.strict: true when the provider honors it.
    const openaiTools = buildOpenAITools(tools, provider)

    // Prepend OPENAI_COMPAT_TOOL_USAGE_RULES to the system message when
    // tools are present — in-context reminder of schema authority for
    // providers that don't enforce `strict: true` server-side (Mistral,
    // generic long-tail). Cheap to include everywhere since providers
    // that DO enforce server-side just see an extra system note.
    const systemText = openaiTools.length > 0
      ? (rawSystemText
          ? `${OPENAI_COMPAT_TOOL_USAGE_RULES}\n${rawSystemText}`
          : OPENAI_COMPAT_TOOL_USAGE_RULES)
      : rawSystemText

    // History conversion → OpenAI Chat Completions messages.
    const chatMessages = convertHistoryToOpenAI(messages, systemText)

    // Build request body with per-provider quirks applied.
    const body = applyProviderRequestQuirks(
      {
        model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        tools: openaiTools.length > 0 && !isLocal ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 && !isLocal ? 'auto' : undefined,
        max_tokens: clampMaxTokens(provider, max_tokens),
        temperature: temperature ?? (isLocal ? 0.7 : undefined),
        stop: stop_sequences?.length ? stop_sequences : undefined,
      },
      provider,
      thinking,
    )

    // Headers per-provider.
    const headers = buildRequestHeaders(provider, cfg.apiKey)

    // Fire request.
    const url = normalizeBaseUrl(cfg.baseUrl) + '/chat/completions'

    const messageId = `compat-${Date.now()}`
    let messageStartEmitted = false
    let inputTokens = 0
    let outputTokens = 0
    let cachedInputTokens = 0
    let reasoningTokens = 0

    // Content-block state.
    let currentBlockIndex = 0
    let inTextBlock = false
    let inThinkingBlock = false
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string; anthropicIndex: number }>()
    let emittedAnyToolUse = false

    const emitMessageStart = () => {
      if (messageStartEmitted) return undefined
      messageStartEmitted = true
      return {
        type: 'message_start' as const,
        message: {
          id: messageId,
          type: 'message' as const,
          role: 'assistant' as const,
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            ...(cachedInputTokens > 0 && {
              cache_read_input_tokens: cachedInputTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        },
      }
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (err: any) {
      if (!messageStartEmitted) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      yield* emitErrorText(`${provider} API connection error: ${err?.message ?? String(err)}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
      yield { type: 'message_stop' }
      return blankUsage(inputTokens, outputTokens, cachedInputTokens, reasoningTokens)
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      if (!messageStartEmitted) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      // Detect prompt-too-long / context-window-exceeded per the
      // transformer's known markers. Emit with the "Prompt is too long"
      // prefix claude.ts reactive-compact text-matches against —
      // otherwise Flash / smaller models 400 on oversized turns and
      // the user has to `/compact` manually.
      const transformer = getTransformer(provider as ProviderId)
      const markers = transformer.contextExceededMarkers()
      const lowered = errText.toLowerCase()
      const isPromptTooLong = markers.some(m => lowered.includes(m.toLowerCase()))
      const headline = isPromptTooLong
        ? `Prompt is too long (${provider} ${response.status})`
        : `${provider} API error ${response.status}`
      yield* emitErrorText(`${headline}: ${errText.slice(0, 500)}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } }
      yield { type: 'message_stop' }
      return blankUsage(inputTokens, outputTokens, cachedInputTokens, reasoningTokens)
    }

    if (!response.body) {
      throw new Error('OpenAI-compat: empty response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      reading: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') break reading
          if (!payload) continue

          let chunk: any
          try {
            chunk = JSON.parse(payload)
          } catch { continue }

          // Apply per-provider response normalization (reasoning field
          // renames etc.) so downstream IR emission is uniform.
          chunk = applyProviderResponseQuirks(chunk, provider)

          // Stream-level usage (present on final chunk for most providers).
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens
            outputTokens = chunk.usage.completion_tokens ?? outputTokens
            cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens
            reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          if (!messageStartEmitted && (delta.content || delta.tool_calls || delta.reasoning_content || delta.thinking)) {
            const mst = emitMessageStart()
            if (mst) yield mst
          }

          // Reasoning / thinking content. We normalize into a thinking
          // block that claude.ts can render. Providers disagree: some
          // stream reasoning_content (DeepSeek reasoner), some stream
          // reasoning (Groq / OpenRouter), some stream thinking (already
          // normalized).
          const thinkingDelta: string | undefined =
            delta.thinking ?? delta.reasoning_content ?? delta.reasoning
          if (typeof thinkingDelta === 'string' && thinkingDelta.length > 0) {
            if (inTextBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              currentBlockIndex++
              inTextBlock = false
            }
            if (!inThinkingBlock) {
              yield {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
              inThinkingBlock = true
            }
            yield {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'thinking_delta', thinking: thinkingDelta },
            }
          }

          // Text content.
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (inThinkingBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              currentBlockIndex++
              inThinkingBlock = false
            }
            if (!inTextBlock) {
              yield {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              inTextBlock = true
            }
            yield {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }
          }

          // Tool-call deltas. OpenAI-style tool_calls arrive piece-by-piece
          // indexed by position. We accumulate args until finish_reason
          // signals completion.
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              let buf = toolCallBuffers.get(idx)
              if (!buf) {
                // Close any currently-open text/thinking block.
                if (inTextBlock || inThinkingBlock) {
                  yield { type: 'content_block_stop', index: currentBlockIndex }
                  currentBlockIndex++
                  inTextBlock = false
                  inThinkingBlock = false
                }
                buf = {
                  id: tc.id ?? `call_${idx}`,
                  name: tc.function?.name ?? '',
                  args: '',
                  anthropicIndex: currentBlockIndex,
                }
                currentBlockIndex++
                toolCallBuffers.set(idx, buf)
                emittedAnyToolUse = true
              }
              if (tc.id) buf.id = tc.id
              if (tc.function?.name) buf.name = tc.function.name
              if (typeof tc.function?.arguments === 'string') buf.args += tc.function.arguments
            }
          }

          // finish_reason signals completion of this choice's output.
          const finishReason = choice.finish_reason
          if (finishReason) {
            // Close open text / thinking blocks.
            if (inTextBlock || inThinkingBlock) {
              yield { type: 'content_block_stop', index: currentBlockIndex }
              inTextBlock = false
              inThinkingBlock = false
            }

            // Emit final tool_use blocks with the accumulated arguments.
            for (const buf of toolCallBuffers.values()) {
              const implId = normalizeToolName(buf.name)
              let input: Record<string, unknown>
              try {
                input = buf.args ? JSON.parse(buf.args) : {}
              } catch {
                input = { _raw: buf.args }
              }
              const anthropicToolUseId = buf.id.startsWith('toolu_') ? buf.id : `toolu_compat_${buf.id}`
              // Three-event sequence: start (empty input) + input_json_delta
              // (args as JSON string) + stop. claude.ts's accumulator reads
              // partial_json, not the inline input field — inline input gets
              // dropped and every tool sees `{}`.
              yield {
                type: 'content_block_start',
                index: buf.anthropicIndex,
                content_block: {
                  type: 'tool_use',
                  id: anthropicToolUseId,
                  name: implId,
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: buf.anthropicIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(input ?? {}),
                },
              }
              yield { type: 'content_block_stop', index: buf.anthropicIndex }
            }
            toolCallBuffers.clear()
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    const stopReason: 'tool_use' | 'end_turn' = emittedAnyToolUse ? 'tool_use' : 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: {
        output_tokens: outputTokens,
        input_tokens: inputTokens,
        ...(cachedInputTokens > 0 && {
          cache_read_input_tokens: cachedInputTokens,
          cache_creation_input_tokens: 0,
        }),
      },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cachedInputTokens,
      cache_write_tokens: 0,
      thinking_tokens: reasoningTokens,
    }
  }

  // ── Lane-owns-loop (Phase-2, not wired yet) ─────────────────────

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error('OpenAICompatLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.')
  }

  async listModels(): Promise<ModelInfo[]> {
    // Query /v1/models on every configured provider in parallel, cache
    // for 5 minutes. Errors on individual providers don't block the
    // rest — a slow Ollama install shouldn't delay Groq's list.
    const now = Date.now()
    if (_modelsCache && now - _modelsCacheAt < MODELS_CACHE_TTL_MS) {
      return _modelsCache
    }
    const entries = Array.from(this.configs.entries())
    const results = await Promise.allSettled(entries.map(async ([providerName, cfg]) => {
      const url = `${normalizeBaseUrl(cfg.baseUrl)}/models`
      const headers: Record<string, string> = { 'Accept': 'application/json' }
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
      const resp = await fetch(url, { headers, method: 'GET' })
      if (!resp.ok) return []
      const data = await resp.json() as { data?: Array<{ id?: string; owned_by?: string }> }
      return (data.data ?? [])
        .filter(m => typeof m.id === 'string')
        .map(m => ({
          id: m.id as string,
          name: m.id as string,
        }))
    }))
    const out: ModelInfo[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') out.push(...r.value)
    }
    _modelsCache = out
    _modelsCacheAt = now
    return out
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string | null {
    // Compat lane: no universal fast model — provider-specific hints
    // live in each transformer. The caller passes the currently-
    // configured model to resolveSmallFastModel() below to get a
    // provider-appropriate fast model when present.
    return null
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {}
}

// ─── Helpers ─────────────────────────────────────────────────────

// ─── Per-lane /v1/models cache ────────────────────────────────────

let _modelsCache: ModelInfo[] | null = null
let _modelsCacheAt = 0
const MODELS_CACHE_TTL_MS = 5 * 60_000

/**
 * Resolve a small/fast model for a given main-loop model by delegating
 * to the appropriate transformer. Exported so session-title /
 * tool-use-summary callers can request the cheaper model per-provider.
 */
export function resolveCompatSmallFastModel(
  provider: ProviderType,
  model: string,
): string | null {
  return getTransformer(provider as ProviderId).smallFastModel(model)
}

function blankUsage(i: number, o: number, c: number, r: number): NormalizedUsage {
  return {
    input_tokens: i,
    output_tokens: o,
    cache_read_tokens: c,
    cache_write_tokens: 0,
    thinking_tokens: r,
  }
}

function* emitErrorText(text: string): Generator<AnthropicStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function buildRequestHeaders(provider: ProviderType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  // Delegate provider-specific header additions (e.g. OpenRouter's
  // HTTP-Referer) to the transformer. Adding a new provider = one
  // buildHeaders() method in its transformer file.
  const transformer = getTransformer(provider as ProviderId)
  const extra = transformer.buildHeaders?.(apiKey) ?? {}
  for (const [k, v] of Object.entries(extra)) headers[k] = v
  return headers
}

function normalizeToolName(rawName: string): string {
  // Tool name arrives as whatever the model called. If it matches a native
  // entry in the registry, map to shared impl id. Otherwise pass through.
  const reg = OPENAI_COMPAT_TOOL_REGISTRY.find(r => r.nativeName === rawName)
  return reg?.implId ?? rawName
}

function clampMaxTokens(provider: ProviderType, requested: number): number {
  // Per-provider ceilings live in each transformer (e.g. DeepSeek 8192).
  return getTransformer(provider as ProviderId).clampMaxTokens(requested)
}

// ─── Per-Provider Request Quirks ─────────────────────────────────
//
// Consolidates the transformations the reference transformers do. Each
// quirk has a brief comment explaining *why* (usually: a specific error
// the provider returns on non-compliant requests).

function applyProviderRequestQuirks(
  body: OpenAIChatRequest,
  provider: ProviderType,
  thinking: LaneProviderCallParams['thinking'] | undefined,
): OpenAIChatRequest {
  const transformer = getTransformer(provider as ProviderId)
  const isReasoning = !!(thinking && thinking.type !== 'disabled')
  const effort = resolveReasoningEffort(thinking) ?? null

  // Cache-control placement per-transformer: strip when the provider
  // doesn't honor it (DeepSeek, Groq, Mistral, NIM, Ollama, generic);
  // pass through for OpenRouter (its upstream relocates for Anthropic
  // cap compliance automatically).
  const cacheMode = transformer.cacheControlMode(body.model)
  if (cacheMode === 'none') {
    body.messages = body.messages.map(stripCacheControlFromMessage)
  }

  // Let the transformer apply its provider-specific quirks. Every
  // provider implements this; adding a new one = one new file.
  transformer.transformRequest(body, {
    model: body.model,
    isReasoning,
    reasoningEffort: effort,
  })

  // Groq rejects null-valued `function_call` on assistant messages;
  // always strip null tool_calls regardless of provider (the cost of
  // doing it uniformly is < 1ms, the risk of missing it per-provider
  // is a subtle 400 on certain replay flows).
  body.messages = body.messages.map(stripNullToolCall)

  // Remove undefined fields — many providers 400 on explicit `null` on
  // optional fields they don't recognize.
  const bag = body as unknown as Record<string, unknown>
  for (const k of Object.keys(bag)) {
    if (bag[k] === undefined) delete bag[k]
  }

  return body
}

function resolveReasoningEffort(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || thinking.type === 'disabled') return undefined
  if (thinking.type === 'adaptive') return 'medium'
  const budget = (thinking as any).budget_tokens as number | undefined
  if (budget == null) return 'medium'
  if (budget < 2000) return 'low'
  if (budget < 8000) return 'medium'
  return 'high'
}

function stripCacheControlFromMessage(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.content || typeof m.content === 'string') return m
  const cleanedContent = m.content.map(part => {
    if (typeof part !== 'object' || part === null) return part
    const { cache_control: _cc, ...rest } = part as any
    return rest
  })
  return { ...m, content: cleanedContent as any }
}

function stripNullToolCall(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.tool_calls) return m
  const cleaned = m.tool_calls.filter(tc => tc && tc.function && tc.function.name)
  if (cleaned.length === 0) {
    const { tool_calls: _tc, ...rest } = m
    return rest
  }
  return { ...m, tool_calls: cleaned }
}

function stripNameField(m: OpenAIChatMessage): OpenAIChatMessage {
  if (!m.name) return m
  const { name: _n, ...rest } = m
  return rest
}

function injectMagistralThinkingPrompt(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const thinkingPrompt =
    'Reason step-by-step inside <think>...</think> tags before answering. '
    + 'Emit your thinking first, then provide your final answer outside the tags.'
  const existingSystem = messages.findIndex(m => m.role === 'system')
  if (existingSystem >= 0) {
    const sys = messages[existingSystem]
    const merged = typeof sys.content === 'string'
      ? thinkingPrompt + '\n\n' + sys.content
      : thinkingPrompt
    return messages.map((m, i) => i === existingSystem ? { ...m, content: merged } : m)
  }
  return [{ role: 'system', content: thinkingPrompt }, ...messages]
}

// ─── Per-Provider Response Quirks ────────────────────────────────

function applyProviderResponseQuirks(chunk: any, provider: ProviderType): any {
  const choice = chunk?.choices?.[0]
  if (!choice) return chunk
  const delta = choice.delta ?? {}

  // Groq: returns `reasoning` on deltas; normalize to reasoning_content
  // for uniform downstream handling (not strictly required with our
  // thinking-delta union fallback, but keeps things tidy).
  if (provider === 'groq' && typeof delta.reasoning === 'string' && !delta.reasoning_content) {
    delta.reasoning_content = delta.reasoning
  }
  // Qwen (DashScope compatible-mode) reasoning + DashScope error handling
  // moved to src/lanes/qwen/ (dedicated lane). Compat no longer sees qwen.
  // DeepSeek already sends reasoning_content; nothing to rename.
  // OpenRouter may send either reasoning or reasoning_content depending
  // on the underlying model; the union handling in streamAsProvider
  // covers both.

  // Rebuild choice with normalized delta.
  return { ...chunk, choices: [{ ...choice, delta }] }
}

// ─── Tool Schema Sanitization ────────────────────────────────────

function buildOpenAITools(
  tools: ProviderTool[],
  provider: ProviderType,
): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}> {
  // Transformer-driven strict mode + schema drop list. Per-provider
  // config lives in each transformer file — adding a new provider =
  // one new file; this function is provider-agnostic.
  const transformer = getTransformer(provider as ProviderId)
  const useStrict = transformer.supportsStrictMode()
  return tools.map(t => {
    const parameters = sanitizeToolSchema(
      t.input_schema ?? { type: 'object', properties: {} },
      provider,
    )
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        // Every tool description gets the STRICT PARAMETERS summary
        // appended — plain-text in-context reminder of required fields
        // + types. Backstops `strict: true` on providers that honor it
        // and does the whole job on providers that don't.
        description: appendStrictParamsHint(t.description ?? '', parameters),
        parameters,
        ...(useStrict && { strict: true }),
      },
    }
  })
}

// Strip JSON Schema fields that various providers reject. Drop lists
// are owned by each transformer (schemaDropList()); this wrapper just
// runs the walk.
function sanitizeToolSchema(schema: Record<string, unknown>, provider: ProviderType): Record<string, unknown> {
  const drop = getTransformer(provider as ProviderId).schemaDropList()

  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue
        out[k] = walk(value)
      }
      return out
    }
    return v
  }
  return walk(schema) as Record<string, unknown>
}

// ─── History Conversion ──────────────────────────────────────────

function convertHistoryToOpenAI(
  messages: ProviderMessage[],
  systemText: string,
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })
      continue
    }

    const texts: string[] = []
    const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []
    const toolResults: OpenAIChatMessage[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) texts.push(block.text)
          break
        case 'tool_use':
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
          }
          break
        case 'tool_result':
          if (block.tool_use_id) {
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string'
                ? block.content
                : stringifyToolContent(block.content),
            })
          }
          break
        case 'thinking':
          // OpenAI Chat Completions doesn't echo thinking back — skip.
          break
      }
    }

    if (texts.length > 0 || toolCalls.length > 0) {
      out.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: texts.length > 0 ? texts.join('\n') : null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      })
    }
    out.push(...toolResults)
  }

  return out
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as any[]) {
      if (b && typeof b === 'object') {
        if ('text' in b && typeof b.text === 'string') parts.push(b.text)
        else parts.push(JSON.stringify(b))
      }
    }
    return parts.join('\n')
  }
  return JSON.stringify(content ?? '')
}

// ─── Singleton Export ────────────────────────────────────────────

export const openaiCompatLane = new OpenAICompatLane()
