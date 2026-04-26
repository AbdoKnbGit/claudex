import type { ModelInfo } from '../../services/api/providers/base_provider.js'

export interface OpenRouterCatalogModel {
  id?: string
  name?: string
  context_length?: number
  pricing?: Record<string, string | number | undefined>
}

const PROVIDER_LABELS: Record<string, string> = {
  aionlabs: 'AionLabs',
  'aion-labs': 'AionLabs',
  allenai: 'AllenAI',
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  baidu: 'Baidu',
  bytedance: 'ByteDance Seed',
  'bytedance-seed': 'ByteDance Seed',
  deepseek: 'DeepSeek',
  google: 'Google',
  inclusionai: 'inclusionAI',
  kwaipilot: 'Kwaipilot',
  liquidai: 'LiquidAI',
  liquid: 'LiquidAI',
  meta: 'Meta',
  'meta-llama': 'Meta Llama',
  minimax: 'MiniMax',
  minimaxai: 'MiniMax',
  mistral: 'Mistral',
  mistralai: 'Mistral',
  moonshotai: 'MoonshotAI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  stepfun: 'StepFun',
  'stepfun-ai': 'StepFun',
  tencent: 'Tencent',
  upstage: 'Upstage',
  writer: 'Writer',
  'x-ai': 'xAI',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  'z-ai': 'Z.ai',
  zai: 'Z.ai',
}

export function toOpenRouterModelInfo(model: OpenRouterCatalogModel): ModelInfo | null {
  if (typeof model.id !== 'string' || model.id.length === 0) {
    return null
  }

  const provider = inferOpenRouterProvider(model)
  const free = isFreeOpenRouterModel(model)
  const tags = free ? ['free'] as const : undefined

  return {
    id: model.id,
    name: normalizeOpenRouterModelName(model.name ?? model.id, provider, free),
    provider,
    contextWindow: model.context_length,
    ...(tags ? { tags } : {}),
  }
}

export function inferProviderLabelFromModelId(id: string, fallback = 'Unknown'): string {
  const rawPrefix = id.split('/')[0]?.replace(/^~/, '').trim()
  if (!rawPrefix) return fallback

  const normalized = rawPrefix.toLowerCase()
  return PROVIDER_LABELS[normalized] ?? humanizeProviderPrefix(rawPrefix)
}

function inferOpenRouterProvider(model: OpenRouterCatalogModel): string {
  const nameProvider = parseProviderPrefixFromName(model.name)
  if (nameProvider) return nameProvider

  return inferProviderLabelFromModelId(model.id ?? '')
}

function parseProviderPrefixFromName(name?: string): string | null {
  if (!name) return null

  const match = /^([^:]{2,40}):\s+/.exec(name.trim())
  return match ? match[1]!.trim() : null
}

function normalizeOpenRouterModelName(name: string, provider: string, free: boolean): string {
  let normalized = name.trim()
  const prefix = `${provider}:`
  if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
    normalized = normalized.slice(prefix.length).trim()
  }
  if (free) {
    normalized = normalized.replace(/\s+\(free\)$/i, '').trim()
  }
  return normalized || name
}

function isFreeOpenRouterModel(model: OpenRouterCatalogModel): boolean {
  return priceValue(model.pricing?.prompt) === 0
    && priceValue(model.pricing?.completion) === 0
}

function priceValue(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function humanizeProviderPrefix(prefix: string): string {
  return prefix
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.length <= 2 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}
