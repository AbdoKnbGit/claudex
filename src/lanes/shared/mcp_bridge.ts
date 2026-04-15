/**
 * Shared MCP bridge.
 *
 * MCP servers expose tools via JSON-Schema 2020-12. Each lane's provider
 * accepts a *subset* of that schema vocabulary — requesting unsupported
 * keywords trips 400s at varying points in the pipeline, quietly breaks
 * tool-calling on some models, or produces tools the model can't actually
 * invoke because the schema shape is foreign.
 *
 * This module is the single place where we normalize MCP tool schemas
 * into each lane's accepted subset. Adding a new lane = add one row to
 * the strip-list map.
 *
 * Reference behaviors:
 *   - gemini-cli's mcp-tool.ts sanitizer (Gemini subset)
 *   - codex-rs/codex-mcp/src/mcp_tool_names.rs (Responses API subset)
 *   - litellm/groq + claude-code-router/groq transformers (Groq subset)
 *   - OpenAI strict-mode tool-schema restrictions
 */

import type { ProviderTool } from '../../services/api/providers/base_provider.js'

export type LaneSchemaProfile =
  | 'gemini'
  | 'codex'
  | 'anthropic'
  | 'openai-strict'
  | 'openai-loose'
  | 'groq'
  | 'mistral'
  | 'ollama'
  | 'qwen'
  | 'deepseek'
  | 'openrouter'
  | 'nim'
  | 'generic'

// Keywords each lane rejects on tool parameter schemas. Drop-lists based
// on field research: what the provider either 400s on or silently ignores
// in a way that breaks schema matching downstream.
const DROP_BY_PROFILE: Record<LaneSchemaProfile, Set<string>> = {
  // Gemini: minimal JSON-Schema subset. Uppercase type enum enforced elsewhere.
  gemini: new Set([
    '$schema', '$id', '$ref', '$comment', 'additionalProperties', 'strict',
    'examples', 'default', 'minLength', 'maxLength', 'minItems', 'maxItems',
    'pattern', 'format', 'patternProperties', 'propertyNames',
  ]),
  // Codex Responses API: accepts most JSON-Schema but rejects $schema/$id.
  codex: new Set(['$schema', '$id', '$ref', '$comment']),
  // Anthropic: passes most keywords through; strip a handful that confuse
  // the server validator in rare edge cases.
  anthropic: new Set(['$schema', '$id', '$ref', '$comment']),
  // OpenAI strict mode rejects additionalProperties=false+extra metadata.
  'openai-strict': new Set(['$schema', '$id', '$ref', '$comment', 'default']),
  'openai-loose': new Set(['$schema', '$id', '$ref', '$comment']),
  // Groq: actively fails on $schema in tool params; also strips strict.
  groq: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  // Mistral: grammar validator chokes on several keywords.
  mistral: new Set([
    '$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties',
    'format', 'examples', 'default',
  ]),
  ollama: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  qwen: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  deepseek: new Set(['$schema', '$id', '$ref', '$comment']),
  openrouter: new Set(['$schema', '$id', '$ref', '$comment']),
  nim: new Set(['$schema', '$id', '$ref', '$comment']),
  generic: new Set(['$schema', '$id', '$ref', '$comment', 'strict']),
}

/**
 * Sanitize a JSON Schema for the target lane. Returns a fresh object —
 * never mutates the input. Safe to call on MCP schemas before forwarding.
 */
export function sanitizeSchemaForLane(
  schema: unknown,
  profile: LaneSchemaProfile,
): Record<string, unknown> {
  const drop = DROP_BY_PROFILE[profile]
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
  const result = walk(schema)
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { type: 'object', properties: {} }
  }
  return result as Record<string, unknown>
}

/**
 * Normalize a MCP ProviderTool for a given lane. Returns a tool shape
 * compatible with that lane's tool registration format.
 *
 *   Gemini:  { name, description, parameters }
 *   Codex:   { type: 'function', name, description, parameters }
 *   Anthropic / compat: { name, description, input_schema }
 */
export function buildLaneTool(
  tool: ProviderTool,
  profile: LaneSchemaProfile,
): Record<string, unknown> {
  const cleanedSchema = sanitizeSchemaForLane(tool.input_schema ?? { type: 'object', properties: {} }, profile)

  switch (profile) {
    case 'gemini':
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: cleanedSchema,
      }
    case 'codex':
      return {
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: cleanedSchema,
      }
    default:
      // OpenAI Chat Completions + Anthropic Messages shape.
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: cleanedSchema,
        },
      }
  }
}

/**
 * MCP tool namespacing. Codex Rust uses `mcp_<server>_<tool>`;
 * gemini-cli uses the same. Keep the convention uniform across lanes
 * so a single dispatch map works regardless of which lane invokes.
 */
export const MCP_TOOL_PREFIX = 'mcp_'

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

export interface ParsedMcpToolName {
  server: string
  tool: string
}

export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (!isMcpToolName(name)) return null
  const body = name.slice(MCP_TOOL_PREFIX.length)
  const idx = body.indexOf('_')
  if (idx <= 0) return null
  return { server: body.slice(0, idx), tool: body.slice(idx + 1) }
}

export function buildMcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}_${tool}`
}
