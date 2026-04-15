/**
 * Gemini Lane — Native Agent Loop + Provider-Shim Entry
 *
 * Two entry points:
 *
 *   1. streamAsProvider(params) — single-turn, provider-shim-compatible.
 *      Used by src/lanes/provider-bridge.ts. claude.ts owns the outer
 *      turn-orchestration loop; the lane handles one native API call
 *      per invocation.
 *
 *   2. run(context) — future lane-owns-loop mode. Not currently wired;
 *      scaffold preserved for the Phase-2 migration where each lane owns
 *      its full agent loop (per the architecture plan).
 *
 * Both paths speak Gemini's native REST API directly:
 *   - POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   - Native functionDeclarations, not Anthropic tools schema
 *   - Native thinkingConfig with thinkingBudget: -1 (dynamic)
 *   - Native safetySettings (all OFF)
 *   - Native cache (cachedContent field when available)
 *
 * References:
 *   - google-gemini/gemini-cli packages/core/src/core/geminiChat.ts
 *   - google-gemini/gemini-cli packages/core/src/agent/event-translator.ts
 */

import type {
  AnthropicStreamEvent,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  getRegistrationByNativeName,
  buildGeminiFunctionDeclarations,
  GEMINI_TOOL_REGISTRY,
} from './tools.js'
import { geminiApi } from './api.js'
import { getOrCreateCache, invalidateCache } from '../../services/api/providers/gemini_cache.js'
import { sanitizeSchemaForGemini } from '../../services/api/adapters/anthropic_to_gemini.js'

// ─── Constants ───────────────────────────────────────────────────

const MAX_TURNS = 100

// ─── Gemini Native Message Types ─────────────────────────────────

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown>; thoughtSignature?: string } }
  | { functionResponse: { name: string; response: { content: string } } }
  | { thought: boolean; text: string }

// ─── The Lane Implementation ─────────────────────────────────────

export class GeminiLane implements Lane {
  readonly name = 'gemini'
  readonly displayName = 'Google Gemini (Native)'

