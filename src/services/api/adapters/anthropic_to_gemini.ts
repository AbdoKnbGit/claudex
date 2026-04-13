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
import { getThoughtSignature } from './gemini_thought_cache.js'

// ─── Gemini types ──────────────────────────────────────────────────

export interface GeminiSafetySettingEntry {
  category: string
  threshold: string
}

export interface GeminiRequest {
  contents: GeminiContent[]
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    stopSequences?: string[]
    thinkingConfig?: {
      thinkingBudget?: number
      includeThoughts?: boolean
    }
  }
  safetySettings?: GeminiSafetySettingEntry[]
  /**
   * Reference to a previously created `cachedContents/...` resource. When
   * set, `systemInstruction` and `tools` MUST be omitted — the cache
   * carries them. Used by the cache manager to reduce per-turn token cost
   * on repeated system prompts.
   */
  cachedContent?: string
}

// ─── Safety Settings ──────────────────────────────────────────────
// Identical to CLIProxyAPI's DefaultSafetySettings(): all harm categories
// set to OFF so Gemini doesn't block legitimate code content (error
// handling code, security tools, shell commands, etc.).

const GEMINI_SAFETY_SETTINGS: GeminiSafetySettingEntry[] = [
  { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',    threshold: 'BLOCK_NONE' },
]

// ─── Model-Specific Generation Configs ────────────────────────────
// Matched to the real Gemini CLI's defaultModelConfigs.ts:
//   chat-base:     temperature: 1, topP: 0.95, topK: 64, includeThoughts: true
//   chat-base-2.5: thinkingBudget: 8192
//   chat-base-3:   thinkingBudget: 24576 (HIGH)

/** Default thinking budget for Gemini 2.5 models (matches Gemini CLI). */
const THINKING_BUDGET_2_5 = 8192
/** Default thinking budget for Gemini 3.x models (HIGH level). */
const THINKING_BUDGET_3 = 24576

/**
 * Get model-specific generation config values. Matches the real Gemini CLI's
 * per-model config hierarchy so models perform at their intended capability.
 */
function getModelGenerationDefaults(model: string): {
  topP: number
  topK: number
  thinkingBudget: number
} {
  const m = model.toLowerCase()
  // Gemini 3.x models — highest thinking budget
  if (m.includes('gemini-3')) {
    return { topP: 0.95, topK: 64, thinkingBudget: THINKING_BUDGET_3 }
  }
  // Gemini 2.5 models — standard thinking budget
  if (m.includes('gemini-2.5')) {
    return { topP: 0.95, topK: 64, thinkingBudget: THINKING_BUDGET_2_5 }
  }
  // Older / unknown Gemini models — no thinking, still good sampling
  return { topP: 0.95, topK: 64, thinkingBudget: 0 }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * Synthetic thought signature used when no real signature is available.
 * The Gemini API accepts this sentinel to bypass strict signature validation.
 * Matches the constant used by the Gemini CLI.
 */
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

export type GeminiPart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
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
 * Gemini accepts a subset of OpenAPI 3.0 schema: type, format,
 * description, nullable, enum, items, properties, required,
 * minimum, maximum, minItems, maxItems, minLength, maxLength.
 * Everything else must be stripped recursively.
 */
const UNSUPPORTED_GEMINI_SCHEMA_FIELDS = new Set([
  // JSON Schema identifiers & references
  '$schema', '$id', '$ref', '$comment', '$defs', 'definitions',
  // Composition keywords — handled by flattenComposition() before stripping
  'not', 'if', 'then', 'else',
  // Object validation keywords Gemini rejects
  'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'unevaluatedProperties',
  'dependentRequired', 'dependentSchemas',
  // Number validation keywords beyond min/max
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  // String validation (pattern is regex — Gemini doesn't support it)
  'pattern', 'contentMediaType', 'contentEncoding',
  // Array validation beyond items/min/max
  'unevaluatedItems', 'prefixItems', 'contains', 'minContains', 'maxContains',
  // Metadata fields
  'default', 'const', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'title',
])

/**
 * Flatten JSON Schema composition keywords (anyOf, oneOf, allOf) that
 * Gemini cannot handle natively. Strategy:
 *
 *   - anyOf / oneOf with a null type → extract the non-null branch + nullable
 *   - anyOf / oneOf without null → take the first branch
 *   - allOf → shallow-merge all branches into one schema
 *
 * This runs BEFORE the normal sanitize pass so the flattened result can
 * be cleaned of unsupported fields normally.
 */
function flattenComposition(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  // Handle type arrays like ["string", "null"] → type: "string", nullable: true
  if (Array.isArray(result.type)) {
    const types = result.type as string[]
    const nonNull = types.filter(t => t !== 'null')
    if (types.includes('null')) {
      result.nullable = true
    }
    result.type = nonNull.length === 1 ? nonNull[0] : nonNull[0] ?? 'string'
  }

  // anyOf / oneOf → pick first non-null variant, set nullable if null present
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = result[keyword] as Record<string, unknown>[] | undefined
    if (!Array.isArray(variants) || variants.length === 0) continue

    const nonNull = variants.filter(v => v.type !== 'null')
    const hasNull = variants.some(v => v.type === 'null')
    const picked = nonNull[0] ?? variants[0]!

    // Merge the picked variant's fields into result
    delete result[keyword]
    if (hasNull) result.nullable = true
    for (const [k, v] of Object.entries(picked)) {
      if (v !== undefined && !(k in result && k !== keyword)) {
        result[k] = v
      }
    }
  }

  // allOf → shallow-merge all branches
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf as Record<string, unknown>[]
    delete result.allOf
    for (const branch of branches) {
      for (const [k, v] of Object.entries(branch)) {
        if (v === undefined) continue
        if (k === 'properties' && result.properties) {
          // Merge properties objects
          result.properties = {
            ...(result.properties as Record<string, unknown>),
            ...(v as Record<string, unknown>),
          }
        } else if (k === 'required' && result.required) {
          // Merge required arrays
          result.required = [
            ...new Set([
              ...(result.required as string[]),
              ...(v as string[]),
            ]),
          ]
        } else if (!(k in result)) {
          result[k] = v
        }
      }
    }
  }

  return result
}

