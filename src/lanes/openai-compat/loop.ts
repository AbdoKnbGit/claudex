/**
 * OpenAI-Compatible Lane — Agent Loop
 *
 * Handles ALL providers that speak the OpenAI Chat Completions format:
 *   - DeepSeek (deepseek-chat, deepseek-coder, deepseek-reasoner)
 *   - Groq (llama, mixtral, gemma via Groq)
 *   - NVIDIA NIM
 *   - Ollama (local models)
 *   - OpenRouter (long tail of models)
 *   - Mistral, xAI/Grok, Fireworks, Together, etc.
 *
 * Per-provider quirks are handled by small adapter functions, not by
 * separate lane implementations. LiteLLM's provider docs are the
 * reference for these quirks.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type { Lane, LaneRunContext, LaneRunResult, NormalizedUsage } from '../types.js'
import { resolveToolCall, formatToolResult, buildOpenAICompatFunctions } from './tools.js'
import { assembleOpenAICompatPrompt } from './prompt.js'

const MAX_TURNS = 50 // Lower for compat models — they're less reliable on long chains

// ─── Provider Detection ──────────────────────────────────────────

type ProviderType = 'deepseek' | 'groq' | 'nim' | 'ollama' | 'openrouter' | 'generic'

function detectProvider(model: string, baseUrl: string): ProviderType {
  if (baseUrl.includes('deepseek')) return 'deepseek'
  if (baseUrl.includes('groq')) return 'groq'
  if (baseUrl.includes('integrate.api.nvidia')) return 'nim'
  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) return 'ollama'
  if (baseUrl.includes('openrouter')) return 'openrouter'
  const m = model.toLowerCase()
  if (m.includes('deepseek')) return 'deepseek'
  if (m.includes('llama') || m.includes('mixtral') || m.includes('gemma')) return 'groq'
  return 'generic'
}

function isLocalModel(baseUrl: string): boolean {
  return baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0')
}

// ─── Per-Provider Quirks ─────────────────────────────────────────

function getProviderHeaders(provider: ProviderType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  // OpenRouter wants additional headers for ranking/attribution
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/claudex'
    headers['X-Title'] = 'ClaudeX'
  }
  return headers
}

function adjustRequestBody(provider: ProviderType, body: any): any {
  // Ollama doesn't support stream_options
  if (provider === 'ollama') {
    delete body.stream_options
  }
  // DeepSeek Reasoner: add reasoning fields
  if (provider === 'deepseek' && body.model?.includes('reasoner')) {
    body.reasoning_effort = 'medium'
  }
  // NIM: some models need specific adjustments
  if (provider === 'nim') {
    delete body.stream_options
  }
  return body
}

// ─── Lane Implementation ─────────────────────────────────────────

export class OpenAICompatLane implements Lane {
  readonly name = 'openai-compat'
  readonly displayName = 'OpenAI Compatible'

  private configs = new Map<string, { apiKey: string; baseUrl: string }>()
  private _healthy = true

  /**
   * Register a provider with its auth. Called for each compat provider
   * during init (DeepSeek, Groq, NIM, Ollama, OpenRouter, etc.).
   */
  registerProvider(name: string, apiKey: string, baseUrl: string): void {
    this.configs.set(name, { apiKey, baseUrl })
  }

  /** Get config for a specific provider */
  private getConfig(model: string): { apiKey: string; baseUrl: string } | null {
    // Try to match by model prefix to a registered provider
    const m = model.toLowerCase()
    if (m.includes('deepseek')) return this.configs.get('deepseek') ?? null
    if (this.configs.has('groq') && (m.includes('llama') || m.includes('mixtral') || m.includes('gemma'))) {
      return this.configs.get('groq') ?? null
    }
    if (this.configs.has('nim')) return this.configs.get('nim') ?? null
    if (this.configs.has('ollama')) return this.configs.get('ollama') ?? null
    if (this.configs.has('openrouter')) return this.configs.get('openrouter') ?? null
    // Fallback: try any registered provider
    for (const config of this.configs.values()) return config
    return null
  }

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    // Everything that isn't Claude, Gemini, or native OpenAI (GPT/o-series/codex)
    return !(
      m.startsWith('claude-') || m.includes('anthropic') ||
      m.startsWith('gemini-') || m.startsWith('gemma-') ||
      m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('codex-')
    )
  }

  async *run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    const { model, signal } = context
    const config = this.getConfig(model)
    if (!config) {
      throw new Error(`No provider configured for model ${model}`)
    }

    const provider = detectProvider(model, config.baseUrl)
    const local = isLocalModel(config.baseUrl)

    const { full: systemPrompt } = assembleOpenAICompatPrompt(model, context.systemParts, local)
    const tools = buildOpenAICompatFunctions().map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    const messages: Array<{ role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }> = [
      { role: 'system', content: systemPrompt },
    ]
    // Convert history
    for (const msg of context.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content })
      } else {
        const texts: string[] = []
        const tcs: any[] = []
        for (const b of msg.content) {
          if (b.type === 'text' && b.text) texts.push(b.text)
          if (b.type === 'tool_use' && b.name) {
            tcs.push({ id: b.id ?? `c_${Date.now()}`, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
          }
          if (b.type === 'tool_result') {
            messages.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) })
          }
        }
        if (texts.length > 0 || tcs.length > 0) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: texts.join('\n') || null,
            ...(tcs.length > 0 && { tool_calls: tcs }),
          })
        }
      }
    }

    const totalUsage: NormalizedUsage = {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_tokens: 0, thinking_tokens: 0,
    }

    let turnCount = 0
    while (turnCount < MAX_TURNS) {
      if (signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
      turnCount++

      const messageId = `compat-${Date.now()}-${turnCount}`
      yield {
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant',
          content: [], model, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }

      let body: any = {
        model,
        messages,
        stream: true,
        ...(tools.length > 0 && !local ? { tools } : {}),
        // Local models: fewer tools, longer timeout, no stream_options
        ...(local ? { temperature: 0.7 } : {}),
      }
      body = adjustRequestBody(provider, body)

      let responseText = ''
      const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      let blockIndex = 0

      try {
        const headers = getProviderHeaders(provider, config.apiKey)
        const url = `${config.baseUrl}/chat/completions`
        const response = await fetch(url, {
          method: 'POST', headers, body: JSON.stringify(body), signal,
        })

        if (!response.ok) {
          const errText = await response.text().catch(() => '')
          throw new Error(`${provider} API error ${response.status}: ${errText.slice(0, 200)}`)
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const partials = new Map<number, { id: string; name: string; args: string }>()

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
              if (data === '[DONE]' || !data) continue

              let chunk: any
              try { chunk = JSON.parse(data) } catch { continue }
              const delta = chunk.choices?.[0]?.delta
              if (!delta) continue

              if (delta.content) {
                if (!responseText) {
                  yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }
                }
                responseText += delta.content
                yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } }
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!partials.has(tc.index)) {
                    if (responseText && blockIndex === 0) {
                      yield { type: 'content_block_stop', index: blockIndex }; blockIndex++
                    }
                    partials.set(tc.index, { id: tc.id ?? `c_${tc.index}`, name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' })
                  } else {
                    const p = partials.get(tc.index)!
                    if (tc.function?.arguments) p.args += tc.function.arguments
                    if (tc.function?.name) p.name = tc.function.name
                    if (tc.id) p.id = tc.id
                  }
                }
              }

              if (chunk.usage) {
                totalUsage.input_tokens += chunk.usage.prompt_tokens ?? 0
                totalUsage.output_tokens += chunk.usage.completion_tokens ?? 0
              }
            }
          }
        } finally { reader.releaseLock() }

        for (const [, tc] of partials) {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.args) } catch { args = { raw: tc.args } }
          toolCalls.push({ id: tc.id, name: tc.name, args })
          yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: args } }
          yield { type: 'content_block_stop', index: blockIndex }
          blockIndex++
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
        yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: `\n\n${provider} error: ${err.message}` } }
        yield { type: 'content_block_stop', index: blockIndex }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
        yield { type: 'message_stop' }
        return { stopReason: 'error', usage: totalUsage }
      }

      if (responseText || toolCalls.length === 0) {
        yield { type: 'content_block_stop', index: blockIndex }
      }

      if (toolCalls.length === 0) {
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
        yield { type: 'message_stop' }
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }

      messages.push({
        role: 'assistant', content: responseText || null,
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      })

      for (const tc of toolCalls) {
        const resolved = resolveToolCall(tc.name, tc.args)
        let result: string
        if (!resolved) {
          result = `Error: Unknown tool "${tc.name}"`
        } else {
          try {
            const r = await context.executeTool(resolved.implId, resolved.input)
            result = formatToolResult(tc.name, r.isError ? `Error: ${r.content}` : r.content)
          } catch (err: any) {
            result = `Error: ${err.message}`
          }
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
    }

    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async listModels(): Promise<ModelInfo[]> { return [] }
  resolveModel(model: string): string { return model }
  isHealthy(): boolean { return this._healthy && this.configs.size > 0 }
  setHealthy(h: boolean): void { this._healthy = h }
  dispose(): void {}
}

export const openaiCompatLane = new OpenAICompatLane()
