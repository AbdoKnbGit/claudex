/**
 * Kiro static model catalog.
 *
 * Matches the curated `kr:` block in 9router's providerModels.js. Kiro's
 * ListAvailableModels endpoint (AmazonCodeWhispererService.ListAvailableModels)
 * requires a profileArn the default Builder-ID user doesn't always have,
 * and the returned catalog is noisy (retired ids, internal aliases). The
 * hardcoded list below is what Kiro's own editor ships.
 *
 * IDs are the ones the CodeWhisperer chat API expects in the `modelId`
 * field of userInputMessage — NOT canonical Anthropic/DeepSeek names.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const KIRO_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2' },
  { id: 'deepseek-3.1', name: 'DeepSeek 3.1' },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
  { id: 'glm-5', name: 'GLM 5' },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
]

export function isKiroModel(id: string): boolean {
  return KIRO_MODELS.some(m => m.id === id)
}