/**
 * Recursively strip fields that Gemini does not support from a JSON Schema object.
 * Also handles composition keywords (anyOf/oneOf/allOf) by flattening them,
 * type arrays by extracting the non-null type, and empty required arrays.
 * Returns a new object — does not mutate the original.
 */
function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  // First pass: flatten composition keywords
  const flattened = flattenComposition(schema)
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flattened)) {
    // Strip unsupported fields and undefined values
    if (UNSUPPORTED_GEMINI_SCHEMA_FIELDS.has(key)) continue
    if (value === undefined) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into each property definition
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([propName, propSchema]) => [
            propName,
            propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
              ? sanitizeSchemaForGemini(propSchema as Record<string, unknown>)
              : propSchema,
          ]),
      )
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into array item schema
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else if (key === 'required' && Array.isArray(value)) {
      // Gemini rejects empty required arrays — only include if non-empty.
      if (value.length > 0) {
        result[key] = value
      }
    } else if (Array.isArray(value)) {
      // Recurse into arrays of schemas (e.g. items as tuple)
      result[key] = value.map(item =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeSchemaForGemini(item as Record<string, unknown>)
          : item,
      )
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into any nested schema object
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

// ─── Conversion ────────────────────────────────────────────────────

export function anthropicToGeminiRequest(params: ProviderRequestParams): GeminiRequest {
  // Resolve the actual Gemini model name (params.model may already be resolved
  // by the provider, or may still be a Claude alias — handle both).
  const model = params.model

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

  // Safety settings — all categories OFF, matching CLIProxyAPI's defaults.
  // Without this, Gemini's default safety filters block legitimate code
  // content (security tools, error handling, shell commands, etc.).
  request.safetySettings = GEMINI_SAFETY_SETTINGS

  // Generation config — model-specific defaults from the real Gemini CLI.
  const modelDefaults = getModelGenerationDefaults(model)
  request.generationConfig = {
    maxOutputTokens: params.max_tokens,
    temperature: params.temperature ?? 1,
    topP: modelDefaults.topP,
    topK: modelDefaults.topK,
    ...(params.stop_sequences && { stopSequences: params.stop_sequences }),
  }

  // Thinking config — use Anthropic's budget if provided, otherwise use
  // model-specific defaults from Gemini CLI. Gemini 2.5+ and 3.x models
  // all support thinking; it makes them dramatically smarter.
  if (params.thinking && params.thinking.type === 'disabled') {
    // Explicitly disabled — don't add thinkingConfig.
  } else if (params.thinking && params.thinking.type === 'enabled') {
    // Explicit budget from Anthropic thinking config.
    request.generationConfig.thinkingConfig = {
      thinkingBudget: params.thinking.budget_tokens,
      includeThoughts: true,
    }
  } else if (modelDefaults.thinkingBudget > 0) {
    // No explicit thinking config from Anthropic — use the model's default.
    // This is what the real Gemini CLI does: always enable thinking with
    // a model-appropriate budget.
    request.generationConfig.thinkingConfig = {
      thinkingBudget: modelDefaults.thinkingBudget,
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

        case 'tool_use': {
          // Track id → name for later functionResponse
          if (block.id && block.name) {
            toolIdToName.set(block.id, block.name)
          }
          // Always include thoughtSignature (camelCase) — Gemini 2.5+
          // thinking models require it on every functionCall in history.
          // Priority: real sig from content block → session cache → synthetic.
          const sig = block._gemini_thought_signature
            ?? getThoughtSignature(block.id ?? '')
            ?? SYNTHETIC_THOUGHT_SIGNATURE
          const fcPart: Record<string, unknown> = {
            functionCall: {
              name: block.name ?? '',
              args: (block.input as Record<string, unknown>) ?? {},
            },
            thoughtSignature: sig,
          }
          parts.push(fcPart as GeminiPart)
          break
        }

        case 'thinking':
          // Gemini thinking text → { text, thought: true }
          if (block.thinking) {
            parts.push({ text: block.thinking, thought: true })
          }
          break

        case 'redacted_thinking':
          // Anthropic redacted thinking — not applicable to Gemini, skip
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
