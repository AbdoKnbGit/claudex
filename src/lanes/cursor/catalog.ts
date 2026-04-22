/**
 * Cursor static model catalog.
 *
 * Cursor does not expose a clean public model-list endpoint for this lane.
 * The available ids here are Cursor ids for the ConnectRPC Model field, not
 * OpenAI/Anthropic canonical ids. Some labels intentionally match OpenAI
 * names; provider selection still determines the lane, so `/models cursor`
 * and `/models openai` remain separate.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'

/** UI/session id used by claudex for Cursor Auto. */
export const CURSOR_AUTO_MODEL_ID = 'auto'
/** Wire id Cursor's ConnectRPC endpoint expects for server-picked Auto. */
export const CURSOR_AUTO_WIRE_MODEL_ID = 'default'

export type CursorModelSection =
  | 'recommended'
  | 'anthropic'
  | 'openai'
  | 'other'

export type CursorVariantTag = 'thinking' | 'fast'

export interface CursorModelVariant {
  /** Concrete Cursor model id sent to the Cursor API. */
  id: string
  /** Short label shown in the horizontal variant selector. */
  label: string
  /** Optional expanded display name used in flat search output. */
  name?: string
  tags?: readonly CursorVariantTag[]
}

export interface CursorModelGroup {
  /** Stable row id for `/models cursor`; not necessarily sent to the API. */
  id: string
  name: string
  section: CursorModelSection
  defaultVariantId?: string
  variants: readonly CursorModelVariant[]
}

