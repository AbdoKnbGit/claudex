/**
 * Global reasoning effort store for OpenAI Codex models.
 *
 * The model picker writes the user's chosen level here; the OpenAI
 * provider reads it at request time.
 */

export type OpenAIReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh'

const REASONING_LEVELS: readonly OpenAIReasoningLevel[] = ['low', 'medium', 'high', 'xhigh']

const REASONING_LABELS: Record<OpenAIReasoningLevel, string> = {
  low:    'Low',
  medium: 'Medium',
  high:   'High',
  xhigh:  'Extra High',
}

let _currentLevel: OpenAIReasoningLevel = 'medium'

/** True once the user has explicitly picked a level via ← → in the picker. */
let _explicitlySet = false

export function getOpenAIReasoningLevel(): OpenAIReasoningLevel {
  return _currentLevel
}

/** Whether the user has explicitly chosen a reasoning level. */
export function isReasoningLevelExplicit(): boolean {
  return _explicitlySet
}

export function setOpenAIReasoningLevel(level: OpenAIReasoningLevel): void {
  _currentLevel = level
  _explicitlySet = true
}

export function cycleOpenAIReasoningLevel(direction: 'left' | 'right'): OpenAIReasoningLevel {
  const idx = REASONING_LEVELS.indexOf(_currentLevel)
  if (direction === 'right') {
    _currentLevel = REASONING_LEVELS[(idx + 1) % REASONING_LEVELS.length]!
  } else {
    _currentLevel = REASONING_LEVELS[(idx - 1 + REASONING_LEVELS.length) % REASONING_LEVELS.length]!
  }
  _explicitlySet = true
  return _currentLevel
}

export function getReasoningLabel(level: OpenAIReasoningLevel): string {
  return REASONING_LABELS[level]
}

export function getAllReasoningLevels(): readonly OpenAIReasoningLevel[] {
  return REASONING_LEVELS
}

/**
 * Check if an OpenAI model supports reasoning_effort.
 * GPT-5 family + o-series reasoning models.
 */
export function modelSupportsReasoning(modelId: string): boolean {
  return /^(o[1-9](-|$)|o[1-9][0-9]?(-mini|-pro)?|gpt-[5-9])/i.test(modelId)
}
