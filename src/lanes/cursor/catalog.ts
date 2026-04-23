/**
 * Cursor static model catalog.
 *
 * These ids are Cursor-native chat model ids. They stay provider-scoped,
 * so ids such as `gpt-5.3-codex` remain on the Cursor lane when Cursor is
 * the active provider.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const CURSOR_AUTO_MODEL_ID = 'auto'
export const CURSOR_AUTO_WIRE_MODEL_ID = 'default'

export type CursorModelSection =
  | 'recommended'
  | 'cursor'
  | 'anthropic'
  | 'openai'
  | 'other'

export type CursorVariantTag = 'thinking' | 'fast'

export interface CursorModelVariant {
  id: string
  label: string
  name?: string
  tags?: readonly CursorVariantTag[]
}

export interface CursorModelGroup {
  id: string
  name: string
  section: CursorModelSection
  defaultVariantId?: string
  variants: readonly CursorModelVariant[]
}

function variant(
  id: string,
  label: string,
  name: string,
  tags?: readonly CursorVariantTag[],
): CursorModelVariant {
  return tags ? { id, label, name, tags } : { id, label, name }
}

export const CURSOR_MODEL_GROUPS: readonly CursorModelGroup[] = [
  {
    id: 'auto',
    name: 'Auto',
    section: 'recommended',
    defaultVariantId: 'auto',
    variants: [variant('auto', 'Auto', 'Auto')],
  },
  {
    id: 'composer-2',
    name: 'Composer 2',
    section: 'cursor',
    defaultVariantId: 'composer-2',
    variants: [
      variant('composer-2-fast', 'Fast', 'Composer 2 Fast', ['fast']),
      variant('composer-2', 'Default', 'Composer 2'),
    ],
  },
  {
    id: 'composer-1.5',
    name: 'Composer 1.5',
    section: 'cursor',
    defaultVariantId: 'composer-1.5',
    variants: [variant('composer-1.5', 'Default', 'Composer 1.5')],
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    section: 'openai',
    defaultVariantId: 'gpt-5.3-codex',
    variants: [
      variant('gpt-5.3-codex-low', 'Low', 'GPT-5.3 Codex Low'),
      variant('gpt-5.3-codex-low-fast', 'Low Fast', 'GPT-5.3 Codex Low Fast', ['fast']),
      variant('gpt-5.3-codex', 'Default', 'GPT-5.3 Codex'),
      variant('gpt-5.3-codex-fast', 'Fast', 'GPT-5.3 Codex Fast', ['fast']),
      variant('gpt-5.3-codex-high', 'High', 'GPT-5.3 Codex High'),
      variant('gpt-5.3-codex-high-fast', 'High Fast', 'GPT-5.3 Codex High Fast', ['fast']),
      variant('gpt-5.3-codex-xhigh', 'XHigh', 'GPT-5.3 Codex XHigh'),
      variant('gpt-5.3-codex-xhigh-fast', 'XHigh Fast', 'GPT-5.3 Codex XHigh Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.3-codex-spark-preview',
    name: 'GPT-5.3 Codex Spark Preview',
    section: 'openai',
    defaultVariantId: 'gpt-5.3-codex-spark-preview',
    variants: [
      variant('gpt-5.3-codex-spark-preview-low', 'Low', 'GPT-5.3 Codex Spark Preview Low'),
      variant('gpt-5.3-codex-spark-preview', 'Default', 'GPT-5.3 Codex Spark Preview'),
      variant('gpt-5.3-codex-spark-preview-high', 'High', 'GPT-5.3 Codex Spark Preview High'),
      variant('gpt-5.3-codex-spark-preview-xhigh', 'XHigh', 'GPT-5.3 Codex Spark Preview XHigh'),
    ],
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    section: 'openai',
    defaultVariantId: 'gpt-5.2-codex',
    variants: [
      variant('gpt-5.2-codex-low', 'Low', 'GPT-5.2 Codex Low'),
      variant('gpt-5.2-codex-low-fast', 'Low Fast', 'GPT-5.2 Codex Low Fast', ['fast']),
      variant('gpt-5.2-codex', 'Default', 'GPT-5.2 Codex'),
      variant('gpt-5.2-codex-fast', 'Fast', 'GPT-5.2 Codex Fast', ['fast']),
      variant('gpt-5.2-codex-high', 'High', 'GPT-5.2 Codex High'),
      variant('gpt-5.2-codex-high-fast', 'High Fast', 'GPT-5.2 Codex High Fast', ['fast']),
      variant('gpt-5.2-codex-xhigh', 'XHigh', 'GPT-5.2 Codex XHigh'),
      variant('gpt-5.2-codex-xhigh-fast', 'XHigh Fast', 'GPT-5.2 Codex XHigh Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    section: 'openai',
    defaultVariantId: 'gpt-5.1-codex-max-medium',
    variants: [
      variant('gpt-5.1-codex-max-low', 'Low', 'GPT-5.1 Codex Max Low'),
      variant('gpt-5.1-codex-max-low-fast', 'Low Fast', 'GPT-5.1 Codex Max Low Fast', ['fast']),
      variant('gpt-5.1-codex-max-medium', 'Medium', 'GPT-5.1 Codex Max Medium'),
      variant('gpt-5.1-codex-max-medium-fast', 'Medium Fast', 'GPT-5.1 Codex Max Medium Fast', ['fast']),
      variant('gpt-5.1-codex-max-high', 'High', 'GPT-5.1 Codex Max High'),
      variant('gpt-5.1-codex-max-high-fast', 'High Fast', 'GPT-5.1 Codex Max High Fast', ['fast']),
      variant('gpt-5.1-codex-max-xhigh', 'XHigh', 'GPT-5.1 Codex Max XHigh'),
      variant('gpt-5.1-codex-max-xhigh-fast', 'XHigh Fast', 'GPT-5.1 Codex Max XHigh Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-medium',
    variants: [
      variant('gpt-5.4-low', 'Low', 'GPT-5.4 Low'),
      variant('gpt-5.4-medium', 'Medium', 'GPT-5.4 Medium'),
      variant('gpt-5.4-medium-fast', 'Medium Fast', 'GPT-5.4 Medium Fast', ['fast']),
      variant('gpt-5.4-high', 'High', 'GPT-5.4 High'),
      variant('gpt-5.4-high-fast', 'High Fast', 'GPT-5.4 High Fast', ['fast']),
      variant('gpt-5.4-xhigh', 'XHigh', 'GPT-5.4 XHigh'),
      variant('gpt-5.4-xhigh-fast', 'XHigh Fast', 'GPT-5.4 XHigh Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    section: 'openai',
    defaultVariantId: 'gpt-5.2',
    variants: [
      variant('gpt-5.2-low', 'Low', 'GPT-5.2 Low'),
      variant('gpt-5.2-low-fast', 'Low Fast', 'GPT-5.2 Low Fast', ['fast']),
      variant('gpt-5.2', 'Default', 'GPT-5.2'),
      variant('gpt-5.2-fast', 'Fast', 'GPT-5.2 Fast', ['fast']),
      variant('gpt-5.2-high', 'High', 'GPT-5.2 High'),
      variant('gpt-5.2-high-fast', 'High Fast', 'GPT-5.2 High Fast', ['fast']),
      variant('gpt-5.2-xhigh', 'XHigh', 'GPT-5.2 XHigh'),
      variant('gpt-5.2-xhigh-fast', 'XHigh Fast', 'GPT-5.2 XHigh Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-mini-medium',
    variants: [
      variant('gpt-5.4-mini-none', 'None', 'GPT-5.4 Mini None'),
      variant('gpt-5.4-mini-low', 'Low', 'GPT-5.4 Mini Low'),
      variant('gpt-5.4-mini-medium', 'Medium', 'GPT-5.4 Mini Medium'),
      variant('gpt-5.4-mini-high', 'High', 'GPT-5.4 Mini High'),
      variant('gpt-5.4-mini-xhigh', 'XHigh', 'GPT-5.4 Mini XHigh'),
    ],
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-nano-medium',
    variants: [
      variant('gpt-5.4-nano-none', 'None', 'GPT-5.4 Nano None'),
      variant('gpt-5.4-nano-low', 'Low', 'GPT-5.4 Nano Low'),
      variant('gpt-5.4-nano-medium', 'Medium', 'GPT-5.4 Nano Medium'),
      variant('gpt-5.4-nano-high', 'High', 'GPT-5.4 Nano High'),
      variant('gpt-5.4-nano-xhigh', 'XHigh', 'GPT-5.4 Nano XHigh'),
    ],
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    section: 'openai',
    defaultVariantId: 'gpt-5.1',
    variants: [
      variant('gpt-5.1-low', 'Low', 'GPT-5.1 Low'),
      variant('gpt-5.1', 'Default', 'GPT-5.1'),
      variant('gpt-5.1-high', 'High', 'GPT-5.1 High'),
    ],
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    section: 'openai',
    defaultVariantId: 'gpt-5.1-codex-mini',
    variants: [
      variant('gpt-5.1-codex-mini-low', 'Low', 'GPT-5.1 Codex Mini Low'),
      variant('gpt-5.1-codex-mini', 'Default', 'GPT-5.1 Codex Mini'),
      variant('gpt-5.1-codex-mini-high', 'High', 'GPT-5.1 Codex Mini High'),
    ],
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    section: 'openai',
    defaultVariantId: 'gpt-5-mini',
    variants: [variant('gpt-5-mini', 'Default', 'GPT-5 Mini')],
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    section: 'anthropic',
    defaultVariantId: 'claude-opus-4-7-high',
    variants: [
      variant('claude-opus-4-7-low', 'Low', 'Claude Opus 4.7 Low'),
      variant('claude-opus-4-7-medium', 'Medium', 'Claude Opus 4.7 Medium'),
      variant('claude-opus-4-7-high', 'High', 'Claude Opus 4.7 High'),
      variant('claude-opus-4-7-xhigh', 'XHigh', 'Claude Opus 4.7 XHigh'),
      variant('claude-opus-4-7-max', 'Max', 'Claude Opus 4.7 Max'),
      variant('claude-opus-4-7-thinking-low', 'Thinking Low', 'Claude Opus 4.7 Thinking Low', ['thinking']),
      variant('claude-opus-4-7-thinking-medium', 'Thinking Medium', 'Claude Opus 4.7 Thinking Medium', ['thinking']),
      variant('claude-opus-4-7-thinking-high', 'Thinking High', 'Claude Opus 4.7 Thinking High', ['thinking']),
      variant('claude-opus-4-7-thinking-xhigh', 'Thinking XHigh', 'Claude Opus 4.7 Thinking XHigh', ['thinking']),
      variant('claude-opus-4-7-thinking-max', 'Thinking Max', 'Claude Opus 4.7 Thinking Max', ['thinking']),
    ],
  },
  {
    id: 'claude-4.6-sonnet',
    name: 'Claude 4.6 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4.6-sonnet-medium',
    variants: [
      variant('claude-4.6-sonnet-medium', 'Medium', 'Claude 4.6 Sonnet Medium'),
      variant('claude-4.6-sonnet-medium-thinking', 'Medium Thinking', 'Claude 4.6 Sonnet Medium Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.6-opus',
    name: 'Claude 4.6 Opus',
    section: 'anthropic',
    defaultVariantId: 'claude-4.6-opus-high',
    variants: [
      variant('claude-4.6-opus-high', 'High', 'Claude 4.6 Opus High'),
      variant('claude-4.6-opus-max', 'Max', 'Claude 4.6 Opus Max'),
      variant('claude-4.6-opus-high-thinking', 'High Thinking', 'Claude 4.6 Opus High Thinking', ['thinking']),
      variant('claude-4.6-opus-max-thinking', 'Max Thinking', 'Claude 4.6 Opus Max Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.5-opus',
    name: 'Claude 4.5 Opus',
    section: 'anthropic',
    defaultVariantId: 'claude-4.5-opus-high',
    variants: [
      variant('claude-4.5-opus-high', 'High', 'Claude 4.5 Opus High'),
      variant('claude-4.5-opus-high-thinking', 'High Thinking', 'Claude 4.5 Opus High Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.5-sonnet',
    name: 'Claude 4.5 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4.5-sonnet',
    variants: [
      variant('claude-4.5-sonnet', 'Default', 'Claude 4.5 Sonnet'),
      variant('claude-4.5-sonnet-thinking', 'Thinking', 'Claude 4.5 Sonnet Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4-sonnet',
    name: 'Claude 4 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4-sonnet',
    variants: [
      variant('claude-4-sonnet', 'Default', 'Claude 4 Sonnet'),
      variant('claude-4-sonnet-1m', '1M', 'Claude 4 Sonnet 1M'),
      variant('claude-4-sonnet-thinking', 'Thinking', 'Claude 4 Sonnet Thinking', ['thinking']),
      variant('claude-4-sonnet-1m-thinking', '1M Thinking', 'Claude 4 Sonnet 1M Thinking', ['thinking']),
    ],
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    section: 'other',
    defaultVariantId: 'gemini-3.1-pro',
    variants: [variant('gemini-3.1-pro', 'Default', 'Gemini 3.1 Pro')],
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    section: 'other',
    defaultVariantId: 'gemini-3-flash',
    variants: [variant('gemini-3-flash', 'Default', 'Gemini 3 Flash')],
  },
  {
    id: 'grok-4-20',
    name: 'Grok 4.20',
    section: 'other',
    defaultVariantId: 'grok-4-20',
    variants: [
      variant('grok-4-20', 'Default', 'Grok 4.20'),
      variant('grok-4-20-thinking', 'Thinking', 'Grok 4.20 Thinking', ['thinking']),
    ],
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    section: 'other',
    defaultVariantId: 'kimi-k2.5',
    variants: [variant('kimi-k2.5', 'Default', 'Kimi K2.5')],
  },
]

const CURSOR_GROUP_ORDER = [
  'auto',
  'composer-2',
  'composer-1.5',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.3-codex-spark-preview',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.4',
  'claude-opus-4-7',
  'claude-4.6-sonnet',
  'claude-4.6-opus',
  'claude-4.5-opus',
  'gemini-3.1-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'grok-4-20',
  'claude-4.5-sonnet',
  'gpt-5.1',
  'gemini-3-flash',
  'gpt-5.1-codex-mini',
  'claude-4-sonnet',
  'gpt-5-mini',
  'kimi-k2.5',
] as const

const CURSOR_GROUP_ORDER_INDEX = new Map(
  CURSOR_GROUP_ORDER.map((id, index) => [id, index]),
)

export const CURSOR_ORDERED_MODEL_GROUPS: readonly CursorModelGroup[] = [...CURSOR_MODEL_GROUPS]
  .sort((left, right) => {
    const leftIndex = CURSOR_GROUP_ORDER_INDEX.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightIndex = CURSOR_GROUP_ORDER_INDEX.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })

export const CURSOR_MODELS: ModelInfo[] = CURSOR_ORDERED_MODEL_GROUPS.flatMap(group =>
  group.variants.map(variantInfo => ({
    id: variantInfo.id,
    name: variantInfo.name ?? `${group.name} ${variantInfo.label}`,
  })),
)

const CURSOR_MODEL_IDS = new Set(CURSOR_MODELS.map(model => model.id))

const CURSOR_LEGACY_MODEL_ALIASES = new Map<string, string>([
  ['composer-1', 'composer-1.5'],
  ['gpt-5.1-codex-max', 'gpt-5.1-codex-max-medium'],
  ['gpt-5.4', 'gpt-5.4-medium'],
  ['gpt-5.4-fast', 'gpt-5.4-medium-fast'],
  ['opus-4.6', 'claude-4.6-opus-high'],
  ['opus-4.6-thinking', 'claude-4.6-opus-high-thinking'],
  ['sonnet-4.6', 'claude-4.6-sonnet-medium'],
  ['sonnet-4.6-thinking', 'claude-4.6-sonnet-medium-thinking'],
  ['opus-4.5', 'claude-4.5-opus-high'],
  ['opus-4.5-thinking', 'claude-4.5-opus-high-thinking'],
  ['sonnet-4.5', 'claude-4.5-sonnet'],
  ['sonnet-4.5-thinking', 'claude-4.5-sonnet-thinking'],
  ['grok', 'grok-4-20'],
])

const CURSOR_MODEL_DISPLAY_NAMES = new Map<string, string>()

for (const group of CURSOR_MODEL_GROUPS) {
  CURSOR_MODEL_DISPLAY_NAMES.set(group.id, group.name)
  for (const variantInfo of group.variants) {
    CURSOR_MODEL_DISPLAY_NAMES.set(
      variantInfo.id,
      variantInfo.name ?? `${group.name} ${variantInfo.label}`,
    )
  }
}

export function isCursorModel(id: string): boolean {
  return CURSOR_MODEL_IDS.has(id) || id === CURSOR_AUTO_WIRE_MODEL_ID || CURSOR_LEGACY_MODEL_ALIASES.has(id)
}

export function isCursorAutoModelId(id: string): boolean {
  return id === CURSOR_AUTO_MODEL_ID || id === CURSOR_AUTO_WIRE_MODEL_ID
}

export function getCursorModelDisplayName(id: string): string | null {
  const resolvedId =
    isCursorAutoModelId(id)
      ? CURSOR_AUTO_MODEL_ID
      : (CURSOR_LEGACY_MODEL_ALIASES.get(id) ?? id)
  return CURSOR_MODEL_DISPLAY_NAMES.get(resolvedId) ?? null
}

export function resolveCursorModelId(id: string): string {
  if (isCursorAutoModelId(id)) {
    return CURSOR_AUTO_WIRE_MODEL_ID
  }
  return CURSOR_LEGACY_MODEL_ALIASES.get(id) ?? id
}
