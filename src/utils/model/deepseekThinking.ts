/**
 * DeepSeek V4 thinking-mode toggle.
 *
 * V4 (deepseek-v4-flash, deepseek-v4-pro) defaults `thinking: enabled`
 * server-side. Without an explicit toggle Claudex inherits that default
 * and later tool turns 400 on missing reasoning_content.
 *
 * The model picker writes the user's choice here; the deepseek transformer
 * reads it at request time so the picker — not the hidden /thinking
 * command — owns the V4 thinking flow.
 *
 * Scope: V4 models only. deepseek-reasoner / deepseek-chat / deepseek-coder
 * keep their existing behavior driven by the global thinking config.
 */

const V4_THINKING_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
])

let _v4Enabled = false

export function isDeepSeekV4ThinkingModel(model: string): boolean {
  return V4_THINKING_MODELS.has(model)
}

export function getDeepSeekV4Thinking(): boolean {
  return _v4Enabled
}

export function setDeepSeekV4Thinking(enabled: boolean): void {
  _v4Enabled = enabled
}

export function toggleDeepSeekV4Thinking(): boolean {
  _v4Enabled = !_v4Enabled
  return _v4Enabled
}