  private _healthy = true

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('gemini-') || m.startsWith('gemma-')
  }

  // ── Provider-shim-compatible single-turn entry ──────────────────

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, thinking, signal } = params

    // Normalize system → plain string for Gemini's systemInstruction.
    const systemText =
      typeof system === 'string'
        ? system
        : (system ?? []).map(b => b.text).join('\n\n')

    // Build id→native-name map across the whole conversation so
    // tool_result blocks can find their original Gemini function name.
    const toolUseIdToNative = buildToolUseIdToNativeMap(messages)

    // Convert Anthropic-format messages → Gemini native contents.
    const contents = convertHistoryToGemini(messages, toolUseIdToNative)

    // Build function declarations: prefer the native schema from our
    // registry for tools that match; pass through provider-shaped tools
    // for anything we don't recognize (MCP tools, custom tools).
    const functionDeclarations = buildLaneFunctionDeclarations(tools)

    // Map thinkingBudget from Anthropic-format thinking param.
    const thinkingBudget = resolveThinkingBudget(thinking)

    // Try to place the stable portion of the request (system + tools) into
    // Google's cachedContents API. On a hit, the model sees cache_read
    // input tokens at ~25% of the normal rate — meaningful win when the
    // same system+tools are re-used across turns of a session.
    //
    // Cache is API-key-path only (OAuth proxy doesn't expose it). If the
    // cache layer returns null, fall back to sending system+tools inline.
    const cacheSystemInstruction = { parts: [{ text: systemText }] }
    const cacheTools = functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined

    let cacheName: string | null = null
    if (geminiApi.supportsServerCache()) {
      const apiKey = geminiApi.getApiKey()
      if (apiKey) {
        try {
          cacheName = await getOrCreateCache({
            model,
            baseUrl: geminiApi.cacheBaseUrl,
            apiKey,
            systemInstruction: cacheSystemInstruction,
            tools: cacheTools,
          })
        } catch {
          cacheName = null
        }
      }
    }

    const request = buildGeminiRequest({
      model,
      contents,
      systemText,
      functionDeclarations,
      maxOutputTokens: max_tokens,
      thinkingBudget,
      cacheName,
    })

    // Track usage across the stream.
    let inputTokens = 0
    let outputTokens = 0
    let thinkingTokens = 0
    let cacheReadTokens = 0
    const cacheWriteTokens = 0

    // Stream state per turn.
    const messageId = `gemini-${Date.now()}`
    let thinkingText = ''
    let responseText = ''
    let blockIndex = 0
    let inBlock: 'thinking' | 'text' | null = null
    let messageStartEmitted = false
    const toolCalls: Array<{
      implId: string
      nativeName: string
      input: Record<string, unknown>
      anthropicToolUseId: string
      nativeArgs: Record<string, unknown>
      thoughtSignature?: string
    }> = []

    // Defer message_start until the first chunk arrives so we can fold
    // cache-hit and input-token numbers into the initial usage block —
    // Anthropic's AnthropicMessage.usage carries cache_read_input_tokens
    // only on the initial message_start, so emitting it blank first loses
    // the data. Mirrors the gemini_to_anthropic legacy adapter pattern.
    const emitMessageStart = () => {
      if (messageStartEmitted) return
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
            ...(cacheReadTokens > 0 && {
              cache_read_input_tokens: cacheReadTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        },
      }
    }

    try {
      const stream = geminiApi.streamGenerateContent(request, signal)

      for await (const chunk of stream) {
        if (signal.aborted) break

        // Fold usage FIRST so message_start (emitted on first chunk) sees
        // the correct cache-hit numbers before any blocks flow.
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata
          inputTokens = u.promptTokenCount ?? inputTokens
          outputTokens = u.candidatesTokenCount ?? outputTokens
          thinkingTokens = u.thoughtsTokenCount ?? thinkingTokens
          cacheReadTokens = u.cachedContentTokenCount ?? cacheReadTokens
        }

        if (!messageStartEmitted) {
          const ev = emitMessageStart()
          if (ev) yield ev
        }

        for (const candidate of chunk.candidates ?? []) {
          for (const part of (candidate.content?.parts ?? []) as any[]) {
            // ── Thinking part ──
            if (part.thought === true && typeof part.text === 'string') {
              if (inBlock === 'text') {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                responseText = ''
              }
              if (inBlock !== 'thinking') {
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                }
                inBlock = 'thinking'
              }
              thinkingText += part.text
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'thinking_delta', thinking: part.text },
              }
              continue
            }

            // ── Text part ──
            if (typeof part.text === 'string' && part.thought !== true) {
              if (inBlock === 'thinking') {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                thinkingText = ''
              }
              if (inBlock !== 'text') {
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' },
                }
                inBlock = 'text'
              }
              responseText += part.text
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: part.text },
              }
              continue
            }

            // ── Function call part ──
            if (part.functionCall) {
              const fc = part.functionCall as {
                name: string
                args: Record<string, unknown>
                thoughtSignature?: string
              }

              // Close any open text/thinking block first.
              if (inBlock !== null) {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
                inBlock = null
                responseText = ''
                thinkingText = ''
              }

              // Map native name → shared impl id (so claude.ts can execute it).
              const reg = getRegistrationByNativeName(fc.name)
              const implId = reg?.implId ?? fc.name
              const adaptedInput = reg
                ? reg.adaptInput(fc.args ?? {})
                : (fc.args ?? {})

              const anthropicToolUseId = `toolu_gem_${Date.now()}_${blockIndex}`

              toolCalls.push({
                implId,
                nativeName: fc.name,
                input: adaptedInput,
                anthropicToolUseId,
                nativeArgs: fc.args ?? {},
                thoughtSignature: fc.thoughtSignature,
              })

              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: anthropicToolUseId,
                  name: implId,
                  input: adaptedInput,
                  // Stash the thought signature so we can thread it back on
                  // the next turn (Antigravity + thinking-enabled models need
                  // this for multi-turn reasoning coherence).
                  ...(fc.thoughtSignature && {
                    _gemini_thought_signature: fc.thoughtSignature,
                  }),
                },
              }
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              continue
            }
          }
        }
      }
    } catch (err: any) {
      // If the server says the cached content doesn't exist (404 or
      // specific string), invalidate so the next call builds fresh.
      if (
        cacheName
        && err
        && typeof err.body === 'string'
        && (err.status === 404 || /cachedContent/i.test(err.body))
      ) {
        invalidateCache(cacheName)
      }
      // Make sure message_start is emitted so downstream assembly works.
      if (!messageStartEmitted) {
        const ev = emitMessageStart()
        if (ev) yield ev
      }
      if (err?.name === 'AbortError' || signal.aborted) {
        // Close any open block and signal abort.
        if (inBlock !== null) {
          yield { type: 'content_block_stop', index: blockIndex }
        }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: outputTokens },
        }
        yield { type: 'message_stop' }
        return {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
          thinking_tokens: thinkingTokens,
        }
      }
      // Surface other errors as a text block + end.
      if (inBlock !== null) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
      }
      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: `\n\nGemini API error: ${err?.message ?? String(err)}` },
      }
      yield { type: 'content_block_stop', index: blockIndex }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: outputTokens },
      }
      yield { type: 'message_stop' }
      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        thinking_tokens: thinkingTokens,
      }
    }

    // Make sure message_start was emitted (edge case: empty response).
    if (!messageStartEmitted) {
      const ev = emitMessageStart()
      if (ev) yield ev
    }

    // Close final open block.
    if (inBlock !== null) {
      yield { type: 'content_block_stop', index: blockIndex }
    }

    // Decide stop reason: if we emitted tool_use blocks, the model wants to
    // run tools; otherwise it finished its turn.
    const stopReason: 'tool_use' | 'end_turn' =
      toolCalls.length > 0 ? 'tool_use' : 'end_turn'

    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      thinking_tokens: thinkingTokens,
    }
  }

  // ── Lane-owns-loop mode (future Phase-2 migration) ─────────────

  async *run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    // Lane-owns-loop isn't wired into the query pipeline yet. For now this
    // delegates to streamAsProvider so the interface stays usable if called.
    const { model, messages, systemParts, mcpTools, signal, maxTokens } = context

    // Synthesize a system string from SystemPromptParts.
    const systemText = assembleSystemFromParts(systemParts)

    // Aggregate lane-native tool defs + MCP tools in provider-tool shape.
    const allTools = [
      ...GEMINI_TOOL_REGISTRY.map(r => ({
        name: r.implId,
        description: r.nativeDescription,
        input_schema: r.nativeSchema,
      })),
      ...mcpTools,
    ]

    const totalUsage: NormalizedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }

    let currentMessages = messages
    let turnCount = 0

    while (turnCount < MAX_TURNS) {
      if (signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
      turnCount++

      const collectedToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

      const gen = this.streamAsProvider({
        model,
        messages: currentMessages,
        system: systemText,
        tools: allTools,
        max_tokens: maxTokens,
        signal,
      })

      // Forward events while collecting tool_use blocks for execution.
      let done = false
      let stopReason: 'end_turn' | 'tool_use' = 'end_turn'
      while (!done) {
        const next = await gen.next()
        if (next.done) {
          const u = next.value
          totalUsage.input_tokens += u.input_tokens
          totalUsage.output_tokens += u.output_tokens
          totalUsage.cache_read_tokens += u.cache_read_tokens
          totalUsage.cache_write_tokens += u.cache_write_tokens
          totalUsage.thinking_tokens += u.thinking_tokens
          done = true
          break
        }
        const ev = next.value
        yield ev
        if (
          ev.type === 'content_block_start'
          && ev.content_block?.type === 'tool_use'
          && ev.content_block.id
          && ev.content_block.name
        ) {
          collectedToolUses.push({
            id: ev.content_block.id,
            name: ev.content_block.name,
            input: (ev.content_block.input ?? {}) as Record<string, unknown>,
          })
        }
        if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'tool_use') {
          stopReason = 'tool_use'
        }
      }

      if (stopReason !== 'tool_use' || collectedToolUses.length === 0) {
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      // Execute tools via the shared layer and feed results back.
      const toolResultBlocks = await Promise.all(
        collectedToolUses.map(async tu => {
          try {
            const result = await context.executeTool(tu.name, tu.input)
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
              is_error: result.isError,
            }
          } catch (e: any) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tu.id,
              content: `Error: ${e?.message ?? String(e)}`,
              is_error: true,
            }
          }
        }),
      )

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: collectedToolUses.map(tu => ({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          })),
        },
        { role: 'user', content: toolResultBlocks },
      ]
    }

    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async listModels(): Promise<ModelInfo[]> {
    return geminiApi.listModels()
  }

  resolveModel(model: string): string {
    return model
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    // No resources to release yet. When we add cachedContent lifetime
    // management we'll clean up here.
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function resolveThinkingBudget(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): number {
  // -1 = dynamic (Gemini picks per-turn). 0 = off. positive integer = cap.
  if (!thinking || thinking.type === 'adaptive') return -1
  if (thinking.type === 'disabled') return 0
  if (thinking.type === 'enabled') return thinking.budget_tokens ?? -1
  return -1
}

function assembleSystemFromParts(parts: {
  memory?: string
  environment?: string
  gitStatus?: string
  toolsAddendum?: string
  mcpIntro?: string
  skillsContext?: string
  customInstructions?: string
}): string {
  const sections: string[] = []
  if (parts.customInstructions) sections.push(parts.customInstructions)
  if (parts.toolsAddendum) sections.push(parts.toolsAddendum)
  if (parts.mcpIntro) sections.push(parts.mcpIntro)
  if (parts.skillsContext) sections.push(`Skills:\n${parts.skillsContext}`)
  if (parts.memory) sections.push(`Context:\n${parts.memory}`)
  if (parts.environment) sections.push(parts.environment)
  if (parts.gitStatus) sections.push(`Git status:\n${parts.gitStatus}`)
  return sections.join('\n\n')
}

// Build a map of tool_use_id → native tool name by scanning the history
// for tool_use blocks. Some blocks emit an implId as their name, others may
// already carry the native name. We record both candidates keyed by id.
function buildToolUseIdToNativeMap(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        // Resolve the block's name → native name. If name is an implId, look
        // up the first native registration; otherwise treat it as already-native.
        const native = implIdToNative(block.name) ?? block.name
        map.set(block.id, native)
      }
    }
  }
  return map
}

