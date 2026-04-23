/**
 * Kilo fallback catalog.
 *
 * Used only when /api/openrouter/models fails (network blip, token revoked
 * mid-session, gateway outage). The authoritative source is the live
 * endpoint — see KiloLane.listModels() for the dynamic path and the
 * subscription-aware filtering that happens server-side.
 *
 * Order = curated preference when scores tie. Mirrors the "default" model
 * order exposed by https://api.kilo.ai/api/openrouter/models for a
 * logged-in individual user (no org context).
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const KILO_FALLBACK_MODELS: readonly ModelInfo[] = [
  { id: 'kilo-auto/balanced', name: 'Kilo Auto (balanced)' },
  { id: 'kilo-auto/coder', name: 'Kilo Auto (coder)' },
  { id: 'kilo-auto/free', name: 'Kilo Auto (free)' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
  { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner' },
  { id: 'z-ai/glm-5', name: 'GLM-5' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast 1' },
]

export const KILO_FALLBACK_FREE_IDS: ReadonlySet<string> = new Set([
  'kilo-auto/free',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat',
  'z-ai/glm-5',
  'moonshotai/kimi-k2.6',
  'qwen/qwen3-coder',
])

export function isKiloFreeId(id: string): boolean {
  return KILO_FALLBACK_FREE_IDS.has(id.toLowerCase())
}
