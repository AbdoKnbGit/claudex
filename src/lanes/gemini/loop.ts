/**
 * Gemini Lane — Native Agent Loop
 *
 * This is the core of the Gemini lane. It replaces claude.ts for Gemini
 * models, running the agent loop in Gemini's native idiom:
 *
 *   - Native Gemini REST API (streamGenerateContent with SSE)
 *   - Native tool names (read_file, run_shell_command, replace, etc.)
 *   - Native thinking (thinkingBudget: -1, dynamic per-turn)
 *   - Native context caching (cachedContents API)
 *   - Native error recovery and retry patterns from gemini-cli
 *
 * The loop follows gemini-cli's LegacyAgentProtocol._runLoop() pattern:
 *   1. Send request to model
 *   2. Stream response, collect tool calls
 *   3. If tool calls → execute via shared layer → feed results back → loop
 *   4. If no tool calls → finish
 *
 * All output is normalized to AnthropicStreamEvent (the shared IR) so
 * the UI renders identically regardless of lane.
 *
 * Vendored from: google-gemini/gemini-cli packages/core/src/agent/
 */

import type {
  AnthropicStreamEvent,
  AnthropicMessage,
  AnthropicContentBlock,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
} from '../types.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  resolveToolCall,
  formatToolResult,
  buildGeminiFunctionDeclarations,
  GEMINI_TOOL_REGISTRY,
} from './tools.js'
import { assembleGeminiSystemPrompt } from './prompt.js'
import { geminiApi, type GeminiStreamChunk } from './api.js'

// ─── Constants ───────────────────────────────────────────────────

const MAX_TURNS = 100
const MID_STREAM_MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

// ─── Gemini Native Message Types ─────────────────────────────────

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
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

  async *run(context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    const { model, signal } = context

    // ── Assemble native system prompt ──
    const { stable, volatile } = assembleGeminiSystemPrompt(model, context.systemParts)

    // ── Build native tool declarations ──
    const functionDeclarations = buildGeminiFunctionDeclarations()

    // ── Convert history to Gemini native format ──
    let contents = convertHistoryToGemini(context.messages)

    // ── Accumulate usage across turns ──
    const totalUsage: NormalizedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }

    // ── Agent loop (gemini-cli LegacyAgentProtocol._runLoop pattern) ──
    let turnCount = 0

    while (turnCount < MAX_TURNS) {
      if (signal.aborted) {
        return { stopReason: 'aborted', usage: totalUsage }
      }

      turnCount++

      // ── Build the request ──
      const request = buildGeminiRequest({
        model,
        contents,
        systemStable: stable,
        systemVolatile: volatile,
        functionDeclarations,
      })

      // ── Send to Gemini API with streaming ──
      let responseText = ''
      let thinkingText = ''
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
      let turnInputTokens = 0
      let turnOutputTokens = 0
      let turnThinkingTokens = 0
      let blockIndex = 0

      // Emit message_start
      const messageId = `gemini-${Date.now()}-${turnCount}`
      yield {
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

      try {
        // Stream from Gemini API
        const stream = geminiApi.streamGenerateContent(request, signal)

        for await (const chunk of stream) {
          if (signal.aborted) break

          // Process each candidate's parts
          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {

              // ── Thinking part ──
              if ('thought' in part && part.thought) {
                if (!thinkingText) {
                  // Start thinking block
                  yield {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                  }
                }
                thinkingText += part.text
                yield {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'thinking_delta', thinking: part.text },
                }
              }

              // ── Text part ──
              else if ('text' in part && !('thought' in part)) {
                if (thinkingText && blockIndex === 0) {
                  // Close thinking block, start text block
                  yield { type: 'content_block_stop', index: blockIndex }
                  blockIndex++
                }
                if (!responseText) {
                  yield {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  }
                }
                responseText += part.text
                yield {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: part.text },
                }
              }

              // ── Function call part ──
              else if ('functionCall' in part) {
                const fc = part.functionCall
                toolCalls.push({ name: fc.name, args: fc.args })

                // Close previous block if open
                if (responseText || thinkingText) {
                  yield { type: 'content_block_stop', index: blockIndex }
                  blockIndex++
                }

                const toolUseId = `toolu_gemini_${Date.now()}_${blockIndex}`
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: toolUseId,
                    name: fc.name,
                    input: fc.args,
                  },
                }
                // Tool input is complete (not streamed for Gemini)
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
              }
            }
          }

          // Extract usage from the chunk
          if (chunk.usageMetadata) {
            turnInputTokens = chunk.usageMetadata.promptTokenCount ?? 0
            turnOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0
            turnThinkingTokens = chunk.usageMetadata.thoughtsTokenCount ?? 0
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal.aborted) {
          return { stopReason: 'aborted', usage: totalUsage }
        }
        // Emit error as text and stop
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: `\n\nGemini API error: ${err.message}` },
        }
        yield { type: 'content_block_stop', index: blockIndex }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: turnOutputTokens },
        }
        yield { type: 'message_stop' }
        return { stopReason: 'error', usage: totalUsage }
      }

      // Close any open blocks
      if (responseText || thinkingText || toolCalls.length === 0) {
        yield { type: 'content_block_stop', index: blockIndex }
      }

      // Accumulate usage
      totalUsage.input_tokens += turnInputTokens
      totalUsage.output_tokens += turnOutputTokens
      totalUsage.thinking_tokens += turnThinkingTokens

      // ── No tool calls → model is done ──
      if (toolCalls.length === 0) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: turnOutputTokens },
        }
        yield { type: 'message_stop' }
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      // ── Tool calls → execute and loop ──
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: turnOutputTokens },
      }
      yield { type: 'message_stop' }

      // Add model response to conversation history
      const modelParts: GeminiPart[] = []
      if (thinkingText) modelParts.push({ thought: true, text: thinkingText })
      if (responseText) modelParts.push({ text: responseText })
      for (const tc of toolCalls) {
        modelParts.push({ functionCall: { name: tc.name, args: tc.args } })
      }
      contents.push({ role: 'model', parts: modelParts })

      // Execute each tool call through the shared layer
      const toolResponseParts: GeminiPart[] = []
      for (const tc of toolCalls) {
        const resolved = resolveToolCall(tc.name, tc.args)
        let resultContent: string

        if (!resolved) {
          resultContent = `Error: Unknown tool "${tc.name}"`
        } else {
          try {
            const result = await context.executeTool(resolved.implId, resolved.input)
            resultContent = formatToolResult(
              tc.name,
              result.isError ? `Error: ${result.content}` : result.content,
            )
          } catch (err: any) {
            resultContent = `Error executing ${tc.name}: ${err.message}`
          }
        }

        toolResponseParts.push({
          functionResponse: {
            name: tc.name,
            response: { content: resultContent },
          },
        })
      }

      // Add tool results to conversation history
      contents.push({ role: 'user', parts: toolResponseParts })

      // Reset for next turn
      responseText = ''
      thinkingText = ''
      toolCalls.length = 0
      blockIndex = 0
    }

    // Max turns reached
    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async listModels(): Promise<ModelInfo[]> {
    return geminiApi.listModels()
  }

  resolveModel(model: string): string {
    return model // Gemini model IDs are used as-is
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    // Nothing to clean up yet
  }
}

