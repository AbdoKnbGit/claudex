import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { resolveProviderAuth } from '../../services/api/auth/provider_auth.js'
import { getProvider } from '../../services/api/providers/providerShim.js'
import { validateProviderAuth } from '../auth.js'
import {
  getOllamaCatalog,
  type OllamaCatalog,
  type OllamaModelInfo,
} from './ollamaCatalog.js'
import {
  SELECTABLE_PROVIDERS,
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from './providers.js'

export type BrowsableModelProvider = Exclude<APIProvider, 'firstParty'>

export const BROWSABLE_MODEL_PROVIDERS: readonly BrowsableModelProvider[] =
  SELECTABLE_PROVIDERS.filter(
    (provider): provider is BrowsableModelProvider =>
      provider !== 'firstParty',
  )

export function getDefaultBrowsableProvider(
  preferredProvider: APIProvider,
): BrowsableModelProvider {
  if (
    preferredProvider !== 'firstParty' &&
    BROWSABLE_MODEL_PROVIDERS.includes(preferredProvider)
  ) {
    return preferredProvider
  }

  return (
    BROWSABLE_MODEL_PROVIDERS.find(provider =>
      validateProviderAuth(provider).valid,
    ) ?? 'openai'
  )
}

export function parseProviderModelQuery(
  rawArgs: string,
  fallbackProvider: BrowsableModelProvider,
): { provider: BrowsableModelProvider; query: string } {
  const args = rawArgs.trim()
  if (!args) {
    return { provider: fallbackProvider, query: '' }
  }

  const colonIndex = args.indexOf(':')
  if (colonIndex > 0) {
    const providerCandidate = args
      .slice(0, colonIndex)
      .trim()
      .toLowerCase() as BrowsableModelProvider
    if (BROWSABLE_MODEL_PROVIDERS.includes(providerCandidate)) {
      return {
        provider: providerCandidate,
        query: args.slice(colonIndex + 1).trim(),
      }
    }
  }

  const [firstToken, ...rest] = args.split(/\s+/)
  const providerCandidate = firstToken?.toLowerCase() as
    | BrowsableModelProvider
    | undefined
  if (providerCandidate && BROWSABLE_MODEL_PROVIDERS.includes(providerCandidate)) {
    return {
      provider: providerCandidate,
      query: rest.join(' ').trim(),
    }
  }

  return { provider: fallbackProvider, query: args }
}

export async function loadProviderModels(
  provider: BrowsableModelProvider,
): Promise<ModelInfo[]> {
  await resolveProviderAuth(provider)

  const models = await getProvider(provider).listModels()
  return sortProviderModels(models)
}

/**
 * A sectioned section of models to render inside the picker. Sections are
 * header-labelled groups with optional capability badges on each row. Non-
 * Ollama providers render a single "All models" section.
 */
export interface ProviderModelSection {
  id: string
  title: string
  accent?: 'cloud' | 'local' | 'toolless'
  models: SectionedModelInfo[]
}

export interface SectionedModelInfo extends ModelInfo {
  /** Optional tags to render beside the model name (tools, thinking, etc). */
  tags?: readonly ModelTag[]
  /** True when the model requires an extra pull/auth step before use. */
  needsPull?: boolean
}

export type ModelTag =
  | 'cloud'
  | 'local'
  | 'tools'
  | 'no-tools'
  | 'thinking'
  | 'pulled'
  | 'missing'

/**
 * Load a provider's models split into sections. For Ollama this means
 * {Cloud, Local, No-tool-support}. For every other provider it's a single
 * "All models" bucket — existing callers keep working untouched via
 * loadProviderModels() above.
 */
export async function loadProviderModelSections(
  provider: BrowsableModelProvider,
): Promise<ProviderModelSection[]> {
  if (provider === 'ollama') {
    const catalog = await getOllamaCatalog()
    return buildOllamaSections(catalog)
  }

  const models = await loadProviderModels(provider)
  return [
    {
      id: 'all',
      title: `${getProviderBrowseLabel(provider)} models`,
      models: models.map(m => ({ ...m })),
    },
  ]
}

function buildOllamaSections(catalog: OllamaCatalog): ProviderModelSection[] {
  const sections: ProviderModelSection[] = []

  if (catalog.cloud.length > 0) {
    sections.push({
      id: 'cloud',
      title: 'Cloud models',
      accent: 'cloud',
      models: catalog.cloud.map(toSectionedModel),
    })
  }

  if (catalog.local.length > 0) {
    sections.push({
      id: 'local',
      title: 'Local models',
      accent: 'local',
      models: catalog.local.map(toSectionedModel),
    })
  }

  if (catalog.toolless.length > 0) {
    sections.push({
      id: 'toolless',
      title: 'Local models without tool support',
      accent: 'toolless',
      models: catalog.toolless.map(toSectionedModel),
    })
  }

  return sections
}

function toSectionedModel(model: OllamaModelInfo): SectionedModelInfo {
  const tags: ModelTag[] = []
  tags.push(model.category === 'cloud' ? 'cloud' : 'local')
  tags.push(model.supportsTools ? 'tools' : 'no-tools')
  if (model.supportsThinking) tags.push('thinking')
  if (model.category === 'cloud') {
    tags.push(model.pulled ? 'pulled' : 'missing')
  }

  return {
    id: model.id,
    name: model.name,
    tags,
    needsPull: model.category === 'cloud' && !model.pulled,
  }
}

export function filterProviderModels(
  models: readonly ModelInfo[],
  query: string,
): ModelInfo[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...models]
  }

  return models.filter(model => {
    const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase()
    return haystack.includes(normalized)
  })
}

export function getProviderBrowseLabel(provider: BrowsableModelProvider): string {
  return PROVIDER_DISPLAY_NAMES[provider]
}

function sortProviderModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const leftName = (left.name || left.id).toLowerCase()
    const rightName = (right.name || right.id).toLowerCase()

    if (leftName !== rightName) {
      return leftName.localeCompare(rightName)
    }

    return left.id.localeCompare(right.id)
  })
}