// ─── History Conversion ──────────────────────────────────────────
//
// Anthropic-IR ProviderMessage[] → Gemini native GeminiContent[].
// Handles the shared-impl-name ↔ native-name mapping transparently.

function convertHistoryToGemini(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
  toolUseIdToNative: Map<string, string>,
): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const msg of messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) parts.push({ text: msg.content })
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            if (block.text) parts.push({ text: block.text })
            break
          case 'tool_use':
            if (block.name) {
              const nativeName = implIdToNative(block.name) ?? block.name
              const nativeInput = implToNativeInput(block.name, block.input ?? {})
              const fc: GeminiPart = {
                functionCall: {
                  name: nativeName,
                  args: nativeInput,
                  ...(block._gemini_thought_signature && {
                    thoughtSignature: block._gemini_thought_signature,
                  }),
                },
              }
              parts.push(fc)
            }
            break
          case 'tool_result': {
            const id = block.tool_use_id ?? ''
            const nativeName = (id && toolUseIdToNative.get(id)) ?? 'unknown'
            const content = stringifyToolResultContent(block.content)
            parts.push({
              functionResponse: {
                name: nativeName,
                response: { content },
              },
            })
            break
          }
          case 'thinking':
            if (block.thinking) parts.push({ thought: true, text: block.thinking })
            break
        }
      }
    }

    if (parts.length > 0) contents.push({ role, parts })
  }

  return contents
}