// ─── History Conversion ──────────────────────────────────────────
//
// Convert lane-neutral ProviderMessage[] → Gemini native GeminiContent[].
// This runs when a session is inherited from another lane (mid-session
// lane switch) or when starting a new turn with existing history.

function convertHistoryToGemini(
  messages: import('../../services/api/providers/base_provider.js').ProviderMessage[],
): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const msg of messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            if (block.text) parts.push({ text: block.text })
            break
          case 'tool_use':
            if (block.name && block.input) {
              // Map Anthropic tool name → Gemini native name
              const nativeName = mapAnthropicToolToGemini(block.name)
              parts.push({
                functionCall: {
                  name: nativeName,
                  args: block.input,
                },
              })
            }
            break
          case 'tool_result':
            if (block.tool_use_id) {
              // Tool results become functionResponse parts
              const content = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
              parts.push({
                functionResponse: {
                  name: block.name ?? 'unknown',
                  response: { content },
                },
              })
            }
            break
          case 'thinking':
            if (block.thinking) {
              parts.push({ thought: true, text: block.thinking })
            }
            break
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

// Map Anthropic tool names to Gemini native names (for history conversion)
const ANTHROPIC_TO_GEMINI_TOOL_MAP: Record<string, string> = {}
for (const reg of GEMINI_TOOL_REGISTRY) {
  // Reverse map: shared impl ID → native name (first match wins)
  // This is used when converting history from Anthropic lane
}
// Build by iterating registry: implId → nativeName
const _implToNative = new Map<string, string>()
for (const reg of GEMINI_TOOL_REGISTRY) {
  if (!_implToNative.has(reg.implId)) {
    _implToNative.set(reg.implId, reg.nativeName)
  }
}

function mapAnthropicToolToGemini(anthropicName: string): string {
  // Direct lookup: the Anthropic name IS the implId in most cases
  return _implToNative.get(anthropicName) ?? anthropicName
}

// ─── Request Builder ─────────────────────────────────────────────

interface GeminiRequestConfig {
  model: string
  contents: GeminiContent[]
  systemStable: string
  systemVolatile: string
  functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

function buildGeminiRequest(config: GeminiRequestConfig): Record<string, unknown> {
  const { model, contents, systemStable, systemVolatile, functionDeclarations } = config

  // Combine system prompt
  const systemText = systemVolatile
    ? `${systemStable}\n\n${systemVolatile}`
    : systemStable

  const request: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: systemText }] },
    tools: [{ functionDeclarations }],
    generationConfig: {
      maxOutputTokens: 16384,
      topP: 0.95,
      topK: 64,
      // Dynamic thinking — model decides per-turn
      thinkingConfig: {
        thinkingBudget: -1,
        includeThoughts: true,
      },
    },
    // All safety categories OFF (same as gemini-cli and CLIProxyAPI)
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ],
  }

  return request
}

// ─── Singleton Export ────────────────────────────────────────────

export const geminiLane = new GeminiLane()
