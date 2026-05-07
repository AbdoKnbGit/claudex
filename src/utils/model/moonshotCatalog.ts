import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export const MOONSHOT_MODELS: readonly ModelInfo[] = [
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    contextWindow: 262_144,
    supportsToolCalling: true,
    tags: ['recommended', 'reasoning'],
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    contextWindow: 262_144,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    contextWindow: 262_144,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'kimi-k2-thinking-turbo',
    name: 'Kimi K2 Thinking Turbo',
    contextWindow: 262_144,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
  {
    id: 'kimi-k2-turbo-preview',
    name: 'Kimi K2 Turbo',
    contextWindow: 262_144,
    supportsToolCalling: true,
    tags: ['fast'],
  },
  {
    id: 'kimi-k2-0905-preview',
    name: 'Kimi K2 0905',
    contextWindow: 262_144,
    supportsToolCalling: true,
  },
  {
    id: 'kimi-k2-0711-preview',
    name: 'Kimi K2 0711',
    contextWindow: 131_072,
    supportsToolCalling: true,
  },
] as const

const MOONSHOT_MODEL_META = new Map(
  MOONSHOT_MODELS.map(model => [model.id, model] as const),
)

export function cloneMoonshotModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    tags: model.tags ? [...model.tags] : undefined,
  }
}

export function toMoonshotModelInfo(model: { id: string; name?: string }): ModelInfo {
  const id = model.id.trim()
  const known = MOONSHOT_MODEL_META.get(id.toLowerCase())
  if (known) {
    return {
      ...cloneMoonshotModelInfo(known),
      name: model.name && model.name.trim() ? model.name.trim() : known.name,
    }
  }

  return {
    id,
    name: model.name && model.name.trim() ? model.name.trim() : humanizeMoonshotModelId(id),
    supportsToolCalling: true,
    ...(looksLikeMoonshotThinkingModel(id) ? { tags: ['reasoning'] as const } : {}),
  }
}

export function isMoonshotChatModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase()
  return normalized.startsWith('kimi-') || normalized.startsWith('moonshot-')
}

export function normalizeMoonshotModelId(model: string): string {
  const trimmed = model.trim()
  const lower = trimmed.toLowerCase()
  return isMoonshotChatModelId(lower) ? lower : model
}

export function isMoonshotThinkingModel(model: string): boolean {
  const normalized = normalizeMoonshotModelId(model)
  return looksLikeMoonshotThinkingModel(normalized)
}

function looksLikeMoonshotThinkingModel(id: string): boolean {
  const normalized = id.trim().toLowerCase()
  return normalized.includes('kimi-k2-thinking')
    || normalized === 'kimi-k2.5'
    || normalized === 'kimi-k2.6'
}

function humanizeMoonshotModelId(id: string): string {
  return id
    .replace(/^models\//i, '')
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(part => {
      if (part.toLowerCase() === 'kimi') return 'Kimi'
      if (/^k\d/.test(part.toLowerCase())) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}
