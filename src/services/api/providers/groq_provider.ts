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
 * IMPORTANT — Groq free-tier has strict rate limits:
 *   - TPM (tokens per minute): 6,000–15,000 depending on model
 *   - RPM (requests per minute): 30
 *   - RPD (requests per day): 14,400
 *
 * Because of the low TPM, we aggressively trim the system prompt
 * and tool payload to stay under ~6K total tokens per request.
 *
 * Available models (April 2026):
 *   - openai/gpt-oss-120b          — Flagship reasoning model
 *   - openai/gpt-oss-20b           — Smaller GPT-OSS variant
 *   - qwen/qwen3-32b               — Strong coding, replaced qwq
 *   - deepseek-r1-distill-llama-70b — DeepSeek R1 reasoning
 *   - deepseek-r1-distill-qwen-32b — DeepSeek R1 Qwen variant
 *   - llama-3.3-70b-versatile      — Proven Llama 3.3 workhorse
 *   - groq/compound                — Agentic system (search + code exec)
 *   - groq/compound-mini           — Lower-latency compound variant
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ProviderConfig, ProviderRequestParams, ProviderTool } from './base_provider.js'

/** Minimal tool set for Groq — only the essentials to stay under TPM */
const GROQ_CORE_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
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

    // Aggressive optimization for Groq's low TPM limits
    // Override base class defaults unless user set GROQ-specific env vars
    if (!process.env.GROQ_MAX_SYSTEM_CHARS && !process.env.PROVIDER_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = 2000
    }
    if (!process.env.GROQ_MAX_TOKENS && !process.env.PROVIDER_MAX_TOKENS) {
      this.maxTokensCap = 2048
    }
  }

  /**
   * Override tool filtering for Groq — use a smaller tool set and
   * strip verbose descriptions to minimize token usage.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (!this.optimizePayload) return params

    const optimized = super.optimizeParams(params)

    // Further filter to Groq's minimal tool set
    if (optimized.tools && optimized.tools.length > 0) {
      const filtered = optimized.tools.filter(t => GROQ_CORE_TOOLS.has(t.name))
      optimized.tools = filtered.length > 0 ? filtered.map(t => this._trimToolSchema(t)) : undefined
    }

    return optimized
  }

  /**
   * Trim verbose tool descriptions to save tokens.
   * Groq's models are smart enough to work with shorter descriptions.
   */
  private _trimToolSchema(tool: ProviderTool): ProviderTool {
    const maxDescLen = 200
    let desc = tool.description ?? ''
    if (desc.length > maxDescLen) {
      const cutPoint = desc.lastIndexOf('.', maxDescLen)
      desc = desc.slice(0, cutPoint > maxDescLen * 0.5 ? cutPoint + 1 : maxDescLen)
    }
    return { ...tool, description: desc }
  }
}
