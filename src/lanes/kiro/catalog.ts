/**
 * Kiro static model catalog.
 *
 * Mirrors the native `kiro-cli chat --list-models` list so `/models`
 * matches what Kiro currently exposes even when the live catalog API is
 * unavailable or returns stale/internal ids.
 *
 * IDs are the ones the CodeWhisperer chat API expects in the `modelId`
 * field of userInputMessage — NOT canonical Anthropic/DeepSeek names.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const KIRO_MODELS: ModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 1_000_000, supportsToolCalling: true },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, supportsToolCalling: true },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, supportsToolCalling: true },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', contextWindow: 200_000, supportsToolCalling: true },
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2', contextWindow: 164_000, supportsToolCalling: true },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', contextWindow: 196_000, supportsToolCalling: true },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1', contextWindow: 196_000, supportsToolCalling: true },
  { id: 'glm-5', name: 'GLM 5', contextWindow: 200_000, supportsToolCalling: true },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', contextWindow: 256_000, supportsToolCalling: true },
]

const KIRO_MODEL_ALIASES = new Map<string, string>([
  ['claude-sonnet-4.0', 'claude-sonnet-4'],
  ['minimax-m2.5', 'minimax-m2.5'],
  ['minimax-m2.1', 'minimax-m2.1'],
  ['minimax-m2_5', 'minimax-m2.5'],
  ['minimax-m2_1', 'minimax-m2.1'],
  ['minimax-m2-5', 'minimax-m2.5'],
  ['minimax-m2-1', 'minimax-m2.1'],
  ['minimax m2.5', 'minimax-m2.5'],
  ['minimax m2.1', 'minimax-m2.1'],
  ['MiniMax-M2.5'.toLowerCase(), 'minimax-m2.5'],
  ['MiniMax-M2.1'.toLowerCase(), 'minimax-m2.1'],
])

export function normalizeKiroModelId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const aliased = KIRO_MODEL_ALIASES.get(lower)
  if (aliased) return aliased
  const exact = KIRO_MODELS.find(model => model.id.toLowerCase() === lower)
  return exact?.id ?? trimmed
}

export function isKiroModel(id: string): boolean {
  const normalized = normalizeKiroModelId(id)
  return KIRO_MODELS.some(m => m.id === normalized)
}