function stringifyToolResultContent(
  content: unknown,
): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const b of content as any[]) {
      if (b && typeof b === 'object') {
        if ('text' in b && typeof b.text === 'string') texts.push(b.text)
        else texts.push(JSON.stringify(b))
      }
    }
    return texts.join('\n')
  }
  return JSON.stringify(content ?? '')
}

// Map a shared impl id → native Gemini tool name (first match wins).
// Returns undefined for unknown impls (MCP tools etc — caller treats the
// name as already-native).
const _implToNative = new Map<string, string>()
function _ensureImplMap(): void {
  if (_implToNative.size > 0) return
  for (const reg of GEMINI_TOOL_REGISTRY) {
    if (!_implToNative.has(reg.implId)) {
      _implToNative.set(reg.implId, reg.nativeName)
    }
  }
}
function implIdToNative(implOrNative: string): string | undefined {
  _ensureImplMap()
  if (_implToNative.has(implOrNative)) return _implToNative.get(implOrNative)
  // If it's already a native name, return as-is.
  const reg = getRegistrationByNativeName(implOrNative)
  if (reg) return reg.nativeName
  return undefined
}

// Translate shared-impl input → native Gemini input shape, running it
// through adaptInput's inverse where available. For most tools the shape
// is nearly identical, but some (Read offset+limit ↔ start_line+end_line)
// differ and we do the best-effort inverse here.
function implToNativeInput(
  implOrNative: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // If the caller already sent native-name input, pass through.
  const byNative = getRegistrationByNativeName(implOrNative)
  if (byNative) return input

  // Find by impl id.
  const reg = GEMINI_TOOL_REGISTRY.find(r => r.implId === implOrNative)
  if (!reg) return input

  // Specific inverse adapters for divergent shapes.
  switch (reg.nativeName) {
    case 'read_file': {
      const offset = input.offset as number | undefined
      const limit = input.limit as number | undefined
      const out: Record<string, unknown> = { file_path: input.file_path }
      if (offset != null) {
        out.start_line = offset + 1
        if (limit != null) out.end_line = offset + limit
      }
      return out
    }
    case 'replace': {
      return {
        file_path: input.file_path,
        old_string: input.old_string,
        new_string: input.new_string,
        ...(input.replace_all != null && { allow_multiple: input.replace_all }),
      }
    }
    case 'grep_search': {
      const out: Record<string, unknown> = { pattern: input.pattern }
      if (input.path != null) out.dir_path = input.path
      if (input.glob != null) out.include_pattern = input.glob
      if (input.head_limit != null) out.total_max_matches = input.head_limit
      if (input.output_mode === 'files_with_matches') out.names_only = true
      return out
    }
    default:
      return input
  }
}

