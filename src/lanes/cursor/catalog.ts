/**
 * Cursor static model catalog.
 *
 * Mirrors the curated `cu:` block in 9router's providerModels.js. Cursor's
 * model-listing endpoint (aiserver.v1.AiService/GetDefaultModelNudgeData)
 * uses the same ConnectRPC protobuf transport as the chat endpoint and
 * returns a noisy list that includes internal aliases + retired ids; the
 * hardcoded list below is what Cursor's IDE ships to its picker.
 *
 * The id is what the protobuf Model field expects — NOT a canonical
 * Anthropic/OpenAI id. `default` means "let the Cursor server pick".
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const CURSOR_MODELS: ModelInfo[] = [
  { id: 'default', name: 'Auto (Server Picks)' },
  { id: 'claude-4.5-opus-high-thinking', name: 'Claude 4.5 Opus High Thinking' },
  { id: 'claude-4.5-opus-high', name: 'Claude 4.5 Opus High' },
  { id: 'claude-4.5-sonnet-thinking', name: 'Claude 4.5 Sonnet Thinking' },
  { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
  { id: 'claude-4.5-haiku', name: 'Claude 4.5 Haiku' },
  { id: 'claude-4.5-opus', name: 'Claude 4.5 Opus' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex' },
  { id: 'claude-4.6-opus-max', name: 'Claude 4.6 Opus Max' },
  { id: 'claude-4.6-sonnet-medium-thinking', name: 'Claude 4.6 Sonnet Medium Thinking' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
  { id: 'gpt-5.2', name: 'GPT 5.2' },
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex' },
]

/**
 * Strict id match — Cursor's dotted/slashed ids don't collide with the
 * Anthropic-canonical (`claude-sonnet-4-20250514`) or OpenAI-canonical
 * (`gpt-5-codex`) ids, so the dispatcher won't accidentally steal any
 * model away from its native lane.
 */
export function isCursorModel(id: string): boolean {
  return CURSOR_MODELS.some(m => m.id === id)
}
