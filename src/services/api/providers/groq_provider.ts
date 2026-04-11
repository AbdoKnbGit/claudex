/**
 * Groq provider — extends OpenAIProvider.
 *
 * Groq provides ultra-fast inference for open-source models.
 * All models are free with rate limits.
 *
 * Base URL: https://api.groq.com/openai/v1
 * Auth: Bearer token (gsk_...)
 * API: OpenAI-compatible
 *
 * CRITICAL — Groq free-tier TPM limits (tokens per minute, INPUT+OUTPUT combined):
 *   qwen/qwen3-32b:               6,000 TPM
 *   llama-3.3-70b-versatile:     12,000 TPM
 *   deepseek-r1-distill-llama-70b: 6,000 TPM
 *   openai/gpt-oss-120b:          6,000 TPM
 *
 * With 6K TPM, we must keep total per-request token usage under ~2500
 * so the user can make 2 requests per minute. This means:
 *   - System prompt: ~100 tokens (400 chars)
 *   - Tools: 4 tools with minimal schemas (~300 tokens total)
 *   - Conversation: ~100 tokens
 *   - Output cap: 1024 tokens
 *   - Total: ~1524 per request, fits 3-4 requests per minute
 */

import { OpenAIProvider } from './openai_provider.js'
import type {
  ProviderConfig,
  ProviderRequestParams,
  ProviderTool,
  SystemBlock,
} from './base_provider.js'

/** Only 4 tools — the absolute minimum for coding assistance */
const GROQ_ESSENTIAL_TOOLS = new Set([
  'Bash',
  'Read',
  'Edit',
  'Grep',
])

export class GroqProvider extends OpenAIProvider {
  readonly name = 'groq'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://api.groq.com/openai/v1',
      extraHeaders: config.extraHeaders,
    })

    // Extreme optimization for Groq's 6K TPM limits
    if (!process.env.GROQ_MAX_SYSTEM_CHARS && !process.env.PROVIDER_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = 400
    }
    if (!process.env.GROQ_MAX_TOKENS && !process.env.PROVIDER_MAX_TOKENS) {
      this.maxTokensCap = 1024
    }
  }

  /**
   * Override optimization for Groq — ultra-aggressive to stay under 6K TPM.
   * Replaces the system prompt with a minimal one, strips tools to 4 essentials,
   * and removes all verbose schema content.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (!this.optimizePayload) return params

    // Build a minimal system prompt instead of trimming the huge one
    const system = this._buildMinimalSystem()

    // Filter to 4 essential tools and strip their schemas to bare minimum
    let tools: ProviderTool[] | undefined
    if (params.tools && params.tools.length > 0) {
      const filtered = params.tools.filter(t => GROQ_ESSENTIAL_TOOLS.has(t.name))
      tools = filtered.length > 0 ? filtered.map(t => this._minimizeToolSchema(t)) : undefined
    }

    return {
      ...params,
      system,
      tools,
      max_tokens: Math.min(params.max_tokens, this.maxTokensCap),
    }
  }

  /**
   * Build a tiny system prompt (~80 tokens) instead of trimming
   * the massive Claude Code system prompt.
   */
  private _buildMinimalSystem(): string {
    return (
      'You are a coding assistant. Help the user with software engineering tasks. ' +
      'Use the provided tools: Bash (run commands), Read (read files), Edit (edit files), Grep (search code). ' +
      'Be concise. Write correct, secure code.'
    )
  }

  /**
   * Strip tool schemas to absolute minimum — remove descriptions,
   * remove optional property metadata, keep only required fields.
   * This reduces each tool from ~200 tokens to ~40 tokens.
   */
  private _minimizeToolSchema(tool: ProviderTool): ProviderTool {
    return {
      name: tool.name,
      description: this._getShortDesc(tool.name),
      input_schema: this._stripSchema(tool.input_schema),
    }
  }

  /** One-line description per tool — saves ~150 tokens vs full descriptions */
  private _getShortDesc(name: string): string {
    switch (name) {
      case 'Bash':  return 'Run a shell command'
      case 'Read':  return 'Read a file'
      case 'Edit':  return 'Edit a file with string replacement'
      case 'Grep':  return 'Search file contents with regex'
      default:      return name
    }
  }

  /**
   * Recursively strip a JSON schema to its bare minimum:
   * keep type, required, properties (names + types only), remove everything else.
   */
  private _stripSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    // Keep only essential fields
    if (schema.type) result.type = schema.type
    if (Array.isArray(schema.required)) result.required = schema.required

    // Simplify properties — keep only name and type
    if (schema.properties && typeof schema.properties === 'object') {
      const props: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (val && typeof val === 'object') {
          const prop = val as Record<string, unknown>
          const simplified: Record<string, unknown> = {}
          if (prop.type) simplified.type = prop.type
          if (prop.enum) simplified.enum = prop.enum
          props[key] = simplified
        } else {
          props[key] = val
        }
      }
      result.properties = props
    }

    return result
  }
}