function cursorVariant(
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
    variants: [
      {
        id: 'auto',
        label: 'Auto',
        name: 'Auto',
      },
    ],
  },
  {
    id: 'composer-2',
    name: 'Composer 2',
    section: 'recommended',
    defaultVariantId: 'composer-2-fast',
    variants: [
      cursorVariant('composer-2-fast', 'Fast', 'Composer 2 Fast', ['fast']),
      cursorVariant('composer-2', 'Standard', 'Composer 2'),
    ],
  },
  {
    id: 'composer-1.5',
    name: 'Composer 1.5',
    section: 'recommended',
    variants: [
      cursorVariant('composer-1.5', 'Standard', 'Composer 1.5'),
    ],
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT 5.3 Codex',
    section: 'recommended',
    defaultVariantId: 'gpt-5.3-codex',
    variants: [
      cursorVariant('gpt-5.3-codex-low', 'Low', 'GPT 5.3 Codex Low'),
      cursorVariant('gpt-5.3-codex-low-fast', 'Low Fast', 'GPT 5.3 Codex Low Fast', ['fast']),
      cursorVariant('gpt-5.3-codex', 'Medium', 'GPT 5.3 Codex'),
      cursorVariant('gpt-5.3-codex-fast', 'Medium Fast', 'GPT 5.3 Codex Fast', ['fast']),
      cursorVariant('gpt-5.3-codex-high', 'High', 'GPT 5.3 Codex High'),
      cursorVariant('gpt-5.3-codex-high-fast', 'High Fast', 'GPT 5.3 Codex High Fast', ['fast']),
      cursorVariant('gpt-5.3-codex-xhigh', 'Extra High', 'GPT 5.3 Codex Extra High'),
      cursorVariant('gpt-5.3-codex-xhigh-fast', 'Extra High Fast', 'GPT 5.3 Codex Extra High Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.3-codex-spark-preview',
    name: 'GPT 5.3 Codex Spark',
    section: 'openai',
    defaultVariantId: 'gpt-5.3-codex-spark-preview',
    variants: [
      cursorVariant('gpt-5.3-codex-spark-preview-low', 'Low', 'GPT 5.3 Codex Spark Low'),
      cursorVariant('gpt-5.3-codex-spark-preview', 'Medium', 'GPT 5.3 Codex Spark'),
      cursorVariant('gpt-5.3-codex-spark-preview-high', 'High', 'GPT 5.3 Codex Spark High'),
      cursorVariant('gpt-5.3-codex-spark-preview-xhigh', 'Extra High', 'GPT 5.3 Codex Spark Extra High'),
    ],
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT 5.2 Codex',
    section: 'openai',
    defaultVariantId: 'gpt-5.2-codex',
    variants: [
      cursorVariant('gpt-5.2-codex-low', 'Low', 'GPT 5.2 Codex Low'),
      cursorVariant('gpt-5.2-codex-low-fast', 'Low Fast', 'GPT 5.2 Codex Low Fast', ['fast']),
      cursorVariant('gpt-5.2-codex', 'Medium', 'GPT 5.2 Codex'),
      cursorVariant('gpt-5.2-codex-fast', 'Medium Fast', 'GPT 5.2 Codex Fast', ['fast']),
      cursorVariant('gpt-5.2-codex-high', 'High', 'GPT 5.2 Codex High'),
      cursorVariant('gpt-5.2-codex-high-fast', 'High Fast', 'GPT 5.2 Codex High Fast', ['fast']),
      cursorVariant('gpt-5.2-codex-xhigh', 'Extra High', 'GPT 5.2 Codex Extra High'),
      cursorVariant('gpt-5.2-codex-xhigh-fast', 'Extra High Fast', 'GPT 5.2 Codex Extra High Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT 5.1 Codex Max',
    section: 'openai',
    defaultVariantId: 'gpt-5.1-codex-max-medium',
    variants: [
      cursorVariant('gpt-5.1-codex-max-low', 'Low', 'GPT 5.1 Codex Max Low'),
      cursorVariant('gpt-5.1-codex-max-low-fast', 'Low Fast', 'GPT 5.1 Codex Max Low Fast', ['fast']),
      cursorVariant('gpt-5.1-codex-max-medium', 'Medium', 'GPT 5.1 Codex Max'),
      cursorVariant('gpt-5.1-codex-max-medium-fast', 'Medium Fast', 'GPT 5.1 Codex Max Medium Fast', ['fast']),
      cursorVariant('gpt-5.1-codex-max-high', 'High', 'GPT 5.1 Codex Max High'),
      cursorVariant('gpt-5.1-codex-max-high-fast', 'High Fast', 'GPT 5.1 Codex Max High Fast', ['fast']),
      cursorVariant('gpt-5.1-codex-max-xhigh', 'Extra High', 'GPT 5.1 Codex Max Extra High'),
      cursorVariant('gpt-5.1-codex-max-xhigh-fast', 'Extra High Fast', 'GPT 5.1 Codex Max Extra High Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT 5.1 Codex Mini',
    section: 'openai',
    defaultVariantId: 'gpt-5.1-codex-mini',
    variants: [
      cursorVariant('gpt-5.1-codex-mini-low', 'Low', 'GPT 5.1 Codex Mini Low'),
      cursorVariant('gpt-5.1-codex-mini', 'Medium', 'GPT 5.1 Codex Mini'),
      cursorVariant('gpt-5.1-codex-mini-high', 'High', 'GPT 5.1 Codex Mini High'),
    ],
  },
  {
    id: 'gpt-5.2',
    name: 'GPT 5.2',
    section: 'openai',
    defaultVariantId: 'gpt-5.2',
    variants: [
      cursorVariant('gpt-5.2-low', 'Low', 'GPT 5.2 Low'),
      cursorVariant('gpt-5.2-low-fast', 'Low Fast', 'GPT 5.2 Low Fast', ['fast']),
      cursorVariant('gpt-5.2', 'Medium', 'GPT 5.2'),
      cursorVariant('gpt-5.2-fast', 'Medium Fast', 'GPT 5.2 Fast', ['fast']),
      cursorVariant('gpt-5.2-high', 'High', 'GPT 5.2 High'),
      cursorVariant('gpt-5.2-high-fast', 'High Fast', 'GPT 5.2 High Fast', ['fast']),
      cursorVariant('gpt-5.2-xhigh', 'Extra High', 'GPT 5.2 Extra High'),
      cursorVariant('gpt-5.2-xhigh-fast', 'Extra High Fast', 'GPT 5.2 Extra High Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-medium',
    variants: [
      cursorVariant('gpt-5.4-low', 'Low', 'GPT 5.4 Low'),
      cursorVariant('gpt-5.4-medium', 'Medium', 'GPT 5.4'),
      cursorVariant('gpt-5.4-medium-fast', 'Medium Fast', 'GPT 5.4 Fast', ['fast']),
      cursorVariant('gpt-5.4-high', 'High', 'GPT 5.4 High'),
      cursorVariant('gpt-5.4-high-fast', 'High Fast', 'GPT 5.4 High Fast', ['fast']),
      cursorVariant('gpt-5.4-xhigh', 'Extra High', 'GPT 5.4 Extra High'),
      cursorVariant('gpt-5.4-xhigh-fast', 'Extra High Fast', 'GPT 5.4 Extra High Fast', ['fast']),
    ],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-mini-medium',
    variants: [
      cursorVariant('gpt-5.4-mini-none', 'None', 'GPT 5.4 Mini None'),
      cursorVariant('gpt-5.4-mini-low', 'Low', 'GPT 5.4 Mini Low'),
      cursorVariant('gpt-5.4-mini-medium', 'Medium', 'GPT 5.4 Mini'),
      cursorVariant('gpt-5.4-mini-high', 'High', 'GPT 5.4 Mini High'),
      cursorVariant('gpt-5.4-mini-xhigh', 'Extra High', 'GPT 5.4 Mini Extra High'),
    ],
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT 5.4 Nano',
    section: 'openai',
    defaultVariantId: 'gpt-5.4-nano-medium',
    variants: [
      cursorVariant('gpt-5.4-nano-none', 'None', 'GPT 5.4 Nano None'),
      cursorVariant('gpt-5.4-nano-low', 'Low', 'GPT 5.4 Nano Low'),
      cursorVariant('gpt-5.4-nano-medium', 'Medium', 'GPT 5.4 Nano'),
      cursorVariant('gpt-5.4-nano-high', 'High', 'GPT 5.4 Nano High'),
      cursorVariant('gpt-5.4-nano-xhigh', 'Extra High', 'GPT 5.4 Nano Extra High'),
    ],
  },
  {
    id: 'gpt-5.1',
    name: 'GPT 5.1',
    section: 'openai',
    defaultVariantId: 'gpt-5.1',
    variants: [
      cursorVariant('gpt-5.1-low', 'Low', 'GPT 5.1 Low'),
      cursorVariant('gpt-5.1', 'Medium', 'GPT 5.1'),
      cursorVariant('gpt-5.1-high', 'High', 'GPT 5.1 High'),
    ],
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT 5 Mini',
    section: 'openai',
    variants: [
      cursorVariant('gpt-5-mini', 'Standard', 'GPT 5 Mini'),
    ],
  },
  {
    id: 'claude-4.6-sonnet',
    name: 'Claude 4.6 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4.6-sonnet-medium',
    variants: [
      cursorVariant('claude-4.6-sonnet-medium', 'Medium', 'Claude 4.6 Sonnet'),
      cursorVariant('claude-4.6-sonnet-medium-thinking', 'Medium Thinking', 'Claude 4.6 Sonnet Medium Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.6-opus',
    name: 'Claude 4.6 Opus',
    section: 'anthropic',
    defaultVariantId: 'claude-4.6-opus-high',
    variants: [
      cursorVariant('claude-4.6-opus-high', 'High', 'Claude 4.6 Opus High'),
      cursorVariant('claude-4.6-opus-high-thinking', 'High Thinking', 'Claude 4.6 Opus High Thinking', ['thinking']),
      cursorVariant('claude-4.6-opus-max', 'Max', 'Claude 4.6 Opus Max'),
      cursorVariant('claude-4.6-opus-max-thinking', 'Max Thinking', 'Claude 4.6 Opus Max Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.5-opus',
    name: 'Claude 4.5 Opus',
    section: 'anthropic',
    defaultVariantId: 'claude-4.5-opus-high',
    variants: [
      cursorVariant('claude-4.5-opus-high', 'High', 'Claude 4.5 Opus High'),
      cursorVariant('claude-4.5-opus-high-thinking', 'High Thinking', 'Claude 4.5 Opus High Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4.5-sonnet',
    name: 'Claude 4.5 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4.5-sonnet',
    variants: [
      cursorVariant('claude-4.5-sonnet', 'Standard', 'Claude 4.5 Sonnet'),
      cursorVariant('claude-4.5-sonnet-thinking', 'Thinking', 'Claude 4.5 Sonnet Thinking', ['thinking']),
    ],
  },
  {
    id: 'claude-4-sonnet',
    name: 'Claude 4 Sonnet',
    section: 'anthropic',
    defaultVariantId: 'claude-4-sonnet',
    variants: [
      cursorVariant('claude-4-sonnet', 'Standard', 'Claude 4 Sonnet'),
      cursorVariant('claude-4-sonnet-1m', '1M', 'Claude 4 Sonnet 1M'),
      cursorVariant('claude-4-sonnet-thinking', 'Thinking', 'Claude 4 Sonnet Thinking', ['thinking']),
      cursorVariant('claude-4-sonnet-1m-thinking', '1M Thinking', 'Claude 4 Sonnet 1M Thinking', ['thinking']),
    ],
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    section: 'other',
    variants: [
      cursorVariant('kimi-k2.5', 'Standard', 'Kimi K2.5'),
    ],
  },
  {
    id: 'gemini-3',
    name: 'Gemini 3',
    section: 'other',
    variants: [
      cursorVariant('gemini-3.1-pro', '3.1 Pro', 'Gemini 3.1 Pro'),
      cursorVariant('gemini-3-pro', '3 Pro', 'Gemini 3 Pro'),
      cursorVariant('gemini-3-flash', '3 Flash', 'Gemini 3 Flash'),
    ],
  },
  {
    id: 'grok-4-20',
    name: 'Grok 4.20',
    section: 'other',
    variants: [
      cursorVariant('grok-4-20', 'Standard', 'Grok 4.20'),
      cursorVariant('grok-4-20-thinking', 'Thinking', 'Grok 4.20 Thinking', ['thinking']),
    ],
  },
]

export const CURSOR_MODELS: ModelInfo[] = CURSOR_MODEL_GROUPS.flatMap(group =>
  group.variants.map(variant => ({
    id: variant.id,
    name: variant.name ?? `${group.name} ${variant.label}`,
  })),
)

const CURSOR_MODEL_IDS = new Set(CURSOR_MODELS.map(model => model.id))

/**
 * Strict Cursor catalog membership. This is catalog validation only; actual
 * request routing remains provider-scoped through the Cursor provider shim.
 */
export function isCursorModel(id: string): boolean {
  return id === 'default' || CURSOR_MODEL_IDS.has(id)
}

/**
 * Older claudex builds stored Cursor Auto as `default`, while the picker now
 * stores `auto` for a clearer UI. The Cursor chat protobuf still expects
 * `default` on the wire for server-picked Auto.
 */
export function resolveCursorModelId(id: string): string {
  return id === CURSOR_AUTO_MODEL_ID || id === CURSOR_AUTO_WIRE_MODEL_ID
    ? CURSOR_AUTO_WIRE_MODEL_ID
    : id
}