// Build function declarations from the active tool list passed in by the
// caller. Tools matching our native registry use the native schema the
// model was trained on; unknown tools (MCP, custom) pass through with
// their provider-shaped schema, after light sanitization for Gemini.
function buildLaneFunctionDeclarations(
  tools: import('../../services/api/providers/base_provider.js').ProviderTool[],
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const decls: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = []

  for (const tool of tools) {
    // Try to match by impl id first (how claude.ts names tools).
    const byImpl = GEMINI_TOOL_REGISTRY.find(r => r.implId === tool.name)
    if (byImpl) {
      decls.push({
        name: byImpl.nativeName,
        description: byImpl.nativeDescription,
        parameters: byImpl.nativeSchema,
      })
      continue
    }

    // Maybe the caller already gave us a native name.
    const byNative = getRegistrationByNativeName(tool.name)
    if (byNative) {
      decls.push({
        name: byNative.nativeName,
        description: byNative.nativeDescription,
        parameters: byNative.nativeSchema,
      })
      continue
    }

    // Unknown tool — forward with its provider-shaped schema, sanitized
    // for Gemini's OpenAPI 3.0 subset. Reuses the legacy adapter's
    // battle-tested sanitizer (handles `const`, composition flattening
    // for anyOf/oneOf/allOf, null-type nullable mapping, etc.) so MCP
    // tools with complex JSON Schema survive the wire format.
    decls.push({
      name: tool.name,
      description: tool.description ?? '',
      parameters: sanitizeSchemaForGemini(tool.input_schema ?? { type: 'object', properties: {} }),
    })
  }

  return decls
}

// ─── Request Builder ─────────────────────────────────────────────

interface GeminiRequestConfig {
  model: string
  contents: GeminiContent[]
  systemText: string
  functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxOutputTokens: number
  thinkingBudget: number
  /** Server-side cache name from cachedContents API (if hit). */
  cacheName?: string | null
}

function buildGeminiRequest(config: GeminiRequestConfig): Record<string, unknown> {
  const {
    model,
    contents,
    systemText,
    functionDeclarations,
    maxOutputTokens,
    thinkingBudget,
    cacheName,
  } = config

  const request: Record<string, unknown> = {
    model,
    contents,
    generationConfig: {
      maxOutputTokens,
      topP: 0.95,
      topK: 64,
      thinkingConfig: {
        thinkingBudget,
        includeThoughts: thinkingBudget !== 0,
      },
    },
    // Safety categories OFF — matches gemini-cli and CLIProxyAPI defaults so
    // the model behaves the same way it does in its home environment.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ],
  }

  // Cache is mutually exclusive with inline system + tools — when the
  // cachedContents API holds the stable portion, reference it and omit
  // the duplicated fields. Otherwise send them inline every turn.
  if (cacheName) {
    request.cachedContent = cacheName
  } else {
    request.systemInstruction = { parts: [{ text: systemText }] }
    if (functionDeclarations.length > 0) {
      request.tools = [{ functionDeclarations }]
    }
  }

  return request
}

// ─── Singleton Export ────────────────────────────────────────────

export const geminiLane = new GeminiLane()
