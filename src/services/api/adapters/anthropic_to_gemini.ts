/**
 * Outbound adapter: Converts Anthropic-format messages → Google Gemini generateContent format.
 *
 * Gemini uses a different structure:
 * - contents: array of {role: "user"|"model", parts: [{text}, {functionCall}, {functionResponse}]}
 * - tools: [{functionDeclarations: [...]}]
 * - systemInstruction: {parts: [{text}]}
 * - generationConfig: {maxOutputTokens, temperature}
 */

import type {
  ProviderRequestParams,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  SystemBlock,
} from '../providers/base_provider.js'

// ─── Gemini types ──────────────────────────────────────────────────

export interface GeminiRequest {
  contents: GeminiContent[]
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    stopSequences?: string[]
    thinkingConfig?: {
      thinkingBudget?: number
      includeThoughts?: boolean
    }
  }
  /**
   * Reference to a previously created `cachedContents/...` resource. When
   * set, `systemInstruction` and `tools` MUST be omitted — the cache
   * carries them. Used by the cache manager to reduce per-turn token cost
   * on repeated system prompts.
   */
  cachedContent?: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } }
  | { inlineData: { mimeType: string; data: string } }

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ─── Schema Sanitization ───────────────────────────────────────────

/**
 * Fields that Gemini's functionDeclarations do NOT support.
 * These are valid JSON Schema but rejected by the Gemini REST API.
 * Must be stripped recursively from all tool parameter schemas.
 */
const UNSUPPORTED_GEMINI_SCHEMA_FIELDS = new Set([
  '$schema',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  '$id',
  '$ref',
  '$comment',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'default',
])

/**
 * Recursively strip fields that Gemini does not support from a JSON Schema object.
 * Returns a new object — does not mutate the original.
 */
function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_GEMINI_SCHEMA_FIELDS.has(key)) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into each property definition
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propName, propSchema]) => [
          propName,
          propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
            ? sanitizeSchemaForGemini(propSchema as Record<string, unknown>)
            : propSchema,
        ]),
      )
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into array item schema
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

// ─── Conversion ────────────────────────────────────────────────────

export function anthropicToGeminiRequest(params: ProviderRequestParams): GeminiRequest {
  // Per-request map: track tool_use_id → tool_name because Gemini's
  // functionResponse uses the function name, not an ID.
  const toolIdToName = new Map<string, string>()
  const request: GeminiRequest = {
    contents: convertMessages(params.messages, toolIdToName),
  }

  // System prompt → systemInstruction (strip Anthropic-specific cache_control)
  if (params.system) {
    const systemText = typeof params.system === 'string'
      ? params.system
      : (params.system as SystemBlock[]).map(s => {
          const { cache_control, ...rest } = s as SystemBlock & { cache_control?: unknown }
          return rest.text
        }).join('\n\n')
    if (systemText) {
      request.systemInstruction = { parts: [{ text: systemText }] }
    }
  }

  // Tools → functionDeclarations (sanitize schemas for Gemini compatibility)
  if (params.tools && params.tools.length > 0) {
    request.tools = [{
      functionDeclarations: params.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeSchemaForGemini(t.input_schema),
      })),
    }]
  }

  // Generation config
  request.generationConfig = {
    maxOutputTokens: params.max_tokens,
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.stop_sequences && { stopSequences: params.stop_sequences }),
  }

  // Map Anthropic-style thinking → Gemini thinkingConfig. Only Gemini 2.5+
  // "thinking" models honor this; older models ignore it. -1 is dynamic.
  if (params.thinking && params.thinking.type !== 'disabled') {
    const budget =
      params.thinking.type === 'enabled' ? params.thinking.budget_tokens : -1
    request.generationConfig.thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: true,
    }
  }

  return request
}

function convertMessages(
  messages: ProviderMessage[],
  toolIdToName: Map<string, string>,
): GeminiContent[] {
  const result: GeminiContent[] = []

  for (const msg of messages) {
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user'

    if (typeof msg.content === 'string') {
      // Merge consecutive same-role messages (Gemini requires alternating roles)
      const last = result[result.length - 1]
      if (last && last.role === geminiRole) {
        last.parts.push({ text: msg.content })
      } else {
        result.push({ role: geminiRole, parts: [{ text: msg.content }] })
      }
      continue
    }

    const blocks = msg.content as ProviderContentBlock[]
    const parts: GeminiPart[] = []

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ text: block.text })
          break

        case 'tool_use':
          // Track id → name for later functionResponse
          if (block.id && block.name) {
            toolIdToName.set(block.id, block.name)
          }
          parts.push({
            functionCall: {
              name: block.name ?? '',
              args: (block.input as Record<string, unknown>) ?? {},
            },
          })
          break

        case 'tool_result': {
          // Look up the function name from the tool_use_id
          const funcName = block.tool_use_id
            ? toolIdToName.get(block.tool_use_id) ?? block.tool_use_id
            : 'unknown'
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.text ?? '').join('')
              : ''
          parts.push({
            functionResponse: {
              name: funcName,
              response: { content },
            },
          })
          break
        }

        case 'image':
          if (block.source) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            })
          }
          break
      }
    }

    if (parts.length === 0) continue

    // Merge consecutive same-role (Gemini constraint)
    const last = result[result.length - 1]
    if (last && last.role === geminiRole) {
      last.parts.push(...parts)
    } else {
      result.push({ role: geminiRole, parts })
    }
  }

  return result
}
